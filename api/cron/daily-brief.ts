/**
 * 매일 아침 08:00 KST (UTC 23:00) — 오늘 브리핑을 #할일에 게시하고 캘린더를 동기화합니다.
 * 수동 실행: GET /api/cron/daily-brief?secret=CRON_SECRET
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCronAuth, json } from "../../src/lib/http.js";
import { runDailyBrief } from "../../src/lib/brief.js";
import { syncVault } from "../../src/lib/obsidian.js";
import { config } from "../../src/lib/config.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronAuth(req)) return json(res, 401, { ok: false, error: "unauthorized" });
  try {
    const brief = await runDailyBrief();
    let obsidian: unknown = "disabled";
    if (config.obsidian.enabled) {
      obsidian = await syncVault({ sinceIso: new Date(Date.now() - 24 * 3600e3).toISOString() }).catch((e) => ({ error: String(e) }));
    }
    return json(res, 200, { ok: true, brief, obsidian });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
