import type { VercelRequest } from "@vercel/node";

export interface RawBody {
  /** 서명 검증에 쓸 본문 문자열 */
  raw: string;
  /** 어떻게 얻었는지 — 진단용 */
  source: "string" | "buffer" | "stream" | "reparsed" | "empty";
}

/**
 * 요청 본문을 가공 전 문자열로 읽습니다.
 *
 * Slack 서명 검증은 "원본 그대로"의 본문이 필요합니다. 그래서 해당 엔드포인트는
 * `export const config = { api: { bodyParser: false } }` 로 자동 파싱을 끕니다.
 *
 * 다만 런타임이 그 설정을 무시하고 본문을 미리 파싱해 버리면 스트림이 이미 비어 있어
 * 서명이 무조건 어긋납니다. 그 경우를 대비해 파싱된 객체에서 form 문자열을 되살립니다.
 * (Slack은 application/x-www-form-urlencoded 로 보내므로 키 순서만 유지되면 복원됩니다.)
 */
export async function readRawBody(req: VercelRequest): Promise<RawBody> {
  if (typeof req.body === "string") return { raw: req.body, source: "string" };
  if (Buffer.isBuffer(req.body)) return { raw: req.body.toString("utf8"), source: "buffer" };

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  } catch {
    // 스트림이 이미 소비됨 — 아래 복원 경로로
  }
  if (chunks.length) return { raw: Buffer.concat(chunks).toString("utf8"), source: "stream" };

  if (req.body && typeof req.body === "object") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      params.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    return { raw: params.toString(), source: "reparsed" };
  }
  return { raw: "", source: "empty" };
}

export function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}
