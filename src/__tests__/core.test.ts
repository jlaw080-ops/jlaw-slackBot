import { describe, expect, it } from "vitest";
import { addDays, parseDateInput, prettyKST, weekdayOf } from "../lib/dates.js";
import { normalizeCommand, parseCommand } from "../lib/commands.js";
import { appendMemo, extractMemos, fileToTask, parseFrontmatter, renderFrontmatter, renderTask, renderWorklog, safeFileName, taskPath, type VaultTask } from "../lib/vault.js";
import { pageToTicket, ticketToVaultStatus } from "../lib/notion.js";

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
    expect(parseDateInput("모레", BASE)).toBe("2026-09-05");
    expect(parseDateInput("+3", BASE)).toBe("2026-09-06");
    expect(parseDateInput("이번주", BASE)).toBe("2026-09-04");
    expect(parseDateInput("다음주", BASE)).toBe("2026-09-11");
    expect(parseDateInput("9/15", BASE)).toBe("2026-09-15");
    expect(parseDateInput("1/5", BASE)).toBe("2027-01-05");
    expect(parseDateInput("2026-12-01", BASE)).toBe("2026-12-01");
    expect(parseDateInput("언젠가", BASE)).toBeNull();
  });
  it("addDays 월 경계", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });
});

describe("slash command parsing", () => {
  it("명령 이름 정규화", () => {
    expect(normalizeCommand("/할일")).toBe("할일");
    expect(normalizeCommand("/todo")).toBe("할일");
    expect(normalizeCommand("/worklog")).toBe("작업일지");
    expect(normalizeCommand("/일정")).toBe("일정");
    expect(normalizeCommand("/티켓")).toBe("티켓");
  });
  it("/할일 추가 제목 | 마감 | 우선순위 | 태그", () => {
    expect(parseCommand("/할일", "추가 ZEB 검토서 작성 | 금요일 | 높음 | 리서치, ZEB", BASE)).toEqual({
      kind: "todo.add", title: "ZEB 검토서 작성", due: "2026-09-04", priority: "높음", tags: ["리서치", "ZEB"], rawDue: "금요일",
    });
  });
  it("하위 명령 없이 제목만 쓰면 추가", () => {
    const p = parseCommand("/할일", "패시브하우스 자료 정리 | 내일", BASE);
    expect(p).toMatchObject({ kind: "todo.add", title: "패시브하우스 자료 정리", due: "2026-09-04" });
  });
  it("목록/상태/도움말", () => {
    expect(parseCommand("/할일", "목록 전체", BASE)).toEqual({ kind: "todo.list", scope: "전체" });
    expect(parseCommand("/할일", "완료 프리셋", BASE)).toEqual({ kind: "todo.status", keyword: "프리셋", status: "완료" });
    expect(parseCommand("/할일", "시작 ALT 하드코딩", BASE)).toEqual({ kind: "todo.status", keyword: "ALT 하드코딩", status: "진행중" });
    expect(parseCommand("/할일", "보류 데이터센터", BASE)).toEqual({ kind: "todo.status", keyword: "데이터센터", status: "보류" });
    expect(parseCommand("/할일", "", BASE)).toEqual({ kind: "help", command: "할일" });
  });
  it("/작업일지", () => {
    expect(parseCommand("/작업일지", "증산4 ALT 용량 검토 완료", BASE)).toEqual({ kind: "worklog.note", text: "증산4 ALT 용량 검토 완료" });
    expect(parseCommand("/작업일지", "생성", BASE)).toEqual({ kind: "worklog.generate" });
  });
  it("/일정", () => {
    expect(parseCommand("/일정", "", BASE)).toEqual({ kind: "help", command: "일정" });
    expect(parseCommand("/일정", "내일", BASE)).toEqual({ kind: "schedule.list", days: 1, from: "2026-09-04" });
    expect(parseCommand("/일정", "주간", BASE)).toEqual({ kind: "schedule.list", days: 7, from: BASE });
    expect(parseCommand("/일정", "추가 설계협의 | 내일 | 14:00 | 15:30", BASE)).toEqual({
      kind: "schedule.add", title: "설계협의", date: "2026-09-04", start: "14:00", end: "15:30", rawDate: "내일",
    });
  });
  it("/티켓", () => {
    expect(parseCommand("/티켓", "발급 프리셋", BASE)).toEqual({ kind: "ticket.issue", keyword: "프리셋" });
    expect(parseCommand("/티켓", "발급 대안 생성 검토 | 다음주 | 높음 | V5 QA", BASE)).toEqual({
      kind: "ticket.issueNew", title: "대안 생성 검토", due: "2026-09-11", priority: "높음", tags: ["V5 QA"], rawDue: "다음주",
    });
    expect(parseCommand("/티켓", "상태", BASE)).toEqual({ kind: "ticket.status" });
    expect(parseCommand("/티켓", "할당", BASE)).toEqual({ kind: "ticket.pull" });
    expect(parseCommand("/티켓", "", BASE)).toEqual({ kind: "help", command: "티켓" });
  });
});

