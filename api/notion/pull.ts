/**
 * Notion 접점 수동 실행: 나에게 넘어온 티켓 후보를 #업무에 게시 + 연결된 티켓 상태 갱신
 *   GET /api/notion/pull?secret=CRON_SECRET
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCronAuth, json } from "../../src/lib/http.js";
import { findAssignedCandidates, refreshTicketStatus } from "../../src/lib/notion-sync.js";
import { candidateCard, context, notifyMe, section } from "../../src/lib/slack.js";
import { config } from "../../src/lib/config.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronAuth(req)) return json(res, 401, { ok: false, error: "unauthorized" });
  try {
    const r = await findAssignedCandidates();
    if (r.candidates.length) {
      await notifyMe(config.slack.channelWork, `📌 Notion에서 나에게 넘어온 티켓 ${r.candidates.length}건`, [
        section(`📌 *Notion에서 나에게 넘어온 티켓* (${r.candidates.length}) — 할일로 등록할지 골라 주세요`),
        ...r.candidates.slice(0, 10).flatMap(candidateCard),
        context(`이미 볼트에 있음 ${r.skipped.length}건 · 무시 ${r.ignored}건 · 댓글 스캔 ${r.commentScan.scanned}/${r.commentScan.total}건`),
      ]);
    }
    const refreshed = await refreshTicketStatus();
    return json(res, 200, {
      ok: true,
      candidates: r.candidates.map((c) => ({ title: c.ticket.title, reason: c.reason })),
      skipped: r.skipped.map((s) => ({ title: s.ticket.title, path: s.path })),
      ignored: r.ignored,
      commentScan: r.commentScan,
      statusChecked: refreshed.checked,
      statusChanged: refreshed.changed.map((c) => ({ title: c.task.title, from: c.from, to: c.to })),
      finished: refreshed.finished.map((t) => t.title),
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
