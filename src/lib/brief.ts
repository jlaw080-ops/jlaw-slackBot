/**
 * 아침 브리핑: 오늘 일정 + 지연/오늘/이번주 할일 + 진행 중 작업 → Slack #할일
 */
import { config } from "./config.js";
import { listMyOpenTasks, type Task } from "./notion.js";
import { listEvents, syncTaskToCalendar, type CalEvent } from "./gcal.js";
import { addDays, dayRangeKST, prettyKST, timeKST, todayKST } from "./dates.js";
import { context, divider, header, postMessage, section, taskLine } from "./slack.js";

export interface BriefData {
  date: string;
  events: CalEvent[];
  overdue: Task[];
  today: Task[];
  week: Task[];
  inProgress: Task[];
  noDue: Task[];
}

export async function collectBrief(date = todayKST()): Promise<BriefData> {
  const tasks = await listMyOpenTasks();
  const weekEnd = addDays(date, 7);
  const events = config.google.enabled
    ? await listEvents(dayRangeKST(date).timeMin, dayRangeKST(date).timeMax).catch(() => [])
    : [];
  return {
    date,
    events: events.filter((e) => !e.notionPageId), // 할일에서 만든 종일 일정은 제외(중복 방지)
    overdue: tasks.filter((t) => t.due && t.due < date),
    today: tasks.filter((t) => t.due === date),
    week: tasks.filter((t) => t.due && t.due > date && t.due <= weekEnd),
    inProgress: tasks.filter((t) => (t.status === "진행 중" || t.status === "테스트 중") && (!t.due || t.due > weekEnd)),
    noDue: tasks.filter((t) => !t.due && t.status !== "진행 중" && t.status !== "테스트 중"),
  };
}

export function eventLine(e: CalEvent): string {
  const when = e.allDay ? "종일" : `${timeKST(e.start)}–${timeKST(e.end)}`;
  const where = e.location ? ` @ ${e.location}` : "";
  return `🗓 ${when} · <${e.htmlLink}|${e.summary}>${where}`;
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
  if (b.noDue.length) blocks.push(context(`▫️ 마감 없는 대기 할일 ${b.noDue.length}건 — \`/할일 목록 전체\`로 확인`));
  blocks.push(divider);
  blocks.push(context("`/할일 추가 제목 | 마감 | 우선순위` · `/할일 완료 키워드` · `/일정 오늘` · `/작업일지 오늘 한 일`"));

  const total = b.overdue.length + b.today.length;
  const text = `${prettyKST(b.date)} 브리핑: 일정 ${b.events.length}건, 마감지남 ${b.overdue.length}, 오늘마감 ${b.today.length}, 이번주 ${b.week.length}`;
  void total;
  return { text, blocks };
}

/** 브리핑 게시 + 캘린더 동기화 */
export async function runDailyBrief(date = todayKST()) {
  const data = await collectBrief(date);
  const { text, blocks } = buildBriefBlocks(data);
  const posted = await postMessage(config.slack.channelTodo, text, blocks);

  let calendar: Record<string, number> = {};
  if (config.google.enabled) {
    calendar = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 };
    const all = [...data.overdue, ...data.today, ...data.week];
    for (const t of all) {
      try { calendar[await syncTaskToCalendar(t)]++; } catch { calendar.failed++; }
    }
  }
  return { ts: posted.ts, counts: { events: data.events.length, overdue: data.overdue.length, today: data.today.length, week: data.week.length }, calendar };
}
