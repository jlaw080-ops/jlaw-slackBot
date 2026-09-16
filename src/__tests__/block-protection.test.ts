/**
 * "일일노트를 직접 수정해서 최종본을 만들고 싶다"는 요청에 대한 근본 해결책 검증.
 *
 * 지금까지는 봇이 마커 블록(WORKHUB-LOG, WORKHUB-REPORT)을 매번 통째로 다시 썼다.
 * 그 블록 안을 사람이 직접 고쳐 최종본으로 다듬고 있으면, PC가 아직 못 올린 그
 * 수정과 봇이 GitHub에 먼저 올린 수정이 같은 줄을 건드려 git 충돌이 났다.
 *
 * 이제 블록을 쓸 때마다 지문(해시)을 남기고, 다음에 다시 쓰려 할 때 지금 지문이
 * 그대로인지 먼저 확인한다. 사람이 손댔으면(=지문이 안 맞으면) 덮어쓰지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const shaOf = (c: string) => `sha-${c.length}`;

vi.mock("../lib/github.js", () => ({
  async readFile(path: string) {
    const c = files.get(path);
    return c === undefined ? null : { path, sha: shaOf(c), content: c };
  },
  async listTree(subdir?: string) {
    const prefix = subdir ? `${subdir}/` : "";
    return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ path: p, sha: shaOf(files.get(p)!), type: "blob" as const }));
  },
  async readMany(entries: Array<{ path: string; sha: string }>) {
    return entries.map((e) => ({ path: e.path, sha: e.sha, content: files.get(e.path)! }));
  },
  async writeFile(path: string, content: string) {
    const changed = files.get(path) !== content;
    files.set(path, content);
    return changed;
  },
  invalidateTreeCache() {},
}));

const { writeWorklogBlock, appendMemo, fileToTask } = await import("../lib/vault.js");
const { writeReportBlock } = await import("../lib/report.js");
const { todayKST } = await import("../lib/dates.js");

const TODAY = todayKST();
const NOTE_PATH = `05_Daily/${TODAY}.md`;
const done1 = () => fileToTask({ path: "06_To Do/x/a.md", sha: "", content: "---\nproject: 에너빌드\nstatus: done\n---\n\n본문\n" });
const done2 = () => fileToTask({ path: "06_To Do/x/b.md", sha: "", content: "---\nproject: 에너빌드\nstatus: done\n---\n\n본문2\n" });

beforeEach(() => files.clear());

describe("작업일지(LOG) 블록 — 사람이 손댔으면 건너뛴다", () => {
  it("사람이 손 안 댔으면 계속 다시 쓴다", async () => {
    const r1 = await writeWorklogBlock({ date: TODAY, done: [done1()], active: [], events: [], ticketChanges: [] });
    expect(r1.skipped).toBe(false);
    const r2 = await writeWorklogBlock({ date: TODAY, done: [done1(), done2()], active: [], events: [], ticketChanges: [] });
    expect(r2.skipped).toBe(false);
    expect(files.get(NOTE_PATH)).toContain("[[06_To Do/x/b|");
  });

  it("사람이 블록 안(완료 목록)을 직접 고쳤으면 다시 쓰지 않는다", async () => {
    await writeWorklogBlock({ date: TODAY, done: [done1()], active: [], events: [], ticketChanges: [] });
    const edited = files.get(NOTE_PATH)!.replace("- [x]", "- [x] (내가 정리함)");
    files.set(NOTE_PATH, edited);

    const r = await writeWorklogBlock({ date: TODAY, done: [done1(), done2()], active: [], events: [], ticketChanges: [] });
    expect(r.skipped).toBe(true);
    expect(files.get(NOTE_PATH)).toBe(edited); // 파일이 한 글자도 안 바뀐다
  });

  it("지문이 없는 옛 블록은 이번 한 번은 그대로 써서 새 형식으로 넘어간다", async () => {
    files.set(NOTE_PATH, "# 일일노트\n\n<!-- WORKHUB-LOG:START -->\n## 🗂 WorkHub 작업일지 (자동 생성)\n### ✅ 완료\n- (없음)\n### 📝 메모\n- \n<!-- WORKHUB-LOG:END -->\n");
    const r = await writeWorklogBlock({ date: TODAY, done: [done1()], active: [], events: [], ticketChanges: [] });
    expect(r.skipped).toBe(false);
    expect(files.get(NOTE_PATH)).toContain("workhub:hash:");
  });

  it("사람이 완료/진행 부분을 고쳐도, 메모(appendMemo)는 그대로 계속 쌓인다", async () => {
    await writeWorklogBlock({ date: TODAY, done: [done1()], active: [], events: [], ticketChanges: [] });
    const edited = files.get(NOTE_PATH)!.replace("### 🔄 진행 중", "### 🔄 진행 중 (내가 정리함)");
    files.set(NOTE_PATH, edited);

    await appendMemo(TODAY, "16:00 새 메모");
    expect(files.get(NOTE_PATH)).toContain("### 🔄 진행 중 (내가 정리함)"); // 사람 수정 보존
    expect(files.get(NOTE_PATH)).toContain("- 16:00 새 메모");              // 메모도 정상 추가

    // 메모가 쌓인 뒤에도 완료 목록이 그대로면(=사람이 그 부분은 안 건드렸다고 재확인되면) 다시 쓸 수 있어야 한다
    const r = await writeWorklogBlock({ date: TODAY, done: [done1(), done2()], active: [], events: [], ticketChanges: [] });
    expect(r.skipped).toBe(true); // "진행 중" 제목을 고친 상태라 여전히 건너뛴다
  });
});

describe("일일보고(REPORT) 블록 — 최종본으로 다듬고 있으면 덮어쓰지 않는다", () => {
  it("사람이 손 안 댔으면 다시 실행할 때마다 새 초안으로 갱신된다", async () => {
    const r1 = await writeReportBlock("1. 첫 초안", TODAY);
    expect(r1.skipped).toBe(false);
    const r2 = await writeReportBlock("1. 두 번째 초안", TODAY);
    expect(r2.skipped).toBe(false);
    expect(files.get(NOTE_PATH)).toContain("두 번째 초안");
  });

  it("초안을 직접 고쳐 최종본으로 다듬고 있으면, 다시 실행해도 건드리지 않는다", async () => {
    await writeReportBlock("1. 자동 초안", TODAY);
    const finalized = files.get(NOTE_PATH)!.replace("1. 자동 초안", "1. 내가 다듬은 최종본\n    - 팀에 공유 완료");
    files.set(NOTE_PATH, finalized);

    const r = await writeReportBlock("1. 새로 만든 초안", TODAY);
    expect(r.skipped).toBe(true);
    expect(files.get(NOTE_PATH)).toBe(finalized); // 최종본이 한 글자도 안 바뀐다
    expect(files.get(NOTE_PATH)).toContain("팀에 공유 완료");
  });
});
