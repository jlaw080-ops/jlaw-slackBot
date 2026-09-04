/**
 * 창고(원본): Obsidian 볼트의 마크다운 할일 저장소
 *
 *  WorkHub/Tasks/<제목> (<id>).md     열린 할일 1개 = 파일 1개
 *  WorkHub/Archive/YYYY-MM/…          완료·취소된 할일
 *  WorkHub/Worklog/YYYY-MM-DD.md      날짜별 작업일지
 *
 * 파일 형식
 *  ---
 *  id: "k7x2m9ab"           봇이 붙이는 고유 ID (Slack 버튼·캘린더 연결에 사용)
 *  title: "ZEB 검토서 작성"
 *  status: "할일"           할일 | 진행중 | 보류 | 완료 | 취소
 *  priority: "높음"         높음 | 중간 | 낮음
 *  due: "2026-09-05"
 *  tags: ["리서치"]
 *  source: "slack"          slack | obsidian | notion
 *  created: "2026-09-04"
 *  completed:               완료 날짜
 *  notion_ticket:           발급한(또는 할당받은) Notion 티켓 URL
 *  notion_id:               Notion 페이지 ID
 *  notion_status:           마지막으로 확인한 Notion 진행 상태
 *  ---
 *  본문은 자유 메모. Obsidian에서 직접 편집해도 됩니다. 봇은 frontmatter만 갱신합니다.
 */
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import * as gh from "./github.js";
import { todayKST } from "./dates.js";

export type VaultStatus = "할일" | "진행중" | "보류" | "완료" | "취소";
export type Priority = "높음" | "중간" | "낮음";
export const OPEN_STATUSES: VaultStatus[] = ["할일", "진행중", "보류"];
export const VALID_STATUS: VaultStatus[] = ["할일", "진행중", "보류", "완료", "취소"];
export const VALID_PRIORITY: Priority[] = ["높음", "중간", "낮음"];

export interface VaultTask {
  id: string;
  title: string;
  status: VaultStatus;
  priority: Priority | "";
  due: string | null;
  tags: string[];
  source: "slack" | "obsidian" | "notion" | string;
  created: string;
  completed: string | null;
  notionTicket: string | null;
  notionId: string | null;
  notionStatus: string | null;
  body: string;   // frontmatter 아래 본문
  path: string;
  sha: string;
}

export interface NewVaultTask {
  title: string;
  due?: string | null;
  priority?: Priority;
  tags?: string[];
  source?: VaultTask["source"];
  body?: string;
  notionTicket?: string | null;
  notionId?: string | null;
  notionStatus?: string | null;
  status?: VaultStatus;
}

// ---------- frontmatter ----------
export type Frontmatter = Record<string, string | string[] | boolean | null>;

export function parseFrontmatter(md: string): { fm: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { fm: {}, body: md };
  const fm: Frontmatter = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val === "") { fm[key] = null; continue; }
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      continue;
    }
    if (val === "true" || val === "false") { fm[key] = val === "true"; continue; }
    fm[key] = val.replace(/^["']|["']$/g, "");
  }
  return { fm, body: m[2] };
}

export function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((s) => JSON.stringify(String(s))).join(", ")}]`);
    else if (v === null || v === "") lines.push(`${k}:`);
    else if (typeof v === "boolean") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(String(v))}`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------- 변환 ----------
export function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
}
export function newId(): string { return randomBytes(4).toString("hex"); }

export function taskPath(t: Pick<VaultTask, "id" | "title" | "status" | "completed">): string {
  const name = `${safeFileName(t.title)} (${t.id}).md`;
  if (t.status === "완료" || t.status === "취소") {
    const month = (t.completed ?? todayKST()).slice(0, 7);
    return `${config.vault.archiveDir}/${month}/${name}`;
  }
  return `${config.vault.tasksDir}/${name}`;
}

export function fileToTask(file: gh.VaultFile): VaultTask | null {
  const { fm, body } = parseFrontmatter(file.content);
  const title = typeof fm.title === "string" ? fm.title : file.path.split("/").pop()!.replace(/ \([0-9a-f]{8}\)\.md$|\.md$/, "");
  const str = (k: string) => (typeof fm[k] === "string" ? (fm[k] as string) : null);
  const status = VALID_STATUS.includes(fm.status as VaultStatus) ? (fm.status as VaultStatus) : "할일";
  return {
    id: str("id") ?? "",
    title,
    status,
    priority: VALID_PRIORITY.includes(fm.priority as Priority) ? (fm.priority as Priority) : "",
    due: str("due"),
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    source: str("source") ?? "obsidian",
    created: str("created") ?? todayKST(),
    completed: str("completed"),
    notionTicket: str("notion_ticket"),
    notionId: str("notion_id"),
    notionStatus: str("notion_status"),
    body,
    path: file.path,
    sha: file.sha,
  };
}

