/**
 * 매일 저녁 18:00 KST (UTC 09:00) — 오늘 작업일지를 볼트에 쓰고 #작업일지에 게시합니다.
 * 수동 실행: GET /api/cron/worklog?secret=CRON_SECRET&date=2026-09-03
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCronAuth, json } from "../../src/lib/http.js";
import { runWorklog } from "../../src/lib/worklog.js";
import { todayKST } from "../../src/lib/dates.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronAuth(req)) return json(res, 401, { ok: false, error: "unauthorized" });
  try {
    const q = req.query?.date;
    const date = (Array.isArray(q) ? q[0] : q) || todayKST();
    return json(res, 200, { ok: true, worklog: await runWorklog(date) });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
