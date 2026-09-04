/**
 * 아침 브리핑: 오늘 일정 + 지연/오늘/이번주 할일 + 진행 중 + Notion 할당 후보·티켓 상태 → Slack #할일
 */
import { config } from "./config.js";
import { listOpenTasks, type VaultTask } from "./vault.js";
import { listEvents, syncTaskToCalendar, type CalEvent } from "./gcal.js";
import { addDays, dayRangeKST, prettyKST, timeKST, todayKST } from "./dates.js";
import { candidateCard, context, divider, header, postMessage, section, taskLine } from "./slack.js";
import { findAssignedCandidates, refreshTicketStatus, type CandidateResult, type RefreshResult } from "./notion-sync.js";

export interface BriefData {
  date: string;
  events: CalEvent[];
  overdue: VaultTask[];
  today: VaultTask[];
  week: VaultTask[];
  inProgress: VaultTask[];
  rest: VaultTask[];
  pending: VaultTask[];        // notion: pending (발급 대기)
  candidates: CandidateResult;
  refreshed: RefreshResult;
}

export function eventLine(e: CalEvent): string {
  const when = e.allDay ? "종일" : `${timeKST(e.start)}–${timeKST(e.end)}`;
  return `🗓 ${when} · <${e.htmlLink}|${e.summary}>${e.location ? ` @ ${e.location}` : ""}`;
}

export async function collectBrief(date = todayKST()): Promise<BriefData> {
  const tasks = await listOpenTasks();
  const refreshed = await refreshTicketStatus(tasks).catch((): RefreshResult => ({ checked: 0, changed: [], finished: [] }));
  const candidates = await findAssignedCandidates().catch((): CandidateResult => ({ candidates: [], skipped: [], ignored: 0, commentScan: { scanned: 0, total: 0 } }));
  const weekEnd = addDays(date, 7);
  const events = config.google.enabled ? await listEvents(dayRangeKST(date).timeMin, dayRangeKST(date).timeMax).catch(() => []) : [];
  const active = (t: VaultTask) => t.status === "in-progress" || t.status === "review";
  return {
    date,
    events: events.filter((e) => !e.vaultPath),
    overdue: tasks.filter((t) => t.due && t.due < date),
    today: tasks.filter((t) => t.due === date),
    week: tasks.filter((t) => t.due && t.due > date && t.due <= weekEnd),
    inProgress: tasks.filter((t) => active(t) && (!t.due || t.due > weekEnd)),
    rest: tasks.filter((t) => !active(t) && (!t.due || t.due > weekEnd)),
    pending: tasks.filter((t) => t.notion === "pending"),
    candidates,
    refreshed,
  };
}

export function buildBriefBlocks(b: BriefData): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [header(`☀️ ${prettyKST(b.date)} 오늘의 브리핑`)];
  const list = (title: string, items: string[], emptyText?: string) => {
    if (!items.length) { if (emptyText) blocks.push(section(`*${title}*\n_${emptyText}_`)); return; }
    blocks.push(section(`*${title}* (${items.length})\n${items.slice(0, 15).join("\n")}${items.length > 15 ? `\n_…외 ${items.length - 15}건_` : ""}`));
  };
  list("📅 오늘 일정", b.events.map(eventLine), config.google.enabled ? "일정 없음" : "Google Calendar 미연결");
  blocks.push(divider);
  list("⚠️ 마감 지난 할일", b.overdue.map((t) => taskLine(t, b.date)));
  list("🎯 오늘 마감", b.today.map((t) => taskLine(t, b.date)), "오늘 마감 없음");
  list("📆 이번 주 마감", b.week.map((t) => taskLine(t, b.date)));
  list("🔄 진행 중 / 검토 중", b.inProgress.map((t) => taskLine(t, b.date)));
  if (b.rest.length) blocks.push(context(`▫️ 그 외 예정 할일 ${b.rest.length}건 — \`/할일 목록 전체\``));

  if (config.notion.enabled) {
    blocks.push(divider);
    if (b.candidates.candidates.length) {
      blocks.push(section(`*📌 Notion에서 나에게 넘어온 티켓* (${b.candidates.candidates.length}) — 할일로 등록할지 확인해 주세요`));
      for (const c of b.candidates.candidates.slice(0, 8)) blocks.push(...candidateCard(c));
      if (b.candidates.candidates.length > 8) blocks.push(context(`…외 ${b.candidates.candidates.length - 8}건 — \`/티켓 할당\``));
    }
    if (b.refreshed.changed.length) list("🎫 내 티켓 상태 변화", b.refreshed.changed.map((c) => `${taskLine(c.task, b.date)}  _(${c.from ?? "-"} → ${c.to})_`));
    if (b.refreshed.finished.length) blocks.push(context(`✅ Notion에서 끝난 티켓 ${b.refreshed.finished.length}건: ${b.refreshed.finished.map((t) => t.title).join(", ")} — 볼트 노트는 직접 완료 처리해 주세요 (\`/할일 완료 키워드\`)`));
    if (b.pending.length) blocks.push(context(`🎫 발급 대기 노트 ${b.pending.length}건: ${b.pending.map((t) => t.title).join(", ")} — Claude Code에서 \`notion-qa-ticket\` 스킬로 발급`));
    const cs = b.candidates.commentScan;
    if (cs.total > cs.scanned) blocks.push(context(`댓글 멘션 스캔: 활성 ${cs.total}건 중 최근 ${cs.scanned}건만 확인`));
  }
  blocks.push(divider);
  blocks.push(context("`/할일 추가 제목 | 마감 | 우선순위 | 프로젝트` · `/할일 목록` · `/티켓 상태` · `/일정 오늘` · `/작업일지 메모`"));
  const text = `${prettyKST(b.date)} 브리핑: 일정 ${b.events.length}, 지연 ${b.overdue.length}, 오늘 ${b.today.length}, 이번주 ${b.week.length}, Notion 후보 ${b.candidates.candidates.length}`;
  return { text, blocks };
}

export async function runDailyBrief(date = todayKST()) {
  const data = await collectBrief(date);
  const { text, blocks } = buildBriefBlocks(data);
  const posted = await postMessage(config.slack.channelTodo, text, blocks);
  const calendar: Record<string, number> = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 };
  if (config.google.enabled) {
    for (const t of [...data.overdue, ...data.today, ...data.week]) {
      try { calendar[await syncTaskToCalendar(t)]++; } catch { calendar.failed++; }
    }
  }
  return {
    ts: posted.ts,
    counts: { events: data.events.length, overdue: data.overdue.length, today: data.today.length, week: data.week.length, candidates: data.candidates.candidates.length, ticketChanges: data.refreshed.changed.length },
    calendar,
  };
}
