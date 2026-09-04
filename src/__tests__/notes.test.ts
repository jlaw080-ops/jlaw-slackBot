/**
 * 작업일지 → 프로젝트 노트 (01_진행업무) 통합 테스트.
 * 볼트를 메모리로 대신해, 봇이 폴더를 임의로 만들지 않고 기존 노트도 덮어쓰지 않는지 확인합니다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const shaOf = (c: string) => `sha-${c.length}`;

vi.mock("../lib/github.js", () => ({
  async readFile(path: string) {
    const content = files.get(path);
    return content === undefined ? null : { path, sha: shaOf(content), content };
  },
  /** 실제 GitHub 트리처럼 폴더(type: "tree") 항목도 만들어 준다 */
  async listTree(subdir?: string) {
    const prefix = subdir ? `${subdir}/` : "";
    const dirs = new Set<string>();
    for (const p of files.keys()) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return [
      ...[...dirs].map((p) => ({ path: p, sha: "t", type: "tree" as const })),
      ...[...files.keys()].map((p) => ({ path: p, sha: shaOf(files.get(p)!), type: "blob" as const })),
    ].filter((e) => e.path.startsWith(prefix));
  },
  async readMany(entries: Array<{ path: string; sha: string }>) {
    return entries.map((e) => ({ path: e.path, sha: e.sha, content: files.get(e.path)! }));
  },
  async writeFile(path: string, content: string) { files.set(path, content); return true; },
  async readBlob(path: string, sha: string) { return { path, sha, content: files.get(path)! }; },
  invalidateTreeCache() {},
}));

const { appendToProgress, listWorkDirs, projectDir, resolveWorkDir, worklogNotePath, writeWorklogNote } = await import("../lib/notes.js");
const { executeCommand, parseCommand } = await import("../lib/commands.js");

const ENERBUILD = "01_Projects/02_에너빌드";

beforeEach(() => {
  files.clear();
  // 볼트에 이미 있는 작업 폴더들 (봇은 이 안에만 노트를 만든다)
  files.set(`${ENERBUILD}/03_에너지분석/01_진행업무/0801_기존건.md`, "# 기존\n");
  files.set(`${ENERBUILD}/05_웹사이트/01_진행업무/0801_웹.md`, "# 웹\n");
  files.set("01_Projects/03_분산자원통합운영플랫폼/01_진행업무/0801_RTU.md", "# RTU\n");
});

describe("프로젝트 폴더 판정", () => {
  it("스킬 경로표대로 프로젝트 폴더를 찾는다", () => {
    expect(projectDir("에너빌드")).toBe(ENERBUILD);
    expect(projectDir("에너지노관리")).toBe("02_Areas/10_에너지노행정관련");
    expect(projectDir("없는프로젝트")).toBeNull();
  });

  it("볼트에 실제로 있는 01_진행업무 폴더만 후보로 삼는다", async () => {
    const dirs = await listWorkDirs("에너빌드");
    expect(dirs.map((d) => d.label).sort()).toEqual(["에너지분석", "웹사이트"]);
    expect(await listWorkDirs("BIPV특허기획")).toEqual([]); // 폴더가 없으면 빈 목록
  });

  it("서브가 하나뿐이면 바로 정하고, 프로젝트 바로 아래면 라벨이 빈 값", async () => {
    const r = await resolveWorkDir("RTU 통신 점검 완료");
    expect(r).toMatchObject({ ok: true, project: "분산자원통합운영플랫폼" });
    if (r.ok) expect(r.workDir).toEqual({ path: "01_Projects/03_분산자원통합운영플랫폼/01_진행업무", label: "" });
  });

  it("본문에 서브 이름이 있으면 그 폴더를 고른다", async () => {
    const r = await resolveWorkDir("에너빌드 QA\n에너지분석 화면 계산 로직 확인");
    expect(r.ok && r.workDir.label).toBe("에너지분석");
  });

  it("서브를 못 정하면 만들지 않고 선택지를 돌려준다", async () => {
    const r = await resolveWorkDir("에너빌드 QA 진행");
    expect(r).toMatchObject({ ok: false, reason: "ambiguous", project: "에너빌드" });
  });

  it("프로젝트를 못 정하면 no-project", async () => {
    expect(await resolveWorkDir("점심 먹고 산책")).toEqual({ ok: false, reason: "no-project" });
  });

  it("작업 폴더가 없는 프로젝트는 no-workdir (폴더를 만들지 않는다)", async () => {
    const r = await resolveWorkDir("BIPV 난연재 시험 일정 확인");
    expect(r).toMatchObject({ ok: false, reason: "no-workdir", project: "BIPV특허기획" });
  });
});

