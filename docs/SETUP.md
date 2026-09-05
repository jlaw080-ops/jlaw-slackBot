# 설치 가이드 (처음부터 끝까지)

이 문서는 **개발 경험이 없어도** 따라 할 수 있도록 순서대로 썼습니다.
각 단계의 목표는 "복사해서 붙여넣을 값"을 얻는 것이고, 마지막에 Vercel 환경변수 화면에 한 번에 넣습니다.
`.env.example` 파일을 메모장에 열어 두고 채워 나가면 편합니다.

> 이 시스템이 **왜 이렇게 생겼는지**, 무엇이 어디에 저장되는지는 [전체구조.md](전체구조.md)에 정리해 두었습니다.

---

## 전체 그림 — 창고는 Obsidian 볼트, 리모컨은 Slack

```
 Slack (조작 화면)                          Vercel (봇 서버, 무료)
 ┌──────────────┐  /할일 /작업일지 /일정 /티켓  ┌──────────────────────┐
 │ #할일        │ ─────────────────────────▶ │ api/slack/command    │
 │ #작업일지    │ ◀───────────────────────── │ api/slack/interactive│ 버튼(완료/진행/발급대기/등록)
 │ #업무 (+DM)  │ ◀───────────────────────── │ api/cron/daily-brief │ 08:00 아침 브리핑
 └──────────────┘                            │ api/cron/worklog     │ 18:00 작업일지
                                             │ api/notion/webhook   │ ◀── Notion 담당자 지정/멘션
                                             └──────┬────────┬──────┘
                                                    │        │
       ┌────────────────────────────────────────────┘        └──────────────┐
       ▼                                                                    ▼
 【창고】 Obsidian 볼트 Vault_jlaw80 = GitHub 저장소                     Google Calendar (선택)
   06_To Do/YYYY-MM/MMDD_제목.md   할일 노트 (todo-capture 정본 형식)       · due → 종일 일정
   05_Daily/YYYY-MM-DD.md          일일노트의 WORKHUB-LOG 블록만 봇이 씀    · /일정 추가 → 시간 일정
   .workhub/notion-ignored.txt     무시한 Notion 티켓 목록
   ▲ Obsidian Git 플러그인이 내 PC ↔ GitHub 를 자동 동기화
   ▲ Vault-Kanban 앱 · todo-capture · notion-todo-sync · notion-qa-ticket 스킬과 같은 파일을 공유

 【읽기 전용 접점】 Notion 에너빌드작업 보드 (선택)
   · 할당 감지: 담당자가 나 / 댓글 멘션 → Slack 후보 카드 → 등록 버튼 → notion: assigned 노트
   · 상태 확인: notion-url이 있는 노트의 notion-status 갱신
   · 티켓 발급: 봇은 notion: pending 표시만, 실제 발급은 Claude Code의 notion-qa-ticket 스킬
```

**Notion에는 아무것도 쓰지 않습니다.** 볼트 파일이 유일한 원본이고, 봇은 노트의 frontmatter만 고칩니다.

---

## 1단계. Obsidian 볼트를 GitHub에 올리기 — 필수 (창고)

Obsidian은 내 PC 폴더라 클라우드 봇이 직접 볼 수 없습니다. GitHub가 중간 다리입니다.
볼트가 Dropbox 안에 있어도 괜찮습니다 — Git 저장소는 폴더 안에 `.git`만 추가합니다.

1. GitHub → **New repository** → 이름 `Vault_jlaw80`, **Private** → Create
2. Obsidian → 설정 → 커뮤니티 플러그인 → **Git** (Obsidian Git) 설치·활성화
3. 명령 팔레트(Ctrl/Cmd+P) → `Git: Initialize a new repo` → `Git: Set remote URL`에 저장소 주소 입력
   → `Git: Commit-and-sync` 한 번 실행 (처음엔 GitHub 로그인/토큰을 물어봅니다)
4. Git 플러그인 설정
   - **Auto commit-and-sync interval**: `5` (분) → 내가 쓴 내용이 5분마다 올라감
   - **Auto pull interval**: `5` (분) → 봇이 쓴 내용이 5분마다 내려옴
   - **Pull on startup**: 켜기
