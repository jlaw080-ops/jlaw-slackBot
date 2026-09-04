/**
 * Notion API 클라이언트 (공식 SDK 없이 fetch 사용 → 의존성 최소화)
 *
 * 다루는 DB 두 개:
 *  1) 에너빌드작업 (할일)  : 작업 / 진행 상태 / 담당자 / 작업완료일 / 우선순위 / 태그 / 슬랙링크
 *  2) 작업일지             : 제목 / 날짜 / 완료 작업 / 진행 작업 / 요약 / Obsidian 경로 / 출처
 */
import { config } from "./config.js";
import { ensureOk } from "./http.js";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export type TaskStatus = "시작 전" | "진행 중" | "테스트 중" | "보완검토중" | "업무제외" | "완료" | "보관";
export type Priority = "낮음" | "중간" | "높음";

export interface Task {
  id: string;
  url: string;
  title: string;
  status: TaskStatus | "";
  priority: Priority | "";
  due: string | null;       // YYYY-MM-DD
  dueEnd: string | null;
  tags: string[];
  assigneeIds: string[];
  assigneeNames: string[];
  slackLink: string | null;
  lastEdited: string;
  created: string;
}

export interface NewTask {
  title: string;
  due?: string | null;
  priority?: Priority;
  tags?: string[];
  assigneeIds?: string[];
  status?: TaskStatus;
  slackLink?: string;
  note?: string; // 본문 첫 문단에 넣을 메모
}

export interface Worklog {
  id: string;
  url: string;
  title: string;
  date: string | null;
  summary: string;
  obsidianPath: string;
  doneTaskIds: string[];
  activeTaskIds: string[];
}

async function notion<T = any>(path: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.notion.token}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  await ensureOk(res, `Notion ${init.method ?? "GET"} ${path}`);
  return res.json() as Promise<T>;
}

// ---------- 속성 파서 ----------
const P = {
  title: (p: any) => (p?.title ?? []).map((t: any) => t.plain_text).join(""),
  text: (p: any) => (p?.rich_text ?? []).map((t: any) => t.plain_text).join(""),
  select: (p: any) => p?.select?.name ?? "",
  status: (p: any) => p?.status?.name ?? "",
  multi: (p: any) => (p?.multi_select ?? []).map((o: any) => o.name as string),
  people: (p: any) => (p?.people ?? []) as Array<{ id: string; name?: string }>,
  dateStart: (p: any) => (p?.date?.start ? String(p.date.start).slice(0, 10) : null),
  dateEnd: (p: any) => (p?.date?.end ? String(p.date.end).slice(0, 10) : null),
  url: (p: any) => p?.url ?? null,
  relation: (p: any) => (p?.relation ?? []).map((r: any) => r.id as string),
};

export function pageToTask(page: any): Task {
  const pr = page.properties ?? {};
  const people = P.people(pr["담당자"]);
  return {
    id: page.id,
    url: page.url,
    title: P.title(pr["작업"]),
    status: P.status(pr["진행 상태"]),
    priority: P.select(pr["우선순위"]),
    due: P.dateStart(pr["작업완료일"]),
    dueEnd: P.dateEnd(pr["작업완료일"]),
    tags: P.multi(pr["태그"]),
    assigneeIds: people.map((u) => u.id),
    assigneeNames: people.map((u) => u.name ?? ""),
    slackLink: P.url(pr["슬랙링크"]),
    lastEdited: page.last_edited_time,
    created: page.created_time,
  };
}

function pageToWorklog(page: any): Worklog {
  const pr = page.properties ?? {};
  return {
    id: page.id,
    url: page.url,
    title: P.title(pr["제목"]),
    date: P.dateStart(pr["날짜"]),
    summary: P.text(pr["요약"]),
    obsidianPath: P.text(pr["Obsidian 경로"]),
    doneTaskIds: P.relation(pr["완료 작업"]),
    activeTaskIds: P.relation(pr["진행 작업"]),
  };
}

