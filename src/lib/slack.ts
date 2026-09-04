/**
 * Slack Web API 클라이언트 + 요청 서명 검증 + 메시지 블록 빌더
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "@vercel/node";
import { config } from "./config.js";
import { ensureOk } from "./http.js";
import { obsidianUri, PRIORITY_KO, STATUS_KO, type VaultTask } from "./vault.js";
import type { Ticket } from "./notion.js";
import type { Candidate } from "./notion-sync.js";
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

/** 메시지 영구 링크 (실패하면 null — 권한이 없어도 동작은 계속) */
export async function getPermalink(channel: string, messageTs: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(messageTs)}`, {
      headers: { Authorization: `Bearer ${config.slack.botToken}` },
    });
    const d = (await res.json()) as any;
    return d.ok ? (d.permalink as string) : null;
  } catch {
    return null;
  }
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

export type VerifyReason = "ok" | "서명키 미설정" | "서명 헤더 없음" | "시각 불일치" | "본문 비어 있음" | "서명 불일치";

/**
 * Slack 요청 서명 검증.
 * 실패해도 이유를 돌려주어 Slack 화면에 무엇이 잘못됐는지 보여줄 수 있게 합니다.
 * (검증 실패 시 명령은 실행하지 않습니다 — 이유만 알려 줍니다.)
 */
export function verifySlackRequest(req: VercelRequest, rawBody: string): { ok: boolean; reason: VerifyReason } {
  let secret: string;
  try {
    secret = config.slack.signingSecret;
  } catch {
    return { ok: false, reason: "서명키 미설정" };
  }
  const ts = String(req.headers["x-slack-request-timestamp"] ?? "");
  const sig = String(req.headers["x-slack-signature"] ?? "");
  if (!ts || !sig) return { ok: false, reason: "서명 헤더 없음" };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return { ok: false, reason: "시각 불일치" };
  if (!rawBody) return { ok: false, reason: "본문 비어 있음" };
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(sig);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { ok: true, reason: "ok" } : { ok: false, reason: "서명 불일치" };
}

/** 서명 검증 실패를 Slack 화면에 그대로 보여 줍니다 (원인 파악용) */
export function verifyFailureMessage(reason: VerifyReason, bodySource: string): string {
  const guide: Record<string, string> = {
    "서명키 미설정": "Vercel 환경변수에 `SLACK_SIGNING_SECRET` 이 없습니다. 넣고 Redeploy 하세요.",
    "서명 헤더 없음": "Slack이 보낸 요청이 아닙니다.",
    "시각 불일치": "서버 시계와 Slack의 시각 차이가 5분을 넘습니다.",
    "본문 비어 있음": "요청 본문을 읽지 못했습니다. Vercel 런타임 문제일 수 있습니다.",
    "서명 불일치": "Vercel의 `SLACK_SIGNING_SECRET` 이 **이 앱**의 Signing Secret과 다릅니다. Slack 앱이 여러 개면 명령이 등록된 앱의 값을 써야 합니다. 값을 고친 뒤 반드시 Redeploy 하세요.",
  };
  return `⚠️ Slack 서명 검증 실패 — *${reason}*\n${guide[reason] ?? ""}\n\n_진단: 본문 획득 방식 ${bodySource}_`;
}

// ---------- 블록 빌더 ----------
export const PRIORITY_ICON: Record<string, string> = { high: "🔴", mid: "🟡", low: "🟢", "": "⚪" };
export const STATUS_ICON: Record<string, string> = { planned: "▫️", "in-progress": "🔄", review: "🔍", done: "✅", backlog: "📥" };
export const TICKET_ICON: Record<string, string> = {
  "시작 전": "▫️", "진행 중": "🔄", "테스트 중": "🧪", 보완검토중: "🔍", 완료: "✅", 보관: "📦", 업무제외: "🚫", "": "❔",
};

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dueLabel(due: string | null, status: string, today: string): string {
  if (!due) return "";
  if (due < today && status !== "done") return ` · ⚠️ ${prettyKST(due)} 지남`;
  if (due === today) return " · 🎯 오늘";
  return ` · ${prettyKST(due)}`;
}

/** 볼트 할일 한 줄 */
export function taskLine(t: VaultTask, today = todayKST()): string {
  const uri = obsidianUri(t.path);
  const title = uri ? `<${uri}|${escapeMrkdwn(t.title)}>` : `*${escapeMrkdwn(t.title)}*`;
  const proj = t.project ? ` · \`${t.project}\`` : "";
  const notion = t.notionUrl
    ? ` · <${t.notionUrl}|Notion ${TICKET_ICON[t.notionStatus ?? ""] ?? ""}${t.notionStatus ?? ""}>`
    : t.notion === "pending" ? " · 🎫 발급 대기" : "";
  return `${STATUS_ICON[t.status] ?? "▫️"} ${PRIORITY_ICON[t.priority] ?? "⚪"} ${title}${dueLabel(t.due, t.status, today)}${proj}${notion}`;
}

