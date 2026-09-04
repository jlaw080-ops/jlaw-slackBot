/**
 * Obsidian 볼트 ↔ Notion 동기화
 *
 * 볼트 폴더 구조 (기본값, 환경변수로 변경 가능)
 *   WorkHub/
 *   ├─ Inbox/    ← 여기에 .md 파일을 만들면 Notion 할일로 자동 등록 (Obsidian → Notion)
 *   ├─ Tasks/    ← Notion 할일이 마크다운으로 내려옴. status를 바꾸면 Notion에 반영 (양방향)
 *   └─ Worklog/  ← 날짜별 작업일지 (Notion 작업일지와 동일 내용)
 */
import { config } from "./config.js";
import * as gh from "./github.js";
import {
  createTask, getTask, listMyOpenTasks, listTasksEditedSince, updateTask,
  type Task, type TaskStatus, type Priority,
} from "./notion.js";
import { parseDateInput } from "./dates.js";

const NOTES_MARKER = "%% ── 아래는 자유 메모 영역입니다. 위 속성은 봇이 관리합니다 ── %%";
const VALID_STATUS: TaskStatus[] = ["시작 전", "진행 중", "테스트 중", "보완검토중", "업무제외", "완료", "보관"];
const VALID_PRIORITY: Priority[] = ["낮음", "중간", "높음"];

// ---------- frontmatter ----------
export interface Frontmatter { [key: string]: string | string[] | boolean | null }

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
    let val = line.slice(idx + 1).trim();
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
    else if (v === null) lines.push(`${k}:`);
    else if (typeof v === "boolean") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(String(v))}`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------- 파일 이름 ----------
export function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
}
export function taskFilePath(t: Task): string {
  const short = t.id.replace(/-/g, "").slice(0, 8);
  return `${config.obsidian.tasksDir}/${safeFileName(t.title)} (${short}).md`;
}

// ---------- Notion → 마크다운 ----------
export function renderTaskMarkdown(t: Task, existingNotes = ""): string {
  const fm = renderFrontmatter({
    notion_id: t.id,
    title: t.title,
    status: t.status,
    synced_status: t.status, // 봇이 마지막으로 동기화한 상태 (충돌 판단용)
    priority: t.priority,
    due: t.due,
    tags: t.tags,
    url: t.url,
    updated: t.lastEdited,
  });
  const checkbox = t.status === "완료" ? "x" : " ";
  const head = [
    fm,
    "",
    `# ${t.title}`,
    "",
    `- [${checkbox}] ${t.title}  ⏳ ${t.due ?? "마감 없음"}  🔺 ${t.priority || "-"}  📌 ${t.status || "-"}`,
    `- 🔗 [Notion에서 열기](${t.url})`,
    "",
    NOTES_MARKER,
    "",
  ].join("\n");
  return head + existingNotes.replace(/^\s*\n/, "");
}

function extractNotes(md: string): string {
  const idx = md.indexOf(NOTES_MARKER);
  return idx < 0 ? "" : md.slice(idx + NOTES_MARKER.length);
}

// ---------- 동기화 ----------
export interface SyncResult {
  toVault: { written: number; skipped: number };
  fromInbox: string[];
  statusPushed: string[];
  errors: string[];
}

/**
 * 양방향 동기화 한 사이클.
 * 1) Inbox/*.md → Notion 할일 생성 → Tasks/로 이동
 * 2) Tasks/*.md 에서 status가 바뀐 파일 → Notion 갱신
 * 3) Notion 미완료 할일 (+최근 편집분) → Tasks/*.md 갱신
 */
