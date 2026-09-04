/**
 * Obsidian 볼트 ↔ Notion 동기화 엔드포인트
 *  - 수동:  GET/POST /api/obsidian/sync?secret=CRON_SECRET
 *  - 자동:  볼트 GitHub 저장소의 Webhook (push 이벤트) → 이 URL 로 설정하면 볼트에 커밋될 때마다 동기화
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac, timingSafeEqual } from "node:crypto";
import { checkCronAuth, json } from "../../src/lib/http.js";
import { syncVault } from "../../src/lib/obsidian.js";
import { config } from "../../src/lib/config.js";

function verifyGithub(req: VercelRequest): boolean {
  const secret = config.cronSecret;
  const sig = String(req.headers["x-hub-signature-256"] ?? "");
  if (!secret || !sig) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(JSON.stringify(req.body ?? {})).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isGithub = Boolean(req.headers["x-github-event"]);
  if (isGithub) {
    if (!verifyGithub(req)) return json(res, 401, { ok: false, error: "bad github signature" });
    if (req.headers["x-github-event"] === "ping") return json(res, 200, { ok: true, pong: true });
    // 봇 자신의 커밋으로 인한 push는 무시 (무한 루프 방지)
    const commits: any[] = req.body?.commits ?? [];
    if (commits.length && commits.every((c) => String(c.message ?? "").startsWith("workhub:"))) {
      return json(res, 200, { ok: true, skipped: "bot commits only" });
    }
  } else if (!checkCronAuth(req)) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const result = await syncVault({ sinceIso: new Date(Date.now() - 24 * 3600e3).toISOString() });
    return json(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
