# 볼트 보조 파일

봇은 기존 볼트 규칙(`06_To Do/YYYY-MM/MMDD_제목.md`, `05_Daily/YYYY-MM-DD.md`)을 그대로 쓰므로 **별도 템플릿이 필요 없습니다.**
`Vault-Kanban` 앱과 `todo-capture` / `notion-todo-sync` / `notion-qa-ticket` 스킬이 만든 노트를 그대로 읽고 씁니다.

| 파일 | 어디에 | 용도 |
|---|---|---|
| `06_To Do/_대시보드.md` | 볼트 `06_To Do/` | Dataview로 열린 할일·마감·Notion 티켓 현황 한눈에 (선택) |

`_`로 시작하는 파일은 봇이 할일로 읽지 않습니다.

## 봇이 노트에 하는 일 (frontmatter만, 본문은 보존)

| 동작 | 바뀌는 필드 |
|---|---|
| `/할일 완료` · ✅ 버튼 | `status: done`, `completed`, `updated` |
| `/할일 시작` · 🔄 버튼 | `status: in-progress`, `started`, `updated` |
| `/티켓 발급` · 🎫 버튼 | `notion: pending`, `notion-url:`, `notion-status:` (발급은 notion-qa-ticket 스킬) |
| `/티켓 상태` · 브리핑 | `notion-status` (Notion 원본 상태), `updated` — `status`는 건드리지 않음 |
| Notion 후보 📥 등록 | 새 노트 생성 (`notion: assigned`, `notion-url`, `notion-status`, `due`) |
| 작업일지 | 일일노트 `<!-- WORKHUB-LOG:START/END -->` 블록 안만 |
