/**
 * 작업일지 → 프로젝트 노트 (01_Projects/<프로젝트>/<서브>/01_진행업무/MMDD_주제/MMDD_주제.md)
 *
 * 스킬(notion-qa-ticket/reference/vault-note.md)의 규칙을 그대로 따릅니다.
 *  - 폴더 경로를 **임의로 만들지 않는다**: 볼트에 이미 있는 `01_진행업무` 폴더 안에만 넣습니다.
 *  - 프로젝트/서브를 못 정하면 만들지 않고 사용자에게 되묻습니다.
 *  - 같은 이름의 노트가 이미 있으면 **덮어쓰지 않고** `## 진행`에 한 줄 덧붙입니다.
 */
import { config } from "./config.js";
import * as gh from "./github.js";
import { todayKST } from "./dates.js";
import { guessProject, PROJECTS, safeFileName } from "./vault.js";

/** todo-capture SKILL.md의 경로 표 (프로젝트 이름 → 볼트 폴더) */
const PROJECT_DIRS: Record<string, string> = {
  "신재생에너지제안(EPC)": "01_Projects/01_신재생에너지검토제안(EPC)",
  에너빌드: "01_Projects/02_에너빌드",
  분산자원통합운영플랫폼: "01_Projects/03_분산자원통합운영플랫폼",
  연료전지급탕패키지: "01_Projects/10_연료전지급탕패키지",
  BIPV특허기획: "01_Projects/11_BIPV화재진단기술",
  "ESS사업(스탠다드에너지)": "01_Projects/12_ESS사업(스탠다드에너지)",
  에너지노관리: "02_Areas/10_에너지노행정관련",
};

const WORK_DIR = "01_진행업무";

/** 설정한 projectsDir 이름을 반영한 프로젝트 폴더 경로 */
export function projectDir(project: string): string | null {
  const d = PROJECT_DIRS[project];
  if (!d) return null;
  return d.startsWith("01_Projects/") ? `${config.vault.projectsDir}/${d.slice("01_Projects/".length)}` : d;
}

export interface WorkDir {
  /** 볼트 경로 (예: 01_Projects/02_에너빌드/03_에너지분석/01_진행업무) */
  path: string;
  /** 폴더 이름에서 숫자 접두어를 뗀 라벨 (예: 에너지분석). 서브 폴더가 없으면 "" */
  label: string;
}

const stripPrefix = (name: string) => name.replace(/^\d+[_\-.\s]*/, "").trim();

