/**
 * Slack 슬래시 명령 해석 + 실행  (창고 = Obsidian 볼트)
 *
 *  /할일 추가 제목 | 마감 | 우선순위 | 태그1,태그2   볼트에 할일 파일 생성 (+캘린더)
 *  /할일 목록 [전체|오늘|주간]                     볼트의 열린 할일
 *  /할일 완료 키워드 · /할일 시작 키워드 · /할일 보류 키워드
 *  /할일 브리핑                                    아침 브리핑 즉시 게시
 *
 *  /작업일지 메모                                  오늘 작업일지(볼트)에 한 줄 추가
 *  /작업일지 생성                                  저녁 작업일지 즉시 생성
 *
 *  /일정 오늘|내일|주간 · /일정 추가 제목 | 날짜 | 시작 | 종료
 *
 *  /티켓 발급 키워드                               볼트 할일 → Notion 티켓 발급
 *  /티켓 발급 새제목 | 마감 | 우선순위 | 태그       할일 생성과 동시에 티켓 발급
 *  /티켓 상태                                      내가 발급/할당받은 티켓 상태
 *  /티켓 할당                                      Notion에서 나에게 할당된 티켓 지금 가져오기
 */
import { config } from "./config.js";
import { addDays, dayRangeKST, parseDateInput, prettyKST, todayKST } from "./dates.js";
import { createTimedEvent, listEvents, syncTaskToCalendar } from "./gcal.js";
import { appendMemo, createTask, findTasksByKeyword, listOpenTasks, setStatus, type Priority, type VaultTask, type VaultStatus } from "./vault.js";
import { context, header, section, taskCard, taskLine } from "./slack.js";
import { runDailyBrief, eventLine } from "./brief.js";
import { runWorklog } from "./worklog.js";
import { issueTicket, pullAssignedTickets, refreshTicketStatus } from "./notion-sync.js";

export interface CommandContext { userId: string; channelId: string; permalink?: string }
export interface CommandReply { text: string; blocks?: unknown[]; inChannel?: boolean }

type AddSpec = { title: string; due: string | null; priority?: Priority; tags?: string[]; rawDue?: string };

export type Parsed =
  | ({ kind: "todo.add" } & AddSpec)
  | { kind: "todo.list"; scope: "기본" | "전체" | "오늘" | "주간" }
  | { kind: "todo.status"; keyword: string; status: VaultStatus }
  | { kind: "todo.brief" }
  | { kind: "worklog.note"; text: string }
  | { kind: "worklog.generate" }
  | { kind: "schedule.list"; days: number; from: string }
  | { kind: "schedule.add"; title: string; date: string | null; start?: string; end?: string; rawDate?: string }
  | { kind: "ticket.issue"; keyword: string }
  | ({ kind: "ticket.issueNew" } & AddSpec)
  | { kind: "ticket.status" }
  | { kind: "ticket.pull" }
  | { kind: "help"; command: string };

