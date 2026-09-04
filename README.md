# jlaw-workhub — Slack에서 총괄하는 할일·작업일지·일정 관리 봇

**창고는 Obsidian 볼트, 리모컨은 Slack.** 할일과 작업일지는 볼트의 마크다운 파일이 유일한 원본이고,
Slack 슬래시 명령·버튼으로 그 파일을 만들고 바꿉니다. Google Calendar는 일정, Notion(에너빌드작업 보드)은
티켓 발급 / 할당 감지 / 상태 확인 세 가지 접점으로만 연결됩니다. Vercel 서버리스로 동작하며 서버가 필요 없습니다.

## 할 수 있는 것

| 기능 | 어떻게 |
|---|---|
| 할일 작성 | `/할일 추가 ZEB 검토서 작성 \| 금요일 \| 높음 \| 리서치` → `WorkHub/Tasks/…md` 생성 + 캘린더 종일 일정 |
| 할일 목록·상태 | `/할일 목록`, 카드의 ✅완료 / 🔄진행 중 버튼, `/할일 완료|시작|보류|취소 키워드` |
| Obsidian에서 작성 | `WorkHub/Tasks/`에 파일을 만들면 자동 등록, `status: 완료`로 바꾸면 Archive로 이동 |
| 아침 브리핑 | 08:00 #할일: 오늘 일정 + 지연/오늘/이번주 할일 + 새로 할당된 Notion 티켓 + 티켓 상태 변화 |
| 작업일지 | `/작업일지 메모`로 누적 → 18:00 `WorkHub/Worklog/날짜.md` 작성 + #작업일지 게시 |
| 일정 | `/일정 오늘·내일·주간`, `/일정 추가 설계협의 \| 내일 \| 14:00 \| 15:30` |
| Notion 티켓 발급 | `/티켓 발급 키워드` 또는 🎫 버튼 → 에너빌드작업 보드에 [QA] 양식 티켓, 파일에 링크 기록 |
| Notion 할당 감지 | 담당자로 지정되거나 코멘트에서 멘션 → 볼트 할일 등록 + 📌 Slack 알림 (웹훅 + 브리핑 폴링) |
| Notion 상태 확인 | `/티켓 상태` → 연결된 티켓 진행 상태, Notion에서 끝난 티켓은 볼트에서도 완료 처리 |

## 구조

```
api/
├─ cron/daily-brief.ts   08:00 KST 브리핑 (+Notion 할당 가져오기, 티켓 상태 갱신, 캘린더 동기화)
├─ cron/worklog.ts       18:00 KST 작업일지
├─ slack/command.ts      /할일 /작업일지 /일정 /티켓
├─ slack/interactive.ts  완료·진행·티켓발급 버튼
├─ notion/webhook.ts     담당자 지정·멘션 → 볼트 할일 + 알림
└─ notion/pull.ts        수동: 할당 가져오기 + 상태 갱신
src/lib/
├─ vault.ts        창고: 볼트 마크다운 할일/작업일지 읽기·쓰기 (frontmatter 규칙)
├─ github.ts       볼트 저장소 파일 API
├─ notion.ts       티켓 생성·조회 (접점 전용)
├─ notion-sync.ts  할당 가져오기 / 상태 갱신 / 티켓 발급 연결
├─ slack.ts        Slack API·블록          ├─ gcal.ts    Google Calendar (서비스 계정)
├─ brief.ts        아침 브리핑              ├─ worklog.ts 작업일지
├─ commands.ts     명령 해석·실행           └─ dates.ts   KST 날짜·자연어 마감 해석
docs/SETUP.md              단계별 설치 가이드 (비개발자용)
obsidian-vault-templates/  볼트용 템플릿·Dataview 예시
```

## 볼트 파일 형식

```markdown
---
id: "k7x2m9ab"
title: "ZEB 검토서 작성"
status: "할일"          # 할일 | 진행중 | 보류 | 완료 | 취소
priority: "높음"        # 높음 | 중간 | 낮음
due: "2026-09-05"
tags: ["리서치"]
source: "slack"         # slack | obsidian | notion
created: "2026-09-04"
completed:
notion_ticket:          # 발급/할당된 Notion 티켓 URL
notion_id:
notion_status:          # 마지막으로 확인한 Notion 진행 상태
---
자유 메모. 봇은 이 본문을 건드리지 않습니다. 티켓 발급 시 "요청사항"으로 들어갑니다.
```

## 시작하기

1. `docs/SETUP.md`를 순서대로 따라 합니다 (볼트 GitHub 올리기 → Slack 앱 → Vercel 배포 → 명령 등록 → Notion/캘린더).
2. 필수 환경변수: `VAULT_REPO`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`
3. 선택: `NOTION_TOKEN`(티켓 접점), `GOOGLE_SERVICE_ACCOUNT_JSON`(캘린더)

## 개발

```bash
npm install
npm run typecheck
npm test
```
