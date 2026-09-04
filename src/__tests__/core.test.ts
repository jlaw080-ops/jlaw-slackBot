import { describe, expect, it } from "vitest";
import { addDays, parseDateInput, prettyKST, weekdayOf } from "../lib/dates.js";
import { normalizeCommand, parseCommand } from "../lib/commands.js";
import {
  extractBlock, extractMemos, fileToTask, guessProject, newTaskPath, normalizePriority, normalizeStatus, notionIdFromUrl,
  parseFrontmatter, priorityForTicket, projectForTicket, renderBlock, renderFrontmatter, renderNewTask, safeFileName, shortTitle,
} from "../lib/vault.js";
import { pageToTicket } from "../lib/notion.js";

process.env.VAULT_REPO = "test/vault";
process.env.GITHUB_TOKEN = "x";

const BASE = "2026-09-03"; // 목요일

describe("dates", () => {
  it("요일 계산", () => {
    expect(weekdayOf(BASE)).toBe(4);
    expect(prettyKST(BASE)).toBe("9/3(목)");
  });
  it("자연어 마감 해석", () => {
    expect(parseDateInput("오늘", BASE)).toBe("2026-09-03");
    expect(parseDateInput("내일", BASE)).toBe("2026-09-04");
    expect(parseDateInput("+3", BASE)).toBe("2026-09-06");
    expect(parseDateInput("이번주", BASE)).toBe("2026-09-04");
    expect(parseDateInput("다음주", BASE)).toBe("2026-09-11");
    expect(parseDateInput("9/15", BASE)).toBe("2026-09-15");
    expect(parseDateInput("1/5", BASE)).toBe("2027-01-05");
    expect(parseDateInput("언젠가", BASE)).toBeNull();
  });
  it("addDays 월 경계", () => { expect(addDays("2026-09-30", 1)).toBe("2026-10-01"); });
});

describe("slash command parsing", () => {
  it("명령 이름 정규화", () => {
    expect(normalizeCommand("/할일")).toBe("할일");
    expect(normalizeCommand("/todo")).toBe("할일");
    expect(normalizeCommand("/worklog")).toBe("작업일지");
    expect(normalizeCommand("/티켓")).toBe("티켓");
  });
  it("/할일 추가 제목 | 마감 | 우선순위 | 프로젝트", () => {
    expect(parseCommand("/할일", "추가 ZEB 검토서 작성 | 금요일 | 높음 | 에너빌드", BASE)).toEqual({
      kind: "todo.add", title: "ZEB 검토서 작성", due: "2026-09-04", priority: "high", project: "에너빌드", rawDue: "금요일", rawProject: "에너빌드",
    });
  });
  it("프로젝트 부분 일치·미지정", () => {
    expect(parseCommand("/할일", "추가 송도 담당자 확인 | | | EPC", BASE)).toMatchObject({ project: "신재생에너지제안(EPC)" });
    const p = parseCommand("/할일", "패시브하우스 자료 정리 | 내일", BASE);
    expect(p).toMatchObject({ kind: "todo.add", title: "패시브하우스 자료 정리", due: "2026-09-04", project: undefined });
  });
  it("상태 명령은 Vault-Kanban status 값으로", () => {
    expect(parseCommand("/할일", "완료 프리셋", BASE)).toEqual({ kind: "todo.status", keyword: "프리셋", status: "done" });
    expect(parseCommand("/할일", "시작 ALT 하드코딩", BASE)).toEqual({ kind: "todo.status", keyword: "ALT 하드코딩", status: "in-progress" });
    expect(parseCommand("/할일", "검토 데이터센터", BASE)).toEqual({ kind: "todo.status", keyword: "데이터센터", status: "review" });
    expect(parseCommand("/할일", "보류 데이터센터", BASE)).toEqual({ kind: "todo.status", keyword: "데이터센터", status: "backlog" });
  });
  it("/작업일지 · /일정 · /티켓", () => {
    expect(parseCommand("/작업일지", "증산4 ALT 용량 검토 완료", BASE)).toEqual({ kind: "worklog.note", text: "증산4 ALT 용량 검토 완료" });
    expect(parseCommand("/일정", "추가 설계협의 | 내일 | 14:00 | 15:30", BASE)).toEqual({ kind: "schedule.add", title: "설계협의", date: "2026-09-04", start: "14:00", end: "15:30", rawDate: "내일" });
    expect(parseCommand("/티켓", "발급 프리셋", BASE)).toEqual({ kind: "ticket.pending", keyword: "프리셋" });
    expect(parseCommand("/티켓", "상태", BASE)).toEqual({ kind: "ticket.status" });
    expect(parseCommand("/티켓", "할당", BASE)).toEqual({ kind: "ticket.pull" });
  });
});

