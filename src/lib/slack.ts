/**
 * Slack Web API 클라이언트 + 요청 서명 검증 + 메시지 블록 빌더
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "@vercel/node";
import { config } from "./config.js";
import { ensureOk } from "./http.js";
import { obsidianUri, type VaultTask } from "./vault.js";
import type { Ticket } from "./notion.js";
import { prettyKST, todayKST } from "./dates.js";

const API = "https://slack.com/api";

async function slackApi<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.slack.botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  await ensureOk(res, `Slack ${method}`);
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`Slack ${method} 오류: ${data.error}`);
  return data as T;
}

export async function postMessage(channel: string, text: string, blocks?: unknown[], threadTs?: string) {
  return slackApi<{ ts: string; channel: string }>("chat.postMessage", { channel, text, blocks, thread_ts: threadTs, unfurl_links: false });
}

/** 채널 + (설정돼 있으면) 나에게 DM */
export async function notifyMe(channel: string, text: string, blocks?: unknown[]) {
  const r = await postMessage(channel, text, blocks);
  if (config.slack.meUserId) await postMessage(config.slack.meUserId, text, blocks).catch(() => {});
  return r;
}

/** 슬래시 명령의 response_url로 답장 (3초 제한을 피하기 위한 비동기 응답) */
export async function respondToCommand(responseUrl: string, text: string, blocks?: unknown[], inChannel = false) {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: inChannel ? "in_channel" : "ephemeral", text, blocks, replace_original: false }),
  });
  await ensureOk(res, "Slack response_url");
}

/** Slack 요청 서명 검증 */
export function verifySlackRequest(req: VercelRequest, rawBody: string): boolean {
  const ts = String(req.headers["x-slack-request-timestamp"] ?? "");
  const sig = String(req.headers["x-slack-signature"] ?? "");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const expected = `v0=${createHmac("sha256", config.slack.signingSecret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- 블록 빌더 ----------
export const PRIORITY_ICON: Record<string, string> = { 높음: "🔴", 중간: "🟡", 낮음: "🟢", "": "⚪" };
export const STATUS_ICON: Record<string, string> = { 할일: "▫️", 진행중: "🔄", 보류: "⏸", 완료: "✅", 취소: "🚫" };
export const TICKET_ICON: Record<string, string> = {
  "시작 전": "▫️", "진행 중": "🔄", "테스트 중": "🧪", 보완검토중: "🔍", 완료: "✅", 보관: "📦", 업무제외: "🚫", "": "❔",
};

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dueLabel(due: string | null, status: string, today: string): string {
  if (!due) return "마감 없음";
  if (due < today && status !== "완료" && status !== "취소") return `⚠️ ${prettyKST(due)} 지남`;
  if (due === today) return `🎯 오늘`;
  return prettyKST(due);
}

/** 볼트 할일 한 줄 */
export function taskLine(t: VaultTask, today = todayKST()): string {
  const uri = obsidianUri(t.path);
  const title = uri ? `<${uri}|${escapeMrkdwn(t.title)}>` : `*${escapeMrkdwn(t.title)}*`;
  const tags = t.tags.length ? ` \`${t.tags.join(", ")}\`` : "";
  const ticket = t.notionTicket ? ` · <${t.notionTicket}|Notion ${TICKET_ICON[t.notionStatus ?? ""] ?? ""}${t.notionStatus ?? "티켓"}>` : "";
  return `${STATUS_ICON[t.status] ?? "▫️"} ${PRIORITY_ICON[t.priority] ?? "⚪"} ${title} · ${dueLabel(t.due, t.status, today)}${tags}${ticket}`;
}

/** Notion 티켓 한 줄 */
export function ticketLine(tk: Ticket): string {
  const who = tk.assigneeNames.filter(Boolean).join(", ");
  return `${TICKET_ICON[tk.status] ?? "❔"} ${PRIORITY_ICON[tk.priority] ?? "⚪"} <${tk.url}|${escapeMrkdwn(tk.title)}> · ${tk.status || "상태 없음"}${tk.due ? ` · ${prettyKST(tk.due)}` : ""}${who ? ` · ${who}` : ""}`;
}

export function section(text: string) { return { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }; }
export function header(text: string) { return { type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } }; }
export const divider = { type: "divider" };
export function context(text: string) { return { type: "context", elements: [{ type: "mrkdwn", text: text.slice(0, 2900) }] }; }

/** 할일 카드: 한 줄 + [완료] [진행 중] [Notion 티켓 발급] 버튼 */
export function taskCard(t: VaultTask) {
  const elements: unknown[] = [
    { type: "button", text: { type: "plain_text", text: "✅ 완료", emoji: true }, style: "primary", action_id: "task_done", value: t.id },
    { type: "button", text: { type: "plain_text", text: "🔄 진행 중", emoji: true }, action_id: "task_start", value: t.id },
  ];
  if (config.notion.enabled && !t.notionTicket) {
    elements.push({ type: "button", text: { type: "plain_text", text: "🎫 티켓 발급", emoji: true }, action_id: "task_ticket", value: t.id,
      confirm: { title: { type: "plain_text", text: "Notion 티켓 발급" }, text: { type: "mrkdwn", text: `*${escapeMrkdwn(t.title)}*\n에너빌드작업 보드에 티켓을 만들까요?` }, confirm: { type: "plain_text", text: "발급" }, deny: { type: "plain_text", text: "취소" } } });
  }
  return [section(taskLine(t)), { type: "actions", block_id: `task:${t.id}`, elements }];
}
