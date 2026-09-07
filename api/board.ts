/**
 * 업무 진행 현황 화면
 *   GET /api/board?secret=CRON_SECRET
 *
 * 볼트를 그때그때 읽어 만듭니다. Obsidian Git 동기화를 기다릴 필요가 없습니다.
 * 업무 내용이 담기므로 CRON_SECRET 으로 잠가 두고, 검색엔진에도 노출되지 않게 합니다.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCronAuth } from "../src/lib/http.js";
import { collectBoard, renderBoard } from "../src/lib/board.js";
import { todayKST } from "../src/lib/dates.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronAuth(req)) {
    res.status(401).setHeader("content-type", "text/html; charset=utf-8");
    return res.send("<h1>401</h1><p>주소 끝에 <code>?secret=…</code> 를 붙여 주세요.</p>");
  }
  const today = todayKST();
  try {
    const items = await collectBoard(today);
    res.status(200)
      .setHeader("content-type", "text/html; charset=utf-8")
      .setHeader("cache-control", "no-store")
      .setHeader("x-robots-tag", "noindex, nofollow");
    return res.send(renderBoard(items, today));
  } catch (e) {
    res.status(500).setHeader("content-type", "text/html; charset=utf-8");
    return res.send(`<h1>현황을 만들지 못했습니다</h1><pre>${String(e instanceof Error ? e.message : e).replace(/</g, "&lt;")}</pre>`);
  }
}
