/**
 * Notion 접점 수동/외부 실행: 나에게 할당된 티켓 가져오기 + 연결된 티켓 상태 갱신
 *   GET /api/notion/pull?secret=CRON_SECRET
 * (아침 브리핑에도 포함되어 있으므로, 낮에 즉시 반영하고 싶을 때 씁니다. Slack에서는 /티켓 할당, /티켓 상태)
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCronAuth, json } from "../../src/lib/http.js";
import { pullAssignedTickets, refreshTicketStatus } from "../../src/lib/notion-sync.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronAuth(req)) return json(res, 401, { ok: false, error: "unauthorized" });
  try {
    const pulled = await pullAssignedTickets({ notify: true });
    const refreshed = await refreshTicketStatus();
    return json(res, 200, {
      ok: true,
      registered: pulled.registered.map((t) => t.title),
      alreadyLinked: pulled.alreadyLinked,
      statusChecked: refreshed.checked,
      statusChanged: refreshed.changed.map((c) => ({ title: c.task.title, from: c.from, to: c.to })),
      completed: refreshed.completed.map((t) => t.title),
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
