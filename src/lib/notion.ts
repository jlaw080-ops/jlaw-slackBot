/**
 * Notion = 에너빌드 스프린트 보드(에너빌드작업 DB). 봇은 읽기만 합니다.
 *  - 담당자가 나인 활성 티켓 / 댓글 멘션 티켓 조회  (notion-todo-sync 스킬과 같은 규칙)
 *  - 연결된 티켓의 현재 상태 조회
 *  - 티켓 본문 요약 (배경·체크리스트 힌트)
 * 티켓 "발급"은 notion-qa-ticket 스킬(Claude Code)이 담당합니다. 봇은 발급 대기 표시만 합니다.
 */
import { config } from "./config.js";
import { ensureOk } from "./http.js";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export type TicketStatus = "시작 전" | "진행 중" | "테스트 중" | "보완검토중" | "업무제외" | "완료" | "보관" | "";
export const TICKET_ACTIVE: TicketStatus[] = ["시작 전", "보완검토중", "진행 중", "테스트 중"];
export const TICKET_DONE: TicketStatus[] = ["완료", "보관", "업무제외"];

export interface Ticket {
  id: string;        // 32자리 hex (하이픈 없음)
  url: string;
  title: string;
  status: TicketStatus;
  priority: string;  // 높음 / 중간 / 낮음 / ""
  due: string | null;
  tags: string[];
  assigneeIds: string[];
  assigneeNames: string[];
  lastEdited: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Notion은 초당 약 3건으로 제한되므로 429가 오면 Retry-After만큼 기다렸다 두 번까지 다시 시도합니다 */
async function notion<T = any>(path: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}): Promise<T> {
  if (!config.notion.enabled) throw new Error("Notion 연동이 꺼져 있습니다 (NOTION_TOKEN 미설정)");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${config.notion.token}`, "Notion-Version": VERSION, "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get("retry-after") ?? "1");
      await sleep(Math.min(Math.max(wait, 1), 5) * 1000);
      continue;
    }
    await ensureOk(res, `Notion ${init.method ?? "GET"} ${path}`);
    return res.json() as Promise<T>;
  }
}

/** 동시 실행 수를 제한해 순서대로 처리 (Notion 요청 제한 대응) */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return out;
}

const P = {
  title: (p: any) => (p?.title ?? []).map((t: any) => t.plain_text).join(""),
  select: (p: any) => p?.select?.name ?? "",
  status: (p: any) => p?.status?.name ?? "",
  multi: (p: any) => (p?.multi_select ?? []).map((o: any) => o.name as string),
  people: (p: any) => (p?.people ?? []) as Array<{ id: string; name?: string }>,
  dateStart: (p: any) => (p?.date?.start ? String(p.date.start).slice(0, 10) : null),
};

export function pageToTicket(page: any): Ticket {
  const pr = page.properties ?? {};
  const people = P.people(pr["담당자"]);
  return {
    id: String(page.id).replace(/-/g, "").toLowerCase(),
    url: page.url,
    title: P.title(pr["작업"]),
    status: P.status(pr["진행 상태"]),
    priority: P.select(pr["우선순위"]),
    due: P.dateStart(pr["작업완료일"]),
    tags: P.multi(pr["태그"]),
    assigneeIds: people.map((u) => u.id),
    assigneeNames: people.map((u) => u.name ?? ""),
    lastEdited: page.last_edited_time,
  };
}

async function queryAll(body: Record<string, unknown>, max = 500): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion(`/databases/${config.notion.ticketsDbId}/query`, {
      method: "POST", body: { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor && out.length < max);
  return out;
}

export async function getTicket(pageId: string): Promise<Ticket> {
  return pageToTicket(await notion(`/pages/${pageId}`));
}

const activeFilter = () => TICKET_DONE.map((s) => ({ property: "진행 상태", status: { does_not_equal: s } }));

/** 담당자가 나인 활성 티켓 (Step 1) */
export async function listTicketsAssignedToMe(): Promise<Ticket[]> {
  const rows = await queryAll({
    filter: { and: [{ property: "담당자", people: { contains: config.notion.meUserId } }, ...activeFilter()] },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return rows.map(pageToTicket);
}

/** 담당자가 내가 아닌 활성 티켓 (댓글 멘션 스캔 대상, 최근 편집순 상한 N건) */
export async function listActiveTicketsNotMine(limit = config.notion.commentScanLimit): Promise<{ tickets: Ticket[]; total: number }> {
  const rows = await queryAll({
    filter: { and: [{ property: "담당자", people: { does_not_contain: config.notion.meUserId } }, ...activeFilter()] },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  }, 1000);
  return { tickets: rows.slice(0, limit).map(pageToTicket), total: rows.length };
}

export interface MentionHit { comment: string; author: string; date: string }

/** 페이지의 미해결 댓글에서 나를 멘션한 것 (Step 2). 페이지 단위 댓글만 — 인라인 댓글은 API가 제공하지 않음 */
export async function findMentionInComments(pageId: string): Promise<MentionHit | null> {
  try {
    const data = await notion(`/comments?block_id=${pageId}&page_size=50`);
    for (const c of [...(data.results ?? [])].reverse()) {
      const rt: any[] = c.rich_text ?? [];
      const mentioned = rt.some((r) => r.type === "mention" && r.mention?.user?.id === config.notion.meUserId);
      if (!mentioned) continue;
      return {
        comment: rt.map((r) => r.plain_text ?? "").join("").trim().slice(0, 200),
        author: c.created_by?.name ?? c.created_by?.id ?? "",
        date: String(c.created_time ?? "").slice(0, 10),
      };
    }
  } catch { /* 댓글 권한 없음 등 */ }
  return null;
}

/** 여러 티켓 상태 한 번에 (동시 3건, 실패한 것은 건너뜀) */
export async function getTicketsStatus(pageIds: string[]): Promise<Map<string, Ticket>> {
  const out = new Map<string, Ticket>();
  await mapLimit([...new Set(pageIds)], 3, async (id) => {
    try { const t = await getTicket(id); out.set(t.id, t); } catch { /* 삭제된 티켓 등 */ }
  });
  return out;
}

export { mapLimit };

/** 티켓 본문에서 배경·요청 요약 몇 줄 (노트 "배경"·"체크리스트" 힌트용). 전문 복사는 하지 않음 */
export async function getTicketSummary(pageId: string): Promise<{ background: string[]; checklist: string[] }> {
  const out = { background: [] as string[], checklist: [] as string[] };
  try {
    const data = await notion(`/blocks/${pageId}/children?page_size=100`);
    let section = "";
    for (const b of data.results ?? []) {
      const type: string = b.type;
      const text: string = (b[type]?.rich_text ?? []).map((r: any) => r.plain_text).join("").trim();
      if (!text) continue;
      if (type.startsWith("heading")) { section = text; continue; }
      if (/^(text|-)$/.test(text)) continue;
      if (/배경|이슈|Background|Issues/i.test(section) && out.background.length < 3) out.background.push(text.split(" / ")[0]);
      else if (/요청|수정 요건|Request|Revision/i.test(section) && out.checklist.length < 5) out.checklist.push(text.split(" / ")[0]);
    }
  } catch { /* 본문 접근 실패는 무시 */ }
  return out;
}