describe("vault: todo-capture 형식", () => {
  const RAW = `---
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
- Notion: [x](https://app.notion.com/p/3cdc74945236801299cee4e4a816bfd4)
`;

  it("기존 노트 파싱 (notion-todo-sync가 만든 형식)", () => {
    const t = fileToTask({ path: "06_To Do/2026-09/0901_프리셋 테스트 페이지 검토.md", sha: "s", content: RAW });
    expect(t.title).toBe("프리셋 테스트 페이지 검토");
    expect(t.project).toBe("에너빌드");
    expect(t.subProject).toBe("에너지분석(에너빌드)");
    expect(t.priority).toBe("high");
    expect(t.status).toBe("planned");
    expect(t.notion).toBe("assigned");
    expect(t.notionStatus).toBe("시작 전");
    expect(notionIdFromUrl(t.notionUrl)).toBe("3cdc74945236801299cee4e4a816bfd4");
    expect(t.fmOrder.slice(0, 3)).toEqual(["project", "sub_project", "priority"]);
    expect(t.body).toContain("## 업무 개요");
  });

  it("frontmatter 갱신 시 키 순서·본문 보존", () => {
    const { fm, order, body } = parseFrontmatter(RAW);
    const out = `${renderFrontmatter({ ...fm, "notion-status": "진행 중", updated: "2026-09-04" }, order)}\n${body}`;
    expect(out.split("\n").slice(0, 3)).toEqual(["---", "project: 에너빌드", "sub_project: 에너지분석(에너빌드)"]);
    expect(out).toContain("notion-status: 진행 중");
    expect(out).toContain("## 업무 개요\n- 프리셋 테스트 페이지 검토");
    expect(out).toContain("works:\n");
  });

  it("Vault-Kanban 정규화: 한글 status/priority 도 읽힘", () => {
    expect(normalizeStatus("진행 중")).toBe("in-progress");
    expect(normalizeStatus("완료")).toBe("done");
    expect(normalizeStatus("예정")).toBe("planned");
    expect(normalizeStatus("검토중")).toBe("review");
    expect(normalizeStatus(undefined)).toBe("backlog");
    expect(normalizePriority("높음")).toBe("high");
    expect(normalizePriority("mid")).toBe("mid");
  });

  it("새 노트 경로·본문 (06_To Do/YYYY-MM/MMDD_제목.md)", () => {
    expect(newTaskPath("송도 인천경제청 담당자 확인", "2026-09-04")).toBe("06_To Do/2026-09/0904_송도 인천경제청 담당자 확인.md");
    const md = renderNewTask({ title: "ZEB 검토서 작성", project: "에너빌드", priority: "high", due: "2026-09-05", sources: ["Slack (9/4(금))"] }, "2026-09-04");
    expect(md).toContain("project: 에너빌드\nsub_project:\npriority: high\ncategory: action\nstatus: planned\nworks:\ntags: []\ncreated: 2026-09-04\nupdated:\ncompleted:\ndue: 2026-09-05");
    expect(md).toContain("## 업무 개요\n- ZEB 검토서 작성");
    expect(md).toContain("## 출처\n- Slack (9/4(금))");
    expect(md).toContain("## 체크리스트");
    const back = fileToTask({ path: "06_To Do/2026-09/0904_ZEB 검토서 작성.md", sha: "", content: md });
    expect(back).toMatchObject({ title: "ZEB 검토서 작성", project: "에너빌드", priority: "high", status: "planned", due: "2026-09-05" });
  });

  it("Notion 티켓 → 노트 규칙 (notion-todo-sync)", () => {
    expect(shortTitle("[Step3]대안 생성 기능 재검토 필요 / Need to re-examine")).toBe("대안 생성 기능 재검토 필요");
    expect(projectForTicket(["V5 QA"])).toEqual({ project: "에너빌드", subProject: "에너지분석(에너빌드)" });
    expect(projectForTicket(["웹사이트"])).toEqual({ project: "에너빌드", subProject: "" });
    expect(priorityForTicket("중간", "2026-09-08", BASE)).toBe("high"); // 7일 이내
    expect(priorityForTicket("중간", "2026-10-01", BASE)).toBe("mid");
    expect(priorityForTicket("낮음", null, BASE)).toBe("low");
    expect(priorityForTicket("", null, BASE)).toBe("mid");
  });

  it("project 키워드 추론 (todo-capture Step 4)", () => {
    expect(guessProject("송도 데이터센터 연료전지 제안")).toBe("신재생에너지제안(EPC)");
    expect(guessProject("Step3 ALT 용량 검토")).toBe("에너빌드");
    expect(guessProject("RTU 멀티빌딩 연동")).toBe("분산자원통합운영플랫폼");
    expect(guessProject("BIPV 난연재 시험")).toBe("BIPV특허기획");
    expect(guessProject("기업부설연구소 신고")).toBe("에너지노관리");
    expect(guessProject("패시브하우스 자료 정리")).toBeNull();
  });

  it("파일명 안전화·Notion ID 정규화", () => {
    expect(safeFileName('증산4/장위9 "ALT" 용량?')).toBe("증산4장위9 ALT 용량");
    expect(notionIdFromUrl("https://www.notion.so/abc-3cdc7494-5236-8012-99ce-e4e4a816bfd4?pvs=4")).toBe("3cdc74945236801299cee4e4a816bfd4");
    expect(notionIdFromUrl("")).toBeNull();
  });
});

