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

describe("아카이브 폴더 제외", () => {
  it("아카이브·보관·완료 폴더의 노트는 목록에 넣지 않는다", async () => {
    const { isExcludedPath } = await import("../lib/vault.js");
    for (const p of [
      "06_To Do/아카이브/0801_끝난건.md",
      "06_To Do/99_아카이브(완료 및 범위 외)/0801_끝난건.md",
      "06_To Do/Archive/x.md",
      "06_To Do/보관함/x.md",
      "06_To Do/2026-09/완료/x.md",
      "06_To Do/_임시/x.md",
    ]) expect(isExcludedPath(p)).toBe(true);

    for (const p of ["06_To Do/2026-09/0904_계산서 검토.md", "06_To Do/5월/0501_건.md", "06_To Do/x.md"]) {
      expect(isExcludedPath(p)).toBe(false);
    }
  });
});

describe("`|` 없이 말로 적은 할일", () => {
  it("실제로 겪은 입력을 제대로 나눈다", () => {
    const p = parseCommand(
      "/할일",
      "추가 데이터센터 ALT 로직 생성 프로세스(전력계통영향평가 고려) 우선순위 high 프로젝트 에너빌드(에너지분석(에너빌드))",
      "2026-09-07",
    );
    expect(p).toMatchObject({
      kind: "todo.add",
      title: "데이터센터 ALT 로직 생성 프로세스(전력계통영향평가 고려)",
      priority: "high",
      project: "에너빌드",
    });
  });

  it("한글 우선순위·마감도 알아듣는다", () => {
    expect(parseCommand("/할일", "추가 계산서 검토 우선순위 높음 프로젝트 에너빌드 마감 내일", "2026-09-07")).toMatchObject({
      kind: "todo.add", title: "계산서 검토", priority: "high", project: "에너빌드", due: "2026-09-08",
    });
  });

  it("`|` 로 준 값이 말로 적은 값보다 우선한다", () => {
    expect(parseCommand("/할일", "추가 계산서 검토 우선순위 낮음 | | 높음 | 에너빌드", "2026-09-07")).toMatchObject({
      title: "계산서 검토", priority: "high", project: "에너빌드",
    });
  });

  it("키워드가 없으면 제목을 그대로 둔다", () => {
    expect(parseCommand("/할일", "추가 우선순위 정하기 회의", "2026-09-07")).toMatchObject({
      kind: "todo.add", title: "우선순위 정하기 회의",
    });
  });
});

describe("낱말 없이 값만 붙인 할일", () => {
  it("실제로 겪은 두 번째 입력을 나눈다", () => {
    expect(parseCommand("/할일", "추가 BIPV 관련 추가 조사 진행 high BIPV화재진단기술", "2026-09-07")).toMatchObject({
      kind: "todo.add", title: "BIPV 관련 추가 조사 진행", priority: "high", project: "BIPV특허기획",
    });
  });

  it("제목이 두 낱말 이하로 줄어들 만큼은 떼지 않는다", () => {
    expect(parseCommand("/할일", "추가 검토 에너빌드", "2026-09-07")).toMatchObject({ title: "검토 에너빌드" });
  });

  it("우선순위로 읽힐 만한 낱말이 없으면 그대로 둔다", () => {
    expect(parseCommand("/할일", "추가 계산서 정확도 검증하기", "2026-09-07")).toMatchObject({
      title: "계산서 정확도 검증하기", priority: undefined,
    });
  });
});

