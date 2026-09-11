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
  async readMany(entries: Array<{ path: string; sha: string }>) {
    return entries.map((e) => ({ path: e.path, sha: e.sha, content: files.get(e.path)! }));
  },
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

describe("요약 제목이 있으면 불릿 몇 개를 곁들인다", () => {
  const NOTE_DIR = "01_Projects/03_분산자원통합운영플랫폼/00_meeting note";

  it("`논의 사항` 제목 아래 불릿을 가져온다 (오늘 실제 노트)", async () => {
    files.set(`${NOTE_DIR}/0911_연료전지 모니터링 시스템 개발 논의_요약.md`, [
      "---",
      "status: done",
      "---",
      "# 0911 신재생에너지통합관리 시스템 개발 논의 요약",
      "",
      "## 논의 사항",
      "- HW 개발 방향 제안",
      "\t- 데이터 경로 엔드 디바이스 → PLC → 통합관리 SW",
      "- SW 개발",
      "\t- 에너지노 개발팀 주도",
      "## Action Item",
      "- 에너지노",
      "\t- 연료전지 제어 시스템 구성 확인 후 공유",
    ].join("\n"));

    const items = await projectNotesOn("2026-09-11");
    const item = items.find((i) => i.title.includes("요약"))!;
    expect(item.bullets.length).toBeGreaterThan(0);
    expect(item.bullets[0]).toBe("HW 개발 방향 제안");
    expect(item.done).toBe(true);
  });

  it("`Key Decisions` 제목도 알아본다 — 없으면 다음 우선순위로 넘어간다", async () => {
    files.set(`${NOTE_DIR}/0911_녹취정리.md`, [
      "# 제목",
      "## 1. 아키텍처 설계",
      "회의는 데이터 수집 경로를 효율화하는 방안으로 시작되었습니다. ".repeat(20),
      "## Key Decisions",
      "- 소프트웨어 개발은 내부 팀이 주도한다",
      "- 1단계에서는 REMS 인증보다 자체 시스템 구축을 우선한다",
    ].join("\n"));

    const items = await projectNotesOn("2026-09-11");
    const item = items.find((i) => i.title === "녹취정리")!;
    expect(item.bullets).toContain("소프트웨어 개발은 내부 팀이 주도한다");
  });

  it("요약 제목이 없는 긴 문서는 본문을 퍼오지 않고 제목만 남긴다", async () => {
    files.set(`${NOTE_DIR}/0911_API계약.md`, "## API 개요\n" + "긴 설명 문장입니다. ".repeat(200));

    const items = await projectNotesOn("2026-09-11");
    const item = items.find((i) => i.title === "API계약")!;
    expect(item.bullets).toEqual([]);
  });
});
