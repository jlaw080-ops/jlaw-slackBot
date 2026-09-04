/**
 * Notion = 에너빌드 스프린트 보드(에너빌드작업 DB). 접점은 세 가지뿐입니다.
 *  1) 티켓 발급: 볼트/Slack 할일 → Notion 티켓 생성 ([QA]Title 템플릿 구조)
 *  2) 할당 감지: 담당자가 나이거나 코멘트에서 멘션된 티켓 → 볼트 할일로 등록
 *  3) 상태 확인: 내가 발급한/할당받은 티켓의 진행 상태 조회
 */
import { config } from "./config.js";
import { ensureOk } from "./http.js";
import type { Priority } from "./vault.js";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export type TicketStatus = "시작 전" | "진행 중" | "테스트 중" | "보완검토중" | "업무제외" | "완료" | "보관" | "";
export const TICKET_DONE: TicketStatus[] = ["완료", "보관", "업무제외"];

export interface Ticket {
  id: string;
  url: string;
  title: string;
  status: TicketStatus;
  priority: Priority | "";
  due: string | null;
  tags: string[];
  assigneeIds: string[];
  assigneeNames: string[];
  lastEdited: string;
}

async function notion<T = any>(path: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}): Promise<T> {
  if (!config.notion.enabled) throw new Error("Notion 연동이 꺼져 있습니다 (NOTION_TOKEN 미설정)");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.notion.token}`, "Notion-Version": VERSION, "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  await ensureOk(res, `Notion ${init.method ?? "GET"} ${path}`);
  return res.json() as Promise<T>;
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
    id: page.id,
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

async function queryAll(body: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion(`/databases/${config.notion.ticketsDbId}/query`, {
      method: "POST", body: { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

export async function getTicket(pageId: string): Promise<Ticket> {
  return pageToTicket(await notion(`/pages/${pageId}`));
}

/** 담당자가 나인 미완료 티켓 */
export async function listTicketsAssignedToMe(): Promise<Ticket[]> {
  const rows = await queryAll({
    filter: {
      and: [
        { property: "담당자", people: { contains: config.notion.meUserId } },
        ...TICKET_DONE.map((s) => ({ property: "진행 상태", status: { does_not_equal: s } })),
      ],
    },
    sorts: [{ property: "작업완료일", direction: "ascending" }],
  });
  return rows.map(pageToTicket);
}

/** 여러 티켓의 현재 상태를 한 번에 조회 (실패한 것은 건너뜀) */
export async function getTicketsStatus(pageIds: string[]): Promise<Map<string, Ticket>> {
  const out = new Map<string, Ticket>();
  await Promise.all(pageIds.map(async (id) => {
    try { out.set(id, await getTicket(id)); } catch { /* 삭제된 티켓 등 */ }
  }));
  return out;
}

export interface NewTicket {
  title: string;
  due?: string | null;
  priority?: Priority;
  tags?: string[];
  assignToMe?: boolean;
  /** 요청사항 본문 (볼트 메모 등) */
  request?: string;
  slackLink?: string;
}

/**
 * 티켓 발급. 에너빌드작업 DB의 [QA]Title 템플릿과 같은 골격(요청사항/조치내용/조치결과)으로 본문을 만듭니다.
 */
export async function createTicket(t: NewTicket): Promise<Ticket> {
  const props: Record<string, unknown> = {
    작업: { title: [{ text: { content: t.title } }] },
    "진행 상태": { status: { name: "시작 전" } },
  };
  if (t.due) props["작업완료일"] = { date: { start: t.due } };
  if (t.priority) props["우선순위"] = { select: { name: t.priority } };
  if (t.tags?.length) props["태그"] = { multi_select: t.tags.map((name) => ({ name })) };
  if (t.assignToMe !== false) props["담당자"] = { people: [{ id: config.notion.meUserId }] };
  if (t.slackLink) props["슬랙링크"] = { url: t.slackLink };

  const h2 = (text: string) => ({ object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: text } }] } });
  const h3 = (text: string) => ({ object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: text } }] } });
  const bullet = (text: string) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: text.slice(0, 1900) } }] } });
  const requestLines = (t.request ?? "").split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);

  const children = [
    h2("1. 요청사항"),
    h3("요청 내용"),
    ...(requestLines.length ? requestLines.slice(0, 30).map(bullet) : [bullet("text")]),
    h3("기대 결과"), bullet("text"),
    h3("수정 요건"), bullet("text"),
    h2("2. 조치내용"), bullet("-"),
    h2("3. 조치결과"), bullet("-"),
  ];
  const page = await notion("/pages", { method: "POST", body: { parent: { database_id: config.notion.ticketsDbId }, properties: props, children } });
  return pageToTicket(page);
}

/** 페이지 코멘트에 내가 멘션되었는지 (웹훅 comment 이벤트 처리용) */
export async function isMentionedInComments(pageId: string): Promise<boolean> {
  try {
    const data = await notion(`/comments?block_id=${pageId}&page_size=20`);
    return (data.results ?? []).some((c: any) =>
      (c.rich_text ?? []).some((r: any) => r.type === "mention" && r.mention?.user?.id === config.notion.meUserId));
  } catch { return false; }
}

/** Notion 상태 → 볼트 상태 대응 */
export function ticketToVaultStatus(s: TicketStatus): "할일" | "진행중" | "보류" | "완료" | "취소" {
  if (s === "완료" || s === "보관") return "완료";
  if (s === "업무제외") return "취소";
  if (s === "진행 중" || s === "테스트 중") return "진행중";
  if (s === "보완검토중") return "보류";
  return "할일";
}