describe("따옴표로 칸을 나눈 할일", () => {
  it("실제로 겪은 입력을 나눈다 (빈 칸 포함)", () => {
    expect(parseCommand("/할일", '추가 "BIPV 관련 추가 조사 진행" "" "high" "BIPV화재진단기술"', "2026-09-07")).toMatchObject({
      kind: "todo.add", title: "BIPV 관련 추가 조사 진행", due: null, priority: "high", project: "BIPV특허기획",
    });
  });

  it("굽은 따옴표도 받는다", () => {
    expect(parseCommand("/할일", '추가 “계산서 검토” “내일” “높음” “에너빌드”', "2026-09-07")).toMatchObject({
      title: "계산서 검토", due: "2026-09-08", priority: "high", project: "에너빌드",
    });
  });

  it("따옴표가 하나뿐이면 평소대로 읽는다", () => {
    expect(parseCommand("/할일", '추가 "긴급" 회의 준비 우선순위 높음', "2026-09-07")).toMatchObject({
      title: '"긴급" 회의 준비', priority: "high",
    });
  });
});

describe("메일 → 노트", () => {
  it("Re:·Fwd:·[태그] 를 걷어 낸 제목을 쓴다", async () => {
    const { mailTitle } = await import("../lib/commands.js");
    expect(mailTitle("Re: Fwd: [에너빌드] 계산서 검토 요청")).toBe("계산서 검토 요청");
    expect(mailTitle("답장: 회의록")).toBe("회의록");
    expect(mailTitle("")).toBe("제목 없는 메일");
  });

  it("인용문·서명 앞까지만 본문으로 남긴다", async () => {
    const { cleanBody } = await import("../lib/gmail.js");
    const raw = "1안 검토했습니다.\n장비일람표 확인 부탁드립니다.\n\n감사합니다\n\n> 이전 메일 내용\n> 더 있음";
    const out = cleanBody(raw);
    expect(out).toContain("1안 검토했습니다.");
    expect(out).toContain("장비일람표");
    expect(out).not.toContain("이전 메일 내용");
  });

  it("`/작업일지 메일` 을 검색어와 프로젝트로 나눈다", () => {
    expect(parseCommand("/작업일지", "메일 계산서 검토 요청")).toEqual({ kind: "worklog.mail", query: "계산서 검토 요청" });
    expect(parseCommand("/작업일지", "메일 계산서 | 에너빌드 | 에너지분석")).toEqual({
      kind: "worklog.mail", query: "계산서", project: "에너빌드", sub: "에너지분석",
    });
  });

  it("Gmail이 꺼져 있으면 안내만 하고 아무것도 만들지 않는다", async () => {
    const before = files.size;
    const r = await executeCommand({ kind: "worklog.mail", query: "계산서" }, { userId: "U1", channelId: "C1" });
    expect(r.text).toContain("Gmail");
    expect(files.size).toBe(before);
  });
});

