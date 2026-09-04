/**
 * 창고(원본): Obsidian 볼트의 할일 노트 — 기존 스킬(todo-capture)과 Vault-Kanban 앱의 형식을 그대로 따릅니다.
 *
 *  06_To Do/YYYY-MM/MMDD_제목.md           (YYYY-MM·MMDD는 생성일)
 *  ---
 *  project: 에너빌드                      필수. 비운 채 만들지 않는다
 *  sub_project: 에너지분석(에너빌드)
 *  priority: high | mid | low
 *  category: action                       고정
 *  status: planned | in-progress | review | done | backlog
 *  works:                                 네이버웍스 등록 여부 (works-todo 스킬 담당) — 건드리지 않음
 *  notion: assigned | registered | pending   assigned=할당받음, registered=발급됨(스킬), pending=발급 대기(봇이 표시)
 *  notion-url:
 *  notion-status:                         Notion 원본 상태 (봇이 확인 시 갱신)
 *  tags: []
 *  created: YYYY-MM-DD
 *  updated:
 *  completed:
 *  due:                                   (선택) Vault-Kanban·캘린더가 읽는 마감일
 *  ---
 *  ## 업무 개요 / ## 출처 / ## 체크리스트   — 본문은 봇이 "보존만" 합니다 (Vault-Kanban 규칙과 동일)
 *
 *  봇은 frontmatter만 고치고 파일을 옮기지 않습니다. 완료는 status: done + completed 날짜.
 */
import { config } from "./config.js";
import * as gh from "./github.js";
import { addDays, todayKST } from "./dates.js";

export type VaultStatus = "planned" | "in-progress" | "review" | "done" | "backlog";
export type Priority = "high" | "mid" | "low";
export const OPEN_STATUSES: VaultStatus[] = ["planned", "in-progress", "review", "backlog"];

export const STATUS_KO: Record<VaultStatus, string> = { planned: "예정", "in-progress": "진행중", review: "검토중", done: "완료", backlog: "백로그" };
export const PRIORITY_KO: Record<Priority, string> = { high: "높음", mid: "중간", low: "낮음" };

/** Vault-Kanban noteParser와 같은 정규화 규칙 */
export function normalizeStatus(v: unknown): VaultStatus {
  const s = typeof v === "string" ? v.trim() : "";
  if (/^(in.?progress|진행중?|진행\s*중)$/i.test(s)) return "in-progress";
  if (/^(done|완료됨?|finished|complete[d]?)$/i.test(s)) return "done";
  if (/^(todo|backlog|백로그|to.?do)$/i.test(s)) return "backlog";
  if (/^(planned?|예정|scheduled|upcoming)$/i.test(s)) return "planned";
  if (/^(review|검토중?|검토\s*중|in.?review|reviewing)$/i.test(s)) return "review";
  return s ? ("backlog" as VaultStatus) : "backlog";
}
export function normalizePriority(v: unknown): Priority | "" {
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "high" || s === "mid" || s === "low") return s;
  return ({ 높음: "high", 중간: "mid", 낮음: "low" } as Record<string, Priority>)[s] ?? "";
}

export interface VaultTask {
  /** 볼트 루트 기준 상대 경로 = 고유 ID (Slack 버튼 값으로도 사용) */
  path: string;
  sha: string;
  title: string;
  project: string;
  subProject: string;
  priority: Priority | "";
  status: VaultStatus;
  due: string | null;
  tags: string[];
  created: string;
  updated: string | null;
  completed: string | null;
  works: string | null;
  notion: "assigned" | "registered" | "pending" | "" | string;
  notionUrl: string | null;
  notionStatus: string | null;
  /** 원본 frontmatter (알 수 없는 키 보존용) — 키 순서 유지 */
  fm: Record<string, unknown>;
  fmOrder: string[];
  body: string;
}

// ---------- frontmatter (YAML 부분집합) ----------
export function parseFrontmatter(md: string): { fm: Record<string, unknown>; order: string[]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { fm: {}, order: [], body: md };
  const fm: Record<string, unknown> = {};
  const order: string[] = [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const mm = /^([A-Za-z0-9_\-가-힣 ]+):\s*(.*)$/.exec(line);
    if (!mm) continue;
    const key = mm[1].trim();
    let val = mm[2].trim();
    // 블록 리스트 (- item) 지원
    if (val === "" && lines[i + 1]?.match(/^\s+-\s+/)) {
      const items: string[] = [];
      while (lines[i + 1]?.match(/^\s+-\s+/)) { items.push(lines[++i].replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "")); }
      fm[key] = items; order.push(key); continue;
    }
    if (val === "") { fm[key] = null; order.push(key); continue; }
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      order.push(key); continue;
    }
    if (val === "true" || val === "false") { fm[key] = val === "true"; order.push(key); continue; }
    if (/^-?\d+(\.\d+)?$/.test(val)) { fm[key] = Number(val); order.push(key); continue; }
    fm[key] = val.replace(/^["']|["']$/g, "");
    order.push(key);
  }
  return { fm, order, body: m[2] };
}

function yamlValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return `[${v.map((s) => yamlScalar(String(s))).join(", ")}]`;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return yamlScalar(String(v));
}
/** todo-capture 노트처럼 따옴표 없이 쓰되, YAML이 오해할 문자가 있으면 따옴표 */
function yamlScalar(s: string): string {
  return /[:#\[\]{}&*!|>'"%@`,]|^\s|\s$|^(true|false|null|~)$/i.test(s) ? JSON.stringify(s) : s;
}

export function renderFrontmatter(fm: Record<string, unknown>, order: string[] = []): string {
  const keys = [...order.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !order.includes(k))];
  return ["---", ...keys.map((k) => `${k}: ${yamlValue(fm[k])}`.replace(/\s+$/, "")), "---"].join("\n");
}

// ---------- 변환 ----------
export function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "untitled";
}

/** 제목에서 [Step3] 같은 화면태그와 " / English" 병기를 떼고 짧게 (notion-todo-sync 규칙) */
export function shortTitle(title: string): string {
  return title.replace(/^\s*(\[[^\]]*\]\s*)+/, "").split(" / ")[0].trim().slice(0, 40) || title;
}

export function newTaskPath(title: string, date = todayKST()): string {
  const [y, m, d] = date.split("-");
  return `${config.vault.todoDir}/${y}-${m}/${m}${d}_${safeFileName(title)}.md`;
}

const str = (fm: Record<string, unknown>, k: string) => (typeof fm[k] === "string" && (fm[k] as string).trim() ? (fm[k] as string).trim() : null);

export function fileToTask(file: gh.VaultFile): VaultTask {
  const { fm, order, body } = parseFrontmatter(file.content);
  const base = file.path.split("/").pop()!.replace(/\.md$/, "");
  const title = str(fm, "title") ?? base.replace(/^\d{4}_/, "");
  return {
    path: file.path,
    sha: file.sha,
    title,
    project: str(fm, "project") ?? "",
    subProject: str(fm, "sub_project") ?? "",
    priority: normalizePriority(fm.priority ?? fm["우선순위"]),
    status: normalizeStatus(fm.status ?? fm["상태"]),
    due: str(fm, "due"),
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
    created: str(fm, "created") ?? "",
    updated: str(fm, "updated"),
    completed: str(fm, "completed"),
    works: str(fm, "works"),
    notion: str(fm, "notion") ?? "",
    notionUrl: str(fm, "notion-url"),
    notionStatus: str(fm, "notion-status"),
    fm, fmOrder: order, body,
  };
}

/** Notion URL → 32자리 hex ID (하이픈·/p/·?pvs 꼬리 제거) */
export function notionIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(url);
  return m ? (m[1] ?? m[2].replace(/-/g, "")).toLowerCase() : null;
}

