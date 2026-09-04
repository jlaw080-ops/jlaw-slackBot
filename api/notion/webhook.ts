/**
 * Notion → Slack 업무 할당 알림
 *
 * Notion 데이터베이스 "자동화"에서
 *   트리거: 담당자 속성이 변경됨  →  작업: 웹훅 보내기 (URL: https://<배포주소>/api/notion/webhook?secret=NOTION_WEBHOOK_SECRET)
 * 로 설정하면, 담당자가 지정될 때마다 이 엔드포인트가 호출되어 Slack으로 알립니다.
 *
 * 페이지 ID는 여러 형태의 페이로드(자동화 웹훅 / 통합 웹훅)에서 최대한 찾아냅니다.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../../src/lib/http.js";
import { config } from "../../src/lib/config.js";
import { getTask } from "../../src/lib/notion.js";
import { context, postDM, postMessage, section, taskCard } from "../../src/lib/slack.js";
import { syncTaskToCalendar } from "../../src/lib/gcal.js";

function findPageId(body: any): string | null {
  const cands = [body?.data?.id, body?.page?.id, body?.entity?.id, body?.id, body?.data?.page?.id];
  for (const c of cands) if (typeof c === "string" && /^[0-9a-f-]{32,36}$/i.test(c)) return c;
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { ok: false });
  if (config.notion.webhookSecret) {
    const q = req.query?.secret;
    if ((Array.isArray(q) ? q[0] : q) !== config.notion.webhookSecret) return json(res, 401, { ok: false, error: "unauthorized" });
  }
  // Notion 통합 웹훅 최초 등록 시 verification_token 확인 요청이 옵니다 → 로그로 남기고 200
  if (req.body?.verification_token) {
    console.log("Notion verification_token:", req.body.verification_token);
    return json(res, 200, { ok: true });
  }

  const pageId = findPageId(req.body);
  if (!pageId) return json(res, 200, { ok: false, reason: "page id not found", received: Object.keys(req.body ?? {}) });

  try {
    const task = await getTask(pageId);
    const mine = task.assigneeIds.includes(config.notion.meUserId);
    const who = task.assigneeNames.filter(Boolean).join(", ") || "미지정";
    const blocks = [
      section(`📌 *업무 할당 알림* — 담당자: ${who}${mine ? " (나)" : ""}`),
      ...taskCard(task),
      context(`상태 ${task.status || "-"} · 우선순위 ${task.priority || "-"}`),
    ];
    const text = `📌 업무 할당: ${task.title} (담당 ${who})`;
    if (mine) await postDM(config.slack.meUserId || undefined, text, blocks);
    else await postMessage(config.slack.channelWork, text, blocks);
    if (config.google.enabled && mine) { try { await syncTaskToCalendar(task); } catch { /* ignore */ } }
    return json(res, 200, { ok: true, task: task.title, mine });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
