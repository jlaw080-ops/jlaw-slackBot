import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "./config.js";

/** JSON 응답 도우미 */
export function json(res: VercelResponse, status: number, body: unknown) {
  res.status(status).setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(body));
}

/**
 * Cron/수동 호출 보호.
 * - Vercel Cron은 자동으로 `Authorization: Bearer $CRON_SECRET` 헤더를 붙입니다.
 * - 브라우저에서 수동 실행할 때는 `?secret=...` 쿼리로도 허용합니다.
 */
export function checkCronAuth(req: VercelRequest): boolean {
  const secret = config.cronSecret;
  if (!secret) return true; // 개발 편의: 비밀값 미설정 시 통과 (배포 시 반드시 설정 권장)
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${secret}`) return true;
  const q = req.query?.secret;
  return (Array.isArray(q) ? q[0] : q) === secret;
}

/** 여러 작업 중 하나가 실패해도 나머지는 계속 진행하고, 실패 목록을 모읍니다. */
export async function settle<T>(
  steps: Array<{ name: string; run: () => Promise<T> }>,
): Promise<{ ok: string[]; failed: Array<{ name: string; error: string }> }> {
  const ok: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const s of steps) {
    try {
      await s.run();
      ok.push(s.name);
    } catch (e) {
      failed.push({ name: s.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok, failed };
}

/** fetch 응답이 실패면 본문을 포함한 에러를 던집니다. */
export async function ensureOk(res: Response, label: string): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label} 실패 (${res.status}): ${text.slice(0, 500)}`);
  }
  return res;
}
