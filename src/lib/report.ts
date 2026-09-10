/**
 * 일일보고 초안 — 오늘 볼트에 쌓인 것을 모아 팀 공유용 양식으로 엮습니다.
 *
 *   **일일보고(김지헌) - 2026-09-04**
 *
 *   1. 항목 제목
 *       - 진행 내용
 *       - 예정사항: …
 *       - https://works.do/…
 *
 * **초안입니다.** 문장을 다듬는 것은 사람 몫이고, 봇은 재료를 모아 자리에 놓기만 합니다.
 * 일일노트에는 사람이 쓴 영역을 건드리지 않도록 별도 마커 블록에 넣습니다.
 */
import { config } from "./config.js";
import * as gh from "./github.js";
import { addDays, todayKST } from "./dates.js";
import { findDailyNote, dailyNotePath, extractMemos, parseFrontmatter, isExcludedPath, type VaultTask, fileToTask } from "./vault.js";

export const REPORT_START = "<!-- WORKHUB-REPORT:START -->";
export const REPORT_END = "<!-- WORKHUB-REPORT:END -->";

export interface ReportItem {
  title: string;
  project: string;
  bullets: string[];
  links: string[];
  done: boolean;
  /** 어디서 왔는지 — Slack 안내용 */
  from: "할일" | "진행업무" | "메모" | "일일노트" | "프로젝트노트";
}

// ---------- 본문에서 꺼내기 ----------
/** `## <제목>` 섹션의 본문 (다음 ## 앞까지) */
export function section(md: string, heading: string): string {
  const re = new RegExp(`^##\\s*${heading}\\s*$`, "m");
  const m = re.exec(md);
  if (!m) return "";
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/\n##\s/);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/** 불릿(- , · , 1. )을 글머리 없는 문장으로 */
export function bullets(text: string, limit = 6): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*·]|\d+\.)\s*/, "").trim())
    .filter((l) => l && l !== "-" && !/^\[[ x]\]$/.test(l))
    .map((l) => l.replace(/^\[x\]\s*/i, "").replace(/^\[ \]\s*/, ""))
    .filter(Boolean)
    .slice(0, limit);
}

/** 진행업무 노트의 `## 진행` 중 그 날짜 항목의 하위 불릿 */
export function progressOn(md: string, date: string): string[] {
  const sec = section(md, "진행");
  if (!sec) return [];
  const lines = sec.split("\n");
  const out: string[] = [];
  let inDay = false;
  for (const line of lines) {
    const head = /^\s*(?:[-*]|\d+\.)\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (head) { inDay = head[1] === date; continue; }
    if (!inDay) continue;
    const item = line.replace(/^\s*(?:[-*·])\s*/, "").trim();
    if (item) out.push(item);
  }
  return out.slice(0, 6);
}

// ---------- 일일노트에 사람이 직접 쓴 부분 ----------
/** 자동 생성 블록과 git 충돌 표시를 걷어내고, 사람이 쓴 본문만 남깁니다 */
export function stripBlocks(md: string): string {
  return md
    .replace(/<!-- WORKHUB-LOG:START -->[\s\S]*?<!-- WORKHUB-LOG:END -->/g, "")
    .replace(/<!-- WORKHUB-REPORT:START -->[\s\S]*?<!-- WORKHUB-REPORT:END -->/g, "")
    .replace(/^(?:<{7}|={7}|>{7}).*$/gm, "")                                  // git 충돌 표시
    .replace(/^---\n[\s\S]*?\n---\n/, "")                                    // frontmatter
    .replace(/^\s*\*\*일일보고\(.*?\)\s*[-–]\s*\d{4}-\d{2}-\d{2}\*\*\s*$/gm, ""); // 중복 제목줄
}

const indentWidth = (s: string) => [...s].reduce((n, c) => n + (c === "\t" ? 4 : 1), 0);
const cleanLine = (s: string) =>
  s.replace(/^\[[ xX]\]\s*/, "").replace(/\*\*/g, "").replace(/\s+$/, "").trim();

interface RawBullet { w: number; text: string }

/**
 * 일일노트 본문을 보고 항목을 뽑습니다.
 *   `## 제목` / `1. 제목`  → 항목
 *   `- 내용`               → 그 항목의 하위 내용 (들여쓰기 깊이 유지)
 * 어느 항목에도 안 붙는 줄은 「기타」로 모읍니다.
 */
