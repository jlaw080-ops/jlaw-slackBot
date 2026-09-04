import type { VercelRequest } from "@vercel/node";

/**
 * 요청 본문을 가공 전 문자열로 읽습니다.
 * Slack 서명 검증은 "원본 그대로"의 본문이 필요하므로, 해당 엔드포인트는 bodyParser를 끄고 이 함수를 씁니다.
 */
export async function readRawBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}
