/**
 * Slack Web API 클라이언트 + 요청 서명 검증 + 메시지 블록 빌더
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "@vercel/node";
import { config } from "./config.js";
import { ensureOk } from "./http.js";
import type { Task } from "./notion.js";
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
  return slackApi<{ ts: string; channel: string }>("chat.postMessage", {
    channel, text, blocks, thread_ts: threadTs, unfurl_links: false,
  });
}

/** 사용자에게 DM 보내기 (없으면 채널로 대체) */
export async function postDM(userId: string | undefined, text: string, blocks?: unknown[]) {
  const target = userId || config.slack.channelWork;
  return postMessage(target, text, blocks);
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

/** Slack 요청 서명 검증 (https://api.slack.com/authentication/verifying-requests-from-slack) */
export function verifySlackRequest(req: VercelRequest, rawBody: string): boolean {
  const ts = String(req.headers["x-slack-request-timestamp"] ?? "");
  const sig = String(req.headers["x-slack-signature"] ?? "");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false; // 5분 이상 지난 요청 거부
  const base = `v0:${ts}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", config.slack.signingSecret).update(base).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 메시지 퍼머링크 (Notion "슬랙링크" 속성에 저장) */
export async function permalink(channel: string, ts: string): Promise<string | null> {
  try {
    const d = await slackApi<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts });
    return d.permalink;
  } catch {
    return null;
  }
}

// ---------- 블록 빌더 ----------
export const PRIORITY_ICON: Record<string, string> = { 높음: "🔴", 중간: "🟡", 낮음: "🟢", "": "⚪" };
export const STATUS_ICON: Record<string, string> = {
  "시작 전": "▫️", "진행 중": "🔄", "테스트 중": "🧪", 보완검토중: "🔍", 완료: "✅", 보관: "📦", 업무제외: "🚫", "": "▫️",
};

export function taskLine(t: Task, today = todayKST()): string {
  const due = t.due ? (t.due < today && t.status !== "완료" ? `⚠️ ${prettyKST(t.due)} 지남` : prettyKST(t.due)) : "마감 없음";
  const tags = t.tags.length ? ` \`${t.tags.join(", ")}\`` : "";
  return `${STATUS_ICON[t.status] ?? "▫️"} ${PRIORITY_ICON[t.priority] ?? "⚪"} <${t.url}|${escapeMrkdwn(t.title)}> · ${due}${tags}`;
}

export function section(text: string) {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } };
}
export function header(text: string) {
  return { type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } };
}
export const divider = { type: "divider" };
export function context(text: string) {
  return { type: "context", elements: [{ type: "mrkdwn", text: text.slice(0, 2900) }] };
}

/** 작업 카드: 제목 + [완료] [진행중] 버튼 */
export function taskCard(t: Task) {
  return [
    section(taskLine(t)),
    {
      type: "actions",
      block_id: `task:${t.id}`,
      elements: [
        { type: "button", text: { type: "plain_text", text: "✅ 완료", emoji: true }, style: "primary", action_id: "task_done", value: t.id },
        { type: "button", text: { type: "plain_text", text: "🔄 진행 중", emoji: true }, action_id: "task_start", value: t.id },
        { type: "button", text: { type: "plain_text", text: "📝 Notion 열기", emoji: true }, url: t.url, action_id: "task_open" },
      ],
    },
  ];
}

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