const PRIORITY_ALIAS: Record<string, Priority> = {
  높음: "높음", 상: "높음", high: "높음", h: "높음", "!": "높음", 급: "높음",
  중간: "중간", 중: "중간", medium: "중간", m: "중간",
  낮음: "낮음", 하: "낮음", low: "낮음", l: "낮음",
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
  const [title, dueRaw, prRaw, tagRaw] = text.split("|").map((s) => s.trim());
  if (!title) return null;
  return {
    title,
    due: dueRaw ? parseDateInput(dueRaw, today) : null,
    priority: prRaw ? PRIORITY_ALIAS[prRaw.toLowerCase()] : undefined,
    tags: tagRaw ? tagRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    rawDue: dueRaw,
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
    if (["완료", "done", "끝"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "완료" };
    if (["시작", "start", "진행"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "진행중" };
    if (["보류", "hold", "대기"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "보류" };
    if (["취소", "cancel", "삭제"].includes(sub) && rest) return { kind: "todo.status", keyword: rest, status: "취소" };
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
    if (["발급", "issue", "생성", "create"].includes(sub)) {
      if (!rest) return { kind: "help", command: "티켓" };
      if (rest.includes("|")) { const spec = parseAddSpec(rest, today)!; return { kind: "ticket.issueNew", ...spec }; }
      return { kind: "ticket.issue", keyword: rest };
    }
    if (["상태", "status", "현황", "목록"].includes(sub)) return { kind: "ticket.status" };
    if (["할당", "pull", "가져오기", "동기화"].includes(sub)) return { kind: "ticket.pull" };
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
    "*📋 /할일 — 창고는 Obsidian 볼트 `WorkHub/Tasks/`*",
    "• `/할일 추가 제목 | 마감 | 우선순위 | 태그` — 예) `/할일 추가 ZEB 검토서 작성 | 금요일 | 높음 | 리서치`",
    "   마감: 오늘·내일·모레·이번주·다음주·9/15·+3 / 우선순위: 높음·중간·낮음",
    "• `/할일 목록 [전체|오늘|주간]` — 버튼으로 완료·진행 중·티켓 발급",
    "• `/할일 완료|시작|보류|취소 키워드` — 제목 키워드로 상태 변경",
    "• `/할일 브리핑` — 아침 브리핑 지금 게시",
  ].join("\n"),
  작업일지: [
    "*📓 /작업일지 — 볼트 `WorkHub/Worklog/날짜.md`*",
    "• `/작업일지 오늘 한 일` — 오늘 작업일지 메모에 한 줄 추가 (여러 번 가능)",
    "• `/작업일지 생성` — 지금 바로 오늘 작업일지 정리 + #작업일지 게시",
  ].join("\n"),
  일정: [
    "*📅 /일정 — Google Calendar*",
    "• `/일정` · `/일정 내일` · `/일정 주간`",
    "• `/일정 추가 제목 | 날짜 | 시작 | 종료` — 예) `/일정 추가 설계협의 | 내일 | 14:00 | 15:30`",
  ].join("\n"),
  티켓: [
    "*🎫 /티켓 — Notion 에너빌드작업 보드*",
    "• `/티켓 발급 키워드` — 볼트 할일을 Notion 티켓으로 발급 (요청사항/조치내용/조치결과 양식)",
    "• `/티켓 발급 새제목 | 마감 | 우선순위 | 태그` — 할일 생성과 동시에 발급",
    "• `/티켓 상태` — 내가 발급했거나 할당받은 티켓의 진행 상태",
    "• `/티켓 할당` — Notion에서 나에게 할당된 티켓을 지금 할일로 가져오기",
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

async function addTask(spec: AddSpec, ctx: CommandContext): Promise<{ task?: VaultTask; reply?: CommandReply; calNote: string }> {
  if (spec.rawDue && !spec.due) return { reply: { text: `⚠️ 마감일 "${spec.rawDue}"을(를) 이해하지 못했어요. 예: 내일, 금요일, 9/15, 2026-09-15` }, calNote: "" };
  const task = await createTask({ title: spec.title, due: spec.due, priority: spec.priority, tags: spec.tags, source: "slack", body: ctx.permalink ? `Slack: ${ctx.permalink}\n` : "" });
  let calNote = "";
  if (config.google.enabled && task.due) {
    try { await syncTaskToCalendar(task); calNote = " · 📅 캘린더 등록"; } catch { calNote = " · ⚠️ 캘린더 등록 실패"; }
  }
  return { task, calNote };
}

export async function executeCommand(p: Parsed, ctx: CommandContext): Promise<CommandReply> {
  const today = todayKST();
  switch (p.kind) {
    case "help":
      return { text: HELP[p.command] ?? HELP.할일 };

    case "todo.add": {
      const r = await addTask(p, ctx);
      if (r.reply) return r.reply;
      return { inChannel: true, text: `✅ 할일 추가: ${r.task!.title}${r.calNote}`, blocks: [section(`✅ *할일 추가됨* → 볼트 \`${r.task!.path}\`${r.calNote}`), ...taskCard(r.task!)] };
    }

    case "todo.list": {
      const tasks = await listOpenTasks();
      const weekEnd = addDays(today, 7);
      let picked: VaultTask[]; let title: string;
      if (p.scope === "전체") { picked = tasks; title = "열린 할일 전체"; }
      else if (p.scope === "오늘") { picked = tasks.filter((t) => t.due && t.due <= today); title = "오늘 마감 + 지연"; }
      else if (p.scope === "주간") { picked = tasks.filter((t) => t.due && t.due <= weekEnd); title = "이번 주 마감 (지연 포함)"; }
      else { picked = tasks.filter((t) => (t.due && t.due <= weekEnd) || t.status === "진행중"); title = "이번 주 + 진행 중"; }
      if (!picked.length) return { text: `🎉 ${title}: 해당 할일이 없습니다.` };
      const blocks: unknown[] = [header(`📋 ${title} (${picked.length})`)];
      for (const t of picked.slice(0, 12)) blocks.push(...taskCard(t));
      if (picked.length > 12) blocks.push(context(`…외 ${picked.length - 12}건. Obsidian \`WorkHub/Tasks/\`에서 전체 보기`));
      return { text: `${title} ${picked.length}건`, blocks };
    }

    case "todo.status": {
      const { task, reply } = await pickOne(p.keyword, "처리");
      if (reply) return reply;
      const updated = await setStatus(task!, p.status);
      if (config.google.enabled) { try { await syncTaskToCalendar(updated); } catch { /* ignore */ } }
      const icon = { 완료: "✅", 진행중: "🔄", 보류: "⏸", 취소: "🚫", 할일: "▫️" }[p.status];
      return { inChannel: true, text: `${icon} ${updated.title} → ${p.status}`, blocks: [section(taskLine(updated))] };
    }

    case "todo.brief": {
      const r = await runDailyBrief();
      return { text: `☀️ 브리핑을 <#${config.slack.channelTodo}>에 게시했어요. (일정 ${r.counts.events}, 지연 ${r.counts.overdue}, 오늘 ${r.counts.today}, 새 할당 ${r.counts.newlyAssigned})` };
    }

    case "worklog.note": {
      const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      const path = await appendMemo(today, `${stamp} ${p.text}`);
      return { inChannel: true, text: `📝 작업일지 메모 추가: ${p.text}`, blocks: [section(`📝 *${prettyKST(today)} 작업일지 메모 추가*\n> ${p.text}`), context(`볼트 \`${path}\``)] };
    }

    case "worklog.generate": {
      const r = await runWorklog();
      return { text: `🌙 작업일지를 <#${config.slack.channelWorklog}>에 게시했어요. 완료 ${r.done}건, 진행 중 ${r.active}건, 메모 ${r.memos}건 · 볼트 \`${r.path}\`` };
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

    case "ticket.issue":
    case "ticket.issueNew": {
      if (!config.notion.enabled) return { text: "🎫 Notion 연동이 꺼져 있어요. (NOTION_TOKEN 설정 필요)" };
      let task: VaultTask;
      if (p.kind === "ticket.issueNew") {
        const r = await addTask(p, ctx);
        if (r.reply) return r.reply;
        task = r.task!;
      } else {
        const r = await pickOne(p.keyword, "발급");
        if (r.reply) return r.reply;
        task = r.task!;
        if (task.notionTicket) return { text: `이미 티켓이 있어요: <${task.notionTicket}|${task.title}> (${task.notionStatus ?? "-"})` };
      }
      const { task: linked, ticket } = await issueTicket(task, { slackLink: ctx.permalink });
      return { inChannel: true, text: `🎫 Notion 티켓 발급: ${ticket.title}`, blocks: [section(`🎫 *Notion 티켓 발급됨* → <${ticket.url}|열기>`), ...taskCard(linked)] };
    }

    case "ticket.status": {
      if (!config.notion.enabled) return { text: "🎫 Notion 연동이 꺼져 있어요." };
      const open = await listOpenTasks();
      const r = await refreshTicketStatus(open);
      const linked = (await listOpenTasks()).filter((t) => t.notionTicket);
      if (!linked.length && !r.completed.length) return { text: "🎫 연결된 티켓이 없어요. `/티켓 발급 키워드` 또는 `/티켓 할당`을 써 보세요." };
      const blocks: unknown[] = [header(`🎫 내 Notion 티켓 (${linked.length})`)];
      if (linked.length) blocks.push(section(linked.map((t) => taskLine(t)).join("\n")));
      if (r.changed.length) blocks.push(section(`*🔔 방금 바뀐 상태*\n${r.changed.map((c) => `• ${c.task.title}: ${c.from ?? "-"} → ${c.to}`).join("\n")}`));
      if (r.completed.length) blocks.push(context(`✅ Notion에서 끝난 티켓 ${r.completed.length}건은 볼트에서도 완료 처리했어요.`));
      return { text: `내 티켓 ${linked.length}건`, blocks };
    }

    case "ticket.pull": {
      if (!config.notion.enabled) return { text: "🎫 Notion 연동이 꺼져 있어요." };
      const r = await pullAssignedTickets({ notify: false });
      if (!r.registered.length) return { text: `📌 새로 할당된 티켓이 없어요. (이미 연결된 티켓 ${r.alreadyLinked}건)` };
      return { inChannel: true, text: `📌 할당된 티켓 ${r.registered.length}건을 할일로 등록했어요`, blocks: [section(`📌 *Notion 할당 → 할일 등록* (${r.registered.length})`), ...r.registered.flatMap(taskCard)] };
    }
  }
}
