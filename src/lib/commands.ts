/**
 * Slack 슬래시 명령 해석 + 실행  (창고 = Obsidian 볼트 06_To Do)
 *
 *  /할일 추가 제목 | 마감 | 우선순위 | 프로젝트   06_To Do/YYYY-MM/MMDD_제목.md 생성 (+캘린더)
 *  /할일 목록 [전체|오늘|주간]
 *  /할일 완료|시작|검토|보류 키워드               status 변경 (done / in-progress / review / backlog)
 *  /할일 브리핑
 *  /작업일지 메모  ·  /작업일지 생성               일일노트 마커 블록
 *  /일정 오늘|내일|주간  ·  /일정 추가 제목 | 날짜 | 시작 | 종료
 *  /티켓 발급 키워드                              노트에 notion: pending 표시 (발급은 notion-qa-ticket 스킬)
 *  /티켓 상태                                     연결된 티켓의 Notion 상태 확인
 *  /티켓 할당                                     Notion에서 나에게 넘어온 티켓 후보 보기 (등록/무시 버튼)
 */
import { config } from "./config.js";
import { addDays, dayRangeKST, parseDateInput, prettyKST, todayKST } from "./dates.js";
import { createTimedEvent, listEvents, syncTaskToCalendar } from "./gcal.js";
import {
  appendMemo, createTask, findTasksByKeyword, guessProject, listOpenTasks, PROJECTS, setStatus, STATUS_KO,
  type Priority, type VaultStatus, type VaultTask,
} from "./vault.js";
import { candidateCard, context, header, projectPicker, section, taskCard, taskLine } from "./slack.js";
import { runDailyBrief, eventLine } from "./brief.js";
import { runWorklog } from "./worklog.js";
import { findAssignedCandidates, markPending, refreshTicketStatus } from "./notion-sync.js";

export interface CommandContext { userId: string; channelId: string; permalink?: string }
export interface CommandReply { text: string; blocks?: unknown[]; inChannel?: boolean }

export type AddSpec = { title: string; due: string | null; priority?: Priority; project?: string; rawDue?: string; rawProject?: string };

export type Parsed =
  | ({ kind: "todo.add" } & AddSpec)
  | { kind: "todo.list"; scope: "기본" | "전체" | "오늘" | "주간" }
  | { kind: "todo.status"; keyword: string; status: VaultStatus }
  | { kind: "todo.brief" }
  | { kind: "worklog.note"; text: string }
  | { kind: "worklog.generate" }
  | { kind: "schedule.list"; days: number; from: string }
  | { kind: "schedule.add"; title: string; date: string | null; start?: string; end?: string; rawDate?: string }
  | { kind: "ticket.pending"; keyword: string }
  | { kind: "ticket.status" }
  | { kind: "ticket.pull" }
  | { kind: "help"; command: string };

const PRIORITY_ALIAS: Record<string, Priority> = {
  높음: "high", 상: "high", high: "high", h: "high", "!": "high", 급: "high",
  중간: "mid", 중: "mid", mid: "mid", medium: "mid", m: "mid",
  낮음: "low", 하: "low", low: "low", l: "low",
};

