/**
 * Gmail 읽기 (OAuth 갱신 토큰, 외부 라이브러리 없음)
 *
 * 캘린더와 달리 **개인 Gmail 편지함은 서비스 계정으로 읽을 수 없습니다.**
 * 구글이 막아 두었기 때문에, 한 번 로그인해서 받은 "갱신 토큰"을 씁니다.
 * 준비 방법은 docs/SETUP.md 의 "Gmail 연결" 절에 있습니다.
 *
 * 봇은 **읽기만** 합니다 (gmail.readonly). 메일을 보내거나 지우거나 라벨을 바꾸지 않습니다.
 */
import { config } from "./config.js";
import { ensureOk } from "./http.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

let cached: { token: string; exp: number } | null = null;

/** 갱신 토큰으로 한 시간짜리 접근 토큰을 받아 둡니다 */
async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const { clientId, clientSecret, refreshToken } = config.gmail;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  await ensureOk(res, "Gmail 토큰 발급");
  const d = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return cached.token;
}

async function api<T = any>(path: string): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  await ensureOk(res, `Gmail GET ${path}`);
  return res.json() as Promise<T>;
}

// ---------- 메일 본문 파싱 ----------
interface Part { mimeType?: string; body?: { data?: string; size?: number }; parts?: Part[]; filename?: string }

function decode(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** text/plain 을 우선 찾고, 없으면 text/html 에서 태그를 걷어 냅니다 */
function extractBody(payload: Part): string {
  const walk = (p: Part, want: string): string => {
    if (p.mimeType === want && p.body?.data) return decode(p.body.data);
    for (const child of p.parts ?? []) {
      const hit = walk(child, want);
      if (hit) return hit;
    }
    return "";
  };
  const plain = walk(payload, "text/plain");
  if (plain) return plain;
  const html = walk(payload, "text/html");
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n");
}

/** 인용문·서명·자동 문구를 걷어 내고 앞부분만 남깁니다 */
export function cleanBody(text: string, maxLines = 25): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*(>|On .+ wrote:|\d{4}년 .+에 .+님이 작성:|-{2,}\s*원본 메일|-{2,}\s*Original Message)/.test(line)) break;
    if (/^\s*(감사합니다|Thanks|Best regards|Regards|드림|올림)[.,!]?\s*$/i.test(line) && out.length > 2) break;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface Mail {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;      // YYYY-MM-DD
  time: string;      // HH:MM
  snippet: string;
  body: string;
  url: string;
}

const header = (headers: Array<{ name: string; value: string }>, name: string) =>
  headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

function toKST(raw: string): { date: string; time: string } {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const [date, time] = f.format(d).split(" ");
  return { date, time: time?.slice(0, 5) ?? "" };
}

export async function getMail(id: string): Promise<Mail> {
  const m = await api<{ id: string; threadId: string; snippet: string; payload: Part & { headers: Array<{ name: string; value: string }> } }>(
    `/messages/${id}?format=full`,
  );
  const h = m.payload.headers ?? [];
  const { date, time } = toKST(header(h, "date"));
  return {
    id: m.id,
    threadId: m.threadId,
    subject: header(h, "subject") || "(제목 없음)",
    from: header(h, "from"),
    to: header(h, "to"),
    date,
    time,
    snippet: m.snippet ?? "",
    body: cleanBody(extractBody(m.payload)),
    url: `https://mail.google.com/mail/u/0/#all/${m.id}`,
  };
}

/** 검색어로 메일 찾기 (최신순). 제목 일부만 적어도 됩니다 */
export async function searchMails(query: string, limit = 5): Promise<Mail[]> {
  const r = await api<{ messages?: Array<{ id: string }> }>(`/messages?maxResults=${limit}&q=${encodeURIComponent(query)}`);
  const ids = (r.messages ?? []).map((m) => m.id);
  const out: Mail[] = [];
  for (const id of ids) out.push(await getMail(id));
  return out;
}

/** 노트 본문으로 쓸 여러 줄 */
export function mailToNoteLines(mail: Mail): string {
  return [
    `보낸이: ${mail.from}`,
    ...(mail.to ? [`받는이: ${mail.to}`] : []),
    `받은날짜: ${mail.date}${mail.time ? ` ${mail.time}` : ""}`,
    `원본: ${mail.url}`,
    "",
    ...(mail.body ? mail.body.split("\n") : [mail.snippet]),
  ].join("\n");
}