export function handwritten(md: string): ReportItem[] {
  const items: ReportItem[] = [];
  let title = "";
  let done = false;
  let raw: RawBullet[] = [];

  const flush = () => {
    if (!title && !raw.length) return;
    const min = raw.length ? Math.min(...raw.map((b) => b.w)) : 0;
    items.push({
      title: title || "기타",
      project: "",
      bullets: raw.map((b) => "\t".repeat(Math.min(3, Math.round((b.w - min) / 4))) + b.text),
      links: [],
      done,
      from: "일일노트",
    });
    title = ""; done = false; raw = [];
  };
  const start = (t: string, isDone: boolean) => { flush(); title = t; done = isDone; };

  for (const line of stripBlocks(md).split("\n")) {
    if (!line.trim()) continue;
    const isDone = /^\s*(?:[-*·]|\d+[.)]|#{1,4})?\s*\[[xX]\]/.test(line);

    const head = /^#{1,4}\s+(.+?)\s*#*$/.exec(line);
    if (head) { start(cleanLine(head[1]), isDone); continue; }

    const num = /^[ \t]{0,3}\d+[.)]\s+(.+)$/.exec(line);
    if (num) { start(cleanLine(num[1]), isDone); continue; }

    const bul = /^([ \t]*)[-*·]\s+(.+)$/.exec(line);
    if (bul) {
      const text = cleanLine(bul[2]);
      if (text) raw.push({ w: indentWidth(bul[1]), text });
      continue;
    }

    const text = cleanLine(line);
    if (!text) continue;
    if (!title && !raw.length) title = text; else raw.push({ w: 0, text });
  }
  flush();
  return items.filter((i) => i.title !== "기타" || i.bullets.length);
}

// ---------- 재료 모으기 ----------
const MMDD = (d: string) => d.slice(5).replace("-", "");

/** 최근 며칠 안에 만들어진 진행업무 노트만 읽습니다 (볼트 전체를 읽지 않기 위해) */
async function recentWorkNotes(date: string, days = 14): Promise<gh.VaultFile[]> {
  const prefixes = new Set<string>();
  for (let i = 0; i < days; i++) prefixes.add(MMDD(addDays(date, -i)));
  const tree = await gh.listTree();
  const targets = tree.filter((t) => {
    if (t.type !== "blob" || !t.path.endsWith(".md")) return false;
    if (!t.path.includes("/01_진행업무/")) return false;
    const base = t.path.split("/").pop()!;
    return prefixes.has(base.slice(0, 4));
  });
  return gh.readMany(targets);
}

const worksUrl = (fm: Record<string, unknown>) => {
  const v = fm["works-url"] ?? fm["works_url"];
  return typeof v === "string" && v.startsWith("http") ? v : null;
};

/** 그날 움직인 할일 노트인가 */
function movedToday(t: VaultTask, date: string): boolean {
  return t.completed === date || t.updated === date || t.created === date || String(t.fm.started ?? "") === date;
}

