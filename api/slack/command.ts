/**
 * Slack 슬래시 명령 엔드포인트 (/할일, /작업일지, /일정 모두 이 URL로)
 * Slack은 3초 안에 응답을 요구하므로, 즉시 "처리 중" 응답을 보내고
 * 실제 작업은 백그라운드(waitUntil)에서 끝낸 뒤 response_url로 결과를 보냅니다.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { readRawBody, parseForm } from "../../src/lib/raw-body.js";
import { respondToCommand, verifySlackRequest } from "../../src/lib/slack.js";
import { executeCommand, parseCommand } from "../../src/lib/commands.js";

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const raw = await readRawBody(req);
  if (!verifySlackRequest(req, raw)) return res.status(401).send("invalid signature");

  const form = parseForm(raw);
  const parsed = parseCommand(form.command ?? "", form.text ?? "");
  const ctx = { userId: form.user_id ?? "", channelId: form.channel_id ?? "" };

  // 도움말은 즉시 응답
  if (parsed.kind === "help") {
    const reply = await executeCommand(parsed, ctx);
    return res.status(200).json({ response_type: "ephemeral", text: reply.text, blocks: reply.blocks });
  }

  const work = (async () => {
    try {
      const reply = await executeCommand(parsed, ctx);
      await respondToCommand(form.response_url, reply.text, reply.blocks, reply.inChannel);
    } catch (e) {
      console.error("command failed", e);
      await respondToCommand(form.response_url, `❌ 처리 중 오류: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
    }
  })();
  waitUntil(work);

  return res.status(200).json({ response_type: "ephemeral", text: "⏳ 처리 중…" });
}