describe("노트 작성", () => {
  it("MMDD_제목/MMDD_제목.md 규칙을 따른다", () => {
    expect(worklogNotePath("A/01_진행업무", "계산서 검토", "2026-09-04")).toBe("A/01_진행업무/0904_계산서 검토/0904_계산서 검토.md");
  });

  it("새 노트를 만들고, 두 번째는 덮어쓰지 않고 ## 진행에 덧붙인다", async () => {
    const wd = `${ENERBUILD}/03_에너지분석/01_진행업무`;
    const a = await writeWorklogNote({ title: "계산서 검토", content: "1안 확인", project: "에너빌드", subProject: "에너지분석", workDir: wd, date: "2026-09-04", time: "10:30" });
    expect(a.created).toBe(true);
    const first = files.get(a.path)!;
    expect(first).toContain("project: 에너빌드");
    expect(first).toContain("sub_project: 에너지분석");
    expect(first).toContain("category: action");
    expect(first).toContain("# 계산서 검토");
    expect(first).toContain("\t- 1안 확인");

    const b = await writeWorklogNote({ title: "계산서 검토", content: "2안 확인", project: "에너빌드", subProject: "에너지분석", workDir: wd, date: "2026-09-04", time: "15:00" });
    expect(b.created).toBe(false);
    expect(b.path).toBe(a.path);
    const second = files.get(b.path)!;
    expect(second).toContain("1안 확인");
    expect(second).toContain("2안 확인");
    expect(second).toContain("## 출처"); // 뒤 섹션이 살아 있다
    expect(second.match(/# 계산서 검토/g)).toHaveLength(1); // 제목이 중복되지 않는다
  });

  it("appendToProgress는 다음 제목 앞에 끼워 넣는다", () => {
    const md = "# 제목\n\n## 진행\n\n- 기존\n\n## 출처\n\n- x\n";
    const out = appendToProgress(md, "- 새 항목");
    expect(out.indexOf("- 새 항목")).toBeGreaterThan(out.indexOf("- 기존"));
    expect(out.indexOf("- 새 항목")).toBeLessThan(out.indexOf("## 출처"));
  });
});

describe("Slack 명령", () => {
  it("여러 줄이면 자동으로 노트, 한 줄이면 메모", () => {
    expect(parseCommand("/작업일지", "오늘 계산서 확인함").kind).toBe("worklog.note");
    expect(parseCommand("/작업일지", "에너빌드 QA\n에너지분석 화면 확인")).toMatchObject({
      kind: "worklog.vaultnote", title: "에너빌드 QA", content: "에너지분석 화면 확인",
    });
    expect(parseCommand("/작업일지", "노트 계산서 검토 | 에너빌드 | 에너지분석\n1안 확인")).toMatchObject({
      kind: "worklog.vaultnote", title: "계산서 검토", project: "에너빌드", sub: "에너지분석", content: "1안 확인",
    });
  });

  it("/할일 보내기 는 대상 채널과 범위를 읽는다", () => {
    expect(parseCommand("/할일", "보내기 작업일지 오늘")).toEqual({ kind: "todo.push", target: "작업일지", scope: "오늘" });
    expect(parseCommand("/할일", "보내기")).toEqual({ kind: "todo.push", target: "할일", scope: "기본" });
  });

  it("서브를 못 정하면 노트를 만들지 않고 되묻는다", async () => {
    const before = files.size;
    const r = await executeCommand(parseCommand("/작업일지", "노트 에너빌드 QA 진행\n화면 확인"), { userId: "U1", channelId: "C1" });
    expect(r.text).toContain("서브 프로젝트");
    expect(files.size).toBe(before); // 아무 파일도 만들지 않았다
  });

  it("판정되면 노트를 만들고 일일노트에도 메모를 남긴다", async () => {
    const r = await executeCommand(
      parseCommand("/작업일지", "노트 계산서 검토 | 에너빌드 | 에너지분석\n1안 확인"),
      { userId: "U1", channelId: "C1" },
    );
    expect(r.text).toContain("작업일지 노트 생성");
    const notePath = [...files.keys()].find((p) => p.includes("계산서 검토"))!;
    expect(notePath.startsWith(`${ENERBUILD}/03_에너지분석/01_진행업무/`)).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith("05_Daily/"))).toBe(true);
  });
});

describe("한 줄 입력 (Slack 슬래시 명령은 여러 줄을 받지 못한다)", () => {
  it("`/작업일지 노트` 만 쓰면 입력 창을 연다", () => {
    expect(parseCommand("/작업일지", "노트")).toEqual({ kind: "worklog.modal", title: "" });
  });

  it("`::` 뒤를 본문으로 읽는다", () => {
    expect(parseCommand("/작업일지", "노트 계산서 검토 | 에너빌드 | 에너지분석 :: 1안 확인")).toMatchObject({
      kind: "worklog.vaultnote", title: "계산서 검토", project: "에너빌드", sub: "에너지분석", content: "1안 확인",
    });
  });
});

describe("전체 도움말", () => {
  it("어느 명령에서든 `도움말 전체`로 전체 사용법을 본다", async () => {
    for (const c of ["/할일", "/작업일지", "/일정", "/티켓"]) {
      expect(parseCommand(c, "도움말 전체")).toEqual({ kind: "help", command: "전체" });
    }
    const r = await executeCommand({ kind: "help", command: "전체" }, { userId: "U1", channelId: "C1" });
    for (const c of ["/할일", "/작업일지", "/일정", "/티켓"]) expect(r.text).toContain(c);
  });

  it("개별 도움말에는 다른 명령 안내가 붙는다", async () => {
    const r = await executeCommand({ kind: "help", command: "할일" }, { userId: "U1", channelId: "C1" });
    expect(r.text).toContain("전체 사용법");
  });
});
