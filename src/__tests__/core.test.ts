import { describe, expect, it } from "vitest";
import { addDays, parseDateInput, prettyKST, weekdayOf } from "../lib/dates.js";
import { normalizeCommand, parseCommand } from "../lib/commands.js";
import { parseFrontmatter, renderFrontmatter, renderTaskMarkdown, safeFileName } from "../lib/obsidian.js";
import { pageToTask } from "../lib/notion.js";

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
    expect(parseDateInput("이번주", BASE)).toBe("2026-09-04"); // 이번 주 금요일
    expect(parseDateInput("다음주", BASE)).toBe("2026-09-11");
    expect(parseDateInput("9/15", BASE)).toBe("2026-09-15");
    expect(parseDateInput("1/5", BASE)).toBe("2027-01-05"); // 지난 날짜는 내년으로
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
  });
  it("/할일 추가 제목 | 마감 | 우선순위 | 태그", () => {
    const p = parseCommand("/할일", "추가 ZEB 검토서 작성 | 금요일 | 높음 | 리서치, ZEB", BASE);
    expect(p).toEqual({ kind: "todo.add", title: "ZEB 검토서 작성", due: "2026-09-04", priority: "높음", tags: ["리서치", "ZEB"], rawDue: "금요일" });
  });
  it("하위 명령 없이 제목만 쓰면 추가", () => {
    const p = parseCommand("/할일", "패시브하우스 자료 정리 | 내일", BASE);
    expect(p.kind).toBe("todo.add");
    if (p.kind === "todo.add") { expect(p.title).toBe("패시브하우스 자료 정리"); expect(p.due).toBe("2026-09-04"); }
  });
  it("목록/완료/시작/도움말", () => {
    expect(parseCommand("/할일", "목록 전체", BASE)).toEqual({ kind: "todo.list", scope: "전체" });
    expect(parseCommand("/할일", "완료 프리셋", BASE)).toEqual({ kind: "todo.done", keyword: "프리셋" });
    expect(parseCommand("/할일", "시작 ALT 하드코딩", BASE)).toEqual({ kind: "todo.start", keyword: "ALT 하드코딩" });
    expect(parseCommand("/할일", "", BASE)).toEqual({ kind: "help", command: "할일" });
  });
  it("/작업일지 메모와 생성", () => {
    expect(parseCommand("/작업일지", "증산4 ALT 용량 검토 완료", BASE)).toEqual({ kind: "worklog.note", text: "증산4 ALT 용량 검토 완료" });
    expect(parseCommand("/작업일지", "생성", BASE)).toEqual({ kind: "worklog.generate" });
  });
  it("/일정", () => {
    expect(parseCommand("/일정", "", BASE)).toEqual({ kind: "help", command: "일정" });
    expect(parseCommand("/일정", "오늘", BASE)).toEqual({ kind: "schedule.list", days: 1, from: BASE });
    expect(parseCommand("/일정", "내일", BASE)).toEqual({ kind: "schedule.list", days: 1, from: "2026-09-04" });
    expect(parseCommand("/일정", "주간", BASE)).toEqual({ kind: "schedule.list", days: 7, from: BASE });
    expect(parseCommand("/일정", "추가 설계협의 | 내일 | 14:00 | 15:30", BASE)).toEqual({
      kind: "schedule.add", title: "설계협의", date: "2026-09-04", start: "14:00", end: "15:30", rawDate: "내일",
    });
    expect(parseCommand("/일정", "추가 현장방문 | 9/10 | 9", BASE)).toMatchObject({ kind: "schedule.add", date: "2026-09-10", start: "09:00" });
  });
});

describe("obsidian markdown", () => {
  const task = pageToTask({
    id: "abcd1234-0000-0000-0000-000000000000",
    url: "https://www.notion.so/abcd1234",
    created_time: "2026-09-01T00:00:00.000Z",
    last_edited_time: "2026-09-03T01:00:00.000Z",
    properties: {
      작업: { title: [{ plain_text: "ZEB 검토서 작성" }] },
      "진행 상태": { status: { name: "진행 중" } },
      우선순위: { select: { name: "높음" } },
      작업완료일: { date: { start: "2026-09-04", end: null } },
      태그: { multi_select: [{ name: "리서치" }] },
      담당자: { people: [{ id: "u1", name: "김지헌" }] },
      슬랙링크: { url: null },
    },
  });

  it("Notion 페이지 → Task", () => {
    expect(task.title).toBe("ZEB 검토서 작성");
    expect(task.status).toBe("진행 중");
    expect(task.due).toBe("2026-09-04");
    expect(task.assigneeNames).toEqual(["김지헌"]);
  });

  it("frontmatter 왕복", () => {
    const md = renderTaskMarkdown(task, "\n내 메모입니다\n");
    const { fm, body } = parseFrontmatter(md);
    expect(fm.notion_id).toBe(task.id);
    expect(fm.status).toBe("진행 중");
    expect(fm.synced_status).toBe("진행 중");
    expect(fm.tags).toEqual(["리서치"]);
    expect(body).toContain("- [ ] ZEB 검토서 작성");
    expect(body).toContain("내 메모입니다");
  });

  it("완료 작업은 체크박스 체크", () => {
    const md = renderTaskMarkdown({ ...task, status: "완료" });
    expect(md).toContain("- [x] ZEB 검토서 작성");
  });

  it("frontmatter 파서: 배열/불리언/빈값", () => {
    const { fm } = parseFrontmatter(renderFrontmatter({ a: ["x", "y"], b: true, c: null, d: "문자 열" }) + "\n본문");
    expect(fm).toEqual({ a: ["x", "y"], b: true, c: null, d: "문자 열" });
  });

  it("파일명 안전화", () => {
    expect(safeFileName('[Step3] 증산4/장위9 "ALT" 용량?')).toBe("Step3 증산4 장위9 ALT 용량");
  });
});
