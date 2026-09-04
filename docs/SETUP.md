# 설치 가이드 (처음부터 끝까지)

이 문서는 **개발 경험이 없어도** 따라 할 수 있도록 순서대로 썼습니다.
전체 소요 시간은 약 1시간이며, 각 단계에서 "복사해서 붙여넣을 값"을 얻는 것이 목표입니다.

> 이 값들을 모두 모으면 마지막에 Vercel 환경변수 화면에 한 번에 붙여넣습니다.
> 값을 모으는 동안 `.env.example` 파일을 메모장에 열어 두고 채워 나가면 편합니다.

---

## 전체 그림

```
 Slack (조작 화면)                    Vercel (봇 서버, 무료)
 ┌──────────────┐   /할일 /일정 /작업일지   ┌──────────────────────┐
 │ #할일        │ ───────────────────────▶ │ api/slack/command    │
 │ #작업일지    │ ◀─────────────────────── │ api/cron/daily-brief │ 08:00 아침 브리핑
 │ #업무 (DM)   │ ◀─────────────────────── │ api/cron/worklog     │ 18:00 작업일지
 └──────────────┘                          │ api/notion/webhook   │ ◀── Notion 담당자 변경
                                           │ api/obsidian/sync    │ ◀── 볼트 GitHub push
                                           └──────┬───────┬───────┘
                                                  │       │
                       ┌──────────────────────────┘       └───────────────────┐
                       ▼                                                      ▼
            Notion (데이터 원본)                                   Google Calendar
            · 에너빌드작업 DB = 할일                               · 마감일 → 종일 일정
            · 작업일지 DB    = 일일 기록                           · /일정 추가 → 시간 일정
                       ▲
                       │  GitHub 저장소를 통해 양방향 동기화
                       ▼
            Obsidian 볼트 (내 PC)  ← Obsidian Git 플러그인으로 자동 push/pull
            · WorkHub/Inbox/   새 .md 파일 → Notion 할일 생성
            · WorkHub/Tasks/   Notion 할일이 .md로 내려옴, status 수정 시 Notion 반영
            · WorkHub/Worklog/ 날짜별 작업일지
```

---

## 1단계. Notion 통합(Integration) 만들기 — 필수

1. https://www.notion.so/my-integrations 접속 → **새 API 통합 만들기**
2. 이름: `jlaw-workhub`, 워크스페이스: 본인 워크스페이스 선택 → 제출
3. 표시되는 **내부 통합 시크릿**(`secret_…` 또는 `ntn_…`)을 복사 → `NOTION_TOKEN`
4. **중요**: 통합이 DB에 접근하려면 DB마다 "연결"해야 합니다.
   - Notion에서 **프로젝트와 작업** 페이지 열기 → 우측 상단 `…` → **연결** → `jlaw-workhub` 선택
   - 상위 페이지에 연결하면 그 아래 **에너빌드작업**, **작업일지** DB 모두 접근 가능합니다.

> DB ID와 사용자 ID는 코드에 기본값으로 들어 있어 별도 입력이 필요 없습니다.
> (에너빌드작업 `4abb47d5…`, 작업일지 `15ffa610…`, 내 사용자 ID `63428ed9…`)

---

## 2단계. Slack 앱 만들기 — 필수

1. https://api.slack.com/apps → **Create New App** → **From scratch**
   - App Name: `WorkHub`, Workspace: 본인 워크스페이스
2. 왼쪽 메뉴 **OAuth & Permissions** → **Scopes → Bot Token Scopes**에 아래 추가
   - `chat:write`  (메시지 보내기)
   - `commands`    (슬래시 명령)
   - `im:write`    (DM 보내기)
   - `chat:write.public` (봇이 초대되지 않은 공개 채널에도 쓰기)
3. 같은 페이지 상단 **Install to Workspace** → 허용
   → **Bot User OAuth Token** (`xoxb-…`) 복사 → `SLACK_BOT_TOKEN`
4. 왼쪽 메뉴 **Basic Information** → **App Credentials → Signing Secret** 복사 → `SLACK_SIGNING_SECRET`
5. **슬래시 명령 등록** (배포 주소가 필요하므로 4단계 배포 후에 합니다 — 아래 "5단계"에서 계속)
6. (선택) 업무 할당 알림을 DM으로 받으려면: Slack에서 내 프로필 → `…` → **멤버 ID 복사** → `SLACK_ME_USER_ID`
7. #할일, #작업일지, #업무 채널에 봇 초대: 각 채널에서 `/invite @WorkHub`

