/**
 * Slack 슬래시 명령 해석 + 실행
 *
 *  /할일 추가 제목 | 마감 | 우선순위 | 태그1,태그2
 *  /할일 목록 [전체|오늘|주간]
 *  /할일 완료 키워드         (제목에 키워드가 들어간 미완료 작업을 완료 처리)
 *  /할일 시작 키워드         (진행 중으로 변경)
 *  /할일 브리핑              (아침 브리핑 즉시 게시)
 *  /할일 동기화              (Obsidian 볼트 + 캘린더 동기화 즉시 실행)
 *  /작업일지 오늘 한 일 메모  (오늘 작업일지 요약에 한 줄 추가)
 *  /작업일지 생성            (저녁 작업일지 즉시 생성)
 *  /일정 오늘|내일|주간
 *  /일정 추가 제목 | 날짜 | 시작 | 종료
 */
import { config } from "./config.js";
import { addDays, dayRangeKST, parseDateInput, prettyKST, todayKST } from "./dates.js";
import { createTimedEvent, listEvents, syncTaskToCalendar } from "./gcal.js";
import { createTask, findTasksByTitle, listMyOpenTasks, updateTask, upsertWorklog, type Priority, type Task } from "./notion.js";
import { context, divider, header, section, taskCard, taskLine } from "./slack.js";
import { runDailyBrief } from "./brief.js";
import { runWorklog } from "./worklog.js";
import { syncVault } from "./obsidian.js";
import { eventLine } from "./brief.js";

export interface CommandContext {
  userId: string;       // Slack 사용자 ID
  channelId: string;
  permalink?: string;   // 명령을 친 채널 링크 (Notion 슬랙링크에 저장)
}

export interface CommandReply {
  text: string;
  blocks?: unknown[];
  inChannel?: boolean;
}

export type Parsed =
  | { kind: "todo.add"; title: string; due: string | null; priority?: Priority; tags?: string[]; rawDue?: string }
  | { kind: "todo.list"; scope: "기본" | "전체" | "오늘" | "주간" }
  | { kind: "todo.done"; keyword: string }
  | { kind: "todo.start"; keyword: string }
  | { kind: "todo.brief" }
  | { kind: "todo.sync" }
  | { kind: "worklog.note"; text: string }
  | { kind: "worklog.generate" }
  | { kind: "schedule.list"; days: number; from: string }
  | { kind: "schedule.add"; title: string; date: string | null; start?: string; end?: string; rawDate?: string }
  | { kind: "help"; command: string };

const PRIORITY_ALIAS: Record<string, Priority> = {
  높음: "높음", 상: "높음", high: "높음", h: "높음", "!": "높음", 급: "높음",
  중간: "중간", 중: "중간", medium: "중간", m: "중간",
  낮음: "낮음", 하: "낮음", low: "낮음", l: "낮음",
};

