/**
 * 매일 아침 08:00 KST (UTC 23:00) — 브리핑을 #할일에 게시합니다.
 * 브리핑 안에서 Notion 할당 티켓 가져오기·티켓 상태 갱신·캘린더 동기화가 함께 수행됩니다.
 * 수동 실행: GET /api/cron/daily-brief?secret=CRON_SECRET
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCronAuth, json } from "../../src/lib/http.js";
import { runDailyBrief } from "../../src/lib/brief.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronAuth(req)) return json(res, 401, { ok: false, error: "unauthorized" });
  try {
    return json(res, 200, { ok: true, brief: await runDailyBrief() });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