export function renderTask(t: Omit<VaultTask, "path" | "sha">): string {
  const fm = renderFrontmatter({
    id: t.id, title: t.title, status: t.status, priority: t.priority, due: t.due, tags: t.tags,
    source: t.source, created: t.created, completed: t.completed,
    notion_ticket: t.notionTicket, notion_id: t.notionId, notion_status: t.notionStatus,
  });
  const body = t.body.trim() ? `\n${t.body.replace(/^\s+/, "").replace(/\s+$/, "")}\n` : "\n";
  return `${fm}\n${body}`;
}

/** Obsidian에서 바로 여는 링크 (볼트 이름을 설정한 경우) */
export function obsidianUri(path: string): string | null {
  if (!config.vault.obsidianVaultName) return null;
  return `obsidian://open?vault=${encodeURIComponent(config.vault.obsidianVaultName)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

// ---------- 조회 ----------
/** 열린 할일 전체 (id가 없는 손으로 만든 파일에는 id를 붙여 저장) */
export async function listOpenTasks(): Promise<VaultTask[]> {
  const files = await gh.readDirMarkdown(config.vault.tasksDir);
  const tasks: VaultTask[] = [];
  for (const f of files) {
    const t = fileToTask(f);
    if (!t) continue;
    if (!t.id) {
      // Obsidian에서 직접 만든 파일: id를 부여하고 정식 형식으로 저장 (Obsidian → 창고 등록)
      t.id = newId();
      t.source = "obsidian";
      const path = taskPath(t);
      await gh.moveFile(f, path, renderTask(t), `workhub: 볼트 할일 등록 "${t.title}"`);
      t.path = path;
    }
    if (t.status === "완료" || t.status === "취소") {
      // Obsidian에서 status를 완료로 바꾼 파일 → Archive로 이동
      t.completed = t.completed ?? todayKST();
      await gh.moveFile({ path: t.path, sha: t.sha, content: "" }, taskPath(t), renderTask(t), `workhub: 완료 보관 "${t.title}"`);
      continue;
    }
    tasks.push(t);
  }
  return tasks.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || prioRank(a) - prioRank(b));
}
function prioRank(t: VaultTask) { return t.priority === "높음" ? 0 : t.priority === "중간" ? 1 : t.priority === "낮음" ? 2 : 3; }

export async function findTaskById(id: string): Promise<VaultTask | null> {
  const open = await listOpenTasks();
  const hit = open.find((t) => t.id === id);
  if (hit) return hit;
  // 최근 두 달 Archive 확인
  for (const month of [todayKST().slice(0, 7), prevMonth(todayKST())]) {
    const files = await gh.readDirMarkdown(`${config.vault.archiveDir}/${month}`);
    for (const f of files) { const t = fileToTask(f); if (t?.id === id) return t; }
  }
  return null;
}
function prevMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export async function findTasksByKeyword(keyword: string): Promise<VaultTask[]> {
  const k = keyword.toLowerCase();
  return (await listOpenTasks()).filter((t) => t.title.toLowerCase().includes(k));
}

/** 특정 날짜에 완료된 할일 (Archive/YYYY-MM 에서 completed == date) */
export async function listCompletedOn(date: string): Promise<VaultTask[]> {
  const files = await gh.readDirMarkdown(`${config.vault.archiveDir}/${date.slice(0, 7)}`);
  return files.map(fileToTask).filter((t): t is VaultTask => Boolean(t && t.completed === date && t.status === "완료"));
}

// ---------- 생성/수정 ----------
export async function createTask(input: NewVaultTask): Promise<VaultTask> {
  const t: Omit<VaultTask, "path" | "sha"> = {
    id: newId(),
    title: input.title.trim(),
    status: input.status ?? "할일",
    priority: input.priority ?? "",
    due: input.due ?? null,
    tags: input.tags ?? [],
    source: input.source ?? "slack",
    created: todayKST(),
    completed: null,
    notionTicket: input.notionTicket ?? null,
    notionId: input.notionId ?? null,
    notionStatus: input.notionStatus ?? null,
    body: input.body ?? "",
  };
  const path = taskPath(t);
  await gh.writeFile(path, renderTask(t), `workhub: 할일 추가 "${t.title}"`);
  return { ...t, path, sha: "" };
}

export async function updateTask(task: VaultTask, patch: Partial<Omit<VaultTask, "path" | "sha" | "id">>): Promise<VaultTask> {
  const next: VaultTask = { ...task, ...patch };
  if ((next.status === "완료" || next.status === "취소") && !next.completed) next.completed = todayKST();
  if (OPEN_STATUSES.includes(next.status)) next.completed = null;
  const newPath = taskPath(next);
  const content = renderTask(next);
  if (newPath !== task.path) {
    await gh.moveFile({ path: task.path, sha: task.sha, content: task.body }, newPath, content, `workhub: "${next.title}" → ${next.status}`);
  } else {
    await gh.writeFile(newPath, content, `workhub: "${next.title}" 갱신`, task.sha || undefined);
  }
  return { ...next, path: newPath };
}

export async function setStatus(task: VaultTask, status: VaultStatus): Promise<VaultTask> {
  return updateTask(task, { status });
}

// ---------- 작업일지 ----------
export function worklogPath(date: string): string { return `${config.vault.worklogDir}/${date}.md`; }

const MEMO_HEADER = "## 📝 메모";

/** 작업일지 파일에서 메모 섹션의 줄들만 추출 */
export function extractMemos(md: string): string[] {
  const idx = md.indexOf(MEMO_HEADER);
  if (idx < 0) return [];
  const rest = md.slice(idx + MEMO_HEADER.length);
  const end = rest.search(/\n## /);
  const block = end < 0 ? rest : rest.slice(0, end);
  return block.split("\n").map((l) => l.replace(/^- /, "").trim()).filter((l) => l && l !== "-");
}

/** 오늘 작업일지 파일에 메모 한 줄 추가 (파일이 없으면 최소 골격 생성) */
export async function appendMemo(date: string, memo: string): Promise<string> {
  const path = worklogPath(date);
  const existing = await gh.readFile(path);
  let content: string;
  if (!existing) {
    content = renderWorklog({ date, done: [], active: [], events: [], memos: [memo] });
  } else if (existing.content.includes(MEMO_HEADER)) {
    const idx = existing.content.indexOf(MEMO_HEADER) + MEMO_HEADER.length;
    const head = existing.content.slice(0, idx);
    const tail = existing.content.slice(idx);
    const end = tail.search(/\n## /);
    const memoBlock = (end < 0 ? tail : tail.slice(0, end)).replace(/\s+$/, "");
    const after = end < 0 ? "" : tail.slice(end);
    content = `${head}${memoBlock}\n- ${memo}\n${after}`;
  } else {
    content = `${existing.content.replace(/\s+$/, "")}\n\n${MEMO_HEADER}\n- ${memo}\n`;
  }
  await gh.writeFile(path, content, `workhub: 작업일지 메모 ${date}`, existing?.sha);
  return path;
}

export interface WorklogView {
  date: string;
  done: VaultTask[];
  active: VaultTask[];
  events: Array<{ when: string; summary: string }>;
  memos: string[];
}

export function renderWorklog(w: WorklogView): string {
  const link = (t: VaultTask) => t.notionTicket ? `[[${t.path.replace(/\.md$/, "")}|${t.title}]] ([Notion](${t.notionTicket}))` : `[[${t.path.replace(/\.md$/, "")}|${t.title}]]`;
  return [
    "---",
    `date: ${w.date}`,
    "type: worklog",
    `done: ${w.done.length}`,
    `active: ${w.active.length}`,
    "tags: [worklog]",
    "---",
    "",
    `# ${w.date} 작업일지`,
    "",
    "## ✅ 완료",
    ...(w.done.length ? w.done.map((t) => `- [x] ${link(t)}${t.tags.length ? ` #${t.tags.join(" #")}` : ""}`) : ["- (없음)"]),
    "",
    "## 🔄 진행 중",
    ...(w.active.length ? w.active.map((t) => `- [ ] ${link(t)}${t.due ? ` 📅 ${t.due}` : ""}`) : ["- (없음)"]),
    "",
    "## 📅 일정",
    ...(w.events.length ? w.events.map((e) => `- ${e.when} ${e.summary}`) : ["- (없음)"]),
    "",
    MEMO_HEADER,
    ...(w.memos.length ? w.memos.map((m) => `- ${m}`) : ["- "]),
    "",
  ].join("\n");
}

/** 작업일지 파일을 통째로 다시 씁니다 (메모는 기존 것을 보존) */
export async function writeWorklog(w: Omit<WorklogView, "memos">): Promise<{ path: string; memos: string[] }> {
  const path = worklogPath(w.date);
  const existing = await gh.readFile(path);
  const memos = existing ? extractMemos(existing.content) : [];
  await gh.writeFile(path, renderWorklog({ ...w, memos }), `workhub: 작업일지 ${w.date}`, existing?.sha);
  return { path, memos };
}

export async function readMemos(date: string): Promise<string[]> {
  const f = await gh.readFile(worklogPath(date));
  return f ? extractMemos(f.content) : [];
}
