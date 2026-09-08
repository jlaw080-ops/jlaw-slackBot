import { describe, it, expect } from "vitest";
import { handwritten, renderReport, stripBlocks } from "../lib/report.js";

const NOTE = `<!-- WORKHUB-REPORT:START -->
## 📝 일일보고 초안 (자동 생성 — 다듬어서 위로 옮기세요)

**일일보고(김지헌) - 2026-09-08**

1. (오늘 기록된 작업이 없습니다)
<!-- WORKHUB-REPORT:END -->

<<<<<<< HEAD
**일일보고(김지헌) - 2026-09-08**

1. 에너빌드 - 에너지분석
\t- ESS 설치 프로세스 보완
\t- 전력계통영향평가 기준 적용
\t    - PCS 용량 기준
\t    - PCS->ESS 용량 역산 방법 추가 필요
2. 의왕시 프로젝트 수집  
\t- 1년간 나라장터 입찰공고 0건
\t- 정리 후 배효식 대표님께 전달
=======
<!-- WORKHUB-LOG:START -->
## 🗂 WorkHub 작업일지 (자동 생성)
### 📝 메모
- 
<!-- WORKHUB-LOG:END -->
>>>>>>> origin/main
`;

describe("일일노트 손글씨", () => {
  it("자동 블록과 충돌 표시를 걷어낸다", () => {
    const s = stripBlocks(NOTE);
    expect(s).not.toContain("WORKHUB");
    expect(s).not.toContain("<<<<<<<");
    expect(s).not.toContain("일일보고(김지헌)");
  });
  it("번호 항목과 하위 들여쓰기를 읽는다", () => {
    const items = handwritten(NOTE);
    expect(items.map((i) => i.title)).toEqual(["에너빌드 - 에너지분석", "의왕시 프로젝트 수집"]);
    expect(items[0].bullets).toEqual([
      "ESS 설치 프로세스 보완",
      "전력계통영향평가 기준 적용",
      "\tPCS 용량 기준",
      "\tPCS->ESS 용량 역산 방법 추가 필요",
    ]);
    expect(items.every((i) => i.from === "일일노트")).toBe(true);
  });
  it("보고 양식으로 엮으면 계층이 유지된다", () => {
    const out = renderReport(handwritten(NOTE), "2026-09-08");
    expect(out).toContain("1. 에너빌드 - 에너지분석");
    expect(out).toContain("    - 전력계통영향평가 기준 적용");
    expect(out).toContain("        - PCS 용량 기준");
  });
});