export function obsidianUri(path: string): string | null {
  if (!config.vault.obsidianVaultName) return null;
  return `obsidian://open?vault=${encodeURIComponent(config.vault.obsidianVaultName)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

// ---------- 조회 ----------
/** 06_To Do 아래 모든 노트 (하위 폴더 포함). 파싱만 하고 파일은 건드리지 않습니다 */
export async function listAllTodoNotes(): Promise<VaultTask[]> {
  const tree = await gh.listTree(config.vault.todoDir);
  const mds = tree.filter((t) => t.type === "blob" && t.path.endsWith(".md") && !t.path.includes("/_"));
  const files = await gh.readMany(mds);
  return files.map(fileToTask);
}

export async function listOpenTasks(): Promise<VaultTask[]> {
  const all = await listAllTodoNotes();
  return all
    .filter((t) => OPEN_STATUSES.includes(t.status))
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || prioRank(a) - prioRank(b) || b.created.localeCompare(a.created));
}
function prioRank(t: VaultTask) { return t.priority === "high" ? 0 : t.priority === "mid" ? 1 : t.priority === "low" ? 2 : 3; }

export async function getTask(path: string): Promise<VaultTask | null> {
  const f = await gh.readFile(path);
  return f ? fileToTask(f) : null;
}

export async function findTasksByKeyword(keyword: string): Promise<VaultTask[]> {
  const k = keyword.toLowerCase();
  return (await listOpenTasks()).filter((t) => t.title.toLowerCase().includes(k) || t.path.toLowerCase().includes(k));
}

/** 특정 날짜에 완료된 할일 (completed == date) */
export async function listCompletedOn(date: string): Promise<VaultTask[]> {
  return (await listAllTodoNotes()).filter((t) => t.status === "done" && t.completed === date);
}

/**
 * 볼트 전체에서 notion-url을 가진 노트 수집 (중복 검사용, notion-todo-sync Step 3).
 * 06_To Do 전체 + 01_Projects 안의 01_진행업무 노트만 읽습니다.
 */
export async function collectNotionLinks(): Promise<Map<string, string>> {
  const tree = await gh.listTree();
  const targets = tree.filter((t) => t.type === "blob" && t.path.endsWith(".md") && (
    t.path.startsWith(`${config.vault.todoDir}/`) ||
    (t.path.startsWith(`${config.vault.projectsDir}/`) && t.path.includes("01_진행업무"))
  ));
  const files = await gh.readMany(targets);
  const map = new Map<string, string>();
  for (const f of files) {
    const m = /^notion-url:\s*(.+)$/m.exec(f.content.slice(0, 2000));
    const id = notionIdFromUrl(m?.[1]?.trim());
    if (id && !map.has(id)) map.set(id, f.path);
  }
  return map;
}

// ---------- 생성/수정 ----------
export interface NewVaultTask {
  title: string;
  project: string;
  subProject?: string;
  priority?: Priority;
  due?: string | null;
  tags?: string[];
  overview?: string;
  sources?: string[];       // "## 출처" 항목들
  checklist?: string[];
  notion?: "assigned" | "registered" | "pending";
  notionUrl?: string;
  notionStatus?: string;
  background?: string[];    // "## 배경"
}

export function renderNewTask(t: NewVaultTask, date = todayKST()): string {
  const fm: Record<string, unknown> = {
    project: t.project,
    sub_project: t.subProject ?? "",
    priority: t.priority ?? "mid",
    category: "action",
    status: "planned",
    works: "",
    ...(t.notion ? { notion: t.notion, "notion-url": t.notionUrl ?? "", "notion-status": t.notionStatus ?? "" } : {}),
    tags: t.tags ?? [],
    created: date,
    updated: "",
    completed: "",
    ...(t.due ? { due: t.due } : {}),
  };
  const lines = [
    renderFrontmatter(fm),
    "",
    "## 업무 개요",
    `- ${t.overview ?? t.title}`,
    "",
    "## 출처",
    ...(t.sources?.length ? t.sources.map((s) => `- ${s}`) : ["- "]),
    "",
    ...(t.background?.length ? ["## 배경", ...t.background.map((b) => `- ${b}`), ""] : []),
    "## 체크리스트",
    ...(t.checklist?.length ? t.checklist.map((c) => `- [ ] ${c}`) : ["- [ ] "]),
    "",
  ];
  return lines.join("\n");
}

export async function createTask(t: NewVaultTask): Promise<VaultTask> {
  if (!t.project) throw new Error("project 없이 할일 노트를 만들 수 없습니다 (todo-capture 규칙)");
  const date = todayKST();
  let path = newTaskPath(t.title, date);
  if (await gh.readFile(path)) path = path.replace(/\.md$/, ` (${Date.now().toString(36).slice(-4)}).md`);
  const content = renderNewTask(t, date);
  await gh.writeFile(path, content, `workhub: 할일 노트 생성 ${path.split("/").pop()}`);
  return fileToTask({ path, sha: "", content });
}

/** frontmatter 필드만 갱신 (본문·키 순서 보존). updated는 자동으로 오늘 날짜 */
export async function patchTask(task: VaultTask, patch: Record<string, unknown>): Promise<VaultTask> {
  const fm = { ...task.fm, ...patch, updated: todayKST() };
  const order = [...task.fmOrder];
  for (const k of Object.keys(patch)) if (!order.includes(k)) order.push(k);
  if (!order.includes("updated")) order.push("updated");
  const content = `${renderFrontmatter(fm, order)}\n${task.body.startsWith("\n") ? task.body : `\n${task.body}`}`;
  await gh.writeFile(task.path, content, `workhub: ${task.path.split("/").pop()} ${Object.keys(patch).join(",")}`, task.sha || undefined);
  return fileToTask({ path: task.path, sha: "", content });
}

export async function setStatus(task: VaultTask, status: VaultStatus): Promise<VaultTask> {
  const patch: Record<string, unknown> = { status };
  if (status === "done") patch.completed = todayKST();
  else if (task.completed) patch.completed = "";
  if (status === "in-progress" && !task.fm.started) patch.started = todayKST();
  return patchTask(task, patch);
}

// ---------- 프로젝트 판정 (todo-capture Step 4) ----------
export const PROJECTS = [
  "신재생에너지제안(EPC)", "에너빌드", "분산자원통합운영플랫폼", "연료전지급탕패키지", "BIPV특허기획", "ESS사업(스탠다드에너지)", "에너지노관리",
] as const;

const KEYWORDS: Array<[RegExp, string]> = [
  [/연료전지|데이터센터|교육청|송도|지열|제안\s*문건|미코파워|두산퓨얼셀|범한퓨얼셀/i, "신재생에너지제안(EPC)"],
  [/\bALT\b|\bQA\b|계산서|장비일람표|하이멕|세움터|디벨로퍼|샐리|공공민간|에너지절약계획서|에너지사용계획서|에너빌드|Step\s*\d|프리셋|대안/i, "에너빌드"],
  [/\bRTU\b|멀티빌딩|D-BEMS|해밀|일품/i, "분산자원통합운영플랫폼"],
  [/BIPV|조달우수|난연재|화재진단/i, "BIPV특허기획"],
  [/\bESS\b|스탠다드에너지|\bVIB\b/i, "ESS사업(스탠다드에너지)"],
  [/기업부설연구소|구독\s*서비스|강의|지명원/i, "에너지노관리"],
];

/** 제목·메모에서 project 추론. 못 정하면 null (→ 사용자에게 묻는다) */
export function guessProject(text: string): string | null {
  for (const [re, p] of KEYWORDS) if (re.test(text)) return p;
  const exact = PROJECTS.find((p) => text.includes(p));
  return exact ?? null;
}

/** Notion 에너빌드작업 티켓의 project/sub_project (notion-todo-sync Step 4) */
export function projectForTicket(tags: string[]): { project: string; subProject: string } {
  const noSub = ["웹사이트", "마케팅", "브랜딩", "동영상 제작", "영업지원"];
  return { project: "에너빌드", subProject: tags.some((t) => noSub.includes(t)) ? "" : "에너지분석(에너빌드)" };
}

/** Notion 우선순위 → 노트 priority (작업완료일이 7일 이내면 high) */
export function priorityForTicket(notionPriority: string, due: string | null, today = todayKST()): Priority {
  if (due && due <= addDays(today, 7)) return "high";
  if (notionPriority === "높음") return "high";
  if (notionPriority === "낮음") return "low";
  return "mid";
}

// ---------- 무시 목록 (Notion 할당 후보 중 등록하지 않기로 한 것) ----------
const IGNORE_PATH = () => `${config.vault.metaDir}/notion-ignored.txt`;

export async function readIgnored(): Promise<Set<string>> {
  const f = await gh.readFile(IGNORE_PATH());
  return new Set((f?.content ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
}
export async function addIgnored(notionId: string, title: string): Promise<void> {
  const f = await gh.readFile(IGNORE_PATH());
  const content = `${(f?.content ?? "").replace(/\s+$/, "")}\n${notionId}  # ${todayKST()} ${title}\n`.replace(/^\n/, "");
  await gh.writeFile(IGNORE_PATH(), content, `workhub: Notion 티켓 무시 ${title}`, f?.sha);
}

