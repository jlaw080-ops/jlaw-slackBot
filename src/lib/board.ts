/**
 * 업무별 진행 현황 — 볼트를 그때그때 읽어 한 화면으로 보여 줍니다.
 *
 * 작업일지(진행업무 노트의 `## 진행`)와 할일 노트를 프로젝트별로 묶고,
 * **마지막으로 손댄 날**을 기준으로 며칠째 멈춰 있는지 보여 주는 것이 핵심입니다.
 * 파일을 고치지 않고 읽기만 합니다.
 */
import { config } from "./config.js";
import * as gh from "./github.js";
import { addDays, todayKST } from "./dates.js";
import { fileToTask, obsidianUri, OPEN_STATUSES, parseFrontmatter, STATUS_KO, PRIORITY_KO, type Priority, type VaultStatus, normalizeStatus, normalizePriority, isExcludedPath } from "./vault.js";
import { section as mdSection, bullets } from "./report.js";

export interface BoardItem {
  title: string;
  project: string;
  subProject: string;
  status: VaultStatus;
  priority: Priority | "";
  due: string | null;
  /** 마지막으로 내용이 늘어난 날 (작업일지 기준) */
  lastActive: string;
  /** 마지막 진행 내용 몇 줄 */
  recent: string[];
  links: Array<{ label: string; url: string }>;
  path: string;
  kind: "진행업무" | "할일";
}

const str = (fm: Record<string, unknown>, k: string) => (typeof fm[k] === "string" ? (fm[k] as string).trim() : "");