export async function collectReport(date = todayKST()): Promise<ReportItem[]> {
  const items: ReportItem[] = [];

  // 1) 진행업무 노트 — 그날 `## 진행`에 적힌 내용이 곧 보고 내용
  const workNotes = await recentWorkNotes(date);
  const readPaths = new Set(workNotes.map((f) => f.path));
  for (const f of workNotes) {
    const { fm, body } = parseFrontmatter(f.content);
    const lines = progressOn(body, date);
    const isToday = f.path.split("/").pop()!.slice(0, 4) === MMDD(date);
    if (!lines.length && !isToday) continue;
    const title = (/^#\s+(.+)$/m.exec(body)?.[1] ?? f.path.split("/").pop()!.replace(/\.md$/, "").replace(/^\d{4}_/, "")).trim();
    items.push({
      title,
      project: String(fm.project ?? ""),
      bullets: lines.length ? lines : bullets(section(body, "요약") || section(body, "업무 개요")),
      links: [worksUrl(fm), typeof fm["notion-url"] === "string" ? (fm["notion-url"] as string) : null].filter((x): x is string => Boolean(x)),
      done: String(fm.status ?? "") === "done",
      from: "진행업무",
    });
  }

  // 2) 그날 움직인 할일 노트
  const tree = await gh.listTree(config.vault.todoDir);
  const mds = tree.filter((t) => t.type === "blob" && t.path.endsWith(".md"));
  for (const f of await gh.readMany(mds)) {
    const task = fileToTask(f);
    if (!movedToday(task, date)) continue;
    if (items.some((i) => i.title === task.title)) continue; // 진행업무 노트와 겹치면 건너뜀
    const done = task.status === "done";
    items.push({
      title: task.title,
      project: task.project,
      bullets: bullets(section(task.body, "진행상황")).length
        ? bullets(section(task.body, "진행상황"))
        : bullets(section(task.body, "업무 개요"), 2),
      links: [worksUrl(task.fm), task.notionUrl].filter((x): x is string => Boolean(x)),
      done,
      from: "할일",
    });
  }

  const daily = await findDailyNote(date);

  // 3) 일일노트에 사람이 직접 쓴 내용 — 봇 블록 바깥
  if (daily) {
    for (const it of handwritten(daily.content)) {
      if (items.some((x) => x.title === it.title)) continue;
      items.push(it);
    }
  }

  // 4) 그날 날짜가 붙은 프로젝트 노트 (미팅노트 등) — 제목만
  for (const it of await projectNotesOn(date, readPaths)) {
    if (items.some((x) => x.title === it.title)) continue;
    items.push(it);
  }

  // 5) 일일노트 메모 — 어느 항목에도 안 붙는 것들
  const memos = daily ? extractMemos(daily.content).map((m) => m.replace(/^\d{1,2}:\d{2}\s*/, "")) : [];
  if (memos.length) items.push({ title: "기타", project: "", bullets: memos.slice(0, 8), links: [], done: false, from: "메모" });

  return items;
}

// ---------- 그날 날짜가 붙은 프로젝트 노트 ----------
/**
 * `01_Projects/` 아래에서 **파일 이름에 그날 날짜가 박힌** 노트를 찾습니다.
 * 미팅노트처럼 진행업무·할일 어디에도 안 걸리는 기록을 놓치지 않기 위한 것입니다.
 *
 * 본문은 읽지 않고 **제목만** 항목으로 올립니다. 회의록은 수백 줄짜리도 있어
 * 그대로 퍼오면 보고서가 못 쓰게 되기 때문입니다. 내용은 사람이 채웁니다.
 */
export function dateInFileName(base: string, date: string): boolean {
  const [y, m, d] = date.split("-");
  return [`${m}${d}_`, `${y}.${m}.${d}`, `${y}-${m}-${d}`, `${y}${m}${d}`].some((p) => base.startsWith(p));
}

/** 파일 이름에서 날짜 접두사와 확장자를 떼어 제목으로 */
export function titleFromFileName(base: string): string {
  return base
    .replace(/\.md$/, "")
    .replace(/^(?:\d{4}[.\-]\d{2}[.\-]\d{2}|\d{8}|\d{4})[_\-. ]*/, "")
    .trim();
}

/** 한 번에 올릴 수 있는 제목 수 — 하루에 문서를 여러 개 쪼개 써도 보고서가 넘치지 않게 */
const PROJECT_NOTE_LIMIT = 12;

/**
 * `skip` 은 1번 재료(recentWorkNotes)가 이미 본문까지 읽은 파일들의 경로입니다.
 * `01_진행업무` 폴더 전체를 빼면 그 안 하위 폴더(`…/dc_capacity/docs/`)에 남긴
 * 그날 문서까지 사라지므로, 실제로 겹치는 파일만 뺍니다.
 */
export async function projectNotesOn(date: string, skip: Set<string> = new Set()): Promise<ReportItem[]> {
  const tree = await gh.listTree("01_Projects");
  return tree
    .filter((t) => {
      if (t.type !== "blob" || !t.path.endsWith(".md")) return false;
      if (skip.has(t.path)) return false;
      if (isExcludedPath(t.path)) return false;
      return dateInFileName(t.path.split("/").pop()!, date);
    })
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, PROJECT_NOTE_LIMIT)
    .map((t) => {
      const parts = t.path.split("/");
      return {
        title: titleFromFileName(parts.pop()!),
        project: parts[1] ? parts[1].replace(/^\d{2}_/, "") : "",
        bullets: [],
        links: [],
        done: false,
        from: "프로젝트노트" as const,
      };
    })
    .filter((i) => i.title);
}

// ---------- 양식으로 엮기 ----------
export function renderReport(items: ReportItem[], date = todayKST(), author = config.reportAuthor): string {
  const head = `**일일보고(${author}) - ${date}**`;
  if (!items.length) return [head, "", "1. (오늘 기록된 작업이 없습니다)", ""].join("\n");
  const body = items.map((it, i) => {
    const lines = [`${i + 1}. ${it.title}${it.done ? " (완료)" : ""}`];
    for (const b of it.bullets.length ? it.bullets : ["(내용 입력)"]) {
      const depth = /^\t*/.exec(b)![0].length;
      lines.push(`${"    ".repeat(depth + 1)}- ${b.slice(depth)}`);
    }
    for (const l of it.links) lines.push(`    - ${l}`);
    return lines.join("\n");
  });
  return [head, "", ...body, ""].join("\n");
}

/** 일일노트에 초안 블록을 넣습니다. 사람이 쓴 부분은 건드리지 않습니다 */
export async function writeReportBlock(text: string, date = todayKST()): Promise<{ path: string; created: boolean }> {
  const existing = await findDailyNote(date);
  const block = [
    REPORT_START,
    "## 📝 일일보고 초안 (자동 생성 — 다듬어서 위로 옮기세요)",
    "",
    text.trim(),
    REPORT_END,
  ].join("\n");

  const cur = existing?.content ?? "";
  const s = cur.indexOf(REPORT_START);
  const e = cur.indexOf(REPORT_END);
  const content = s >= 0 && e > s
    ? `${cur.slice(0, s)}${block}${cur.slice(e + REPORT_END.length)}`
    : cur
      ? `${cur.replace(/\s+$/, "")}\n\n${block}\n`
      : `${block}\n`;

  const path = existing?.path ?? dailyNotePath(date);
  await gh.writeFile(path, content, `workhub: 일일보고 초안 ${date}`, existing?.sha);
  return { path, created: !(s >= 0 && e > s) };
}