/** 프로젝트 폴더 아래에 실제로 존재하는 01_진행업무 폴더들 */
export async function listWorkDirs(project: string): Promise<WorkDir[]> {
  const base = projectDir(project);
  if (!base) return [];
  const tree = await gh.listTree();
  const out: WorkDir[] = [];
  for (const t of tree) {
    if (t.type !== "tree") continue;
    if (!t.path.startsWith(`${base}/`) || !t.path.endsWith(`/${WORK_DIR}`)) continue;
    const middle = t.path.slice(base.length + 1, t.path.length - WORK_DIR.length - 1);
    if (middle.includes("/")) continue; // 서브의 서브까지는 다루지 않는다
    out.push({ path: t.path, label: stripPrefix(middle) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export type Resolution =
  | { ok: true; workDir: WorkDir; project: string }
  | { ok: false; reason: "no-project"; }
  | { ok: false; reason: "no-workdir"; project: string }
  | { ok: false; reason: "ambiguous"; project: string; choices: WorkDir[] };

/**
 * 첫 줄(제목)과 본문을 보고 프로젝트·서브프로젝트를 판정합니다.
 * @param hintProject  사용자가 `| 프로젝트`로 직접 준 값
 * @param hintSub      사용자가 `| 프로젝트 | 서브`로 직접 준 값
 */
export async function resolveWorkDir(text: string, hintProject?: string, hintSub?: string): Promise<Resolution> {
  const project = hintProject
    ? PROJECTS.find((p) => p === hintProject || p.includes(hintProject)) ?? guessProject(hintProject) ?? ""
    : guessProject(text) ?? "";
  if (!project) return { ok: false, reason: "no-project" };

  const dirs = await listWorkDirs(project);
  if (!dirs.length) return { ok: false, reason: "no-workdir", project };

  if (hintSub) {
    const h = hintSub.toLowerCase();
    const hit = dirs.find((d) => d.label.toLowerCase() === h) ?? dirs.find((d) => d.label.toLowerCase().includes(h));
    return hit ? { ok: true, workDir: hit, project } : { ok: false, reason: "ambiguous", project, choices: dirs };
  }
  if (dirs.length === 1) return { ok: true, workDir: dirs[0], project };

  const t = text.toLowerCase();
  const hits = dirs.filter((d) => d.label && t.includes(d.label.toLowerCase()));
  if (hits.length === 1) return { ok: true, workDir: hits[0], project };

  const direct = dirs.find((d) => !d.label); // 프로젝트 바로 아래 01_진행업무
  if (direct && !hits.length) return { ok: true, workDir: direct, project };

  return { ok: false, reason: "ambiguous", project, choices: dirs };
}

export interface WorklogNoteInput {
  title: string;
  /** 본문 (여러 줄). 없으면 제목만 기록 */
  content?: string;
  project: string;
  subProject: string;
  workDir: string;
  source?: string;
  date?: string;
  time?: string;
}

/** MMDD_주제/MMDD_주제.md */
export function worklogNotePath(workDir: string, title: string, date = todayKST()): string {
  const [, m, d] = date.split("-");
  const stem = `${m}${d}_${safeFileName(title)}`;
  return `${workDir}/${stem}/${stem}.md`;
}

function renderNote(i: WorklogNoteInput, date: string, entry: string): string {
  const fm = [
    "---",
    `project: ${i.project}`,
    `sub_project: ${i.subProject}`,
    "priority: mid",
    "category: action",
    "status: in-progress",
    "works:",
    "tags: []",
    `created: ${date}`,
    `updated: ${date}`,
    "completed:",
    "---",
  ].join("\n");
  return [
    fm,
    "",
    `# ${i.title}`,
    "",
    "## 진행",
    "",
    entry,
    "",
    "## 출처",
    "",
    `- ${i.source ?? "Slack 작업일지"}`,
    "",
  ].join("\n");
}

/** 진행 항목 한 덩어리: "- YYYY-MM-DD HH:MM 내용" + 여러 줄이면 들여쓴 하위 항목 */
function renderEntry(i: WorklogNoteInput, date: string): string {
  const lines = (i.content ?? "").split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  const head = `- ${date}${i.time ? ` ${i.time}` : ""}`;
  if (!lines.length) return `${head} — ${i.title}`;
  return [head, ...lines.map((l) => `\t- ${l}`)].join("\n");
}

/** `## 진행` 섹션 끝에 항목을 덧붙입니다 (섹션이 없으면 문서 끝에 만들어 붙입니다) */
export function appendToProgress(md: string, entry: string): string {
  const m = /^##\s*진행\s*$/m.exec(md);
  if (!m) return `${md.replace(/\s+$/, "")}\n\n## 진행\n\n${entry}\n`;
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const nextHeading = rest.search(/\n##\s/);
  const sectionEnd = nextHeading < 0 ? md.length : start + nextHeading;
  const section = md.slice(start, sectionEnd).replace(/\s+$/, "");
  return `${md.slice(0, start)}${section}\n${entry}\n${md.slice(sectionEnd).replace(/^\n+/, "\n")}`;
}

export interface WorklogNoteResult { path: string; created: boolean }

/** 노트를 만들거나(없으면) `## 진행`에 덧붙입니다(있으면). 기존 내용을 덮어쓰지 않습니다 */
export async function writeWorklogNote(i: WorklogNoteInput): Promise<WorklogNoteResult> {
  const date = i.date ?? todayKST();
  const path = worklogNotePath(i.workDir, i.title, date);
  const entry = renderEntry(i, date);
  const existing = await gh.readFile(path);
  if (existing) {
    const content = appendToProgress(existing.content, entry);
    await gh.writeFile(path, content, `workhub: 작업일지 추가 ${i.title}`, existing.sha);
    return { path, created: false };
  }
  await gh.writeFile(path, renderNote(i, date, entry), `workhub: 작업일지 노트 생성 ${i.title}`);
  return { path, created: true };
}