// ---------- 조회 ----------
async function queryAll(dbId: string, body: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion(`/databases/${dbId}/query`, {
      method: "POST",
      body: { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** 내가 담당자인 미완료 작업 (시작 전/진행 중/테스트 중/보완검토중) */
export async function listMyOpenTasks(): Promise<Task[]> {
  const rows = await queryAll(config.notion.tasksDbId, {
    filter: {
      and: [
        { property: "담당자", people: { contains: config.notion.meUserId } },
        { property: "진행 상태", status: { does_not_equal: "완료" } },
        { property: "진행 상태", status: { does_not_equal: "보관" } },
        { property: "진행 상태", status: { does_not_equal: "업무제외" } },
      ],
    },
    sorts: [{ property: "작업완료일", direction: "ascending" }],
  });
  return rows.map(pageToTask);
}

/** 특정 날짜(KST)에 편집된 "완료" 상태 작업 → 작업일지용 */
export async function listTasksCompletedOn(isoDate: string): Promise<Task[]> {
  const rows = await queryAll(config.notion.tasksDbId, {
    filter: {
      and: [
        { property: "진행 상태", status: { equals: "완료" } },
        { property: "담당자", people: { contains: config.notion.meUserId } },
        { timestamp: "last_edited_time", last_edited_time: { on_or_after: `${isoDate}T00:00:00+09:00` } },
        { timestamp: "last_edited_time", last_edited_time: { before: `${isoDate}T23:59:59+09:00` } },
      ],
    },
  });
  return rows.map(pageToTask);
}

/** 마감일이 있는 미완료/진행중 작업 전체 (캘린더 동기화용) */
export async function listTasksWithDue(): Promise<Task[]> {
  const rows = await queryAll(config.notion.tasksDbId, {
    filter: {
      and: [
        { property: "작업완료일", date: { is_not_empty: true } },
        { property: "진행 상태", status: { does_not_equal: "보관" } },
        { property: "진행 상태", status: { does_not_equal: "업무제외" } },
      ],
    },
  });
  return rows.map(pageToTask);
}

/** 최근 N분 안에 편집된 작업 (Obsidian → 볼트 동기화용) */
export async function listTasksEditedSince(isoDateTime: string): Promise<Task[]> {
  const rows = await queryAll(config.notion.tasksDbId, {
    filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: isoDateTime } },
  });
  return rows.map(pageToTask);
}

export async function getTask(pageId: string): Promise<Task> {
  return pageToTask(await notion(`/pages/${pageId}`));
}

/** 제목 일부로 작업 찾기 (Slack에서 "/할일 완료 프리셋" 같은 명령 처리용) */
export async function findTasksByTitle(keyword: string, openOnly = true): Promise<Task[]> {
  const and: any[] = [{ property: "작업", title: { contains: keyword } }];
  if (openOnly) and.push({ property: "진행 상태", status: { does_not_equal: "완료" } });
  const rows = await queryAll(config.notion.tasksDbId, { filter: { and }, page_size: 10 });
  return rows.map(pageToTask);
}

// ---------- 생성/수정 ----------
function taskProps(t: Partial<NewTask>) {
  const props: Record<string, unknown> = {};
  if (t.title !== undefined) props["작업"] = { title: [{ text: { content: t.title } }] };
  if (t.due !== undefined) props["작업완료일"] = t.due ? { date: { start: t.due } } : { date: null };
  if (t.priority) props["우선순위"] = { select: { name: t.priority } };
  if (t.status) props["진행 상태"] = { status: { name: t.status } };
  if (t.tags) props["태그"] = { multi_select: t.tags.map((name) => ({ name })) };
  if (t.assigneeIds) props["담당자"] = { people: t.assigneeIds.map((id) => ({ id })) };
  if (t.slackLink) props["슬랙링크"] = { url: t.slackLink };
  return props;
}

export async function createTask(t: NewTask): Promise<Task> {
  const body: any = {
    parent: { database_id: config.notion.tasksDbId },
    properties: taskProps({
      status: "시작 전",
      assigneeIds: [config.notion.meUserId],
      ...t,
    }),
  };
  if (t.note) {
    body.children = [
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: t.note } }] } },
    ];
  }
  return pageToTask(await notion("/pages", { method: "POST", body }));
}

