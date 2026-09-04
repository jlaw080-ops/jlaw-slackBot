# 설치 가이드 (처음부터 끝까지)

이 문서는 **개발 경험이 없어도** 따라 할 수 있도록 순서대로 썼습니다.
각 단계의 목표는 "복사해서 붙여넣을 값"을 얻는 것이고, 마지막에 Vercel 환경변수 화면에 한 번에 넣습니다.
`.env.example` 파일을 메모장에 열어 두고 채워 나가면 편합니다.

---

## 전체 그림 — 창고는 Obsidian, 리모컨은 Slack

```
 Slack (조작 화면)                          Vercel (봇 서버, 무료)
 ┌──────────────┐  /할일 /작업일지 /일정 /티켓  ┌──────────────────────┐
 │ #할일        │ ─────────────────────────▶ │ api/slack/command    │
 │ #작업일지    │ ◀───────────────────────── │ api/slack/interactive│ 버튼(완료/진행/티켓발급)
 │ #업무 (+DM)  │ ◀───────────────────────── │ api/cron/daily-brief │ 08:00 아침 브리핑
 └──────────────┘                            │ api/cron/worklog     │ 18:00 작업일지
                                             │ api/notion/webhook   │ ◀── Notion 담당자 지정/멘션
                                             └──────┬────────┬──────┘
                                                    │        │
       ┌────────────────────────────────────────────┘        └──────────────┐
       ▼                                                                    ▼
 【창고】 Obsidian 볼트 = GitHub 저장소                                Google Calendar (선택)
   WorkHub/Tasks/    할일 1개 = 파일 1개 (frontmatter로 상태·마감)        · 할일 마감 → 종일 일정
   WorkHub/Archive/  완료된 할일 (월별)                                  · /일정 추가 → 시간 일정
   WorkHub/Worklog/  날짜별 작업일지
   ▲ Obsidian Git 플러그인이 내 PC ↔ GitHub 를 자동 동기화

 【접점만】 Notion 에너빌드작업 보드 (선택)
   · 티켓 발급: 볼트/Slack 할일 → Notion 티켓 ([QA] 템플릿 양식)  → 파일에 notion_ticket 링크 기록
   · 할당 감지: 담당자가 나 / 코멘트 멘션 → 볼트 할일로 등록 + Slack 알림
   · 상태 확인: 연결된 티켓의 진행 상태를 파일에 기록, Notion에서 끝나면 볼트에서도 완료
```

**Notion에는 아무것도 저장하지 않습니다.** 볼트 파일이 유일한 원본이고, Notion은 스프린트 보드로만 씁니다.

---

## 1단계. Obsidian 볼트를 GitHub에 올리기 — 필수 (창고)

Obsidian은 내 PC 폴더라 클라우드 봇이 직접 볼 수 없습니다. GitHub가 중간 다리입니다.

1. GitHub → **New repository** → 이름 `obsidian-vault`, **Private** → Create
2. Obsidian → 설정 → 커뮤니티 플러그인 → **Git** (Obsidian Git) 설치·활성화
3. 명령 팔레트(Ctrl/Cmd+P) → `Git: Initialize a new repo` → `Git: Set remote URL`에 위 저장소 주소 입력
   → `Git: Commit-and-sync` 한 번 실행 (처음엔 GitHub 로그인/토큰을 물어봅니다)
4. Git 플러그인 설정
   - **Auto commit-and-sync interval**: `5` (분) → 내가 쓴 내용이 5분마다 올라감
   - **Auto pull interval**: `5` (분) → 봇이 쓴 내용이 5분마다 내려옴
   - **Pull on startup**: 켜기
5. 볼트 안에 `WorkHub/Tasks`, `WorkHub/Worklog` 폴더를 만들어 두면 좋습니다 (없으면 봇이 첫 저장 때 만듭니다).

### 봇에게 저장소 접근권 주기
1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens → Generate new token**
   - Repository access: **Only select repositories** → `obsidian-vault`
   - Permissions → Repository permissions → **Contents: Read and write**