describe("일일보고 초안", () => {
  const DAILY = "05_Daily/2026-09-07.md";

  beforeEach(() => {
    // 오늘 진행업무 노트 (진행 섹션에 오늘 날짜 항목)
    files.set(`${ENERBUILD}/03_에너지분석/01_진행업무/0907_계산서 검토/0907_계산서 검토.md`,
      "---\nproject: 에너빌드\nstatus: in-progress\nworks-url: https://works.do/abc\nupdated: 2026-09-07\n---\n\n" +
      "# 계산서 검토\n\n## 진행\n\n- 2026-09-06 10:00\n\t- 어제 한 일\n- 2026-09-07 10:30\n\t- 1안 계산 결과 확인\n\t- 장비일람표 반영 필요\n\n## 출처\n\n- Slack\n");
    // 오늘 완료한 할일
    files.set("06_To Do/2026-09/0901_규제 정리.md",
      "---\nproject: 신재생에너지제안(EPC)\nstatus: done\ncreated: 2026-09-01\ncompleted: 2026-09-07\n---\n\n" +
      "## 업무 개요\n- 데이터센터 규제 사항 정리해 내부 공유\n\n## 진행상황\n- 최신 개정 반영 완료\n- 슬라이드 초안 작성\n");
    // 어제 움직인 할일 — 보고에 들어가면 안 된다
    files.set("06_To Do/2026-09/0902_지난건.md",
      "---\nproject: 에너빌드\nstatus: in-progress\ncreated: 2026-09-02\nupdated: 2026-09-05\n---\n\n## 업무 개요\n- 지난 건\n");
    // 사람이 쓴 일일노트 + 봇 블록
    files.set(DAILY, "---\ntags: Daily\n---\n**일일보고(김지헌) - 2026-09-07**\n\n1. 직접 쓴 항목\n\n#### Memo\n-\n\n" +
      "<!-- WORKHUB-LOG:START -->\n### 📝 메모\n- 14:00 회의록 정리함\n<!-- WORKHUB-LOG:END -->\n");
  });

  it("오늘 움직인 것만 모은다", async () => {
    const { collectReport } = await import("../lib/report.js");
    const items = await collectReport("2026-09-07");
    const titles = items.map((i) => i.title);
    expect(titles).toContain("계산서 검토");
    expect(titles).toContain("규제 정리");
    expect(titles).toContain("기타");
    expect(titles).not.toContain("지난건");
  });

  it("그날 `## 진행` 항목만 골라 쓴다", async () => {
    const { collectReport } = await import("../lib/report.js");
    const items = await collectReport("2026-09-07");
    const it = items.find((i) => i.title === "계산서 검토")!;
    expect(it.bullets).toEqual(["1안 계산 결과 확인", "장비일람표 반영 필요"]);
    expect(it.bullets).not.toContain("어제 한 일");
    expect(it.links).toContain("https://works.do/abc");
  });

  it("양식대로 엮는다", async () => {
    const { collectReport, renderReport } = await import("../lib/report.js");
    const text = renderReport(await collectReport("2026-09-07"), "2026-09-07", "김지헌");
    expect(text.split("\n")[0]).toBe("**일일보고(김지헌) - 2026-09-07**");
    expect(text).toMatch(/^1\. /m);
    expect(text).toMatch(/^ {4}- 1안 계산 결과 확인$/m);
    expect(text).toContain("(완료)"); // status: done 인 항목
  });

  it("사람이 쓴 부분과 다른 블록을 건드리지 않는다", async () => {
    const r = await executeCommand({ kind: "worklog.report", date: "2026-09-07" }, { userId: "U1", channelId: "C1" });
    expect(r.text).toContain("일일보고 초안");
    const after = files.get(DAILY)!;
    expect(after).toContain("1. 직접 쓴 항목");          // 사람이 쓴 영역 그대로
    expect(after).toContain("<!-- WORKHUB-LOG:START -->"); // 다른 블록 그대로
    expect(after).toContain("<!-- WORKHUB-REPORT:START -->");
    expect(after).toContain("계산서 검토");
  });

  it("두 번 실행해도 블록이 하나만 남는다", async () => {
    await executeCommand({ kind: "worklog.report", date: "2026-09-07" }, { userId: "U1", channelId: "C1" });
    await executeCommand({ kind: "worklog.report", date: "2026-09-07" }, { userId: "U1", channelId: "C1" });
    expect(files.get(DAILY)!.match(/WORKHUB-REPORT:START/g)).toHaveLength(1);
  });

  it("`/작업일지 일일보고 어제` 는 어제 날짜로", () => {
    expect(parseCommand("/작업일지", "일일보고 어제", "2026-09-07")).toEqual({ kind: "worklog.report", date: "2026-09-06" });
    expect(parseCommand("/작업일지", "일일보고", "2026-09-07")).toEqual({ kind: "worklog.report", date: "2026-09-07" });
  });
});

describe("지난 날짜 표현", () => {
  it("어제·그제·-N 을 읽는다", async () => {
    const { parseDateInput } = await import("../lib/dates.js");
    expect(parseDateInput("어제", "2026-09-07")).toBe("2026-09-06");
    expect(parseDateInput("그제", "2026-09-07")).toBe("2026-09-05");
    expect(parseDateInput("-3", "2026-09-07")).toBe("2026-09-04");
    expect(parseDateInput("+3", "2026-09-07")).toBe("2026-09-10"); // 기존 동작 유지
  });
});
