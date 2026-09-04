/**
 * 통합 테스트: GitHub 계층을 메모리 파일 시스템으로 바꿔 실제 읽기·쓰기 흐름을 검증합니다.
 * 토큰 없이도 "봇이 볼트 파일을 어떻게 바꾸는가"를 배포 전에 확인할 수 있습니다.
 *
 * 특히 중요한 것: 봇이 남의 노트를 망가뜨리지 않는가.
 *  - 본문 보존, frontmatter 키 순서 보존, 모르는 키 보존
 *  - 일일노트의 봇 블록 밖 내용 보존 (사용자가 쓴 글, 다른 스킬의 블록)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- 메모리 볼트 ----
const files = new Map<string, string>();
let writeLog: Array<{ path: string; message: string }> = [];
const shaOf = (content: string) => `sha-${content.length}-${content.charCodeAt(0) || 0}`;

vi.mock("../lib/github.js", () => ({
  async readFile(path: string) {
    const content = files.get(path);
    return content === undefined ? null : { path, sha: shaOf(content), content };
  },
  async listTree(subdir?: string) {
    const prefix = subdir ? `${subdir}/` : "";
    return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ path: p, sha: shaOf(files.get(p)!), type: "blob" as const }));
  },
  async readMany(entries: Array<{ path: string; sha: string }>) {
    return entries.map((e) => ({ path: e.path, sha: e.sha, content: files.get(e.path)! }));
  },
  async writeFile(path: string, content: string, message: string) {
    const changed = files.get(path) !== content;
    files.set(path, content);
    writeLog.push({ path, message });
    return changed;
  },
  async readBlob(path: string, sha: string) { return { path, sha, content: files.get(path)! }; },
  invalidateTreeCache() {},
}));

const {
  appendMemo, collectNotionLinks, createTask, fileToTask, findTasksByKeyword, listCompletedOn, listOpenTasks,
  newTaskPath, patchTask, readIgnored, addIgnored, setStatus, writeWorklogBlock,
} = await import("../lib/vault.js");
const { todayKST } = await import("../lib/dates.js");
const { executeCommand, parseCommand } = await import("../lib/commands.js");

const TODAY = todayKST();

/** notion-todo-sync 스킬이 만든 실제 형태의 노트 */
const ASSIGNED_NOTE = `---
project: 에너빌드
sub_project: 에너지분석(에너빌드)
priority: high
category: action
status: planned
works:
notion: assigned
notion-url: https://app.notion.com/p/3cdc74945236801299cee4e4a816bfd4
notion-status: 시작 전
tags: []
created: 2026-09-01
updated:
completed:
---

## 업무 개요
- 프리셋 테스트 페이지 검토

## 출처
- Notion: [관리자용 프리셋 테스트 페이지](https://app.notion.com/p/3cdc74945236801299cee4e4a816bfd4)
- 할당 근거: 담당자 지정

## 체크리스트
- [ ] 프리셋 적용 결과 확인
`;

/** 사용자가 Obsidian에서 직접 쓴, 봇이 모르는 키가 섞인 노트 */
const HAND_NOTE = `---
project: 신재생에너지제안(EPC)
sub_project:
priority: mid
category: action
status: in-progress
works: pending
works-url: https://project.worksmobile.com?taskId=t-123
내가만든키: 보존되어야함
tags: [송도, 연료전지]
created: 2026-08-20
updated: 2026-08-25
completed:
due: 2026-09-30
---

## 업무 개요
- 송도 인천경제청 담당자 확인

본문에 --- 같은 구분선이 있어도 깨지면 안 된다.

## 체크리스트
- [x] 연락처 확보
- [ ] 통화
`;

beforeEach(() => {
  files.clear();
  writeLog = [];
  files.set("06_To Do/2026-09/0901_프리셋 테스트 페이지 검토.md", ASSIGNED_NOTE);
  files.set("06_To Do/2026-08/0820_송도 인천경제청 담당자 확인.md", HAND_NOTE);
});

