/**
 * Slack 버튼 처리 — Interactivity Request URL
 *   task_done / task_start : 볼트 노트 status 변경 (값 = 노트 경로)
 *   task_ticket            : notion: pending 표시
 *   task_project           : project 선택 후 할일 노트 생성
 *   cand_register / cand_ignore : Notion 할당 후보 → 노트 등록 / 무시
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { readRawBody, parseForm } from "../../src/lib/raw-body.js";
import { section, taskCard, taskLine, verifySlackRequest } from "../../src/lib/slack.js";
import { getTask, setStatus, STATUS_KO, type VaultStatus } from "../../src/lib/vault.js";
import { ignoreCandidate, markPending, registerCandidate } from "../../src/lib/notion-sync.js";
import { getTicket } from "../../src/lib/notion.js";
import { syncTaskToCalendar } from "../../src/lib/gcal.js";
import { addTask } from "../../src/lib/commands.js";
import { config as appConfig } from "../../src/lib/config.js";

export const config = { api: { bodyParser: false } };

const ACTION_STATUS: Record<string, VaultStatus> = { task_done: "done", task_start: "in-progress" };

async function reply(responseUrl: string, text: string, blocks?: unknown[], inChannel = false) {
  await fetch(responseUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: false, response_type: inChannel ? "in_channel" : "ephemeral", text, blocks }),
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
  const value: string = action?.value ?? "";
  const responseUrl: string = payload.response_url;
  const userId: string = payload.user?.id ?? "";
  if (!value) return res.status(200).send("");

  waitUntil((async () => {
    try {
      if (actionId in ACTION_STATUS || actionId === "task_ticket") {
        const task = await getTask(value);
        if (!task) return reply(responseUrl, `⚠️ 볼트에서 노트를 찾지 못했어요: \`${value}\` (이동/삭제되었을 수 있어요)`);
        if (actionId === "task_ticket") {
          const updated = await markPending(task);
          return reply(responseUrl, `🎫 발급 대기 표시: ${updated.title}`, [section(`🎫 *발급 대기 표시됨* (\`notion: pending\`) — Claude Code에서 \`notion-qa-ticket\` 스킬로 발급\n${taskLine(updated)}`)]);
        }
        const status = ACTION_STATUS[actionId];
        const updated = await setStatus(task, status);
        if (appConfig.google.enabled) { try { await syncTaskToCalendar(updated); } catch { /* ignore */ } }
        return reply(responseUrl, `${STATUS_KO[status]} 처리: ${updated.title}`, [section(`*${STATUS_KO[status]}* 처리됨 (status: ${status})\n${taskLine(updated)}`)], true);
      }

      if (actionId === "task_project") {
        const spec = JSON.parse(value);
        const r = await addTask({ title: spec.title, due: spec.due ?? null, priority: spec.priority, project: spec.project }, { userId, channelId: "", permalink: spec.permalink || undefined });
        return reply(responseUrl, r.text, r.blocks, Boolean(r.inChannel));
      }

      if (actionId === "cand_register" || actionId === "cand_ignore") {
        const v = JSON.parse(value) as { id: string; r: "assigned" | "mentioned"; m: any };
        const ticket = await getTicket(v.id);
        if (actionId === "cand_ignore") {
          await ignoreCandidate(ticket);
          return reply(responseUrl, `🙈 무시: ${ticket.title} — 다음 브리핑부터 후보에 나오지 않아요 (\`.workhub/notion-ignored.txt\`)`);
        }
        const task = await registerCandidate(ticket, v.r, v.m ?? undefined);
        return reply(responseUrl, `📥 할일 노트 등록: ${task.title}`, [section(`📥 *할일 노트 등록됨* → \`${task.path}\` (\`notion: assigned\`)`), ...taskCard(task)], true);
      }
    } catch (e) {
      return reply(responseUrl, `❌ 처리 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  })());

  return res.status(200).send("");
}
