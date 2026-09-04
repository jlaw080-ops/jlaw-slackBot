/**
 * Slack 슬래시 명령 엔드포인트 (/할일, /작업일지, /일정 모두 이 URL로)
 * Slack은 3초 안에 응답을 요구하므로, 즉시 "처리 중" 응답을 보내고
 * 실제 작업은 백그라운드(waitUntil)에서 끝낸 뒤 response_url로 결과를 보냅니다.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { readRawBody, parseForm } from "../../src/lib/raw-body.js";
import { noteModal, openView, respondToCommand, verifyFailureMessage, verifySlackRequest } from "../../src/lib/slack.js";
import { executeCommand, parseCommand } from "../../src/lib/commands.js";
import { PROJECTS } from "../../src/lib/vault.js";

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const { raw, source } = await readRawBody(req);
  const check = verifySlackRequest(req, raw);
  if (!check.ok) {
    // 401로 끊으면 Slack에는 "앱이 반응하지 않음"으로만 보여 원인을 알 수 없다.
    // 200 + 안내문으로 돌려주어 무엇이 잘못됐는지 화면에서 바로 보이게 한다. 명령은 실행하지 않는다.
    console.error("Slack 서명 검증 실패", { reason: check.reason, bodySource: source, bodyLength: raw.length });
    return res.status(200).json({ response_type: "ephemeral", text: verifyFailureMessage(check.reason, source) });
  }

  const form = parseForm(raw);
  const parsed = parseCommand(form.command ?? "", form.text ?? "");
  const ctx = { userId: form.user_id ?? "", channelId: form.channel_id ?? "" };

  // 도움말은 즉시 응답
  if (parsed.kind === "help") {
    const reply = await executeCommand(parsed, ctx);
    return res.status(200).json({ response_type: "ephemeral", text: reply.text, blocks: reply.blocks });
  }

  // 입력 창(모달)은 trigger_id가 3초 안에만 유효하므로 바로 엽니다
  if (parsed.kind === "worklog.modal") {
    try {
      await openView(form.trigger_id ?? "", noteModal(form.channel_id ?? "", PROJECTS, parsed.title));
      return res.status(200).send("");
    } catch (e) {
      console.error("views.open 실패", e);
      return res.status(200).json({ response_type: "ephemeral", text: `⚠️ 입력 창을 열지 못했어요 (${e instanceof Error ? e.message : e}). 한 줄로 \`/작업일지 노트 제목 :: 내용\` 처럼 써 보세요.` });
    }
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