export function normalizeCommand(command: string): "할일" | "작업일지" | "일정" | "티켓" | "unknown" {
  const c = command.replace(/^\//, "").toLowerCase();
  if (["할일", "todo", "task"].includes(c)) return "할일";
  if (["작업일지", "worklog", "log"].includes(c)) return "작업일지";
  if (["일정", "schedule", "cal"].includes(c)) return "일정";
  if (["티켓", "ticket", "notion"].includes(c)) return "티켓";
  return "unknown";
}

function parseAddSpec(text: string, today: string): AddSpec | null {
  const [title, dueRaw, prRaw, projRaw] = text.split("|").map((s) => s.trim());
  if (!title) return null;
  const project = projRaw ? (PROJECTS.find((p) => p === projRaw || p.includes(projRaw)) ?? guessProject(projRaw) ?? undefined) : undefined;
  return {
    title,
    due: dueRaw ? parseDateInput(dueRaw, today) : null,
    priority: prRaw ? PRIORITY_ALIAS[prRaw.toLowerCase()] : undefined,
    project,
    rawDue: dueRaw || undefined,
    rawProject: projRaw || undefined,
  };
}

export function parseCommand(command: string, text: string, today = todayKST()): Parsed {
  const kind = normalizeCommand(command);
  const raw = (text ?? "").trim();
  const [first, ...restArr] = raw.split(/\s+/);
  const rest = restArr.join(" ").trim();
  const sub = (first ?? "").toLowerCase();
  const isHelp = !raw || sub === "도움말" || sub === "help";

  if (kind === "할일") {
    if (isHelp) return { kind: "help", command: "할일" };
    if (["추가", "add", "new", "생성"].includes(sub)) {
      const spec = parseAddSpec(rest, today);
      return spec ? { kind: "todo.add", ...spec } : { kind: "help", command: "할일" };
    }
    if (["목록", "list", "ls", "보기"].includes(sub)) {
      const scope = (["전체", "오늘", "주간"].find((s) => rest.startsWith(s)) ?? "기본") as "기본" | "전체" | "오늘" | "주간";
      return { kind: "todo.list", scope };
    }
    if (["완료", "done", "끝"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "done" };
    if (["시작", "start", "진행"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "in-progress" };
    if (["검토", "review"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "review" };
    if (["보류", "hold", "백로그", "backlog"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "backlog" };
    if (["예정", "planned"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "planned" };
    if (["브리핑", "brief"].includes(sub)) return { kind: "todo.brief" };
    const spec = parseAddSpec(raw, today); // 하위 명령 없이 제목만 쓰면 "추가"
    return spec ? { kind: "todo.add", ...spec } : { kind: "help", command: "할일" };
  }

  if (kind === "작업일지") {
    if (isHelp) return { kind: "help", command: "작업일지" };
    if (["생성", "generate", "마감", "정리"].includes(sub)) return { kind: "worklog.generate" };
    return { kind: "worklog.note", text: raw };
  }

  if (kind === "일정") {
    if (isHelp) return { kind: "help", command: "일정" };
    if (["추가", "add", "new"].includes(sub)) {
      const [title, dateRaw, start, end] = rest.split("|").map((s) => s.trim());
      if (!title) return { kind: "help", command: "일정" };
      return { kind: "schedule.add", title, date: dateRaw ? parseDateInput(dateRaw, today) : today, start: normTime(start), end: normTime(end), rawDate: dateRaw };
    }
    if (sub === "내일") return { kind: "schedule.list", days: 1, from: addDays(today, 1) };
    if (["주간", "이번주", "week"].includes(sub)) return { kind: "schedule.list", days: 7, from: today };
    return { kind: "schedule.list", days: 1, from: today };
  }

  if (kind === "티켓") {
    if (isHelp) return { kind: "help", command: "티켓" };
    if (["발급", "issue", "대기", "pending"].includes(sub) && rest) return { kind: "ticket.pending", keyword: rest };
    if (["상태", "status", "현황", "목록"].includes(sub)) return { kind: "ticket.status" };
    if (["할당", "pull", "가져오기", "동기화", "후보"].includes(sub)) return { kind: "ticket.pull" };
    return { kind: "help", command: "티켓" };
  }

  return { kind: "help", command: "할일" };
}

function normTime(s?: string): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s.trim());
  return m ? `${String(Number(m[1])).padStart(2, "0")}:${m[2] ?? "00"}` : undefined;
}

export const HELP: Record<string, string> = {
  할일: [
    "*📋 /할일 — 창고는 Obsidian 볼트 `06_To Do/YYYY-MM/`*",
    "• `/할일 추가 제목 | 마감 | 우선순위 | 프로젝트` — 예) `/할일 추가 ZEB 검토서 작성 | 금요일 | 높음 | 에너빌드`",
    "   마감: 오늘·내일·모레·이번주·다음주·9/15·+3 / 우선순위: 높음·중간·낮음 / 프로젝트를 비우면 제목에서 추론하고, 못 정하면 버튼으로 묻습니다",
    "• `/할일 목록 [전체|오늘|주간]` — 버튼으로 완료·진행 중·티켓 발급 대기",
    "• `/할일 완료|시작|검토|보류 키워드` — status: done / in-progress / review / backlog",
    "• `/할일 브리핑` — 아침 브리핑 지금 게시",
  ].join("\n"),
  작업일지: [
    "*📓 /작업일지 — 일일노트 `05_Daily/날짜.md`의 WorkHub 블록*",
    "• `/작업일지 오늘 한 일` — 메모 한 줄 추가 (여러 번 가능)",
    "• `/작업일지 생성` — 지금 바로 완료·진행·일정·메모를 정리해 #작업일지에 게시",
  ].join("\n"),
  일정: [
    "*📅 /일정 — Google Calendar*",
    "• `/일정` · `/일정 내일` · `/일정 주간`",
    "• `/일정 추가 제목 | 날짜 | 시작 | 종료` — 예) `/일정 추가 설계협의 | 내일 | 14:00 | 15:30`",
  ].join("\n"),
  티켓: [
    "*🎫 /티켓 — Notion 에너빌드작업 보드 (봇은 읽기만, 발급은 notion-qa-ticket 스킬)*",
    "• `/티켓 발급 키워드` — 노트에 `notion: pending` 표시 → Claude Code에서 \"노션 티켓 발급\" 하면 스킬이 pending 노트를 발급",
    "• `/티켓 상태` — 내 노트에 연결된 티켓의 Notion 진행 상태 확인·갱신",
    "• `/티켓 할당` — Notion에서 담당자 지정·댓글 멘션된 티켓 후보 → 등록/무시 버튼",
  ].join("\n"),
};

async function pickOne(keyword: string, label: string): Promise<{ task?: VaultTask; reply?: CommandReply }> {
  const found = await findTasksByKeyword(keyword);
  if (!found.length) return { reply: { text: `🔍 "${keyword}" 키워드의 열린 할일을 찾지 못했어요. \`/할일 목록 전체\`로 확인해 보세요.` } };
  if (found.length > 1) {
    return { reply: { text: `"${keyword}" 검색 결과 ${found.length}건 — 버튼으로 ${label}하세요.`, blocks: [section(`🔍 *"${keyword}"* 검색 결과 ${found.length}건`), ...found.slice(0, 5).flatMap(taskCard)] } };
  }
  return { task: found[0] };
}

/** 할일 노트 생성 (project가 없으면 추론 → 그래도 없으면 선택 버튼) */
export async function addTask(spec: AddSpec, ctx: CommandContext): Promise<CommandReply> {
  if (spec.rawDue && !spec.due) return { text: `⚠️ 마감일 "${spec.rawDue}"을(를) 이해하지 못했어요. 예: 내일, 금요일, 9/15, 2026-09-15` };
  if (spec.rawProject && !spec.project) return { text: `⚠️ 프로젝트 "${spec.rawProject}"을(를) 모르겠어요. 가능한 값: ${PROJECTS.join(", ")}` };
  const project = spec.project ?? guessProject(spec.title);
  if (!project) {
    const { rawDue, rawProject, ...rest } = spec;
    return { text: "어느 프로젝트의 할일인지 골라 주세요.", blocks: projectPicker({ ...rest, permalink: ctx.permalink ?? "" }, PROJECTS) };
  }
  const task = await createTask({
    title: spec.title, project, priority: spec.priority, due: spec.due,
    sources: [`Slack (${prettyKST(todayKST())})${ctx.permalink ? ` — ${ctx.permalink}` : ""}`],
  });
  let calNote = "";
  if (config.google.enabled && task.due) {
    try { await syncTaskToCalendar(task); calNote = " · 📅 캘린더 등록"; } catch { calNote = " · ⚠️ 캘린더 등록 실패"; }
  }
  return { inChannel: true, text: `✅ 할일 노트 생성: ${task.title}${calNote}`, blocks: [section(`✅ *할일 노트 생성* → \`${task.path}\`${calNote}`), ...taskCard(task)] };
}

export async function executeCommand(p: Parsed, ctx: CommandContext): Promise<CommandReply> {
  const today = todayKST();
  switch (p.kind) {
    case "help":
      return { text: HELP[p.command] ?? HELP.할일 };

    case "todo.add":
      return addTask(p, ctx);

    case "todo.list": {
      const tasks = await listOpenTasks();
      const weekEnd = addDays(today, 7);
      let picked: VaultTask[]; let title: string;
      if (p.scope === "전체") { picked = tasks; title = "열린 할일 전체"; }
      else if (p.scope === "오늘") { picked = tasks.filter((t) => t.due && t.due <= today); title = "오늘 마감 + 지연"; }
      else if (p.scope === "주간") { picked = tasks.filter((t) => t.due && t.due <= weekEnd); title = "이번 주 마감 (지연 포함)"; }
      else { picked = tasks.filter((t) => (t.due && t.due <= weekEnd) || t.status === "in-progress" || t.status === "review"); title = "이번 주 + 진행 중"; }
      if (!picked.length) return { text: `🎉 ${title}: 해당 할일이 없습니다.` };
      const blocks: unknown[] = [header(`📋 ${title} (${picked.length})`)];
      for (const t of picked.slice(0, 12)) blocks.push(...taskCard(t));
      if (picked.length > 12) blocks.push(context(`…외 ${picked.length - 12}건. Obsidian \`06_To Do/\` 또는 Vault-Kanban에서 전체 보기`));
      return { text: `${title} ${picked.length}건`, blocks };
    }

    case "todo.status": {
      const { task, reply } = await pickOne(p.keyword, "처리");
      if (reply) return reply;
      const updated = await setStatus(task!, p.status);
      if (config.google.enabled) { try { await syncTaskToCalendar(updated); } catch { /* ignore */ } }
      return { inChannel: true, text: `${STATUS_KO[p.status]} 처리: ${updated.title}`, blocks: [section(`*${STATUS_KO[p.status]}* 처리됨 (status: ${p.status})\n${taskLine(updated)}`)] };
    }

    case "todo.brief": {
      const r = await runDailyBrief();
      return { text: `☀️ 브리핑을 <#${config.slack.channelTodo}>에 게시했어요. (일정 ${r.counts.events}, 지연 ${r.counts.overdue}, 오늘 ${r.counts.today}, Notion 후보 ${r.counts.candidates})` };
    }

    case "worklog.note": {
      const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      const path = await appendMemo(today, `${stamp} ${p.text}`);
      return { inChannel: true, text: `📝 작업일지 메모 추가: ${p.text}`, blocks: [section(`📝 *${prettyKST(today)} 작업일지 메모 추가*\n> ${p.text}`), context(`일일노트 \`${path}\` (WorkHub 블록)`)] };
    }

    case "worklog.generate": {
      const r = await runWorklog();
      return { text: `🌙 작업일지를 <#${config.slack.channelWorklog}>에 게시했어요. 완료 ${r.done}건, 진행 중 ${r.active}건, 메모 ${r.memos}건 · \`${r.path}\`` };
    }

    case "schedule.list": {
      if (!config.google.enabled) return { text: "📅 Google Calendar가 아직 연결되지 않았어요. (GOOGLE_SERVICE_ACCOUNT_JSON 설정 필요)" };
      const { timeMin, timeMax } = dayRangeKST(p.from, p.days);
      const events = await listEvents(timeMin, timeMax);
      const label = p.days === 1 ? prettyKST(p.from) : `${prettyKST(p.from)} ~ ${prettyKST(addDays(p.from, p.days - 1))}`;
      if (!events.length) return { text: `📅 ${label}: 일정이 없어요.` };
      const byDay = new Map<string, string[]>();
      for (const e of events) byDay.set(e.start.slice(0, 10), [...(byDay.get(e.start.slice(0, 10)) ?? []), eventLine(e)]);
      const blocks: unknown[] = [header(`📅 ${label} 일정 (${events.length})`)];
      for (const [day, lines] of byDay) blocks.push(section(`*${prettyKST(day)}*\n${lines.join("\n")}`));
      return { text: `${label} 일정 ${events.length}건`, blocks };
    }

    case "schedule.add": {
      if (!config.google.enabled) return { text: "📅 Google Calendar가 아직 연결되지 않았어요." };
      if (!p.date) return { text: `⚠️ 날짜 "${p.rawDate}"을(를) 이해하지 못했어요.` };
      const ev = await createTimedEvent({ summary: p.title, date: p.date, startTime: p.start, endTime: p.end, description: `Slack에서 추가 (<@${ctx.userId}>)` });
      return { inChannel: true, text: `📅 일정 추가: ${p.title} (${prettyKST(p.date)}${p.start ? ` ${p.start}` : ""})`, blocks: [section(`📅 *일정 추가됨*\n${eventLine(ev)}`)] };
    }

    case "ticket.pending": {
      const { task, reply } = await pickOne(p.keyword, "표시");
      if (reply) return reply;
      if (task!.notionUrl) return { text: `이미 Notion 티켓이 연결돼 있어요: <${task!.notionUrl}|${task!.title}> (${task!.notionStatus ?? "-"})` };
      const updated = await markPending(task!);
      return { inChannel: true, text: `🎫 티켓 발급 대기 표시: ${updated.title}`, blocks: [
        section(`🎫 *발급 대기 표시됨* (\`notion: pending\`)\n${taskLine(updated)}`),
        context("Claude Code에서 \"노션 티켓 발급\" 이라고 하면 `notion-qa-ticket` 스킬이 이 노트를 읽어 한/영 병기 티켓을 만들고 `notion: registered` + `notion-url`을 기록합니다."),
      ] };
    }

    case "ticket.status": {
      if (!config.notion.enabled) return { text: "🎫 Notion 연동이 꺼져 있어요. (NOTION_TOKEN 설정 필요)" };
      const open = await listOpenTasks();
      const r = await refreshTicketStatus(open);
      const linked = (await listOpenTasks()).filter((t) => t.notionUrl);
      const pending = open.filter((t) => t.notion === "pending");
      if (!linked.length && !pending.length) return { text: "🎫 연결된 티켓이 없어요. `/티켓 할당`으로 할당된 티켓을 가져오거나 `/티켓 발급 키워드`로 발급 대기를 표시하세요." };
      const blocks: unknown[] = [header(`🎫 내 Notion 티켓 (${linked.length})`)];
      if (linked.length) blocks.push(section(linked.map((t) => taskLine(t)).join("\n")));
      if (r.changed.length) blocks.push(section(`*🔔 방금 바뀐 상태*\n${r.changed.map((c) => `• ${c.task.title}: ${c.from ?? "-"} → ${c.to}`).join("\n")}`));
      if (r.finished.length) blocks.push(context(`✅ Notion에서 끝난 티켓 ${r.finished.length}건 — 볼트 노트는 \`/할일 완료 키워드\`로 직접 정리해 주세요 (봇은 status를 바꾸지 않습니다)`));
      if (pending.length) blocks.push(context(`🎫 발급 대기 ${pending.length}건: ${pending.map((t) => t.title).join(", ")}`));
      return { text: `내 티켓 ${linked.length}건`, blocks };
    }

    case "ticket.pull": {
      if (!config.notion.enabled) return { text: "🎫 Notion 연동이 꺼져 있어요." };
      const r = await findAssignedCandidates();
      const blocks: unknown[] = [];
      if (!r.candidates.length) {
        return { text: `📌 새로 넘어온 티켓이 없어요. (이미 볼트에 있는 티켓 ${r.skipped.length}건, 무시한 티켓 ${r.ignored}건, 댓글 스캔 ${r.commentScan.scanned}/${r.commentScan.total}건)` };
      }
      blocks.push(section(`📌 *Notion에서 나에게 넘어온 티켓* (${r.candidates.length}) — 할일로 등록할지 골라 주세요`));
      for (const c of r.candidates.slice(0, 10)) blocks.push(...candidateCard(c));
      const notes = [`이미 볼트에 있음 ${r.skipped.length}건`, `무시 ${r.ignored}건`, `댓글 스캔 ${r.commentScan.scanned}/${r.commentScan.total}건`];
      if (r.candidates.length > 10) notes.unshift(`…외 ${r.candidates.length - 10}건은 다음 실행 때`);
      blocks.push(context(notes.join(" · ")));
      return { text: `Notion 후보 ${r.candidates.length}건`, blocks };
    }
  }
}
