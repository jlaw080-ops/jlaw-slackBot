# notion-qa-ticket 스킬 수정안 — `notion: pending` 노트 자동 인식

봇의 `/티켓 발급 키워드`(또는 🎫 버튼)는 볼트 노트에 `notion: pending`만 표시합니다.
실제 발급은 `agents-skills/skills/notion-qa-ticket/SKILL.md` 스킬이 담당하므로, 스킬이 그 노트를 스스로 찾도록
아래 한 단락을 **"## 처리 순서 → 1. 입력 수집"** 에 추가해 주세요. (그 저장소는 이 세션에서 읽기 권한만 있어 직접 고치지 않았습니다.)

## 추가할 내용

```markdown
1. **입력 수집** — 네 경로 중 하나
   - 채팅 설명·스크린샷: 사용자가 상황을 서술
   - Obsidian 일일노트: `05_Daily/YYYY-MM-DD.md`의 N번 항목. 위키링크가 있으면 그 노트도 읽는다
   - 기존 Notion 페이지: URL을 받아 `notion-fetch`로 읽고 티켓으로 쪼갠다
   - **발급 대기 노트**: 사용자가 "노션 티켓 발급" 이라고만 하고 대상을 지정하지 않으면
     `06_To Do/**/*.md`에서 frontmatter `notion: pending`인 노트를 찾는다.

     ```
     Grep: pattern="^notion: pending", glob="06_To Do/**/*.md", path=<볼트 루트>, output_mode="files_with_matches"
     ```

     찾은 노트의 `## 업무 개요`·`## 배경`·`## 체크리스트`가 티켓 본문의 재료다. 제목은 노트 제목(파일명의 `MMDD_` 제거)에서
     화면태그·영문 병기를 붙여 만든다. `project`·`sub_project`·`priority`·`due`는 노트 값을 속성 기본값보다 우선한다
     (priority: high→높음, mid→중간, low→낮음). 여러 건이면 목록을 보여주고 어느 것을 발급할지 확인한다.
```

그리고 **"9. 볼트 노트 생성"** 뒤에 한 줄:

```markdown
   발급 대기 노트에서 온 건이면 새 노트를 만들지 않고 **그 노트의 frontmatter만** 갱신한다:
   `notion: pending` → `notion: registered`, `notion-url: <티켓 URL>`, `notion-status: 시작 전`, `updated: <오늘>`.
   본문은 건드리지 않는다. 진행업무 폴더(`01_Projects/…/01_진행업무/`)로 옮길지는 사용자에게 묻는다.
```

## 왜 이렇게 나누었나

| 역할 | 누가 | 이유 |
|---|---|---|
| 발급 대기 표시 | Slack 봇 | 이동 중에도 "이건 티켓으로" 라고 찍어 둘 수 있게 |
| 티켓 본문 작성·발급 | notion-qa-ticket 스킬 | 유형 판별·한/영 병기·중복 확인·사용자 승인이 필요해 자동화하면 품질이 떨어짐 |
| 발급 후 상태 확인 | Slack 봇 (`/티켓 상태`, 아침 브리핑) | `notion-url`만 있으면 봇이 `notion-status`를 갱신 |

## notion-todo-sync 스킬과의 관계

봇의 "Notion 할당 후보 → 📥 등록" 기능은 `notion-todo-sync` 스킬의 Step 1~6을 자동화한 것입니다.
같은 폴더·같은 frontmatter(`notion: assigned`, `notion-url`, `notion-status`)를 쓰고, 볼트 전체 `notion-url` 중복 검사도 같습니다.
둘을 번갈아 써도 중복 노트가 생기지 않습니다. 차이는 다음 두 가지뿐입니다.

- 봇은 Notion 본문 요약을 `## 배경`·`## 체크리스트`에 **자동으로** 몇 줄 넣습니다 (스킬은 사람이 요약).
- 봇은 `.workhub/notion-ignored.txt`에 "무시" 목록을 기억합니다. 스킬은 매번 사용자에게 묻습니다.