export async function updateTask(pageId: string, patch: Partial<NewTask>): Promise<Task> {
  return pageToTask(await notion(`/pages/${pageId}`, { method: "PATCH", body: { properties: taskProps(patch) } }));
}

/** 페이지 본문에 문단 하나 추가 (작업일지 메모, Slack 코멘트 기록용) */
export async function appendParagraph(pageId: string, text: string): Promise<void> {
  await notion(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: {
      children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text.slice(0, 1900) } }] } }],
    },
  });
}

// ---------- 작업일지 ----------
export async function findWorklogByDate(isoDate: string): Promise<Worklog | null> {
  const rows = await queryAll(config.notion.worklogDbId, {
    filter: { property: "날짜", date: { equals: isoDate } },
    page_size: 1,
  });
  return rows.length ? pageToWorklog(rows[0]) : null;
}

export interface WorklogInput {
  date: string;
  summary?: string;
  obsidianPath?: string;
  doneTaskIds?: string[];
  activeTaskIds?: string[];
  source?: "자동" | "Slack" | "Obsidian" | "수동";
  bodyMarkdownLines?: string[];
}

function worklogProps(w: Partial<WorklogInput>) {
  const props: Record<string, unknown> = {};
  if (w.date) {
    props["제목"] = { title: [{ text: { content: `${w.date} 작업일지` } }] };
    props["날짜"] = { date: { start: w.date } };
  }
  if (w.summary !== undefined) props["요약"] = { rich_text: [{ text: { content: w.summary.slice(0, 1900) } }] };
  if (w.obsidianPath !== undefined) props["Obsidian 경로"] = { rich_text: [{ text: { content: w.obsidianPath } }] };
  if (w.doneTaskIds) props["완료 작업"] = { relation: w.doneTaskIds.map((id) => ({ id })) };
  if (w.activeTaskIds) props["진행 작업"] = { relation: w.activeTaskIds.map((id) => ({ id })) };
  if (w.source) props["출처"] = { select: { name: w.source } };
  return props;
}

/** 같은 날짜 작업일지가 있으면 갱신, 없으면 생성 */
export async function upsertWorklog(w: WorklogInput): Promise<Worklog> {
  const existing = await findWorklogByDate(w.date);
  if (existing) {
    const merged: Partial<WorklogInput> = { ...w };
    if (w.summary !== undefined && existing.summary && !existing.summary.includes(w.summary)) {
      merged.summary = `${existing.summary}\n${w.summary}`;
    }
    merged.doneTaskIds = uniq([...(existing.doneTaskIds ?? []), ...(w.doneTaskIds ?? [])]);
    merged.activeTaskIds = uniq([...(existing.activeTaskIds ?? []), ...(w.activeTaskIds ?? [])]);
    const page = await notion(`/pages/${existing.id}`, { method: "PATCH", body: { properties: worklogProps(merged) } });
    return pageToWorklog(page);
  }
  const body: any = { parent: { database_id: config.notion.worklogDbId }, properties: worklogProps(w) };
  if (w.bodyMarkdownLines?.length) {
    body.children = w.bodyMarkdownLines.slice(0, 90).map((line) => ({
      object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: line.slice(0, 1900) } }] },
    }));
  }
  return pageToWorklog(await notion("/pages", { method: "POST", body }));
}

function uniq<T>(arr: T[]): T[] { return [...new Set(arr)]; }

/** Notion 페이지 ID에서 하이픈 제거 (URL 생성용) */
export function compactId(id: string): string { return id.replace(/-/g, ""); }
