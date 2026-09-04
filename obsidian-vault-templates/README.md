# Obsidian 볼트 템플릿

이 폴더의 파일을 볼트의 `Templates/` 폴더에 복사하고, Obsidian 설정 → 핵심 플러그인 → **템플릿**의 템플릿 폴더 위치를 `Templates`로 지정하세요.

| 템플릿 | 용도 |
|---|---|
| `Templates/할일-Inbox.md` | `WorkHub/Inbox/`에 새 파일을 만들 때 삽입. 다음 동기화 때 Notion 할일로 등록됩니다. |
| `Templates/작업일지-수동.md` | 봇이 만든 작업일지가 없을 때 직접 쓰는 양식 (봇은 같은 날짜 파일이 있으면 덮어씁니다) |

## Inbox 규칙
- 파일 이름 = 할일 제목 (frontmatter `title:`이 있으면 그 값 우선)
- `due:` 는 `2026-09-15`, `내일`, `금요일`, `+3` 모두 가능
- `priority:` 는 높음 / 중간 / 낮음
- `tags:` 는 Notion "태그" 옵션 이름과 같아야 합니다 (예: 리서치, 영업지원, CAD Project)
- 본문은 Notion 페이지 본문 첫 문단으로 들어갑니다

## Tasks 폴더 규칙
- 봇이 관리하는 부분: frontmatter와 상단 요약 줄
- `%% ── 아래는 자유 메모 영역 ── %%` 아래는 자유롭게 써도 보존됩니다
- frontmatter `status:` 를 `완료`로 바꾸면 다음 동기화 때 Notion 상태도 바뀝니다
  (단, 그 사이 Notion에서 상태가 바뀌었다면 Notion 쪽이 우선합니다)
