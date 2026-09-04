# jlaw-workhub — Slack에서 총괄하는 할일·작업일지·일정 관리 봇

**창고는 Obsidian 볼트(`Vault_jlaw80`), 리모컨은 Slack.**
할일은 `06_To Do/YYYY-MM/MMDD_제목.md`, 작업일지는 일일노트 `05_Daily/YYYY-MM-DD.md` — 기존 스킬(`todo-capture`,
`notion-todo-sync`, `notion-qa-ticket`, `claude-daily-log`)과 `Vault-Kanban` 앱이 쓰는 형식을 그대로 따릅니다.
Google Calendar는 일정, Notion(에너빌드작업 보드)은 **읽기 전용 접점**입니다. Vercel 서버리스로 동작하며 서버가 필요 없습니다.

## 할 수 있는 것

| 기능 | 어떻게 |
|---|---|
| 할일 작성 | `/할일 추가 ZEB 검토서 작성 \| 금요일 \| 높음 \| 에너빌드` → `06_To Do/2026-09/0904_ZEB 검토서 작성.md` + 캘린더 종일 일정. 프로젝트를 비우면 제목에서 추론, 못 정하면 버튼으로 묻습니다 |
| 할일 목록·상태 | `/할일 목록`, 카드의 ✅완료 / 🔄진행 중 버튼, `/할일 완료\|시작\|검토\|보류 키워드` (status: done / in-progress / review / backlog) |
| Obsidian·Vault-Kanban에서 편집 | 같은 파일이므로 어디서 바꿔도 다음 명령·브리핑에 반영 |
| 아침 브리핑 | 08:00 #할일: 오늘 일정 + 지연/오늘/이번주 할일 + Notion에서 넘어온 티켓 후보 + 내 티켓 상태 변화 |
| 작업일지 | `/작업일지 메모`로 누적 → 18:00 일일노트의 `<!-- WORKHUB-LOG -->` 블록에 완료·진행·일정·메모 정리 + #작업일지 게시 |
| 일정 | `/일정 오늘·내일·주간`, `/일정 추가 설계협의 \| 내일 \| 14:00 \| 15:30` |
| Notion 할당 감지 | 담당자 지정·댓글 멘션(최근 40건 스캔) → #업무에 후보 카드 → **📥 등록** 누르면 `notion: assigned` 노트 생성, **🙈 무시**는 기억 |
| Notion 상태 확인 | `/티켓 상태` → 연결된 노트의 `notion-status` 갱신·보고. Notion에서 끝난 티켓은 알려만 주고 노트 status는 사용자가 정리 |
| Notion 티켓 발급 | `/티켓 발급 키워드` 또는 🎫 버튼 → 노트에 `notion: pending` 표시 → Claude Code에서 `notion-qa-ticket` 스킬이 발급 |

## 구조

```
api/
├─ cron/daily-brief.ts   08:00 KST 브리핑 (+Notion 후보·상태 갱신·캘린더 동기화)
├─ cron/worklog.ts       18:00 KST 작업일지 (일일노트 블록)
├─ slack/command.ts      /할일 /작업일지 /일정 /티켓
├─ slack/interactive.ts  완료·진행·발급대기·프로젝트 선택·후보 등록/무시 버튼
├─ notion/webhook.ts     담당자 지정·멘션 → 후보 카드
└─ notion/pull.ts        수동: 후보 게시 + 상태 갱신
src/lib/
├─ vault.ts        창고: 06_To Do 노트 읽기·쓰기(frontmatter만), 일일노트 블록, project 추론
├─ github.ts       볼트 저장소 파일 API (트리 스캔 + 병렬 읽기)
├─ notion.ts       티켓 조회 (읽기 전용)     ├─ notion-sync.ts  후보 찾기 / 등록 / 상태 갱신 / 발급 대기
├─ slack.ts        Slack API·블록            ├─ gcal.ts         Google Calendar (서비스 계정)
├─ brief.ts        아침 브리핑               ├─ worklog.ts      작업일지
├─ commands.ts     명령 해석·실행            └─ dates.ts        KST 날짜·자연어 마감 해석
docs/SETUP.md              단계별 설치 가이드 (비개발자용)
obsidian-vault-templates/  06_To Do 대시보드(Dataview) — 선택
```

## 볼트 노트 형식 (정본: todo-capture 스킬)

```markdown
---
project: 에너빌드                 # 필수
sub_project: 에너지분석(에너빌드)
priority: high                    # high | mid | low
category: action
status: planned                   # planned | in-progress | review | done | backlog
works:                            # 네이버웍스 (works-todo 스킬) — 봇은 건드리지 않음
notion: assigned                  # assigned(할당받음) | registered(발급됨) | pending(발급 대기)
notion-url: https://app.notion.com/p/…
notion-status: 시작 전            # Notion 원본 상태 — 봇이 확인 시 갱신
tags: []
created: 2026-09-04
updated:
completed:
due: 2026-09-10                   # 선택 — Vault-Kanban·캘린더가 읽음
---

## 업무 개요
- …
## 출처
- Slack (9/4(금)) — <퍼머링크>  /  Notion: [제목](url) · 할당 근거: 담당자 지정
## 체크리스트
- [ ] …
```

봇은 **frontmatter만 고치고 본문은 보존**합니다 (Vault-Kanban 규칙과 동일). 파일을 옮기지 않습니다.

## 시작하기

1. `docs/SETUP.md`를 순서대로 따라 합니다 (볼트 GitHub 올리기 → Slack 앱 → Vercel 배포 → 명령 등록 → Notion/캘린더).
2. 필수 환경변수: `VAULT_REPO`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`
3. 선택: `NOTION_TOKEN`(할당 후보·상태 확인), `GOOGLE_SERVICE_ACCOUNT_JSON`(캘린더)

## 개발

```bash
npm install
npm run typecheck
npm test
```
