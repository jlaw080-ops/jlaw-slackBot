/**
 * 저녁 작업일지: 오늘 완료/진행 할일 + 오늘 일정 + 낮 동안 Slack으로 남긴 메모
 *   → 일일노트 05_Daily/YYYY-MM-DD.md 의 <!-- WORKHUB-LOG --> 마커 블록 (블록 밖은 보존) + Slack #작업일지
 */
import { config } from "./config.js";
import { listCompletedOn, listOpenTasks, obsidianUri, writeWorklogBlock, type VaultTask } from "./vault.js";
import { listEvents } from "./gcal.js";
import { dayRangeKST, prettyKST, timeKST, todayKST } from "./dates.js";
import { context, divider, header, postMessage, section, taskLine } from "./slack.js";
import { refreshTicketStatus } from "./notion-sync.js";

export interface WorklogResult {
  date: string;
  path: string;
  done: VaultTask[];
  active: VaultTask[];
  memos: string[];
  events: Array<{ when: string; summary: string }>;
  ticketChanges: Array<{ title: string; from: string | null; to: string }>;
}

export async function buildWorklog(date = todayKST()): Promise<WorklogResult> {
  const open = await listOpenTasks();
  const refreshed = await refreshTicketStatus(open).catch(() => ({ checked: 0, changed: [], finished: [] }));
  const done = await listCompletedOn(date);
  const active = open.filter((t) => t.status === "in-progress" || t.status === "review");
  const rawEvents = config.google.enabled ? await listEvents(dayRangeKST(date).timeMin, dayRangeKST(date).timeMax).catch(() => []) : [];
  const events = rawEvents.filter((e) => !e.vaultPath).map((e) => ({ when: e.allDay ? "종일" : `${timeKST(e.start)}–${timeKST(e.end)}`, summary: e.summary }));
  const ticketChanges = refreshed.changed.map((c) => ({ title: c.task.title, from: c.from, to: c.to }));
  const { path, memos } = await writeWorklogBlock({ date, done, active, events, ticketChanges });
  return { date, path, done, active, memos, events, ticketChanges };
}

export function buildWorklogBlocks(w: WorklogResult) {
  const blocks: unknown[] = [header(`🌙 ${prettyKST(w.date)} 작업일지`)];
  blocks.push(section(`*✅ 완료* (${w.done.length})\n${w.done.length ? w.done.map((t) => taskLine(t, w.date)).join("\n") : "_없음_"}`));
  blocks.push(section(`*🔄 진행 중 / 검토 중* (${w.active.length})\n${w.active.length ? w.active.map((t) => taskLine(t, w.date)).join("\n") : "_없음_"}`));
  if (w.events.length) blocks.push(section(`*📅 일정*\n${w.events.map((e) => `• ${e.when} ${e.summary}`).join("\n")}`));
  if (w.ticketChanges.length) blocks.push(section(`*🎫 Notion 티켓 상태 변화*\n${w.ticketChanges.map((c) => `• ${c.title}: ${c.from ?? "-"} → ${c.to}`).join("\n")}`));
  if (w.memos.length) blocks.push(section(`*📝 메모*\n${w.memos.map((m) => `• ${m}`).join("\n")}`));
  blocks.push(divider);
  const uri = obsidianUri(w.path);
  blocks.push(context(`${uri ? `<${uri}|일일노트 열기>` : `일일노트 \`${w.path}\``} · 메모 추가: \`/작업일지 내용\``));
  return { text: `${prettyKST(w.date)} 작업일지: 완료 ${w.done.length}건, 진행 중 ${w.active.length}건, 메모 ${w.memos.length}건`, blocks };
}

export async function runWorklog(date = todayKST()) {
  const w = await buildWorklog(date);
  const { text, blocks } = buildWorklogBlocks(w);
  const posted = await postMessage(config.slack.channelWorklog, text, blocks);
  return { ts: posted.ts, path: w.path, done: w.done.length, active: w.active.length, memos: w.memos.length };
}
