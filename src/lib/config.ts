/**
 * 환경변수 설정 모음.
 *
 * 역할 분담
 *  - Obsidian 볼트(GitHub 저장소) = 창고(원본). 할일·작업일지가 여기 마크다운으로 저장됩니다.  [필수]
 *  - Slack = 조작 화면(명령·알림)                                                        [필수]
 *  - Google Calendar = 일정                                                              [선택]
 *  - Notion = 에너빌드 스프린트 보드. 티켓 발급 / 나에게 할당된 티켓 가져오기 / 상태 확인만  [선택]
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
    root: opt("VAULT_ROOT", "WorkHub"),                 // 볼트 안에서 봇이 관리하는 최상위 폴더
    get tasksDir() { return `${this.root}/Tasks`; },     // 열린 할일
    get archiveDir() { return `${this.root}/Archive`; }, // 완료된 할일 (YYYY-MM 하위 폴더)
    get worklogDir() { return `${this.root}/Worklog`; }, // 날짜별 작업일지
    /** Obsidian URI를 만들 때 쓰는 볼트 이름 (Obsidian에서 열기 링크). 비우면 링크 생략 */
    obsidianVaultName: opt("OBSIDIAN_VAULT_NAME"),
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