5. `.gitignore`에 `.obsidian/workspace*.json`, `.trash/`, `.vault-backup/`를 넣어 두면 불필요한 충돌이 줄어듭니다.

### 봇에게 저장소 접근권 주기
1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens → Generate new token**
   - Repository access: **Only select repositories** → `Vault_jlaw80`
   - Permissions → Repository permissions → **Contents: Read and write**
2. 토큰 → `GITHUB_TOKEN`, 저장소 이름 `jlaw080-ops/Vault_jlaw80` → `VAULT_REPO`

> 폴더 이름이 다르면 `VAULT_TODO_DIR`(기본 `06_To Do`), `VAULT_DAILY_DIR`(기본 `05_Daily`), `VAULT_PROJECTS_DIR`(기본 `01_Projects`)로 바꿉니다.

---

## 2단계. Slack 앱 만들기 — 필수 (리모컨)

1. https://api.slack.com/apps → **Create New App → From scratch** → App Name `WorkHub`, 워크스페이스 선택
2. **OAuth & Permissions → Scopes → Bot Token Scopes**에 추가: `chat:write`, `commands`, `im:write`, `chat:write.public`
3. 같은 페이지 상단 **Install to Workspace** → 허용 → **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
4. **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET`
5. (선택) DM 알림: Slack 내 프로필 → `…` → **멤버 ID 복사** → `SLACK_ME_USER_ID`
6. #할일, #작업일지, #업무 채널에서 `/invite @WorkHub`
7. 슬래시 명령·버튼 URL 등록은 배포 주소가 필요하므로 **4단계 뒤에** 합니다.

---

## 3단계. Vercel 배포 — 필수

1. https://vercel.com → **Add New → Project** → GitHub `jlaw080-ops/jlaw-slackBot` → Import
2. **Environment Variables**에 지금까지 모은 값 입력
   - 최소: `VAULT_REPO`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`(아무 긴 문자열)
3. **Deploy** → 완료되면 주소가 생깁니다. 예: `https://jlaw-slackbot.vercel.app` (이하 `배포주소`)
4. 확인: 브라우저에서 `배포주소/api/cron/daily-brief?secret=CRON_SECRET값` → #할일에 브리핑이 오면 성공

> Vercel 무료(Hobby) 플랜은 크론 2개, 하루 1회 실행까지입니다. 현재 설정(08:00 브리핑, 18:00 작업일지)은 그 범위 안입니다.
> 시간 변경은 `vercel.json`에서 UTC로 (KST − 9시간).

---

## 4단계. Slack 슬래시 명령 + 버튼 연결 — 필수

https://api.slack.com/apps → WorkHub

1. **Slash Commands → Create New Command**, 4개 모두 Request URL은 `배포주소/api/slack/command`

   | Command | Short Description | Usage Hint |
   |---|---|---|
   | `/할일` | 볼트 할일 추가·목록·완료 | `추가 제목 \| 마감 \| 우선순위 \| 프로젝트` |
   | `/작업일지` | 오늘 일일노트에 메모 | `오늘 한 일` |
   | `/일정` | 캘린더 보기·추가 | `오늘 / 내일 / 주간` |
   | `/티켓` | Notion 할당 후보·상태·발급 대기 | `할당 / 상태 / 발급 키워드` |

   **4개를 모두 만들어야 합니다.** 하나라도 빠지면 Slack이 "유효한 명령어가 아닙니다"라고 답합니다.
   한글 명령이 안 되면 `/todo`, `/worklog`, `/cal`, `/ticket`으로 만들어도 동일하게 동작합니다.
