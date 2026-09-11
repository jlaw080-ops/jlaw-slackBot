/**
 * Slack 이벤트 구독 엔드포인트 — #작업일지·#할일 채널에 슬래시 명령 없이
 * 그냥 타이핑한 평문 메시지를 주워 일일노트 메모로 남깁니다.
 *
 * 지금까지 봇이 볼트에 뭔가 쓰는 경로는 슬래시 명령·메시지 바로가기·버튼 클릭
 * 셋뿐이었습니다. 채널에 직접 쓴 글은 이 셋 중 어디에도 해당하지 않아
 * 봇이 아예 받아 본 적이 없었습니다 (Slack은 Events API 구독 없이는
 * 채널 메시지를 앱에 전달하지 않습니다). 이 엔드포인트가 그 구독을 받습니다.
 *
 * Slack App 설정 → Event Subscriptions 에서:
 *   Request URL: https://<배포주소>/api/slack/events
 *   Subscribe to bot events: message.channels (공개 채널) — 비공개 채널이면 message.groups 도 추가
 *   OAuth Scopes: channels:history (또는 groups:history), reactions:write
 * 를 켜고 앱을 다시 설치해야 동작합니다. SETUP.md 참고.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { readRawBody } from "../../src/lib/raw-body.js";
import { verifySlackRequest, addReaction } from "../../src/lib/slack.js";
import { config as appConfig } from "../../src/lib/config.js";
import { appendMemo } from "../../src/lib/vault.js";
import { todayKST } from "../../src/lib/dates.js";

export const config = { api: { bodyParser: false } };

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

/** 어느 채널에서 왔는지 · 메모에 붙일 꼬리표 */
export function sourceLabel(channelId: string): string | null {
  if (channelId === appConfig.slack.channelWorklog) return "작업일지 채널";
  if (channelId === appConfig.slack.channelTodo) return "할일 채널";
  return null;
}

/** 사람이 직접 쓴, 새 최상위 메시지인가 — 봇 메시지·수정·삭제·스레드 답글은 재료로 보지 않는다 */
export function isPlainNewMessage(e: SlackMessageEvent): boolean {
  if (e.type !== "message") return false;
  if (e.subtype) return false; // bot_message, message_changed, message_deleted, channel_join …
  if (e.bot_id) return false;
  if (e.thread_ts && e.thread_ts !== e.ts) return false; // 스레드 답글은 제외 — 본문 소음 방지
  return Boolean(e.text?.trim());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const { raw } = await readRawBody(req);

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return res.status(400).send("invalid json");
  }

  // Slack이 구독을 처음 등록할 때 보내는 확인 — 서명 검증 전에 즉시 돌려줘야 통과합니다
  if (body?.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  const check = verifySlackRequest(req, raw);
  if (!check.ok) {
    console.error("Slack 이벤트 서명 검증 실패", { reason: check.reason });
    return res.status(401).send("bad signature");
  }

  // Slack은 3초 안에 200을 못 받으면 같은 이벤트를 재전송합니다 — 먼저 응답부터
  res.status(200).send("");

  const event = body?.event as SlackMessageEvent | undefined;
  if (!event || !isPlainNewMessage(event)) return;
  const label = sourceLabel(event.channel);
  if (!label) return; // 우리가 보는 두 채널이 아니면 조용히 무시

  waitUntil(
    (async () => {
      try {
        const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: appConfig.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
        await appendMemo(todayKST(), `${stamp} [${label}] ${event.text!.trim()}`);
        await addReaction(event.channel, event.ts).catch((e) => console.error("reactions.add 실패", e));
      } catch (e) {
        console.error("채널 메시지 처리 실패", e);
      }
    })(),
  );
}
