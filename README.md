# jlaw-workhub — Slack에서 총괄하는 할일·작업일지·일정 관리 봇

**Slack을 조작 화면**으로, **Notion을 데이터 원본**으로, **Google Calendar·Obsidian**을 자동 동기화 대상으로 쓰는
개인 업무관리 시스템입니다. Vercel 서버리스 함수로 동작하며 별도 서버가 필요 없습니다.

## 할 수 있는 것

| 기능 | 어떻게 |
|---|---|
| 새 할일 작성 | `/할일 추가 ZEB 검토서 작성 \| 금요일 \| 높음 \| 리서치` → Notion 에너빌드작업 DB에 생성 + 캘린더 종일 일정 |
| 할일 목록·상태 변경 | `/할일 목록`, 버튼으로 ✅완료 / 🔄진행 중, `/할일 완료 키워드` |
| 아침 브리핑 | 매일 08:00 #할일 채널에 오늘 일정 + 지연/오늘/이번주 할일 자동 게시 |
| 작업일지 | 낮에 `/작업일지 메모` 로 누적 → 18:00 Notion 작업일지 DB + Obsidian + #작업일지 자동 생성 |
| 일정 | `/일정 오늘·내일·주간`, `/일정 추가 설계협의 \| 내일 \| 14:00 \| 15:30` |
| 업무 할당 알림 | Notion에서 담당자 지정 → Slack DM/#업무로 📌 알림 (Notion 자동화 웹훅) |
| Obsidian 양방향 | `WorkHub/Inbox/*.md` → Notion 할일 / Notion 할일 → `WorkHub/Tasks/*.md` / 작업일지 → `WorkHub/Worklog/` |

## 구조

```
api/
├─ cron/daily-brief.ts   08:00 KST 아침 브리핑 + 캘린더·볼트 동기화
├─ cron/worklog.ts       18:00 KST 작업일지 생성
├─ slack/command.ts      /할일 /작업일지 /일정 슬래시 명령
├─ slack/interactive.ts  완료/진행 버튼
├─ notion/webhook.ts     담당자 변경 → Slack 알림
└─ obsidian/sync.ts      볼트 ↔ Notion 동기화 (GitHub webhook / 수동)
src/lib/
├─ config.ts   환경변수          ├─ notion.ts   Notion API
├─ slack.ts    Slack API/블록     ├─ gcal.ts     Google Calendar (서비스 계정)
├─ github.ts   볼트 저장소 파일   ├─ obsidian.ts 마크다운 변환·동기화 규칙
├─ brief.ts    아침 브리핑        ├─ worklog.ts  작업일지
├─ commands.ts 명령 해석·실행     └─ dates.ts    KST 날짜/자연어 마감 해석
docs/SETUP.md                  단계별 설치 가이드 (비개발자용)
obsidian-vault-templates/      볼트에 복사해 쓰는 템플릿
```

## 시작하기

1. `docs/SETUP.md`를 순서대로 따라 합니다 (Notion 통합 → Slack 앱 → Vercel 배포 → 명령 등록).
2. 필수 환경변수: `NOTION_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`
3. 선택: `GOOGLE_SERVICE_ACCOUNT_JSON`(캘린더), `OBSIDIAN_REPO` + `GITHUB_TOKEN`(Obsidian)

선택 항목이 비어 있으면 해당 기능만 조용히 꺼지고 나머지는 정상 동작합니다.

## 개발

```bash
npm install
npm run typecheck   # 타입 검사
npm test            # 단위 테스트 (날짜 해석, 명령 파싱, 마크다운 변환)
```