---

## 3단계. Google Calendar 연동 — 선택 (나중에 해도 됨)

서비스 계정 방식이라 로그인 창이 뜨지 않고, 한 번 설정하면 계속 동작합니다.

1. https://console.cloud.google.com → 프로젝트 새로 만들기 (예: `jlaw-workhub`)
2. **API 및 서비스 → 라이브러리** → `Google Calendar API` 검색 → **사용**
3. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → 서비스 계정**
   - 이름 `workhub-bot` → 완료
4. 만든 서비스 계정 클릭 → **키** 탭 → **키 추가 → 새 키 만들기 → JSON** → 파일 다운로드
5. 다운로드한 JSON 파일을 메모장으로 열어 **내용 전체를 한 줄로** 복사 → `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Vercel 환경변수 입력창은 여러 줄도 받으므로 그대로 붙여넣어도 됩니다.
6. JSON 안의 `client_email` 값(예: `workhub-bot@….iam.gserviceaccount.com`)을 복사
7. Google 캘린더(웹) → 내 캘린더 `jlaw080@gmail.com` **설정 및 공유** → **특정 사용자와 공유** → 위 이메일 추가, 권한 **"일정 변경"**
   - 다른 캘린더를 쓰려면 그 캘린더 ID를 `GOOGLE_CALENDAR_ID`에 넣으세요.

---

## 4단계. Vercel 배포 — 필수

1. https://vercel.com → **Add New → Project** → GitHub `jlaw080-ops/jlaw-slackBot` 선택 → Import
2. **Environment Variables**에 지금까지 모은 값 입력 (`.env.example` 참고)
   - 최소: `NOTION_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`(아무 긴 문자열)
3. **Deploy** → 완료되면 주소가 생깁니다. 예: `https://jlaw-slackbot.vercel.app` (이하 `배포주소`)
4. 배포 확인: 브라우저에서 `배포주소/api/cron/daily-brief?secret=CRON_SECRET값` 열기
   → Slack #할일에 브리핑이 올라오면 성공입니다.

> **Cron 안내**: Vercel 무료(Hobby) 플랜은 크론 2개까지, 하루 1회 실행만 가능합니다.
> 현재 설정(아침 08:00 브리핑, 저녁 18:00 작업일지)은 그 범위 안입니다. 시간은 `vercel.json`에서 UTC로 바꿉니다 (KST − 9시간).

---

## 5단계. Slack 슬래시 명령 + 버튼 연결 — 필수

