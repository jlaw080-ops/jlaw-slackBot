/**
 * 진행업무 폴더 **안쪽 하위 폴더**에 남긴 그날 문서가 일일보고에서 사라지지 않는지 검증합니다.
 * 실제로 겪은 사례: `…/01_진행업무/0831데이터센터 ALT 작성/dc_capacity/docs/2026.09.10_인계.md`
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("../lib/github.js", () => ({
  async listTree(subdir?: string) {
    const prefix = subdir ? `${subdir}/` : "";
    return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ path: p, sha: "s", type: "blob" as const }));
  },
  async readMany() { return []; },
  async readFile() { return null; },
  async writeFile() { return; },
}));

const { projectNotesOn } = await import("../lib/report.js");

const WORK = "01_Projects/02_에너빌드/03_에너지분석/01_진행업무/0831데이터센터 ALT 작성";

beforeEach(() => {
  files.clear();
  for (const p of [
    `${WORK}/dc_capacity/docs/2026.09.10_API계약.md`,
    `${WORK}/dc_capacity/docs/2026.09.10_산식근거.md`,
    `${WORK}/dc_capacity/docs/2026.09.10_인계.md`,
    `${WORK}/0831데이터센터 ALT 작성.md`,
    "01_Projects/02_에너빌드/00_meeting note/0910_SW 미팅.md",
    "01_Projects/02_에너빌드/00_meeting note/0909_어제 미팅.md",
    "01_Projects/99_아카이브(완료 및 범위 외)/2026.09.10_묵은 것.md",
  ]) files.set(p, "# 제목\n");
});

describe("그날 날짜가 붙은 프로젝트 노트", () => {
  it("진행업무 폴더 안쪽 하위 폴더의 문서도 찾아낸다", async () => {
    const titles = (await projectNotesOn("2026-09-10")).map((i) => i.title);
    expect(titles).toContain("API계약");
    expect(titles).toContain("산식근거");
    expect(titles).toContain("인계");
    expect(titles).toContain("SW 미팅");
  });

  it("다른 날짜와 아카이브는 빼고, 프로젝트 이름을 붙인다", async () => {
    const items = await projectNotesOn("2026-09-10");
    expect(items.map((i) => i.title)).not.toContain("어제 미팅");
    expect(items.map((i) => i.title)).not.toContain("묵은 것");
    expect(items.every((i) => i.project === "에너빌드")).toBe(true);
  });

  it("1번 재료가 이미 읽은 파일은 건너뛴다", async () => {
    const skip = new Set([`${WORK}/dc_capacity/docs/2026.09.10_인계.md`]);
    const titles = (await projectNotesOn("2026-09-10", skip)).map((i) => i.title);
    expect(titles).not.toContain("인계");
    expect(titles).toContain("API계약");
  });
});