export function normalizeCommand(command: string): "할일" | "작업일지" | "일정" | "unknown" {
  const c = command.replace(/^\//, "").toLowerCase();
  if (["할일", "todo", "task", "work"].includes(c)) return "할일";
  if (["작업일지", "worklog", "log"].includes(c)) return "작업일지";
  if (["일정", "schedule", "cal"].includes(c)) return "일정";
  return "unknown";
}

export function parseCommand(command: string, text: string, today = todayKST()): Parsed {
  const kind = normalizeCommand(command);
  const raw = (text ?? "").trim();
  const [first, ...restArr] = raw.split(/\s+/);
  const rest = restArr.join(" ").trim();
  const sub = (first ?? "").toLowerCase();

  if (kind === "할일") {
    if (!raw || sub === "도움말" || sub === "help") return { kind: "help", command: "할일" };
    if (["추가", "add", "new", "생성"].includes(sub)) {
      const [title, dueRaw, prRaw, tagRaw] = rest.split("|").map((s) => s.trim());
      if (!title) return { kind: "help", command: "할일" };
      const due = dueRaw ? parseDateInput(dueRaw, today) : null;
      const priority = prRaw ? PRIORITY_ALIAS[prRaw.toLowerCase()] : undefined;
      const tags = tagRaw ? tagRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      return { kind: "todo.add", title, due, priority, tags, rawDue: dueRaw };
    }
    if (["목록", "list", "ls", "보기"].includes(sub)) {
      const scope = (["전체", "오늘", "주간"].find((s) => rest.startsWith(s)) ?? "기본") as "기본" | "전체" | "오늘" | "주간";
      return { kind: "todo.list", scope };
    }
    if (["완료", "done", "끝"].includes(sub) && rest) return { kind: "todo.done", keyword: rest };
    if (["시작", "start", "진행"].includes(sub) && rest) return { kind: "todo.start", keyword: rest };
    if (["브리핑", "brief"].includes(sub)) return { kind: "todo.brief" };
    if (["동기화", "sync"].includes(sub)) return { kind: "todo.sync" };
    // 하위 명령 없이 바로 제목을 쓰면 "추가"로 간주
    const [title, dueRaw, prRaw, tagRaw] = raw.split("|").map((s) => s.trim());
    return {
      kind: "todo.add", title,
      due: dueRaw ? parseDateInput(dueRaw, today) : null,
      priority: prRaw ? PRIORITY_ALIAS[prRaw.toLowerCase()] : undefined,
      tags: tagRaw ? tagRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      rawDue: dueRaw,
    };
  }

  if (kind === "작업일지") {
    if (!raw || sub === "도움말" || sub === "help") return { kind: "help", command: "작업일지" };
    if (["생성", "generate", "마감", "정리"].includes(sub)) return { kind: "worklog.generate" };
    return { kind: "worklog.note", text: raw };
  }

  if (kind === "일정") {
    if (!raw || sub === "도움말" || sub === "help") return { kind: "help", command: "일정" };
    if (["추가", "add", "new"].includes(sub)) {
      const [title, dateRaw, start, end] = rest.split("|").map((s) => s.trim());
      if (!title) return { kind: "help", command: "일정" };
      return { kind: "schedule.add", title, date: dateRaw ? parseDateInput(dateRaw, today) : today, start: normTime(start), end: normTime(end), rawDate: dateRaw };
    }
    if (sub === "내일") return { kind: "schedule.list", days: 1, from: addDays(today, 1) };
    if (["주간", "이번주", "week"].includes(sub)) return { kind: "schedule.list", days: 7, from: today };
    return { kind: "schedule.list", days: 1, from: today };
  }

  return { kind: "help", command: "할일" };
}

function normTime(s?: string): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2] ?? "00"}`;
}

export const HELP: Record<string, string> = {
  할일: [
    "*📋 /할일 사용법*",
    "• `/할일 추가 제목 | 마감 | 우선순위 | 태그` — 예) `/할일 추가 ZEB 검토서 작성 | 금요일 | 높음 | 리서치`",
    "   마감: 오늘·내일·모레·이번주·다음주·9/15·+3 / 우선순위: 높음·중간·낮음",
    "• `/할일 목록 [전체|오늘|주간]` — 내 할일 보기 (버튼으로 완료/시작 처리)",
    "• `/할일 완료 키워드` / `/할일 시작 키워드` — 제목 키워드로 상태 변경",
    "• `/할일 브리핑` — 아침 브리핑 지금 게시  •  `/할일 동기화` — Obsidian·캘린더 동기화",
  ].join("\n"),
  작업일지: [
    "*📓 /작업일지 사용법*",
    "• `/작업일지 오늘 한 일 메모` — 오늘 작업일지에 한 줄 추가 (여러 번 가능)",
    "• `/작업일지 생성` — 지금 바로 오늘 작업일지 정리 (Notion + Obsidian + #작업일지)",
  ].join("\n"),
  일정: [
    "*📅 /일정 사용법*",
    "• `/일정` 또는 `/일정 오늘` · `/일정 내일` · `/일정 주간`",
    "• `/일정 추가 제목 | 날짜 | 시작 | 종료` — 예) `/일정 추가 설계협의 | 내일 | 14:00 | 15:30`",
  ].join("\n"),
};

export async function executeCommand(p: Parsed, ctx: CommandContext): Promise<CommandReply> {
  const today = todayKST();
  switch (p.kind) {
    case "help":
      return { text: HELP[p.command] ?? HELP.할일 };

    case "todo.add": {
      if (p.rawDue && !p.due) return { text: `⚠️ 마감일 "${p.rawDue}"을(를) 이해하지 못했어요. 예: 내일, 금요일, 9/15, 2026-09-15` };
      const task = await createTask({ title: p.title, due: p.due, priority: p.priority, tags: p.tags, slackLink: ctx.permalink });
      let calNote = "";
      if (config.google.enabled && task.due) {
        try { await syncTaskToCalendar(task); calNote = " · 📅 캘린더 등록"; } catch { calNote = " · ⚠️ 캘린더 등록 실패"; }
      }
      return { inChannel: true, text: `✅ 할일 추가: ${task.title}${calNote}`, blocks: [section(`✅ *할일 추가됨*${calNote}`), ...taskCard(task)] };
    }

    case "todo.list": {
      const tasks = await listMyOpenTasks();
      const weekEnd = addDays(today, 7);
      let picked: Task[];
      let title: string;
      if (p.scope === "전체") { picked = tasks; title = "내 미완료 할일 전체"; }
      else if (p.scope === "오늘") { picked = tasks.filter((t) => t.due && t.due <= today); title = "오늘 마감 + 지연"; }
      else if (p.scope === "주간") { picked = tasks.filter((t) => t.due && t.due <= weekEnd); title = "이번 주 마감 (지연 포함)"; }
      else { picked = tasks.filter((t) => (t.due && t.due <= weekEnd) || t.status === "진행 중" || t.status === "테스트 중"); title = "이번 주 + 진행 중"; }
      if (!picked.length) return { text: `🎉 ${title}: 해당 할일이 없습니다.` };
      const blocks: unknown[] = [header(`📋 ${title} (${picked.length})`)];
      for (const t of picked.slice(0, 12)) blocks.push(...taskCard(t));
      if (picked.length > 12) blocks.push(context(`…외 ${picked.length - 12}건. Notion에서 전체 보기`));
      return { text: `${title} ${picked.length}건`, blocks };
    }

    case "todo.done":
    case "todo.start": {
      const status = p.kind === "todo.done" ? "완료" : "진행 중";
      const found = await findTasksByTitle(p.keyword);
      if (!found.length) return { text: `🔍 "${p.keyword}" 키워드의 미완료 할일을 찾지 못했어요.` };
      if (found.length > 1) {
        return {
          text: `여러 개가 검색됐어요. 버튼으로 선택해 주세요.`,
          blocks: [section(`🔍 *"${p.keyword}"* 검색 결과 ${found.length}건 — 버튼으로 처리하세요`), ...found.slice(0, 5).flatMap(taskCard)],
        };
      }
      const updated = await updateTask(found[0].id, { status });
      if (config.google.enabled) { try { await syncTaskToCalendar(updated); } catch { /* 캘린더 실패는 무시 */ } }
      return { inChannel: true, text: `${status === "완료" ? "✅" : "🔄"} ${updated.title} → ${status}`, blocks: [section(taskLine(updated))] };
    }

    case "todo.brief": {
      const r = await runDailyBrief();
      return { text: `☀️ 브리핑을 <#${config.slack.channelTodo}>에 게시했어요. (일정 ${r.counts.events}, 지연 ${r.counts.overdue}, 오늘 ${r.counts.today})` };
    }

    case "todo.sync": {
      const lines: string[] = [];
      if (config.obsidian.enabled) {
        const r = await syncVault({ sinceIso: new Date(Date.now() - 24 * 3600e3).toISOString() });
        lines.push(`🗂 Obsidian: 볼트에 ${r.toVault.written}개 갱신, Inbox→Notion ${r.fromInbox.length}건, 상태 반영 ${r.statusPushed.length}건`);
        if (r.errors.length) lines.push(`⚠️ ${r.errors.slice(0, 3).join(" / ")}`);
      } else lines.push("🗂 Obsidian 동기화 비활성 (OBSIDIAN_REPO·GITHUB_TOKEN 설정 필요)");
      if (config.google.enabled) {
        const tasks = (await listMyOpenTasks()).filter((t) => t.due);
        const c = { created: 0, updated: 0, deleted: 0, skipped: 0 };
        for (const t of tasks) { try { c[await syncTaskToCalendar(t)]++; } catch { /* skip */ } }
        lines.push(`📅 캘린더: 생성 ${c.created}, 갱신 ${c.updated}, 삭제 ${c.deleted}`);
      } else lines.push("📅 캘린더 동기화 비활성 (GOOGLE_SERVICE_ACCOUNT_JSON 설정 필요)");
      return { text: lines.join("\n") };
    }

    case "worklog.note": {
      const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      const w = await upsertWorklog({ date: today, summary: `[${stamp}] ${p.text}`, source: "Slack" });
      return { inChannel: true, text: `📝 작업일지에 추가: ${p.text}`, blocks: [section(`📝 *${prettyKST(today)} 작업일지 메모 추가*\n> ${p.text}`), context(`<${w.url}|Notion 작업일지 열기>`)] };
    }

    case "worklog.generate": {
      const r = await runWorklog();
      return { text: `🌙 작업일지를 <#${config.slack.channelWorklog}>에 게시했어요. 완료 ${r.done}건, 진행 중 ${r.active}건 · <${r.notionUrl}|Notion>` };
    }

    case "schedule.list": {
      if (!config.google.enabled) return { text: "📅 Google Calendar가 아직 연결되지 않았어요. (GOOGLE_SERVICE_ACCOUNT_JSON 설정 필요)" };
      const { timeMin, timeMax } = dayRangeKST(p.from, p.days);
      const events = await listEvents(timeMin, timeMax);
      const label = p.days === 1 ? prettyKST(p.from) : `${prettyKST(p.from)} ~ ${prettyKST(addDays(p.from, p.days - 1))}`;
      if (!events.length) return { text: `📅 ${label}: 일정이 없어요.` };
      const byDay = new Map<string, string[]>();
      for (const e of events) {
        const day = e.start.slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), eventLine(e)]);
      }
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
  }
}

export const helpDivider = divider;
