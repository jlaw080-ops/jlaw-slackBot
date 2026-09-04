# Obsidian 볼트 템플릿

이 폴더의 파일들을 볼트에 복사해 쓰세요.

| 파일 | 어디에 | 용도 |
|---|---|---|
| `Templates/할일.md` | 볼트 `Templates/` | `WorkHub/Tasks/`에 새 할일을 손으로 만들 때 (핵심 플러그인 "템플릿" 사용) |
| `WorkHub/대시보드.md` | 볼트 `WorkHub/` | Dataview 플러그인으로 열린 할일·이번 주 마감·티켓 현황을 한눈에 |

## 규칙 요약
- `WorkHub/Tasks/` 안의 `.md` 파일 하나 = 할일 하나. frontmatter가 없어도 봇이 다음 실행 때 채워 줍니다.
- `status:`를 `완료`나 `취소`로 바꾸면 봇이 `WorkHub/Archive/YYYY-MM/`으로 옮깁니다.
- `due:`는 `2026-09-15` 형식. `priority:`는 높음/중간/낮음. `tags:`는 `["리서치", "ZEB"]` 형식.
- 본문은 자유. 봇은 frontmatter만 갱신하고 본문은 보존합니다.
- 티켓을 발급하면 `notion_ticket:`에 링크가, `notion_status:`에 Notion 진행 상태가 기록됩니다.
- `WorkHub/Worklog/날짜.md`의 `## 📝 메모` 아래 줄은 보존되고, 나머지 섹션은 저녁에 봇이 다시 씁니다.
