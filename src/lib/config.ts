/**
 * 환경변수 설정 모음.
 *
 * 역할 분담
 *  - Obsidian 볼트(GitHub 저장소) = 창고(원본). 할일 노트·일일노트가 여기 있습니다.        [필수]
 *    볼트 규칙은 기존 스킬(todo-capture / notion-todo-sync / notion-qa-ticket)과 Vault-Kanban 앱이 정본입니다.
 *  - Slack = 조작 화면(명령·알림)                                                        [필수]
 *  - Google Calendar = 일정                                                              [선택]
 *  - Notion = 에너빌드 스프린트 보드. 할당된 티켓 가져오기 / 상태 확인 / 티켓 발급 대기 표시  [선택]
 */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 이(가) 설정되지 않았습니다.`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  timezone: "Asia/Seoul",

  /** 창고: Obsidian 볼트가 올라간 GitHub 저장소 */
  vault: {
    get repo() { return req("VAULT_REPO"); },          // 예: jlaw080-ops/obsidian-vault
    branch: opt("VAULT_BRANCH", "main"),
    get token() { return req("GITHUB_TOKEN"); },       // Contents: Read and write 권한
    /** 할일 노트 폴더 (todo-capture 정본: 06_To Do/YYYY-MM/MMDD_제목.md) */
    todoDir: opt("VAULT_TODO_DIR", "06_To Do"),
    /** 일일노트 폴더 (05_Daily/YYYY-MM-DD.md 또는 05_Daily/YYYY-MM/YYYY-MM-DD.md) */
    dailyDir: opt("VAULT_DAILY_DIR", "05_Daily"),
    /** 프로젝트 폴더 (notion-qa-ticket이 만든 진행업무 노트의 notion-url 중복 검사용) */
    projectsDir: opt("VAULT_PROJECTS_DIR", "01_Projects"),
    /** 봇 메타데이터 폴더 (무시한 Notion 티켓 목록 등). 점(.)으로 시작해 Obsidian에서는 보이지 않음 */
    metaDir: opt("VAULT_META_DIR", ".workhub"),
    /** Obsidian URI를 만들 때 쓰는 볼트 이름 (기본: Vault_jlaw80). 비우면 링크 생략 */
    obsidianVaultName: opt("OBSIDIAN_VAULT_NAME", "Vault_jlaw80"),
  },

  slack: {
    get botToken() { return req("SLACK_BOT_TOKEN"); },
    get signingSecret() { return req("SLACK_SIGNING_SECRET"); },
    channelTodo: opt("SLACK_CHANNEL_TODO", "C0BUFBDQKM5"),      // #할일
    channelWorklog: opt("SLACK_CHANNEL_WORKLOG", "C0BUYKMLCLR"), // #작업일지
    channelWork: opt("SLACK_CHANNEL_WORK", "C0BU86WLRGC"),       // #업무 (Notion 티켓 알림)
    /** 할당 알림을 DM으로도 받을 내 Slack 사용자 ID (예: U0XXXXXXX). 비우면 채널로만 */
    meUserId: opt("SLACK_ME_USER_ID"),
  },

  notion: {
    token: opt("NOTION_TOKEN"),
    ticketsDbId: opt("NOTION_TICKETS_DB_ID", "4abb47d5588f43fd83e83fe943082cd8"), // 에너빌드작업
    meUserId: opt("NOTION_ME_USER_ID", "63428ed9-eebd-4bcc-9d76-cb550c3e528d"),
    webhookSecret: opt("NOTION_WEBHOOK_SECRET"),
    /** 댓글 멘션 스캔 상한 (notion-todo-sync 스킬과 동일하게 40건) */
    commentScanLimit: Number(opt("NOTION_COMMENT_SCAN_LIMIT", "40")),
    get enabled() { return Boolean(this.token); },
  },

  google: {
    serviceAccountJson: opt("GOOGLE_SERVICE_ACCOUNT_JSON"),
    calendarId: opt("GOOGLE_CALENDAR_ID", "jlaw080@gmail.com"),
    get enabled() { return Boolean(this.serviceAccountJson); },
  },

  /** Vercel Cron 및 수동 호출 보호용 비밀값 */
  get cronSecret() { return opt("CRON_SECRET"); },
};
