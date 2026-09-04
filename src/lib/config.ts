/**
 * 환경변수 설정 모음.
 * - 비밀값(토큰)은 반드시 Vercel 환경변수에 넣습니다. (.env.example 참고)
 * - ID 값(Notion DB, Slack 채널)은 현재 워크스페이스 기준 기본값을 넣어 두었습니다.
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

  notion: {
    get token() { return req("NOTION_TOKEN"); },
    tasksDbId: opt("NOTION_TASKS_DB_ID", "4abb47d5588f43fd83e83fe943082cd8"),
    worklogDbId: opt("NOTION_WORKLOG_DB_ID", "15ffa6101c6944249a6ca7394ecb5b02"),
    /** 내 Notion 사용자 ID (담당자 필터/자동 지정에 사용) */
    meUserId: opt("NOTION_ME_USER_ID", "63428ed9-eebd-4bcc-9d76-cb550c3e528d"),
    /** Notion 자동화 웹훅 검증용 공유 비밀값 (선택) */
    webhookSecret: opt("NOTION_WEBHOOK_SECRET"),
  },

  slack: {
    get botToken() { return req("SLACK_BOT_TOKEN"); },
    get signingSecret() { return req("SLACK_SIGNING_SECRET"); },
    channelTodo: opt("SLACK_CHANNEL_TODO", "C0BUFBDQKM5"),      // #할일
    channelWorklog: opt("SLACK_CHANNEL_WORKLOG", "C0BUYKMLCLR"), // #작업일지
    channelWork: opt("SLACK_CHANNEL_WORK", "C0BU86WLRGC"),       // #업무
    /** 업무 할당 알림을 DM으로 받을 내 Slack 사용자 ID (예: U0XXXXXXX). 비우면 #업무 채널로만 알림 */
    meUserId: opt("SLACK_ME_USER_ID"),
  },

  google: {
    /** 서비스 계정 JSON 전체를 문자열로 넣습니다 (비우면 캘린더 기능 비활성) */
    serviceAccountJson: opt("GOOGLE_SERVICE_ACCOUNT_JSON"),
    calendarId: opt("GOOGLE_CALENDAR_ID", "jlaw080@gmail.com"),
    get enabled() { return Boolean(this.serviceAccountJson); },
  },

  obsidian: {
    /** Obsidian 볼트를 올려 둔 GitHub 저장소 (예: jlaw080-ops/obsidian-vault). 비우면 Obsidian 동기화 비활성 */
    repo: opt("OBSIDIAN_REPO"),
    branch: opt("OBSIDIAN_BRANCH", "main"),
    get token() { return opt("GITHUB_TOKEN"); },
    /** 볼트 안에서 봇이 관리하는 폴더 */
    tasksDir: opt("OBSIDIAN_TASKS_DIR", "WorkHub/Tasks"),
    worklogDir: opt("OBSIDIAN_WORKLOG_DIR", "WorkHub/Worklog"),
    inboxDir: opt("OBSIDIAN_INBOX_DIR", "WorkHub/Inbox"),
    get enabled() { return Boolean(this.repo && this.token); },
  },

  /** Vercel Cron 및 수동 호출 보호용 비밀값 */
  get cronSecret() { return opt("CRON_SECRET"); },
};
