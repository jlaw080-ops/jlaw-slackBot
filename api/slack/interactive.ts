/**
 * Slack 버튼 처리 — Interactivity Request URL
 *   task_done / task_start : 볼트 할일 상태 변경
 *   task_ticket            : 볼트 할일 → Notion 티켓 발급
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { readRawBody, parseForm } from "../../src/lib/raw-body.js";
import { section, taskCard, taskLine, verifySlackRequest } from "../../src/lib/slack.js";
import { findTaskById, setStatus, type VaultStatus } from "../../src/lib/vault.js";
import { issueTicket } from "../../src/lib/notion-sync.js";
import { syncTaskToCalendar } from "../../src/lib/gcal.js";
import { config as appConfig } from "../../src/lib/config.js";

export const config = { api: { bodyParser: false } };

const ACTION_STATUS: Record<string, VaultStatus> = { task_done: "완료", task_start: "진행중" };

async function reply(responseUrl: string, text: string, blocks?: unknown[]) {
  await fetch(responseUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: false, response_type: "ephemeral", text, blocks }),
  }).catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const raw = await readRawBody(req);
  if (!verifySlackRequest(req, raw)) return res.status(401).send("invalid signature");

  const payload = JSON.parse(parseForm(raw).payload ?? "{}");
  if (payload.type !== "block_actions") return res.status(200).send("");
  const action = payload.actions?.[0];
  const actionId: string = action?.action_id ?? "";
  const taskId: string = action?.value ?? "";
  const responseUrl: string = payload.response_url;
  if (!taskId || !(actionId in ACTION_STATUS || actionId === "task_ticket")) return res.status(200).send("");

  waitUntil((async () => {
    try {
      const task = await findTaskById(taskId);
      if (!task) return reply(responseUrl, `⚠️ 볼트에서 할일(${taskId})을 찾지 못했어요. 파일이 이동/삭제되었을 수 있어요.`);
      if (actionId === "task_ticket") {
        if (task.notionTicket) return reply(responseUrl, `이미 티켓이 있어요: <${task.notionTicket}|${task.title}>`);
        const { task: linked, ticket } = await issueTicket(task);
        return reply(responseUrl, `🎫 Notion 티켓 발급: ${ticket.title}`, [section(`🎫 *Notion 티켓 발급됨* → <${ticket.url}|열기>`), ...taskCard(linked)]);
      }
      const status = ACTION_STATUS[actionId];
      const updated = await setStatus(task, status);
      if (appConfig.google.enabled) { try { await syncTaskToCalendar(updated); } catch { /* ignore */ } }
      const icon = status === "완료" ? "✅" : "🔄";
      return reply(responseUrl, `${icon} ${updated.title} → ${status}`, [section(`${icon} *${status}* 처리됨 → 볼트 \`${updated.path}\`\n${taskLine(updated)}`)]);
    } catch (e) {
      return reply(responseUrl, `❌ 처리 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  })());

  return res.status(200).send("");
}
