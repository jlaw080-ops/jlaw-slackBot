/**
 * 아침 브리핑: 오늘 일정 + 지연/오늘/이번주 할일 + 진행 중 + Notion 티켓 현황 → Slack #할일
 */
import { config } from "./config.js";
import { listOpenTasks, type VaultTask } from "./vault.js";
import { listEvents, syncTaskToCalendar, type CalEvent } from "./gcal.js";
import { addDays, dayRangeKST, prettyKST, timeKST, todayKST } from "./dates.js";
import { context, divider, header, postMessage, section, taskLine } from "./slack.js";
import { pullAssignedTickets, refreshTicketStatus } from "./notion-sync.js";

export interface BriefData {
  date: string;
  events: CalEvent[];
  overdue: VaultTask[];
  today: VaultTask[];
  week: VaultTask[];
  inProgress: VaultTask[];
  rest: VaultTask[];
  newlyAssigned: VaultTask[];
  ticketChanges: Array<{ task: VaultTask; from: string | null; to: string }>;
}

export function eventLine(e: CalEvent): string {
  const when = e.allDay ? "종일" : `${timeKST(e.start)}–${timeKST(e.end)}`;
  return `🗓 ${when} · <${e.htmlLink}|${e.summary}>${e.location ? ` @ ${e.location}` : ""}`;
}

export async function collectBrief(date = todayKST()): Promise<BriefData> {
  // 1) Notion 접점: 새로 할당된 티켓 가져오기 + 연결된 티켓 상태 갱신 (브리핑 안에서 알림)
  const pulled = await pullAssignedTickets({ notify: false }).catch(() => ({ registered: [], alreadyLinked: 0 }));
  const refreshed = await refreshTicketStatus().catch(() => ({ checked: 0, changed: [], completed: [] }));

  // 2) 창고(볼트)에서 열린 할일
  const tasks = await listOpenTasks();
  const weekEnd = addDays(date, 7);
  const events = config.google.enabled ? await listEvents(dayRangeKST(date).timeMin, dayRangeKST(date).timeMax).catch(() => []) : [];
  const active = (t: VaultTask) => t.status === "진행중";
  return {
    date,
    events: events.filter((e) => !e.vaultTaskId),
    overdue: tasks.filter((t) => t.due && t.due < date),
    today: tasks.filter((t) => t.due === date),
    week: tasks.filter((t) => t.due && t.due > date && t.due <= weekEnd),
    inProgress: tasks.filter((t) => active(t) && (!t.due || t.due > weekEnd)),
    rest: tasks.filter((t) => !active(t) && (!t.due || t.due > weekEnd)),
    newlyAssigned: pulled.registered,
    ticketChanges: refreshed.changed,
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
  list("🔄 진행 중 (마감 미정/이후)", b.inProgress.map((t) => taskLine(t, b.date)));
  if (b.rest.length) blocks.push(context(`▫️ 그 외 대기 할일 ${b.rest.length}건 — \`/할일 목록 전체\``));
  if (b.newlyAssigned.length || b.ticketChanges.length) {
    blocks.push(divider);
    list("📌 Notion에서 새로 할당된 티켓 → 할일 등록", b.newlyAssigned.map((t) => taskLine(t, b.date)));
    list("🎫 내 티켓 상태 변경", b.ticketChanges.map((c) => `${taskLine(c.task, b.date)}  _(${c.from ?? "-"} → ${c.to})_`));
  }
  blocks.push(divider);
  blocks.push(context("`/할일 추가 제목 | 마감 | 우선순위` · `/할일 목록` · `/티켓 상태` · `/일정 오늘` · `/작업일지 메모`"));
  const text = `${prettyKST(b.date)} 브리핑: 일정 ${b.events.length}, 지연 ${b.overdue.length}, 오늘 ${b.today.length}, 이번주 ${b.week.length}, 새 할당 ${b.newlyAssigned.length}`;
  return { text, blocks };
}

/** 브리핑 게시 + 캘린더 동기화 */
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
    counts: { events: data.events.length, overdue: data.overdue.length, today: data.today.length, week: data.week.length, newlyAssigned: data.newlyAssigned.length, ticketChanges: data.ticketChanges.length },
    calendar,
  };
}