describe("vault (창고) 마크다운", () => {
  const task: Omit<VaultTask, "path" | "sha"> = {
    id: "k7x2m9ab", title: "ZEB 검토서 작성", status: "할일", priority: "높음", due: "2026-09-05", tags: ["리서치"],
    source: "slack", created: BASE, completed: null, notionTicket: null, notionId: null, notionStatus: null, body: "내 메모입니다\n",
  };

  it("파일 경로: 열린 할일은 Tasks/, 완료는 Archive/YYYY-MM/", () => {
    expect(taskPath(task)).toBe("WorkHub/Tasks/ZEB 검토서 작성 (k7x2m9ab).md");
    expect(taskPath({ ...task, status: "완료", completed: "2026-09-10" })).toBe("WorkHub/Archive/2026-09/ZEB 검토서 작성 (k7x2m9ab).md");
  });

  it("렌더 → 파싱 왕복", () => {
    const md = renderTask(task);
    const t = fileToTask({ path: taskPath(task), sha: "s", content: md })!;
    expect(t).toMatchObject({ id: "k7x2m9ab", title: "ZEB 검토서 작성", status: "할일", priority: "높음", due: "2026-09-05", tags: ["리서치"], source: "slack" });
    expect(t.body.trim()).toBe("내 메모입니다");
  });

  it("Obsidian에서 손으로 만든 파일 (frontmatter 없음)도 읽힘", () => {
    const t = fileToTask({ path: "WorkHub/Tasks/현장 답사 준비.md", sha: "s", content: "# 준비물\n- 도면\n" })!;
    expect(t.title).toBe("현장 답사 준비");
    expect(t.id).toBe("");
    expect(t.status).toBe("할일");
  });

  it("frontmatter 파서: 배열/불리언/빈값", () => {
    const { fm } = parseFrontmatter(renderFrontmatter({ a: ["x", "y"], b: true, c: null, d: "문자 열" }) + "\n본문");
    expect(fm).toEqual({ a: ["x", "y"], b: true, c: null, d: "문자 열" });
  });

  it("작업일지 메모 추출", () => {
    const md = renderWorklog({ date: BASE, done: [], active: [], events: [], memos: ["09:10 회의", "14:00 검토"] });
    expect(extractMemos(md)).toEqual(["09:10 회의", "14:00 검토"]);
    expect(md).toContain("# 2026-09-03 작업일지");
  });

  it("파일명 안전화", () => {
    expect(safeFileName('[Step3] 증산4/장위9 "ALT" 용량?')).toBe("Step3 증산4 장위9 ALT 용량");
  });
});

describe("notion 티켓", () => {
  it("페이지 → 티켓, 상태 대응", () => {
    const tk = pageToTicket({
      id: "abcd", url: "https://notion.so/abcd", last_edited_time: "2026-09-03T00:00:00Z",
      properties: {
        작업: { title: [{ plain_text: "[Step3] ALT 용량" }] },
        "진행 상태": { status: { name: "테스트 중" } },
        우선순위: { select: { name: "중간" } },
        작업완료일: { date: { start: "2026-09-10" } },
        태그: { multi_select: [{ name: "V5 QA" }] },
        담당자: { people: [{ id: "u1", name: "김지헌" }] },
      },
    });
    expect(tk).toMatchObject({ title: "[Step3] ALT 용량", status: "테스트 중", priority: "중간", due: "2026-09-10", tags: ["V5 QA"], assigneeIds: ["u1"] });
    expect(ticketToVaultStatus("테스트 중")).toBe("진행중");
    expect(ticketToVaultStatus("완료")).toBe("완료");
    expect(ticketToVaultStatus("업무제외")).toBe("취소");
    expect(ticketToVaultStatus("시작 전")).toBe("할일");
  });
});

// appendMemo는 GitHub API를 호출하므로 여기서는 타입만 확인
void appendMemo;