export function ticketLine(tk: Ticket): string {
  const who = tk.assigneeNames.filter(Boolean).join(", ");
  return `${TICKET_ICON[tk.status] ?? "❔"} <${tk.url}|${escapeMrkdwn(tk.title)}> · ${tk.status || "-"}${tk.priority ? ` · ${tk.priority}` : ""}${tk.due ? ` · ${prettyKST(tk.due)}` : ""}${who ? ` · ${who}` : ""}`;
}

export function section(text: string) { return { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }; }
export function header(text: string) { return { type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } }; }
export const divider = { type: "divider" };
export function context(text: string) { return { type: "context", elements: [{ type: "mrkdwn", text: text.slice(0, 2900) }] }; }
const btn = (text: string, action_id: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ type: "button", text: { type: "plain_text", text, emoji: true }, action_id, value: value.slice(0, 2000), ...extra });

/** 할일 카드: 한 줄 + [완료] [진행 중] [티켓 발급 대기] 버튼 (버튼 값 = 노트 경로) */
export function taskCard(t: VaultTask) {
  const elements: unknown[] = [
    btn("✅ 완료", "task_done", t.path, { style: "primary" }),
    btn("🔄 진행 중", "task_start", t.path),
  ];
  if (config.notion.enabled && !t.notionUrl && t.notion !== "pending") elements.push(btn("🎫 티켓 발급 대기", "task_ticket", t.path));
  return [section(taskLine(t)), { type: "actions", block_id: `task:${t.path.slice(0, 200)}`, elements }];
}

/** Notion 할당 후보 카드: [할일로 등록] [무시] — notion-todo-sync Step 5의 "확인"을 Slack 버튼으로 */
export function candidateCard(c: Candidate) {
  const reason = c.reason === "mentioned"
    ? `댓글 멘션 (${c.mention?.date.slice(5).replace("-", "/") ?? ""}, ${c.mention?.author ?? ""}) — "${escapeMrkdwn(c.mention?.comment ?? "")}"`
    : "담당자 지정";
  const value = JSON.stringify({ id: c.ticket.id, reason, r: c.reason, m: c.mention ?? null });
  return [
    section(`${ticketLine(c.ticket)}\n_할당 근거: ${reason}_`),
    { type: "actions", block_id: `cand:${c.ticket.id}`, elements: [
      btn("📥 할일로 등록", "cand_register", value, { style: "primary" }),
      btn("🙈 무시", "cand_ignore", value),
    ] },
  ];
}

/** project 선택 카드 (todo-capture Step 4: project를 못 정하면 묻는다) */
export function projectPicker(spec: Record<string, unknown>, projects: readonly string[]) {
  return [
    section(`🏷 *어느 프로젝트의 할일인가요?* — "${escapeMrkdwn(String(spec.title ?? ""))}"`),
    { type: "actions", block_id: "pick_project", elements: projects.slice(0, 5).map((p) => btn(p, "task_project", JSON.stringify({ ...spec, project: p }))) },
    ...(projects.length > 5 ? [{ type: "actions", block_id: "pick_project2", elements: projects.slice(5, 10).map((p) => btn(p, "task_project", JSON.stringify({ ...spec, project: p }))) }] : []),
    context(`또는 \`/할일 추가 제목 | 마감 | 우선순위 | 프로젝트\` 로 프로젝트를 직접 적어 주세요. 우선순위·상태는 ${Object.values(PRIORITY_KO).join("/")}, ${Object.values(STATUS_KO).join("/")}`),
  ];
}