// ---------- 일일노트 작업일지 블록 ----------
const START = "<!-- WORKHUB-LOG:START -->";
const END = "<!-- WORKHUB-LOG:END -->";
const MEMO_HEADER = "### 📝 메모";

export async function findDailyNote(date: string): Promise<gh.VaultFile | null> {
  const [y, m] = date.split("-");
  for (const p of [`${config.vault.dailyDir}/${date}.md`, `${config.vault.dailyDir}/${y}-${m}/${date}.md`]) {
    const f = await gh.readFile(p);
    if (f) return f;
  }
  return null;
}
export function dailyNotePath(date: string): string { return `${config.vault.dailyDir}/${date}.md`; }

export function extractBlock(md: string): string | null {
  const s = md.indexOf(START), e = md.indexOf(END);
  return s >= 0 && e > s ? md.slice(s + START.length, e) : null;
}
export function extractMemos(md: string): string[] {
  const block = extractBlock(md) ?? md;
  const idx = block.indexOf(MEMO_HEADER);
  if (idx < 0) return [];
  const rest = block.slice(idx + MEMO_HEADER.length);
  const end = rest.search(/\n#{2,3} /);
  return (end < 0 ? rest : rest.slice(0, end)).split("\n").map((l) => l.replace(/^- /, "").trim()).filter((l) => l && l !== "-");
}

export interface WorklogView {
  date: string;
  done: VaultTask[];
  active: VaultTask[];
  events: Array<{ when: string; summary: string }>;
  memos: string[];
  ticketChanges?: Array<{ title: string; from: string | null; to: string }>;
}

const wikilink = (t: VaultTask) => `[[${t.path.replace(/\.md$/, "")}|${t.title}]]`;

export function renderBlock(w: WorklogView, generatedAt: string): string {
  return [
    START,
    "## 🗂 WorkHub 작업일지 (자동 생성)",
    `> 생성 ${generatedAt} KST · 완료 ${w.done.length} · 진행 중 ${w.active.length}`,
    "",
    "### ✅ 완료",
    ...(w.done.length ? w.done.map((t) => `- [x] ${wikilink(t)}${t.notionUrl ? ` ([Notion](${t.notionUrl}))` : ""}`) : ["- (없음)"]),
    "",
    "### 🔄 진행 중",
    ...(w.active.length ? w.active.map((t) => `- [ ] ${wikilink(t)}${t.due ? ` 📅 ${t.due}` : ""}`) : ["- (없음)"]),
    "",
    "### 📅 일정",
    ...(w.events.length ? w.events.map((e) => `- ${e.when} ${e.summary}`) : ["- (없음)"]),
    "",
    ...(w.ticketChanges?.length ? ["### 🎫 Notion 티켓 상태 변화", ...w.ticketChanges.map((c) => `- ${c.title}: ${c.from ?? "-"} → ${c.to}`), ""] : []),
    MEMO_HEADER,
    ...(w.memos.length ? w.memos.map((m) => `- ${m}`) : ["- "]),
    END,
  ].join("\n");
}

function upsertBlock(existing: string | null, block: string): string {
  if (existing == null) return `${block}\n`;
  const s = existing.indexOf(START), e = existing.indexOf(END);
  if (s >= 0 && e > s) return `${existing.slice(0, s)}${block}${existing.slice(e + END.length)}`;
  return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}

/** 일일노트의 마커 블록만 다시 씁니다. 블록 밖 내용은 절대 건드리지 않습니다 */
export async function writeWorklogBlock(w: Omit<WorklogView, "memos">): Promise<{ path: string; memos: string[] }> {
  const existing = await findDailyNote(w.date);
  const memos = existing ? extractMemos(existing.content) : [];
  const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const content = upsertBlock(existing?.content ?? null, renderBlock({ ...w, memos }, stamp));
  const path = existing?.path ?? dailyNotePath(w.date);
  await gh.writeFile(path, content, `workhub: 작업일지 ${w.date}`, existing?.sha);
  return { path, memos };
}

/** 메모 한 줄 추가 (블록이 없으면 최소 블록 생성) */
export async function appendMemo(date: string, memo: string): Promise<string> {
  const existing = await findDailyNote(date);
  const memos = existing ? extractMemos(existing.content) : [];
  memos.push(memo);
  const cur = existing ? extractBlock(existing.content) : null;
  let block: string;
  if (cur) {
    // 기존 블록에서 메모 섹션만 교체
    const idx = cur.indexOf(MEMO_HEADER);
    const head = idx >= 0 ? cur.slice(0, idx) : `${cur.replace(/\s+$/, "")}\n`;
    block = `${START}${head}${MEMO_HEADER}\n${memos.map((m) => `- ${m}`).join("\n")}\n${END}`;
  } else {
    const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    block = renderBlock({ date, done: [], active: [], events: [], memos }, stamp);
  }
  const content = upsertBlock(existing?.content ?? null, block);
  const path = existing?.path ?? dailyNotePath(date);
  await gh.writeFile(path, content, `workhub: 작업일지 메모 ${date}`, existing?.sha);
  return path;
}

export async function readMemos(date: string): Promise<string[]> {
  const f = await findDailyNote(date);
  return f ? extractMemos(f.content) : [];
}