2. 토큰 복사 → `GITHUB_TOKEN`, 저장소 이름 `사용자명/obsidian-vault` → `VAULT_REPO`
3. (선택) Obsidian 볼트 이름(왼쪽 아래 표시되는 이름) → `OBSIDIAN_VAULT_NAME` — Slack 메시지에 "Obsidian에서 열기" 링크가 붙습니다.

---

## 2단계. Slack 앱 만들기 — 필수 (리모컨)

1. https://api.slack.com/apps → **Create New App → From scratch** → App Name `WorkHub`, 워크스페이스 선택
2. **OAuth & Permissions → Scopes → Bot Token Scopes**에 추가: `chat:write`, `commands`, `im:write`, `chat:write.public`
3. 같은 페이지 상단 **Install to Workspace** → 허용 → **Bot User OAuth Token** (`xoxb-…`) 복사 → `SLACK_BOT_TOKEN`
4. **Basic Information → App Credentials → Signing Secret** 복사 → `SLACK_SIGNING_SECRET`
5. (선택) DM 알림: Slack 내 프로필 → `…` → **멤버 ID 복사** → `SLACK_ME_USER_ID`
6. #할일, #작업일지, #업무 채널에서 `/invite @WorkHub`
7. 슬래시 명령·버튼 URL 등록은 배포 주소가 필요하므로 **4단계 뒤에** 합니다.

---

## 3단계. Vercel 배포 — 필수

1. https://vercel.com → **Add New → Project** → GitHub `jlaw080-ops/jlaw-slackBot` → Import
2. **Environment Variables**에 지금까지 모은 값 입력
   - 최소: `VAULT_REPO`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`(아무 긴 문자열)
3. **Deploy** → 완료되면 주소가 생깁니다. 예: `https://jlaw-slackbot.vercel.app` (이하 `배포주소`)
4. 확인: 브라우저에서 `배포주소/api/cron/daily-brief?secret=CRON_SECRET값` 열기 → #할일에 브리핑이 오면 성공

> Vercel 무료(Hobby) 플랜은 크론 2개, 하루 1회 실행까지입니다. 현재 설정(08:00 브리핑, 18:00 작업일지)은 그 범위 안입니다.
> 시간 변경은 `vercel.json`에서 UTC로 (KST − 9시간).

---

## 4단계. Slack 슬래시 명령 + 버튼 연결 — 필수

https://api.slack.com/apps → WorkHub

1. **Slash Commands → Create New Command**, 4개 모두 Request URL은 `배포주소/api/slack/command`

   | Command | Short Description | Usage Hint |
   |---|---|---|
   | `/할일` | 볼트 할일 추가·목록·완료 | `추가 제목 \| 마감 \| 우선순위` |
   | `/작업일지` | 오늘 작업일지 메모 | `오늘 한 일` |
   | `/일정` | 캘린더 보기·추가 | `오늘 / 내일 / 주간` |
   | `/티켓` | Notion 티켓 발급·상태 | `발급 키워드 / 상태 / 할당` |

   한글 명령이 안 되면 `/todo`, `/worklog`, `/cal`, `/ticket`으로 만들어도 동일하게 동작합니다.
2. **Interactivity & Shortcuts** → On → Request URL `배포주소/api/slack/interactive` → Save
3. **Install App → Reinstall to Workspace**
4. Slack에서 `/할일` 입력 → 도움말이 뜨면 성공. `/할일 추가 테스트 | 내일` → 볼트 `WorkHub/Tasks/`에 파일이 생기고 몇 분 뒤 Obsidian에 나타납니다.

---

## 5단계. Notion 접점 — 선택

### 5-1. 통합 토큰
1. https://www.notion.so/my-integrations → **새 API 통합 만들기** → 이름 `jlaw-workhub` → 시크릿 복사 → `NOTION_TOKEN`
2. Notion에서 **프로젝트와 작업** 페이지 → `…` → **연결** → `jlaw-workhub` (아래 에너빌드작업 DB까지 접근됩니다)
3. Vercel 환경변수에 넣고 **Redeploy**

이제 Slack에서 `/티켓 발급 키워드`, `/티켓 상태`, `/티켓 할당`, 그리고 할일 카드의 **🎫 티켓 발급** 버튼이 동작합니다.

