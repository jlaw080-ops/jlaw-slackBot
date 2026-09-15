/**
 * 일일보고를 더 짧게 — 항목당 불릿을 3개로 줄이고, 긴 줄은 잘라낸다.
 * "요약이 너무 길다" 는 피드백에 맞춘 변경.
 */
import { describe, expect, it } from "vitest";
import { condense, shorten, SHORT_BULLET_LIMIT, SHORT_LINE_CHARS, type ReportItem } from "../lib/report.js";

const item = (bullets: string[]): ReportItem => ({ title: "제목", project: "", bullets, links: [], done: false, from: "메모" });

describe("shorten", () => {
  it("짧은 줄은 그대로 둔다", () => {
    expect(shorten("짧은 줄")).toBe("짧은 줄");
  });
  it("긴 줄은 단어 경계에서 자르고 …을 붙인다", () => {
    const long = "이것은 매우 긴 문장이며 슬랙에서 한눈에 보기에는 너무 길어서 줄여야 하는 문장입니다";
    const out = shorten(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("…")).toBe(true);
    expect(long.startsWith(out.slice(0, -1).trimEnd())).toBe(true);
  });
  it("앞의 탭(하위 항목 깊이)은 자르지 않고 그대로 둔다", () => {
    const out = shorten("\t\t" + "아주 긴 하위 항목 내용입니다 ".repeat(5).trim());
    expect(out.startsWith("\t\t")).toBe(true);
  });
});

describe("condense", () => {
  it(`불릿을 최대 ${SHORT_BULLET_LIMIT}개로 줄이고, 나머지는 건수만 남긴다`, () => {
    const [out] = condense([item(["하나", "둘", "셋", "넷", "다섯"])]);
    expect(out.bullets).toHaveLength(SHORT_BULLET_LIMIT + 1);
    expect(out.bullets.slice(0, 3)).toEqual(["하나", "둘", "셋"]);
    expect(out.bullets[3]).toBe("… 외 2건 (원본 노트 참고)");
  });
  it(`${SHORT_BULLET_LIMIT}개 이하면 그대로 둔다 (건수 안내를 붙이지 않는다)`, () => {
    const [out] = condense([item(["하나", "둘"])]);
    expect(out.bullets).toEqual(["하나", "둘"]);
  });
  it("각 줄도 짧게 자른다", () => {
    const long = "가".repeat(SHORT_LINE_CHARS + 20);
    const [out] = condense([item([long])]);
    expect(out.bullets[0].length).toBeLessThan(long.length);
  });
  it("항목 개수·제목·완료 여부는 건드리지 않는다", () => {
    const items = [item(["하나"]), { ...item(["둘"]), title: "다른 제목", done: true }];
    const out = condense(items);
    expect(out).toHaveLength(2);
    expect(out[1].title).toBe("다른 제목");
    expect(out[1].done).toBe(true);
  });
});