export async function syncVault(opts: { sinceIso?: string } = {}): Promise<SyncResult> {
  const result: SyncResult = { toVault: { written: 0, skipped: 0 }, fromInbox: [], statusPushed: [], errors: [] };
  if (!config.obsidian.enabled) {
    result.errors.push("Obsidian 동기화 비활성 (OBSIDIAN_REPO/GITHUB_TOKEN 미설정)");
    return result;
  }

  // 1) Inbox → Notion
  for (const f of await gh.listDir(config.obsidian.inboxDir)) {
    if (!f.name.endsWith(".md")) continue;
    try {
      const file = await gh.readFile(f.path);
      if (!file) continue;
      const { fm, body } = parseFrontmatter(file.content);
      const title = String(fm.title ?? f.name.replace(/\.md$/, "")).trim();
      const due = typeof fm.due === "string" ? parseDateInput(fm.due) ?? fm.due : null;
      const priority = VALID_PRIORITY.includes(fm.priority as Priority) ? (fm.priority as Priority) : undefined;
      const tags = Array.isArray(fm.tags) ? fm.tags : undefined;
      const note = body.trim().slice(0, 1900) || undefined;
      const task = await createTask({ title, due, priority, tags, note });
      await gh.writeFile(taskFilePath(task), renderTaskMarkdown(task, body ? `\n${body.trim()}\n` : ""), `workhub: Inbox → Notion "${title}"`);
      await gh.deleteFile(f.path, file.sha, `workhub: Inbox 처리 완료 "${title}"`);
      result.fromInbox.push(title);
    } catch (e) {
      result.errors.push(`Inbox ${f.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2) Tasks/*.md 상태 변경 → Notion
  const vaultFiles = await gh.listDir(config.obsidian.tasksDir);
  const vaultByNotionId = new Map<string, { path: string; sha: string; content: string; fm: Frontmatter }>();
  for (const f of vaultFiles) {
    if (!f.name.endsWith(".md")) continue;
    try {
      const file = await gh.readFile(f.path);
      if (!file) continue;
      const { fm } = parseFrontmatter(file.content);
      const id = typeof fm.notion_id === "string" ? fm.notion_id : null;
      if (!id) continue;
      vaultByNotionId.set(id, { ...file, fm });
      const fileStatus = fm.status as TaskStatus;
      const synced = fm.synced_status as TaskStatus;
      if (fileStatus && synced && fileStatus !== synced && VALID_STATUS.includes(fileStatus)) {
        const current = await getTask(id);
        // Notion이 바뀌지 않았고(=synced와 동일) 파일만 바뀐 경우에만 파일 값을 밀어 넣음
        if (current.status === synced) {
          await updateTask(id, { status: fileStatus });
          result.statusPushed.push(`${current.title}: ${synced} → ${fileStatus}`);
        }
      }
    } catch (e) {
      result.errors.push(`Tasks ${f.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3) Notion → Tasks/*.md
  const open = await listMyOpenTasks();
  const recent = opts.sinceIso ? await listTasksEditedSince(opts.sinceIso) : [];
  const merged = new Map<string, Task>();
  for (const t of [...open, ...recent]) merged.set(t.id, t);
  for (const t of merged.values()) {
    try {
      const prev = vaultByNotionId.get(t.id);
      const notes = prev ? extractNotes(prev.content) : "";
      const path = taskFilePath(t);
      const changed = await gh.writeFile(path, renderTaskMarkdown(t, notes), `workhub: Notion → 볼트 "${t.title}"`);
      if (changed) result.toVault.written++; else result.toVault.skipped++;
      // 제목이 바뀌어 파일명이 달라졌으면 옛 파일 제거
      if (prev && prev.path !== path) await gh.deleteFile(prev.path, prev.sha, `workhub: 파일명 변경 "${t.title}"`);
    } catch (e) {
      result.errors.push(`Notion→볼트 ${t.title}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return result;
}

/** 작업일지 마크다운 파일 저장 */
export async function writeWorklogNote(date: string, markdown: string): Promise<string> {
  const path = `${config.obsidian.worklogDir}/${date}.md`;
  if (config.obsidian.enabled) await gh.writeFile(path, markdown, `workhub: 작업일지 ${date}`);
  return path;
}