describe("일일노트 WorkHub 블록", () => {
  it("블록 렌더·메모 추출", () => {
    const block = renderBlock({ date: BASE, done: [], active: [], events: [], memos: ["09:10 회의", "14:00 검토"] }, "18:00");
    const daily = `# 2026-09-03\n\n내가 쓴 일일노트 내용\n\n${block}\n\n<!-- CLAUDE-CODE-LOG:START -->\n다른 스킬 블록\n<!-- CLAUDE-CODE-LOG:END -->\n`;
    expect(extractBlock(daily)).toContain("WorkHub 작업일지");
    expect(extractMemos(daily)).toEqual(["09:10 회의", "14:00 검토"]);
  });
});

describe("notion 티켓", () => {
  it("페이지 → 티켓 (id는 32자리 hex)", () => {
    const tk = pageToTicket({
      id: "3cdc7494-5236-8012-99ce-e4e4a816bfd4", url: "https://notion.so/x", last_edited_time: "2026-09-03T00:00:00Z",
      properties: {
        작업: { title: [{ plain_text: "[Step3] ALT 용량" }] },
        "진행 상태": { status: { name: "테스트 중" } },
        우선순위: { select: { name: "중간" } },
        작업완료일: { date: { start: "2026-09-10" } },
        태그: { multi_select: [{ name: "V5 QA" }] },
        담당자: { people: [{ id: "u1", name: "김지헌" }] },
      },
    });
    expect(tk).toMatchObject({ id: "3cdc74945236801299cee4e4a816bfd4", title: "[Step3] ALT 용량", status: "테스트 중", priority: "중간", due: "2026-09-10", assigneeIds: ["u1"] });
  });
});