2. **Interactivity & Shortcuts** → On → Request URL `배포주소/api/slack/interactive` → Save
   같은 화면 아래 **Shortcuts → Create New Shortcut → On messages** 로 2개를 만듭니다.
   (메시지 오른쪽 `⋯` 메뉴에 나타나며, #할일 채널의 글을 #작업일지로 옮길 때 씁니다)

   | Name | Short Description | Callback ID |
   |---|---|---|
   | 작업일지로 보내기 | 이 메시지를 #작업일지로 옮기고 일일노트 메모로 남깁니다 | `to_worklog` |
   | 프로젝트 노트로 저장 | 이 메시지를 프로젝트 `01_진행업무` 폴더의 노트로 저장합니다 | `to_note` |
3. **Install App → Reinstall to Workspace**
4. Slack에서 `/할일` → 도움말이 뜨면 성공. `/할일 추가 테스트 | 내일 | 중간 | 에너빌드` → `06_To Do/2026-09/0904_테스트.md`가 생기고 몇 분 뒤 Obsidian·Vault-Kanban에 나타납니다.

---

## 5단계. Notion 접점 — 선택

### 5-1. 통합 토큰
1. https://www.notion.so/my-integrations → **새 API 통합 만들기** → 이름 `jlaw-workhub` → 시크릿 → `NOTION_TOKEN`
   - 기능: 콘텐츠 읽기, **댓글 읽기** (멘션 감지용)를 켭니다. 쓰기는 필요 없습니다.
2. Notion **프로젝트와 작업** 페이지 → `…` → **연결** → `jlaw-workhub`
3. Vercel 환경변수에 넣고 **Redeploy**

이제 아침 브리핑과 `/티켓 할당`이 Notion을 조회해 **나에게 넘어온 티켓 후보**를 보여 주고, `/티켓 상태`가 연결된 티켓 상태를 갱신합니다.

### 5-2. 할당 알림 자동화 (담당자 지정 즉시)
1. **에너빌드작업** DB → ⚡ 자동화 → **새 자동화**
2. 트리거: **속성 편집됨 → 담당자**
3. 작업: **웹훅 보내기** → URL `배포주소/api/notion/webhook?secret=NOTION_WEBHOOK_SECRET값`
4. 저장 후 아무 티켓의 담당자를 나로 바꿔 보면 #업무(+DM)에 후보 카드가 옵니다. **📥 할일로 등록**을 누르면 노트가 생깁니다.

> 웹훅 자동화는 Notion 플러스 플랜 이상입니다. 없어도 브리핑·`/티켓 할당`이 직접 조회합니다.
> 댓글 멘션은 Notion API가 페이지 단위 댓글만 주므로, 본문 중간의 인라인 댓글은 놓칠 수 있습니다 (스킬 `notion-todo-sync`와 같은 한계).

### 5-3. 티켓 발급은 Claude Code에서
Slack에서 `/티켓 발급 키워드`(또는 🎫 버튼)를 누르면 노트에 `notion: pending`이 표시됩니다.
Claude Code에서 "노션 티켓 발급" 이라고 하면 `notion-qa-ticket` 스킬이 한/영 병기 티켓을 만들고 노트에 `notion: registered` + `notion-url`을 기록합니다.
스킬이 `notion: pending` 노트를 자동으로 찾게 하려면 스킬의 **입력 수집** 단계에 "`06_To Do`에서 `notion: pending` 노트 검색"을 한 줄 추가하세요.

---

## 6단계. Google Calendar — 선택

1. https://console.cloud.google.com → 새 프로젝트 → **API 및 서비스 → 라이브러리 → Google Calendar API → 사용**
2. **사용자 인증 정보 → 서비스 계정** 생성 → **키 → 새 키 만들기 → JSON** 다운로드
3. JSON 파일 내용 전체 → `GOOGLE_SERVICE_ACCOUNT_JSON`
4. JSON 안의 `client_email` 값 → Google 캘린더(웹) → 내 캘린더 **설정 및 공유 → 특정 사용자와 공유** → 추가, 권한 **일정 변경**
5. Vercel **Redeploy**

---

## 매일 이렇게 씁니다

| 시각 | 무엇이 | 어디에 |
|---|---|---|
| 08:00 | ☀️ 브리핑: 오늘 일정, 지연/오늘/이번주 할일, Notion 후보 카드, 티켓 상태 변화 | Slack #할일 |
| 수시 | `/할일 추가 제목 \| 내일 \| 높음 \| 에너빌드` → 노트 + 캘린더 | Slack 어디서나 |
| 수시 | Obsidian·Vault-Kanban에서 노트 편집 → 다음 명령·브리핑에 반영 | Obsidian |
| 수시 | Notion 담당자 지정 → 후보 카드 → 📥 등록 | Slack #업무 / DM |
| 수시 | `/티켓 발급 키워드` → `notion: pending` → Claude Code에서 스킬로 발급 | Slack → Claude Code |
| 수시 | `/작업일지 ○○ 검토 완료` → 일일노트 WorkHub 블록 메모 | Slack |
| 수시 | `/작업일지 노트` → 입력 창에 제목·내용 → 프로젝트 `01_진행업무` 폴더에 노트 | Slack → Obsidian |
| 수시 | `/할일 보내기 작업일지 오늘` → 볼트 할일을 그 채널에 게시 | Slack |
| 수시 | 메시지 `⋯` → **작업일지로 보내기** → #할일 글을 #작업일지로 | Slack |
| 18:00 | 🌙 작업일지: 완료·진행·일정·티켓 변화·메모 → 일일노트 블록 | Slack #작업일지 |

---

## 문서를 Slack에서 보기

`/할일`, `/작업일지` 같은 도움말 아래에 **📖 전체 구조 문서** 링크가 붙어 있습니다.
현재 연결된 주소는 <https://paperflow-k31v.vercel.app/view/workhub전체구조-1788581366334> 이고,
문서를 다른 곳으로 옮기면 Vercel 환경변수 `DOC_URL` 에 새 주소를 넣어 덮어쓰면 됩니다.
채널 상단 **북마크**에도 같은 주소를 걸어 두면 클릭 한 번에 열립니다.

---

## 명령어를 잊었을 때

Slack에서 아래 중 아무거나 치면 됩니다.

- `/할일 도움말 전체` — **모든 명령 한 장에** (어느 명령 뒤에 붙여도 같습니다: `/작업일지 도움말 전체` 등)
- `/할일`, `/작업일지`, `/일정`, `/티켓` — 그 명령의 자세한 설명
- 입력창에 `/` 만 치면 Slack이 등록된 명령 목록과 짧은 설명을 자동으로 보여 줍니다

---

## 문제가 생기면

- **"처리 중…" 후 답이 없다** → Vercel → 프로젝트 → **Logs** 확인. 대부분 `환경변수 … 설정되지 않았습니다` 또는 GitHub 403(토큰 권한).
- **GitHub 404** → `VAULT_REPO` 철자, 또는 토큰의 Repository access에 볼트 저장소가 빠짐.
- **project 없이 할일 노트를 만들 수 없습니다** → 정상입니다. `/할일 추가 제목 | 마감 | 우선순위 | 프로젝트`로 프로젝트를 적거나 버튼에서 고르세요.
- **invalid signature** → `SLACK_SIGNING_SECRET` 불일치.
- **Notion object_not_found** → 통합을 "프로젝트와 작업" 페이지에 연결하지 않음.
- **Google 403** → 캘린더를 서비스 계정 이메일과 공유하지 않음.
- **먼저 진단 주소를 여세요**: `배포주소/api/health?secret=CRON_SECRET값`
  환경변수 5개가 다 들어갔는지, 봇 토큰이 어느 워크스페이스 것인지, 볼트의 `06_To Do` 폴더가 보이는지를 한 화면에 보여 줍니다.
- **Slack 명령이 "앱이 반응하지 않아 실패했습니다"** → 서명 검증 실패입니다. 이제 봇이 Slack 화면에 이유를 직접 알려 줍니다.
  가장 흔한 원인은 **Slack 앱이 여러 개**일 때 명령이 등록된 앱과 다른 앱의 Signing Secret을 넣은 경우입니다.
  `/api/health` 의 `SLACK_SIGNING_SECRET` 길이·앞 세 글자를 Slack 앱 화면의 값과 대조하세요.
- 수동 실행 주소 (`?secret=CRON_SECRET` 필요): `배포주소/api/cron/daily-brief`, `배포주소/api/cron/worklog&date=…`, `배포주소/api/notion/pull`

---

## 새로 추가된 3가지 기능 (쉬운 설명)

### 1. Slack에 쓴 작업일지를 Obsidian 노트로

> ⚠️ Slack의 `/` 명령은 **한 줄만** 받습니다. Shift+Enter로 줄을 바꾸면 명령이 아니라 그냥 글이 되어
> "유효한 명령어가 아닙니다"가 나옵니다. 그래서 여러 줄은 **입력 창**으로 받습니다.

**방법 A — 입력 창 (권장)**

```
/작업일지 노트
```

만 치고 Enter → 창이 뜹니다. **제목**, **내용**(여러 줄 자유), 필요하면 **프로젝트**·**서브 폴더**를
고르고 **저장**을 누르면 됩니다. 프로젝트를 못 찾으면 창이 닫히지 않고 그 자리에서 골라 달라고 하므로
쓴 내용이 사라지지 않습니다.

**방법 B — 한 줄로 빠르게**

```
/작업일지 노트 계산서 검토 :: 1안 계산 결과 확인
/작업일지 노트 계산서 검토 | 에너빌드 | 에너지분석 :: 1안 계산 결과 확인
```

`::` 앞이 제목, 뒤가 내용입니다. `|` 로 프로젝트·서브 폴더를 직접 지정할 수 있습니다.

**방법 C — 이미 쓴 메시지를 노트로**

채널에 평소처럼 여러 줄로 글을 쓴 뒤, 그 메시지의 `⋯` → **프로젝트 노트로 저장**.

공통 동작:

- 봇이 제목·내용의 낱말을 보고 **프로젝트와 서브 프로젝트를 스스로 골라**
  `01_Projects/02_에너빌드/03_에너지분석/01_진행업무/0904_계산서 검토/0904_계산서 검토.md` 에 저장합니다.
- **폴더를 임의로 만들지 않습니다.** 볼트에 이미 있는 `01_진행업무` 폴더 안에만 씁니다.
- 같은 날 같은 제목으로 또 쓰면 **덮어쓰지 않고** 그 노트의 `## 진행`에 한 줄 덧붙입니다.
- 일일노트에도 노트 링크 메모를 남깁니다.

### 2. Obsidian 할일을 Slack 채널로 불러오기

```
/할일 보내기 작업일지 오늘      → #작업일지 채널에 "오늘 마감 + 지연" 게시
/할일 보내기 할일 주간          → #할일 채널에 이번 주 마감 게시
/할일 보내기                    → #할일 채널에 "이번 주 + 진행 중" 게시
```

`/할일 목록`은 나만 보이지만, `보내기`는 **채널에 남는 글**이라 팀·기록용으로 좋습니다.
게시된 카드의 ✅완료 / 🔄진행 중 버튼도 그대로 동작합니다.

읽어 오는 곳은 볼트의 `06_To Do` 폴더 전체(하위 폴더 포함)이며, 다음은 **자동으로 빠집니다.**

- `아카이브`, `99_아카이브(완료 및 범위 외)`, `보관함`, `Archive`, `완료`, `종료`, `제외`, `템플릿` 등
  이름의 폴더 (앞의 숫자나 뒤의 괄호 설명은 있어도 됩니다)
- `_` 로 시작하는 폴더
- `status: done` 인 노트 (열린 할일만 올립니다)

아카이브 폴더 이름이 위와 전혀 다르면 Vercel 환경변수 `VAULT_TODO_EXCLUDE` 에 폴더 이름을
쉼표로 적어 주세요. 예: `VAULT_TODO_EXCLUDE=지난건,참고자료`

### 3. #할일 채널의 글을 #작업일지 채널로

옮기고 싶은 메시지에 마우스를 올리면 오른쪽에 `⋯` 이 나옵니다. 거기서

- **작업일지로 보내기** → 그 글이 #작업일지에 옮겨지고, 오늘 일일노트의 메모로도 남습니다.
- **프로젝트 노트로 저장** → 위 1번과 같은 방식으로 프로젝트 폴더 노트가 됩니다.

두 메뉴는 4단계에서 Shortcut 2개를 등록해야 보입니다. 등록 후 **Reinstall to Workspace** 를 꼭 눌러 주세요.
