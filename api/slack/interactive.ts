/**
 * Slack 버튼(완료/진행 중) 클릭 처리 — Interactivity Request URL
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { readRawBody, parseForm } from "../../src/lib/raw-body.js";
import { section, taskLine, verifySlackRequest } from "../../src/lib/slack.js";
import { updateTask, type TaskStatus } from "../../src/lib/notion.js";
import { syncTaskToCalendar } from "../../src/lib/gcal.js";
import { config as appConfig } from "../../src/lib/config.js";

export const config = { api: { bodyParser: false } };

const ACTION_STATUS: Record<string, TaskStatus> = { task_done: "완료", task_start: "진행 중" };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const raw = await readRawBody(req);
  if (!verifySlackRequest(req, raw)) return res.status(401).send("invalid signature");

  const payload = JSON.parse(parseForm(raw).payload ?? "{}");
  if (payload.type !== "block_actions") return res.status(200).send("");

  const action = payload.actions?.[0];
  const status = ACTION_STATUS[action?.action_id];
  if (!status) return res.status(200).send("");
  const taskId: string = action.value;
  const responseUrl: string = payload.response_url;

  waitUntil((async () => {
    try {
      const t = await updateTask(taskId, { status });
      if (appConfig.google.enabled) { try { await syncTaskToCalendar(t); } catch { /* ignore */ } }
      await fetch(responseUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replace_original: false, response_type: "ephemeral", text: `${status === "완료" ? "✅" : "🔄"} ${t.title} → ${status}`, blocks: [section(`${status === "완료" ? "✅" : "🔄"} *${status}* 처리됨\n${taskLine(t)}`)] }),
      });
    } catch (e) {
      await fetch(responseUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replace_original: false, response_type: "ephemeral", text: `❌ 상태 변경 실패: ${e instanceof Error ? e.message : e}` }),
      }).catch(() => {});
    }
  })());

  return res.status(200).send("");
}
