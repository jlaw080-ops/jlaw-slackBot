/**
 * Notion ↔ 볼트 접점 (notion-todo-sync 스킬의 규칙을 자동화)
 *
 *  findAssignedCandidates : 담당자가 나이거나 댓글 멘션된 활성 티켓 중 볼트에 아직 없는 것
 *  registerCandidate      : 사용자가 Slack에서 "등록"을 누른 후보 → 06_To Do 노트 생성 (notion: assigned)
 *  refreshTicketStatus    : 연결된 티켓의 notion-status 갱신 (status·본문은 건드리지 않음 — 스킬 규칙)
 *  markPending            : /티켓 발급 → notion: pending 표시 (실제 발급은 notion-qa-ticket 스킬)
 *
 * 규칙: Notion은 읽기만. 볼트 노트는 확인 없이 만들지 않음(후보 → Slack 버튼). 기존 노트 본문은 보존.
 */
import { config } from "./config.js";
import {
  findMentionInComments, getTicketSummary, getTicketsStatus, listActiveTicketsNotMine, listTicketsAssignedToMe,
  type MentionHit, type Ticket,
} from "./notion.js";
import {
  addIgnored, collectNotionLinks, createTask, listOpenTasks, notionIdFromUrl, patchTask, priorityForTicket, projectForTicket,
  readIgnored, shortTitle, type VaultTask,
} from "./vault.js";
import { syncTaskToCalendar } from "./gcal.js";

export interface Candidate {
  ticket: Ticket;
  reason: "assigned" | "mentioned";
  mention?: MentionHit;
}
export interface CandidateResult {
  candidates: Candidate[];
  skipped: Array<{ ticket: Ticket; path: string }>;   // 이미 볼트에 있음
  ignored: number;
  commentScan: { scanned: number; total: number };
}

/** 나에게 넘어온 활성 티켓 중 볼트(06_To Do + 01_진행업무)에 없는 것 */
export async function findAssignedCandidates(opts: { scanComments?: boolean } = {}): Promise<CandidateResult> {
  const empty: CandidateResult = { candidates: [], skipped: [], ignored: 0, commentScan: { scanned: 0, total: 0 } };
  if (!config.notion.enabled) return empty;
  const [assigned, links, ignoredSet] = await Promise.all([listTicketsAssignedToMe(), collectNotionLinks(), readIgnored()]);
  const result: CandidateResult = { ...empty };
  const seen = new Set<string>();

  const consider = (ticket: Ticket, reason: Candidate["reason"], mention?: MentionHit) => {
    if (seen.has(ticket.id)) return;
    seen.add(ticket.id);
    const path = links.get(ticket.id);
    if (path) { result.skipped.push({ ticket, path }); return; }
    if (ignoredSet.has(ticket.id)) { result.ignored++; return; }
    result.candidates.push({ ticket, reason, mention });
  };
  for (const t of assigned) consider(t, "assigned");

  if (opts.scanComments !== false) {
    const { tickets, total } = await listActiveTicketsNotMine();
    result.commentScan = { scanned: tickets.length, total };
    for (const t of tickets) {
      if (links.has(t.id) || ignoredSet.has(t.id)) continue;
      const hit = await findMentionInComments(t.id);
      if (hit) consider(t, "mentioned", hit);
    }
  }
  return result;
}

/** 후보 하나를 06_To Do 노트로 등록 (Slack 등록 버튼) */
export async function registerCandidate(ticket: Ticket, reason: Candidate["reason"], mention?: MentionHit): Promise<VaultTask> {
  const links = await collectNotionLinks();
  const existingPath = links.get(ticket.id);
  if (existingPath) {
    const open = await listOpenTasks();
    const hit = open.find((t) => t.path === existingPath);
    if (hit) return hit;
  }
  const { project, subProject } = projectForTicket(ticket.tags);
  const summary = await getTicketSummary(ticket.id);
  const sources = [`Notion: [${ticket.title}](${ticket.url})`, "할당 근거: 담당자 지정"];
  if (reason === "mentioned" && mention) {
    sources[1] = `할당 근거: 댓글 멘션 (${mention.date.slice(5).replace("-", "/")}, ${mention.author}) — "${mention.comment}"`;
  }
  const task = await createTask({
    title: shortTitle(ticket.title),
    project, subProject,
    priority: priorityForTicket(ticket.priority, ticket.due),
    due: ticket.due,
    tags: [],
    overview: shortTitle(ticket.title),
    sources,
    background: summary.background,
    checklist: summary.checklist,
    notion: "assigned",
    notionUrl: ticket.url,
    notionStatus: ticket.status,
  });
  if (config.google.enabled && task.due) { try { await syncTaskToCalendar(task); } catch { /* ignore */ } }
  return task;
}

export async function ignoreCandidate(ticket: Ticket): Promise<void> {
  await addIgnored(ticket.id, ticket.title);
}

export interface RefreshResult {
  checked: number;
  changed: Array<{ task: VaultTask; from: string | null; to: string }>;
  finished: VaultTask[];   // Notion에서 완료/보관/업무제외 된 것 (볼트 status는 사용자가 정리)
}

/** 볼트 열린 노트 중 notion-url이 있는 것의 notion-status 갱신 */
export async function refreshTicketStatus(tasks?: VaultTask[]): Promise<RefreshResult> {
  const result: RefreshResult = { checked: 0, changed: [], finished: [] };
  if (!config.notion.enabled) return result;
  const open = tasks ?? await listOpenTasks();
  const linked = open.filter((t) => notionIdFromUrl(t.notionUrl));
  if (!linked.length) return result;
  const statuses = await getTicketsStatus(linked.map((t) => notionIdFromUrl(t.notionUrl)!));
  result.checked = statuses.size;
  for (const t of linked) {
    const tk = statuses.get(notionIdFromUrl(t.notionUrl)!);
    if (!tk) continue;
    if (["완료", "보관", "업무제외"].includes(tk.status)) result.finished.push(t);
    if (tk.status === t.notionStatus) continue;
    const updated = await patchTask(t, { "notion-status": tk.status });
    result.changed.push({ task: updated, from: t.notionStatus, to: tk.status });
  }
  return result;
}

/** /티켓 발급: 노트에 notion: pending 표시 → Claude Code에서 notion-qa-ticket 스킬이 발급 */
export async function markPending(task: VaultTask): Promise<VaultTask> {
  if (task.notionUrl) throw new Error(`이미 Notion 티켓이 연결되어 있어요: ${task.notionUrl}`);
  return patchTask(task, { notion: "pending", "notion-url": "", "notion-status": "" });
}
