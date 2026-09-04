/**
 * 설정 진단 — 브라우저로 열어 무엇이 빠졌는지 한눈에 봅니다.
 *   GET /api/health?secret=CRON_SECRET
 *
 * 비밀값 자체는 절대 내보내지 않습니다. 길이와 앞 세 글자만 보여 주어
 * Slack·GitHub 화면의 값과 눈으로 대조할 수 있게 합니다.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCronAuth, json } from "../src/lib/http.js";
import { config } from "../src/lib/config.js";
import * as gh from "../src/lib/github.js";
import { listOpenTasks } from "../src/lib/vault.js";

/** 값을 노출하지 않으면서 대조할 수 있게 요약 */
function peek(v: string | undefined): string {
  if (!v) return "❌ 없음";
  return `✅ 설정됨 (${v.length}자, ${v.slice(0, 3)}…)`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronAuth(req)) return json(res, 401, { ok: false, error: "unauthorized" });

  const out: Record<string, unknown> = {
    안내: "각 항목이 ✅ 인지 확인하세요. Slack 명령이 안 되면 slack.signingSecret 의 길이·앞글자가 Slack 앱 화면의 Signing Secret과 같은지 대조하세요.",
    환경변수: {
      VAULT_REPO: process.env.VAULT_REPO || "❌ 없음",
      GITHUB_TOKEN: peek(process.env.GITHUB_TOKEN),
      SLACK_BOT_TOKEN: peek(process.env.SLACK_BOT_TOKEN),
      SLACK_SIGNING_SECRET: peek(process.env.SLACK_SIGNING_SECRET),
      CRON_SECRET: peek(process.env.CRON_SECRET),
      NOTION_TOKEN: process.env.NOTION_TOKEN ? peek(process.env.NOTION_TOKEN) : "— 미사용",
      GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? "✅ 설정됨" : "— 미사용",
    },
  };

  // Slack: 봇 토큰이 어느 앱·워크스페이스의 것인지
  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.slack.botToken}`, "Content-Type": "application/json; charset=utf-8" },
    });
    const d = (await r.json()) as any;
    out.slack = d.ok
      ? { 상태: "✅ 봇 토큰 정상", 워크스페이스: d.team, 봇이름: d.user, bot_id: d.bot_id, 주의: "이 봇이 속한 앱의 Signing Secret을 써야 합니다" }
      : { 상태: `❌ ${d.error}` };
  } catch (e) {
    out.slack = { 상태: `❌ ${e instanceof Error ? e.message : e}` };
  }

  // 볼트: 저장소를 읽을 수 있는지, 할일 폴더가 있는지
  try {
    const tree = await gh.listTree();
    const todoDir = `${config.vault.todoDir}/`;
    const notes = tree.filter((t) => t.type === "blob" && t.path.startsWith(todoDir) && t.path.endsWith(".md"));
    const open = await listOpenTasks();
    out.볼트 = {
      상태: "✅ 저장소 읽기 성공",
      저장소: config.vault.repo,
      전체파일수: tree.length,
      [`${config.vault.todoDir} 안 노트`]: notes.length,
      열린할일: open.length,
      ...(notes.length === 0
        ? { 주의: `저장소에 '${config.vault.todoDir}' 폴더가 없습니다. Obsidian Git 동기화가 됐는지, 폴더 이름이 맞는지 확인하세요.` }
        : {}),
      최근노트: notes.slice(-3).map((n) => n.path),
    };
  } catch (e) {
    out.볼트 = { 상태: `❌ ${e instanceof Error ? e.message : e}` };
  }

  return json(res, 200, out);
}