describe("할일 목록 읽기", () => {
  it("열린 노트만 골라 마감·우선순위 순으로 정렬한다", async () => {
    files.set("06_To Do/2026-08/0801_끝난일.md", "---\nproject: 에너빌드\nstatus: done\ncompleted: 2026-08-05\n---\n\n본문\n");
    const open = await listOpenTasks();
    expect(open.map((t) => t.title)).toEqual(["송도 인천경제청 담당자 확인", "프리셋 테스트 페이지 검토"]);
    expect(open[0].due).toBe("2026-09-30");
    expect(open[1].due).toBeNull();
  });

  it("완료 노트는 완료일로 찾는다", async () => {
    files.set("06_To Do/2026-08/0801_끝난일.md", "---\nproject: 에너빌드\nstatus: done\ncompleted: 2026-08-05\n---\n\n본문\n");
    expect((await listCompletedOn("2026-08-05")).map((t) => t.title)).toEqual(["끝난일"]);
    expect(await listCompletedOn("2026-08-06")).toEqual([]);
  });

  it("키워드로 찾는다", async () => {
    expect((await findTasksByKeyword("프리셋")).map((t) => t.title)).toEqual(["프리셋 테스트 페이지 검토"]);
    expect(await findTasksByKeyword("없는말")).toEqual([]);
  });

  it("볼트 전체에서 Notion 링크를 모은다 (06_To Do + 01_진행업무)", async () => {
    files.set(
      "01_Projects/02_에너빌드/03_에너지분석/01_진행업무/0902_대안생성/0902_대안생성.md",
      "---\nproject: 에너빌드\nstatus: backlog\nnotion: registered\nnotion-url: https://app.notion.com/p/3c3c749452368024bb52e766f903a995\n---\n\n본문\n",
    );
    files.set("01_Projects/02_에너빌드/자료조사.md", "---\nnotion-url: https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n"); // 진행업무 아님 → 제외
    const links = await collectNotionLinks();
    expect(links.get("3cdc74945236801299cee4e4a816bfd4")).toBe("06_To Do/2026-09/0901_프리셋 테스트 페이지 검토.md");
    expect(links.get("3c3c749452368024bb52e766f903a995")).toContain("01_진행업무");
    expect(links.has("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });
});

describe("상태 변경이 남의 노트를 망가뜨리지 않는다", () => {
  it("완료 처리: status·completed·updated만 바뀌고 본문·모르는 키는 그대로", async () => {
    const before = (await listOpenTasks()).find((t) => t.title.includes("송도"))!;
    const after = await setStatus(before, "done");
    const raw = files.get(after.path)!;

    expect(after.status).toBe("done");
    expect(after.completed).toBe(TODAY);
    expect(after.updated).toBe(TODAY);
    // 모르는 키 보존
    expect(raw).toContain("works: pending");
    expect(raw).toContain("works-url: https://project.worksmobile.com?taskId=t-123");
    expect(raw).toContain("내가만든키: 보존되어야함");
    // 키 순서 보존 (project가 맨 앞)
    expect(raw.split("\n")[1]).toBe("project: 신재생에너지제안(EPC)");
    // 본문 보존 (구분선 포함)
    expect(raw).toContain("본문에 --- 같은 구분선이 있어도 깨지면 안 된다.");
    expect(raw).toContain("- [x] 연락처 확보");
    // 다시 읽어도 같은 값
    expect(fileToTask({ path: after.path, sha: "", content: raw })).toMatchObject({
      status: "done", completed: TODAY, project: "신재생에너지제안(EPC)", due: "2026-09-30", tags: ["송도", "연료전지"],
    });
  });

  it("진행 중으로 바꾸면 started가 붙고, 다시 열면 completed가 비워진다", async () => {
    const t = (await listOpenTasks()).find((x) => x.title.includes("프리셋"))!;
    const started = await setStatus(t, "in-progress");
    expect(files.get(started.path)).toContain(`started: ${TODAY}`);
    const done = await setStatus(started, "done");
    expect(done.completed).toBe(TODAY);
    const reopened = await setStatus(done, "planned");
    expect(reopened.completed).toBeNull();
    expect(files.get(reopened.path)).toContain("completed:\n");
  });

  it("Notion 상태만 갱신할 때 status는 건드리지 않는다", async () => {
    const t = (await listOpenTasks()).find((x) => x.title.includes("프리셋"))!;
    const after = await patchTask(t, { "notion-status": "진행 중" });
    expect(after.notionStatus).toBe("진행 중");
    expect(after.status).toBe("planned");
    expect(files.get(after.path)).toContain("notion-status: 진행 중");
    expect(files.get(after.path)).toContain("## 체크리스트\n- [ ] 프리셋 적용 결과 확인");
  });
});

describe("새 할일 노트 생성", () => {
  it("06_To Do/YYYY-MM/MMDD_제목.md 에 todo-capture 형식으로 만든다", async () => {
    const t = await createTask({ title: "ZEB 검토서 작성", project: "에너빌드", priority: "high", due: "2026-12-01", sources: ["Slack"] });
    expect(t.path).toBe(newTaskPath("ZEB 검토서 작성"));
    const raw = files.get(t.path)!;
    expect(raw.split("\n").slice(1, 6)).toEqual([
      "project: 에너빌드", "sub_project:", "priority: high", "category: action", "status: planned",
    ]);
    expect(raw).toContain("## 업무 개요\n- ZEB 검토서 작성");
    // 만든 노트를 곧바로 목록에서 볼 수 있어야 한다
    expect((await listOpenTasks()).some((x) => x.title === "ZEB 검토서 작성")).toBe(true);
  });

  it("project 없이 만들지 않는다", async () => {
    await expect(createTask({ title: "무엇", project: "" })).rejects.toThrow("project");
  });

  it("같은 이름이 이미 있으면 덮어쓰지 않는다", async () => {
    const a = await createTask({ title: "중복 제목", project: "에너빌드" });
    const b = await createTask({ title: "중복 제목", project: "에너빌드" });
    expect(b.path).not.toBe(a.path);
    expect(files.has(a.path)).toBe(true);
  });
});

describe("일일노트 작업일지 블록", () => {
  const USER_DAILY = `---
tags: [daily]
---

# 2026-09-04

## 오늘 생각
- 사용자가 직접 쓴 내용. 절대 지워지면 안 된다.

<!-- CLAUDE-CODE-LOG:START -->
## 🐾 Claude Code 작업 요약 (자동 생성)
다른 스킬의 블록
<!-- CLAUDE-CODE-LOG:END -->
`;

  it("일일노트가 없으면 만들고, 메모를 여러 번 쌓는다", async () => {
    await appendMemo(TODAY, "09:10 회의");
    await appendMemo(TODAY, "14:00 검토");
    const raw = files.get(`05_Daily/${TODAY}.md`)!;
    expect(raw).toContain("- 09:10 회의");
    expect(raw).toContain("- 14:00 검토");
    expect(raw.indexOf("09:10")).toBeLessThan(raw.indexOf("14:00"));
  });

  it("사용자 글과 다른 스킬 블록은 건드리지 않는다", async () => {
    files.set(`05_Daily/${TODAY}.md`, USER_DAILY);
    await appendMemo(TODAY, "15:00 메모");
    const raw = files.get(`05_Daily/${TODAY}.md`)!;
    expect(raw).toContain("- 사용자가 직접 쓴 내용. 절대 지워지면 안 된다.");
    expect(raw).toContain("<!-- CLAUDE-CODE-LOG:START -->");
    expect(raw).toContain("다른 스킬의 블록");
    expect(raw).toContain("- 15:00 메모");
  });

  it("월별 하위 폴더의 일일노트도 찾아 쓴다", async () => {
    const [y, m] = TODAY.split("-");
    files.set(`05_Daily/${y}-${m}/${TODAY}.md`, USER_DAILY);
    await appendMemo(TODAY, "16:00 메모");
    expect(files.has(`05_Daily/${TODAY}.md`)).toBe(false);
    expect(files.get(`05_Daily/${y}-${m}/${TODAY}.md`)).toContain("- 16:00 메모");
  });

  it("저녁 작업일지는 블록만 다시 쓰고 메모는 살린다", async () => {
    files.set(`05_Daily/${TODAY}.md`, USER_DAILY);
    await appendMemo(TODAY, "11:00 낮에 남긴 메모");
    const done = fileToTask({ path: "06_To Do/2026-08/x.md", sha: "", content: "---\nproject: 에너빌드\nstatus: done\n---\n\n본문\n" });
    const { path, memos } = await writeWorklogBlock({ date: TODAY, done: [done], active: [], events: [{ when: "10:00–11:00", summary: "설계협의" }], ticketChanges: [] });
    const raw = files.get(path)!;
    expect(memos).toEqual(["11:00 낮에 남긴 메모"]);
    expect(raw).toContain("- 11:00 낮에 남긴 메모");
    expect(raw).toContain("- 10:00–11:00 설계협의");
    expect(raw).toContain("- 사용자가 직접 쓴 내용. 절대 지워지면 안 된다.");
    // 블록이 두 번 생기지 않는다
    expect(raw.split("<!-- WORKHUB-LOG:START -->").length - 1).toBe(1);
  });
});

describe("무시 목록", () => {
  it("무시한 티켓 ID를 기억하고 다시 읽는다", async () => {
    expect((await readIgnored()).size).toBe(0);
    await addIgnored("3cdc74945236801299cee4e4a816bfd4", "관리자용 프리셋 테스트 페이지");
    await addIgnored("3c3c749452368024bb52e766f903a995", "공공 프로젝트 대안 생성 설정");
    const ignored = await readIgnored();
    expect(ignored.has("3cdc74945236801299cee4e4a816bfd4")).toBe(true);
    expect(ignored.has("3c3c749452368024bb52e766f903a995")).toBe(true);
    expect(files.get(".workhub/notion-ignored.txt")).toContain("# ");
  });
});

describe("Slack 명령 실행 (토큰 없이 볼트까지)", () => {
  const CTX = { userId: "U1", channelId: "C1" };
  const run = (cmd: string, text: string) => executeCommand(parseCommand(cmd, text), CTX);

  it("/할일 추가 → 노트 생성 + 카드 응답", async () => {
    const r = await run("/할일", "추가 ZEB 검토서 작성 | 2026-12-01 | 높음 | 에너빌드");
    expect(r.text).toContain("ZEB 검토서 작성");
    expect(JSON.stringify(r.blocks)).toContain("06_To Do/");
    expect((await listOpenTasks()).some((t) => t.title === "ZEB 검토서 작성")).toBe(true);
  });

  it("프로젝트를 못 정하면 만들지 않고 선택 버튼을 준다", async () => {
    const before = (await listOpenTasks()).length;
    const r = await run("/할일", "추가 무언가 애매한 일");
    expect(JSON.stringify(r.blocks)).toContain("task_project");
    expect((await listOpenTasks()).length).toBe(before);
  });

  it("제목에서 프로젝트를 추론한다", async () => {
    const r = await run("/할일", "추가 Step3 ALT 용량 확인 | 내일");
    expect(r.text).toContain("Step3 ALT 용량 확인");
    const made = (await listOpenTasks()).find((t) => t.title === "Step3 ALT 용량 확인")!;
    expect(made.project).toBe("에너빌드");
  });

  it("잘못된 마감일은 안내만 하고 만들지 않는다", async () => {
    const before = (await listOpenTasks()).length;
    const r = await run("/할일", "추가 무언가 | 언젠가 | 높음 | 에너빌드");
    expect(r.text).toContain("이해하지 못했");
    expect((await listOpenTasks()).length).toBe(before);
  });

  it("/할일 완료 키워드 → 노트가 완료된다", async () => {
    const r = await run("/할일", "완료 프리셋");
    expect(r.text).toContain("완료");
    const raw = files.get("06_To Do/2026-09/0901_프리셋 테스트 페이지 검토.md")!;
    expect(raw).toContain("status: done");
    expect(raw).toContain(`completed: ${TODAY}`);
  });

  it("여러 건이 걸리면 고르라고 하고 아무것도 바꾸지 않는다", async () => {
    files.set("06_To Do/2026-09/0902_용량 확인.md", "---\nproject: 에너빌드\nstatus: planned\n---\n\n본문\n");
    const r = await run("/할일", "완료 확인");
    expect(r.text).toContain("검색 결과");
    expect(files.get("06_To Do/2026-08/0820_송도 인천경제청 담당자 확인.md")).toContain("status: in-progress");
  });

  it("/할일 목록 → 카드가 그려진다", async () => {
    const r = await run("/할일", "목록 전체");
    expect(r.text).toContain("2건");
    expect(JSON.stringify(r.blocks)).toContain("task_done");
  });

  it("/작업일지 메모 → 일일노트에 시각과 함께 쌓인다", async () => {
    const r = await run("/작업일지", "증산4 ALT 용량 검토 완료");
    expect(r.text).toContain("증산4 ALT 용량 검토 완료");
    expect(files.get(`05_Daily/${TODAY}.md`)).toMatch(/- \d{2}:\d{2} 증산4 ALT 용량 검토 완료/);
  });

  it("/티켓 발급 → notion: pending 표시 (이미 티켓이 있으면 거절)", async () => {
    const r = await run("/티켓", "발급 송도");
    expect(r.text).toContain("발급 대기");
    expect(files.get("06_To Do/2026-08/0820_송도 인천경제청 담당자 확인.md")).toContain("notion: pending");

    const already = await run("/티켓", "발급 프리셋");
    expect(already.text).toContain("이미");
    expect(files.get("06_To Do/2026-09/0901_프리셋 테스트 페이지 검토.md")).toContain("notion: assigned");
  });

  it("Notion·캘린더가 꺼져 있으면 그 명령만 안내하고 멈춘다", async () => {
    expect((await run("/티켓", "할당")).text).toContain("꺼져");
    expect((await run("/일정", "오늘")).text).toContain("연결되지 않");
  });

  it("도움말은 항상 뜬다", async () => {
    for (const c of ["/할일", "/작업일지", "/일정", "/티켓"]) {
      expect((await run(c, "")).text.length).toBeGreaterThan(20);
    }
  });
});

describe("무시 목록 중복", () => {
  it("같은 티켓을 두 번 무시해도 한 줄만 남는다", async () => {
    await addIgnored("3CDC7494-5236-8012-99CE-E4E4A816BFD4", "제목");
    await addIgnored("3cdc74945236801299cee4e4a816bfd4", "제목");
    const body = files.get(".workhub/notion-ignored.txt")!;
    expect(body.split("3cdc74945236801299cee4e4a816bfd4").length - 1).toBe(1);
    expect((await readIgnored()).size).toBe(1);
  });
});