### 5-2. 할당 알림 자동화 (담당자 지정 즉시 알림)
1. **에너빌드작업** DB → ⚡ 자동화 → **새 자동화**
2. 트리거: **속성 편집됨 → 담당자**
3. 작업: **웹훅 보내기** → URL `배포주소/api/notion/webhook?secret=NOTION_WEBHOOK_SECRET값`
4. 저장 후 아무 티켓의 담당자를 나로 바꿔 보면 #업무(+DM)에 📌 알림이 오고 볼트에 할일 파일이 생깁니다.

> 웹훅 자동화는 Notion 플러스 플랜 이상입니다. 없어도 **아침 브리핑**과 `/티켓 할당`이 Notion을 직접 조회해 할당된 티켓을 가져옵니다.
> 코멘트 멘션 감지는 Notion 통합 웹훅(`comment.created`)을 구독했을 때만 동작합니다 (통합 설정 → Webhooks → URL 등록).

---

## 6단계. Google Calendar — 선택

1. https://console.cloud.google.com → 새 프로젝트 → **API 및 서비스 → 라이브러리 → Google Calendar API → 사용**
2. **사용자 인증 정보 → 서비스 계정** 생성 → **키 → 새 키 만들기 → JSON** 다운로드
3. JSON 파일 내용 전체 → `GOOGLE_SERVICE_ACCOUNT_JSON` (여러 줄 그대로 붙여넣어도 됩니다)
4. JSON 안의 `client_email` 값을 복사 → Google 캘린더(웹) → 내 캘린더 **설정 및 공유 → 특정 사용자와 공유** → 추가, 권한 **일정 변경**
5. Vercel **Redeploy**

---

## 매일 이렇게 씁니다

| 시각 | 무엇이 | 어디에 |
|---|---|---|
| 08:00 | ☀️ 브리핑: 오늘 일정, 지연/오늘/이번주 할일, 새로 할당된 Notion 티켓, 티켓 상태 변화 | Slack #할일 |
| 수시 | `/할일 추가 제목 \| 내일 \| 높음` → 볼트 파일 + 캘린더 | Slack 어디서나 |
| 수시 | Obsidian에서 `WorkHub/Tasks/`에 메모 파일 생성 → 다음 명령/브리핑 때 자동 등록 | Obsidian |
| 수시 | `/티켓 발급 키워드` 또는 카드의 🎫 버튼 → Notion 티켓 + 파일에 링크 | Slack |
| 수시 | Notion에서 담당자 지정됨 → 📌 알림 + 볼트 할일 등록 | Slack #업무 / DM |
| 수시 | `/작업일지 ○○ 검토 완료` → 오늘 작업일지 파일 메모 누적 | Slack |
| 18:00 | 🌙 작업일지: 완료·진행·일정·메모 → 볼트 `Worklog/날짜.md` | Slack #작업일지 |

### Obsidian에서 직접 다룰 때
- `WorkHub/Tasks/새 파일.md`를 만들면 봇이 다음 실행 때 `id`를 붙이고 정식 파일명으로 바꿉니다.
- 파일 상단 `status:`를 `완료`로 바꾸면 봇이 `Archive/YYYY-MM/`으로 옮깁니다. `due:`, `priority:`, `tags:`도 자유롭게 수정하세요.
- 본문은 봇이 건드리지 않습니다. 티켓을 발급하면 본문이 Notion "요청사항"에 들어갑니다.

---

## 문제가 생기면

- **"처리 중…" 후 답이 없다** → Vercel → 프로젝트 → **Logs** 확인. 대부분 `환경변수 … 설정되지 않았습니다` 또는 GitHub 403(토큰 권한).
- **GitHub 404** → `VAULT_REPO` 철자, 또는 토큰의 Repository access에 볼트 저장소가 빠짐.
- **invalid signature** → `SLACK_SIGNING_SECRET` 불일치.
- **Notion object_not_found** → 통합을 "프로젝트와 작업" 페이지에 연결하지 않음.
- **Google 403** → 캘린더를 서비스 계정 이메일과 공유하지 않음.
- 수동 실행 주소 (`?secret=CRON_SECRET` 필요): `배포주소/api/cron/daily-brief`, `배포주소/api/cron/worklog&date=…`, `배포주소/api/notion/pull`
