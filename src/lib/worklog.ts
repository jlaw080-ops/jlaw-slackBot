/**
 * 저녁 작업일지: 오늘 완료/진행 작업 + 오늘 일정 + 낮 동안 Slack으로 남긴 메모
 *   → Notion 작업일지 DB + Obsidian 볼트(Worklog/YYYY-MM-DD.md) + Slack #작업일지
 */
import { config } from "./config.js";
import { findWorklogByDate, listMyOpenTasks, listTasksCompletedOn, upsertWorklog, type Task } from "./notion.js";
import { listEvents, type CalEvent } from "./gcal.js";
import { dayRangeKST, prettyKST, timeKST, todayKST } from "./dates.js";
import { context, divider, header, postMessage, section, taskLine } from "./slack.js";
import { writeWorklogNote } from "./obsidian.js";

export interface WorklogData {
  date: string;
  done: Task[];
  active: Task[];
  events: CalEvent[];
  notes: string; // Slack `/작업일지 ...`로 낮 동안 쌓인 메모
}

export async function collectWorklog(date = todayKST()): Promise<WorklogData> {
  const [done, open, existing] = await Promise.all([
    listTasksCompletedOn(date),
    listMyOpenTasks(),
    findWorklogByDate(date),
  ]);
  const events = config.google.enabled
    ? await listEvents(dayRangeKST(date).timeMin, dayRangeKST(date).timeMax).catch(() => [])
    : [];
  return {
    date,
    done,
    active: open.filter((t) => t.status === "진행 중" || t.status === "테스트 중"),
    events: events.filter((e) => !e.notionPageId),
    notes: existing?.summary ?? "",
  };
}

export function renderWorklogMarkdown(w: WorklogData, notionUrl?: string): string {
  const lines: string[] = [
    "---",
    `date: ${w.date}`,
    `type: worklog`,
    `done: ${w.done.length}`,
    `active: ${w.active.length}`,
    ...(notionUrl ? [`notion: "${notionUrl}"`] : []),
    "tags: [worklog]",
    "---",
    "",
    `# ${w.date} 작업일지`,
    "",
    "## ✅ 완료한 작업",
    ...(w.done.length ? w.done.map((t) => `- [x] [${t.title}](${t.url})${t.tags.length ? ` #${t.tags.join(" #")}` : ""}`) : ["- (없음)"]),
    "",
    "## 🔄 진행 중",
    ...(w.active.length ? w.active.map((t) => `- [ ] [${t.title}](${t.url})${t.due ? ` ⏳ ${t.due}` : ""}`) : ["- (없음)"]),
    "",
    "## 📅 일정",
    ...(w.events.length ? w.events.map((e) => `- ${e.allDay ? "종일" : `${timeKST(e.start)}–${timeKST(e.end)}`} ${e.summary}`) : ["- (없음)"]),
    "",
    "## 📝 메모",
    ...(w.notes ? w.notes.split("\n").map((l) => `- ${l}`) : ["- "]),
    "",
  ];
  return lines.join("\n");
}

export function buildWorklogBlocks(w: WorklogData, notionUrl: string, vaultPath?: string) {
  const blocks: unknown[] = [header(`🌙 ${prettyKST(w.date)} 작업일지`)];
  blocks.push(section(`*✅ 완료* (${w.done.length})\n${w.done.length ? w.done.map((t) => taskLine(t, w.date)).join("\n") : "_없음_"}`));
  blocks.push(section(`*🔄 진행 중* (${w.active.length})\n${w.active.length ? w.active.map((t) => taskLine(t, w.date)).join("\n") : "_없음_"}`));
  if (w.notes) blocks.push(section(`*📝 메모*\n${w.notes}`));
  blocks.push(divider);
  blocks.push(context(`<${notionUrl}|Notion 작업일지>${vaultPath ? ` · Obsidian: \`${vaultPath}\`` : ""} · 메모 추가: \`/작업일지 내용\``));
  const text = `${prettyKST(w.date)} 작업일지: 완료 ${w.done.length}건, 진행 중 ${w.active.length}건`;
  return { text, blocks };
}

export async function runWorklog(date = todayKST()) {
  const data = await collectWorklog(date);
  const page = await upsertWorklog({
    date,
    doneTaskIds: data.done.map((t) => t.id),
    activeTaskIds: data.active.map((t) => t.id),
    source: "자동",
    bodyMarkdownLines: renderWorklogMarkdown(data).split("\n").filter((l) => l && !l.startsWith("---") && !/^(date|type|done|active|tags):/.test(l)),
  });
  let vaultPath: string | undefined;
  if (config.obsidian.enabled) {
    vaultPath = await writeWorklogNote(date, renderWorklogMarkdown(data, page.url));
    await upsertWorklog({ date, obsidianPath: vaultPath });
  }
  const { text, blocks } = buildWorklogBlocks(data, page.url, vaultPath);
  const posted = await postMessage(config.slack.channelWorklog, text, blocks);
  return { ts: posted.ts, notionUrl: page.url, vaultPath, done: data.done.length, active: data.active.length };
}