/** `## 진행` 안의 날짜 머리글들 (최신순) */
function progressDates(body: string): string[] {
  const sec = mdSection(body, "진행");
  return [...sec.matchAll(/^\s*(?:[-*]|\d+\.)\s*(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]).sort().reverse();
}

/** 마지막 날짜 항목의 하위 불릿 */
function lastProgressLines(body: string, date: string): string[] {
  const sec = mdSection(body, "진행");
  const lines = sec.split("\n");
  const out: string[] = [];
  let on = false;
  for (const line of lines) {
    const head = /^\s*(?:[-*]|\d+\.)\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (head) { on = head[1] === date; continue; }
    if (!on) continue;
    const item = line.replace(/^\s*[-*·]\s*/, "").trim();
    if (item) out.push(item);
  }
  return out.slice(0, 3);
}

function linksOf(fm: Record<string, unknown>): Array<{ label: string; url: string }> {
  const out: Array<{ label: string; url: string }> = [];
  const works = str(fm, "works-url");
  if (works.startsWith("http")) out.push({ label: "웍스", url: works });
  const notion = str(fm, "notion-url");
  if (notion.startsWith("http")) out.push({ label: "Notion", url: notion });
  return out;
}

/** 진행업무 노트 + 열린 할일을 모아 업무별 현황으로 */
export async function collectBoard(today = todayKST(), days = 90): Promise<BoardItem[]> {
  const items: BoardItem[] = [];
  const since = addDays(today, -days);

  const tree = await gh.listTree();

  // 1) 진행업무 노트 (작업일지)
  const workNotes = tree.filter((t) => t.type === "blob" && t.path.endsWith(".md") && t.path.includes("/01_진행업무/") && !isExcludedPath(t.path));
  for (const f of await gh.readMany(workNotes)) {
    const { fm, body } = parseFrontmatter(f.content);
    const dates = progressDates(body);
    const base = f.path.split("/").pop()!.replace(/\.md$/, "");
    const created = str(fm, "created");
    const lastActive = dates[0] || str(fm, "updated") || created || "";
    if (lastActive && lastActive < since) continue;
    const status = normalizeStatus(fm.status);
    if (status === "done") continue;
    items.push({
      title: (/^#\s+(.+)$/m.exec(body)?.[1] ?? base.replace(/^\d{4}_/, "")).trim(),
      project: str(fm, "project"),
      subProject: str(fm, "sub_project"),
      status,
      priority: normalizePriority(fm.priority),
      due: str(fm, "due") || null,
      lastActive,
      recent: dates[0] ? lastProgressLines(body, dates[0]) : bullets(mdSection(body, "요약"), 2),
      links: linksOf(fm),
      path: f.path,
      kind: "진행업무",
    });
  }

  // 2) 열린 할일
  const todos = tree.filter((t) => t.type === "blob" && t.path.endsWith(".md") && t.path.startsWith(`${config.vault.todoDir}/`) && !isExcludedPath(t.path));
  for (const f of await gh.readMany(todos)) {
    const t = fileToTask(f);
    if (!OPEN_STATUSES.includes(t.status)) continue;
    if (items.some((i) => i.title === t.title)) continue;
    const lastActive = t.updated || String(t.fm.started ?? "") || t.created || "";
    items.push({
      title: t.title,
      project: t.project,
      subProject: t.subProject,
      status: t.status,
      priority: t.priority,
      due: t.due,
      lastActive,
      recent: bullets(mdSection(t.body, "진행상황"), 2).length
        ? bullets(mdSection(t.body, "진행상황"), 2)
        : bullets(mdSection(t.body, "업무 개요"), 1),
      links: linksOf(t.fm),
      path: t.path,
      kind: "할일",
    });
  }

  const rank: Record<VaultStatus, number> = { "in-progress": 0, review: 1, planned: 2, backlog: 3, done: 4 };
  return items.sort((a, b) =>
    rank[a.status] - rank[b.status] ||
    (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
    (b.lastActive || "").localeCompare(a.lastActive || ""),
  );
}

/** 며칠째 손대지 않았나 (모르면 null) */
export function idleDays(lastActive: string, today = todayKST()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastActive)) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastActive}T00:00:00Z`)) / 86_400_000);
}

// ---------- 화면 ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS_CLASS: Record<VaultStatus, string> = {
  "in-progress": "s-go", review: "s-review", planned: "s-plan", backlog: "s-hold", done: "s-done",
};

/** "에너지분석(에너빌드)" 와 "에너지분석" 을 같은 묶음으로 */
export function subLabel(sub: string, project: string): string {
  return sub.replace(new RegExp(`\\s*\\(${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\s*$`), "").trim();
}

function itemHtml(i: BoardItem, today: string): string {
  const idle = idleDays(i.lastActive, today);
  const late = i.due && i.due < today;
  const stale = idle !== null && idle >= 7;
  return `<article class="item${stale ? " stale" : ""}">
  <div class="row">
    <span class="chip ${STATUS_CLASS[i.status]}">${STATUS_KO[i.status]}</span>
    <h3>${esc(i.title)}</h3>
  </div>
  <div class="meta">
    ${i.priority ? `<span class="p p-${i.priority}">${PRIORITY_KO[i.priority]}</span>` : ""}
    ${i.due ? `<span class="${late ? "late" : ""}">마감 ${i.due}${late ? " 지남" : ""}</span>` : ""}
    <span${stale ? ' class="late"' : ""}>${i.lastActive ? `${i.lastActive}${idle === null ? "" : idle === 0 ? " (오늘)" : ` (${idle}일 전)`}` : "기록 없음"}</span>
    <span class="kind">${i.kind}</span>
  </div>
  ${i.recent.length ? `<ul class="recent">${i.recent.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
  <div class="links">
    ${obsidianUri(i.path) ? `<a href="${esc(obsidianUri(i.path)!)}">Obsidian</a>` : ""}
    ${i.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("")}
  </div>
</article>`;
}

export function renderBoard(items: BoardItem[], today = todayKST()): string {
  const byProject = new Map<string, BoardItem[]>();
  for (const i of items) {
    const key = i.project || "(프로젝트 없음)";
    byProject.set(key, [...(byProject.get(key) ?? []), i]);
  }

  const going = items.filter((i) => i.status === "in-progress").length;
  const late = items.filter((i) => i.due && i.due < today).length;
  const stale = items.filter((i) => (idleDays(i.lastActive, today) ?? 0) >= 7).length;

  const sections = [...byProject.entries()].map(([project, list]) => {
    const bySub = new Map<string, BoardItem[]>();
    for (const i of list) {
      const sub = subLabel(i.subProject, project);
      bySub.set(sub, [...(bySub.get(sub) ?? []), i]);
    }
    const groups = [...bySub.entries()].map(([sub, ls]) =>
      `${sub ? `<h3 class="sub">${esc(sub)}</h3>` : ""}<div class="grid">${ls.map((i) => itemHtml(i, today)).join("")}</div>`,
    ).join("");
    return `<section><h2>${esc(project)} <span class="count">${list.length}</span></h2>${groups}</section>`;
  }).join("");

  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>업무 진행 현황</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --ink:#16202b; --ink-soft:#4a5866; --ink-faint:#7f8c99;
  --paper:#f5f6f8; --surface:#fff; --line:#dde1e7; --line-soft:#e9ecf0;
  --go:#1f6f4a; --go-bg:#e3f2ea; --review:#7a5a12; --review-bg:#faf1dd;
  --plan:#2f5fa8; --plan-bg:#e7eefa; --hold:#6a7480; --hold-bg:#eceef1;
  --alert:#a8341f;
  --sans:"IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
  --mono:"IBM Plex Mono",Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --ink:#e6ebf1; --ink-soft:#a6b2be; --ink-faint:#78848f;
  --paper:#11171e; --surface:#181f28; --line:#2c3641; --line-soft:#232c35;
  --go:#7fce9f; --go-bg:#17291f; --review:#d9ab4e; --review-bg:#2e2717;
  --plan:#82aeee; --plan-bg:#1b2839; --hold:#9aa5b1; --hold-bg:#222a33;
  --alert:#ef8a72;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.6;font-size:15px}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 80px}
header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:28px}
h1{font-size:1.5rem;margin:0 0 4px}
.stats{display:flex;flex-wrap:wrap;gap:18px;color:var(--ink-soft);font-size:.9rem}
.stats b{color:var(--ink);font-variant-numeric:tabular-nums}
section{margin-bottom:36px}
h2{font-size:1.05rem;margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;gap:8px}
.count{font-family:var(--mono);font-size:.75rem;color:var(--ink-faint)}
h3.sub{font-size:.8rem;font-weight:500;color:var(--ink-faint);margin:14px 0 8px;letter-spacing:.04em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-items:start}
.item{background:var(--surface);border:1px solid var(--line);padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.item.stale{border-left:3px solid var(--alert)}
.row{display:flex;align-items:baseline;gap:8px}
.item h3{font-size:.98rem;font-weight:600;margin:0;line-height:1.4}
.chip{font-size:.7rem;font-family:var(--mono);padding:2px 7px;border-radius:3px;white-space:nowrap;flex-shrink:0}
.s-go{color:var(--go);background:var(--go-bg)} .s-review{color:var(--review);background:var(--review-bg)}
.s-plan{color:var(--plan);background:var(--plan-bg)} .s-hold{color:var(--hold);background:var(--hold-bg)}
.meta{display:flex;flex-wrap:wrap;gap:10px;font-size:.8rem;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.meta .late{color:var(--alert)}
.p{font-weight:600} .p-high{color:var(--alert)} .p-mid{color:var(--ink-soft)} .p-low{color:var(--ink-faint)}
.kind{font-family:var(--mono);font-size:.7rem;opacity:.75}
.recent{margin:0;padding-left:1.1em;font-size:.86rem;color:var(--ink-soft)}
.recent li{margin-bottom:2px}
.links{display:flex;gap:10px;font-size:.8rem}
.links a{color:var(--plan);text-decoration:none}
.links a:hover{text-decoration:underline}
footer{color:var(--ink-faint);font-size:.82rem;border-top:1px solid var(--line);padding-top:16px}
.empty{color:var(--ink-faint)}
</style></head>
<body><div class="wrap">
<header>
  <h1>업무 진행 현황</h1>
  <div class="stats">
    <span><b>${items.length}</b> 건</span>
    <span>진행 중 <b>${going}</b></span>
    <span>마감 지남 <b>${late}</b></span>
    <span>7일 이상 멈춤 <b>${stale}</b></span>
    <span>${today} 기준</span>
  </div>
</header>
${sections || '<p class="empty">열린 업무가 없습니다.</p>'}
<footer>
  볼트를 열 때마다 새로 읽습니다 · 왼쪽에 붉은 선이 그어진 것은 7일 이상 진행 기록이 없는 업무입니다<br>
  기록을 남기려면 Slack에서 <code>/작업일지 노트</code>
</footer>
</div></body></html>`;
}