배포주소가 생겼으니 Slack 앱 설정으로 돌아갑니다 (https://api.slack.com/apps → WorkHub).

1. **Slash Commands → Create New Command**, 아래 3개를 만듭니다. Request URL은 **셋 다 동일**합니다.

   | Command | Request URL | Short Description | Usage Hint |
   |---|---|---|---|
   | `/할일` | `배포주소/api/slack/command` | 할일 추가·목록·완료 | `추가 제목 \| 마감 \| 우선순위` |
   | `/작업일지` | `배포주소/api/slack/command` | 오늘 작업일지 메모 | `오늘 한 일` |
   | `/일정` | `배포주소/api/slack/command` | 캘린더 보기·추가 | `오늘 / 내일 / 주간` |

   한글 명령이 안 만들어지면 `/todo`, `/worklog`, `/cal` 로 만들어도 동일하게 동작합니다.

2. **Interactivity & Shortcuts** → 켜기 → Request URL: `배포주소/api/slack/interactive` → Save
3. 권한이 바뀌었으므로 **Install App → Reinstall to Workspace** 한 번 더.
4. Slack에서 `/할일` 입력 → 도움말이 뜨면 성공.

---

## 6단계. Notion "업무 할당 알림" 자동화 — 권장

담당자가 지정/변경될 때 Slack으로 알림을 받는 기능입니다.

1. Notion **에너빌드작업** DB 열기 → 우측 상단 ⚡(자동화) → **새 자동화**
2. 트리거: **속성 편집됨 → 담당자**
3. 작업: **웹훅 보내기** → URL: `배포주소/api/notion/webhook?secret=NOTION_WEBHOOK_SECRET값`
   - `NOTION_WEBHOOK_SECRET`은 Vercel 환경변수에 넣어둔 값과 같아야 합니다 (비워두면 검증 생략).
4. 저장 후, 아무 작업의 담당자를 바꿔 보면 Slack DM(또는 #업무)에 알림이 옵니다.

> 웹훅 자동화는 Notion 플러스 플랜 이상에서 제공됩니다. 무료 플랜이면 이 단계는 건너뛰고,
> 아침 브리핑에서 새로 할당된 작업을 확인하는 방식으로 쓰세요.

---

## 7단계. Obsidian 볼트 연동 — 선택

Obsidian은 내 PC의 폴더라 클라우드 봇이 직접 볼 수 없습니다. 그래서 **GitHub를 중간 다리**로 씁니다.

### 7-1. 볼트를 GitHub에 올리기
1. GitHub에서 **비공개(private)** 저장소 생성: 예 `jlaw080-ops/obsidian-vault`
2. Obsidian → 설정 → 커뮤니티 플러그인 → **Git** (Obsidian Git) 설치·활성화
3. 볼트 폴더에서 저장소 초기화 후 원격 연결 (Git 플러그인 명령 팔레트: `Initialize a new repo`, `Set remote`)
4. Git 플러그인 설정에서 **Auto commit-and-sync interval** 10분, **Auto pull interval** 10분 정도로 설정
   - 이렇게 하면 내가 Obsidian에서 쓴 내용은 자동으로 올라가고, 봇이 쓴 내용은 자동으로 내려옵니다.

### 7-2. 봇에게 저장소 접근권 주기
1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens → Generate**
   - Repository access: **Only select repositories** → `obsidian-vault`
   - Permissions → Repository permissions → **Contents: Read and write**
2. 토큰 복사 → Vercel 환경변수 `GITHUB_TOKEN`, 그리고 `OBSIDIAN_REPO=jlaw080-ops/obsidian-vault`
3. Vercel에서 **Redeploy** (환경변수 변경은 재배포해야 반영됩니다)

### 7-3. (선택) 볼트에 커밋될 때 즉시 동기화
GitHub 저장소 → Settings → **Webhooks → Add webhook**
- Payload URL: `배포주소/api/obsidian/sync`
- Content type: `application/json`
- Secret: `CRON_SECRET` 값과 동일
- Just the push event

설정하지 않아도 아침/저녁 크론과 `/할일 동기화` 명령으로 동기화됩니다.

### 7-4. 볼트 안 폴더
봇이 처음 동기화할 때 자동으로 생깁니다. 템플릿은 `obsidian-vault-templates/` 폴더에 있습니다.

```
WorkHub/
├─ Inbox/    ← 새 할일: 이 폴더에 "제목.md" 만들면 다음 동기화 때 Notion에 등록되고 Tasks/로 이동
├─ Tasks/    ← Notion 할일. 상단 frontmatter의 status를 "완료"로 바꾸면 Notion에도 반영
└─ Worklog/  ← 2026-09-03.md 형식의 일일 작업일지
```

---

## 매일 이렇게 씁니다

| 시각 | 무엇이 | 어디에 |
|---|---|---|
| 08:00 | ☀️ 브리핑 (오늘 일정, 지연/오늘/이번주 할일, 진행 중) | Slack #할일 |
| 수시 | `/할일 추가 제목 \| 내일 \| 높음` → Notion 할일 + 캘린더 종일 일정 | Slack 어디서나 |
| 수시 | `/작업일지 ○○ 검토 완료` → 오늘 작업일지 메모 누적 | Slack 어디서나 |
| 수시 | 담당자 지정됨 → 📌 할당 알림 | Slack DM / #업무 |
| 18:00 | 🌙 작업일지 (완료·진행·일정·메모) | Slack #작업일지 + Notion + Obsidian |

---

## 문제가 생기면

- **명령을 쳤는데 "처리 중…" 후 답이 없다** → Vercel → 프로젝트 → **Logs**에서 빨간 오류 확인.
  대부분 `환경변수 … 설정되지 않았습니다` 또는 Notion `object_not_found`(통합 연결 안 됨)입니다.
- **invalid signature** → `SLACK_SIGNING_SECRET`이 틀렸거나, Slack 앱을 새로 만든 경우.
- **Google Calendar 403** → 캘린더를 서비스 계정 이메일과 공유하지 않았습니다 (3단계 7번).
- **Obsidian 파일이 안 내려온다** → Obsidian Git 플러그인의 pull이 안 돌고 있거나, 토큰 권한(Contents: Read and write) 부족.
- 수동 실행 주소 (모두 `?secret=CRON_SECRET` 필요)
  - 브리핑: `배포주소/api/cron/daily-brief`
  - 작업일지: `배포주소/api/cron/worklog` (특정 날짜: `&date=2026-09-03`)
  - Obsidian 동기화: `배포주소/api/obsidian/sync`
