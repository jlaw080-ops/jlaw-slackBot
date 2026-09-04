/**
 * Slack 버튼 처리 — Interactivity Request URL
 *   task_done / task_start : 볼트 노트 status 변경 (값 = 노트 경로)
 *   task_ticket            : notion: pending 표시
 *   task_project           : project 선택 후 할일 노트 생성
 *   cand_register / cand_ignore : Notion 할당 후보 → 노트 등록 / 무시
 *
 * 메시지 바로가기(message_action) — 메시지 `⋯` 메뉴
 *   to_worklog : 그 메시지를 #작업일지 채널로 옮기고 오늘 일일노트 메모로 남김
 *   to_note    : 그 메시지를 프로젝트 폴더의 작업일지 노트로 저장 (첫 줄 = 제목)
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { readRawBody, parseForm } from "../../src/lib/raw-body.js";
import { context, getPermalink, postMessage, section, taskCard, taskLine, verifySlackRequest } from "../../src/lib/slack.js";
import { getTask, setStatus, STATUS_KO, type VaultStatus } from "../../src/lib/vault.js";
import { ignoreCandidate, markPending, registerCandidate } from "../../src/lib/notion-sync.js";
import { getTicket } from "../../src/lib/notion.js";
import { syncTaskToCalendar } from "../../src/lib/gcal.js";
import { addTask, executeCommand } from "../../src/lib/commands.js";
import { appendMemo } from "../../src/lib/vault.js";
import { resolveWorkDir } from "../../src/lib/notes.js";
import { prettyKST, todayKST } from "../../src/lib/dates.js";
import { config as appConfig } from "../../src/lib/config.js";

export const config = { api: { bodyParser: false } };

const ACTION_STATUS: Record<string, VaultStatus> = { task_done: "done", task_start: "in-progress" };

async function reply(responseUrl: string, text: string, blocks?: unknown[], inChannel = false) {
  await fetch(responseUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: false, response_type: inChannel ? "in_channel" : "ephemeral", text, blocks }),
  }).catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const { raw, source } = await readRawBody(req);
  const check = verifySlackRequest(req, raw);
  if (!check.ok) {
    console.error("Slack 서명 검증 실패", { reason: check.reason, bodySource: source, bodyLength: raw.length });
    return res.status(401).send(`invalid signature: ${check.reason}`);
  }

  const payload = JSON.parse(parseForm(raw).payload ?? "{}");

  // ── 작업일지 노트 입력 창 저장 ──
  if (payload.type === "view_submission" && payload.view?.callback_id === "note_modal") {
    const v = payload.view.state?.values ?? {};
    const title = (v.title?.v?.value ?? "").trim();
    const content = (v.content?.v?.value ?? "").trim();
    const project = v.project?.v?.selected_option?.value || undefined;
    const sub = (v.sub?.v?.value ?? "").trim() || undefined;
    const channel = (() => { try { return JSON.parse(payload.view.private_metadata || "{}").channel as string; } catch { return ""; } })();
    const userId: string = payload.user?.id ?? "";

    // 프로젝트를 못 정하면 창을 닫지 않고 그 자리에서 알려 준다 (쓴 내용이 사라지지 않게)
    let resolved;
    try {
      resolved = await Promise.race([
        resolveWorkDir(`${title}\n${content}`, project, sub),
        new Promise<null>((r) => setTimeout(() => r(null), 2200)),
      ]);
    } catch (e) {
      return res.status(200).json({ response_action: "errors", errors: { title: `볼트를 읽지 못했어요: ${e instanceof Error ? e.message : e}` } });
    }
    if (resolved && !resolved.ok) {
      const msg = resolved.reason === "no-project"
        ? "어느 프로젝트인지 못 찾았어요. 아래 '프로젝트'에서 골라 주세요."
        : resolved.reason === "no-workdir"
          ? `'${resolved.project}' 아래에 01_진행업무 폴더가 없어요. Obsidian에서 폴더를 먼저 만들어 주세요.`
          : `'${resolved.project}'의 서브 폴더를 골라 주세요: ${resolved.choices.map((c) => c.label || "(바로 아래)").join(", ")}`;
      return res.status(200).json({ response_action: "errors", errors: { [resolved.reason === "no-project" ? "project" : "sub"]: msg.slice(0, 150) } });
    }

    // 판정이 끝났으면 창은 닫고 저장은 뒤에서 (GitHub 쓰기가 3초를 넘을 수 있음)
    waitUntil((async () => {
      const target = channel || userId;
      try {
        const r = await executeCommand({ kind: "worklog.vaultnote", title, content, project, sub }, { userId, channelId: channel });
        if (target) await postMessage(target, r.text, r.blocks);
      } catch (e) {
        if (target) await postMessage(target, `❌ 작업일지 노트 저장 실패: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
      }
    })());
    return res.status(200).json({ response_action: "clear" });
  }

  // ── 메시지 바로가기: 다른 채널의 메시지를 작업일지로 ──
  if (payload.type === "message_action") {
    const callbackId: string = payload.callback_id ?? "";
    const responseUrl: string = payload.response_url;
    const text: string = (payload.message?.text ?? "").trim();
    const srcChannel: string = payload.channel?.id ?? "";
    const ts: string = payload.message?.message_ts ?? payload.message?.ts ?? "";
    const author: string = payload.message?.user ?? payload.message?.bot_id ?? "";
    if (!text) {
      waitUntil(reply(responseUrl, "⚠️ 옮길 글이 비어 있어요 (파일·첨부만 있는 메시지는 옮길 수 없습니다)."));
      return res.status(200).send("");
    }

    waitUntil((async () => {
      try {
        const today = todayKST();
        const link = ts && srcChannel ? await getPermalink(srcChannel, ts) : null;
        const origin = `<#${srcChannel}>${author.startsWith("U") ? ` · <@${author}>` : ""}${link ? ` · <${link}|원본 보기>` : ""}`;

        if (callbackId === "to_note") {
          const [head, ...rest] = text.split("\n");
          const r = await executeCommand(
            { kind: "worklog.vaultnote", title: head.trim().slice(0, 80), content: rest.join("\n").trim() },
            { userId: payload.user?.id ?? "", channelId: srcChannel, permalink: link ?? undefined },
          );
          return reply(responseUrl, r.text, r.blocks);
        }

        // to_worklog (기본): #작업일지에 옮겨 붙이고 일일노트 메모로도 남긴다
        await postMessage(appConfig.slack.channelWorklog, `📓 작업일지로 옮김: ${text.slice(0, 120)}`, [
          section(`📓 *작업일지로 옮김*\n${text.slice(0, 2800)}`),
          context(`${origin} · ${prettyKST(today)}`),
        ]);
        const memo = `${text.replace(/\s*\n\s*/g, " ").slice(0, 200)}${link ? ` ([Slack](${link}))` : ""}`;
        const path = await appendMemo(today, memo);
        return reply(responseUrl, `📓 <#${appConfig.slack.channelWorklog}>로 옮겼어요. 일일노트 \`${path}\`에도 메모로 남겼습니다.`);
      } catch (e) {
        return reply(responseUrl, `❌ 옮기기 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    })());
    return res.status(200).send("");
  }

  if (payload.type !== "block_actions") return res.status(200).send("");
  const action = payload.actions?.[0];
  const actionId: string = action?.action_id ?? "";
  const value: string = action?.value ?? "";
  const responseUrl: string = payload.response_url;
  const userId: string = payload.user?.id ?? "";
  if (!value) return res.status(200).send("");

  waitUntil((async () => {
    try {
      if (actionId in ACTION_STATUS || actionId === "task_ticket") {
        const task = await getTask(value);
        if (!task) return reply(responseUrl, `⚠️ 볼트에서 노트를 찾지 못했어요: \`${value}\` (이동/삭제되었을 수 있어요)`);
        if (actionId === "task_ticket") {
          const updated = await markPending(task);
          return reply(responseUrl, `🎫 발급 대기 표시: ${updated.title}`, [section(`🎫 *발급 대기 표시됨* (\`notion: pending\`) — Claude Code에서 \`notion-qa-ticket\` 스킬로 발급\n${taskLine(updated)}`)]);
        }
        const status = ACTION_STATUS[actionId];
        const updated = await setStatus(task, status);
        if (appConfig.google.enabled) { try { await syncTaskToCalendar(updated); } catch { /* ignore */ } }
        return reply(responseUrl, `${STATUS_KO[status]} 처리: ${updated.title}`, [section(`*${STATUS_KO[status]}* 처리됨 (status: ${status})\n${taskLine(updated)}`)], true);
      }

      if (actionId === "task_project") {
        const spec = JSON.parse(value);
        const r = await addTask({ title: spec.title, due: spec.due ?? null, priority: spec.priority, project: spec.project }, { userId, channelId: "", permalink: spec.permalink || undefined });
        return reply(responseUrl, r.text, r.blocks, Boolean(r.inChannel));
      }

      if (actionId === "cand_register" || actionId === "cand_ignore") {
        const v = JSON.parse(value) as { id: string; r: "assigned" | "mentioned"; m: any };
        const ticket = await getTicket(v.id);
        if (actionId === "cand_ignore") {
          await ignoreCandidate(ticket);
          return reply(responseUrl, `🙈 무시: ${ticket.title} — 다음 브리핑부터 후보에 나오지 않아요 (\`.workhub/notion-ignored.txt\`)`);
        }
        const task = await registerCandidate(ticket, v.r, v.m ?? undefined);
        return reply(responseUrl, `📥 할일 노트 등록: ${task.title}`, [section(`📥 *할일 노트 등록됨* → \`${task.path}\` (\`notion: assigned\`)`), ...taskCard(task)], true);
      }
    } catch (e) {
      return reply(responseUrl, `❌ 처리 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  })());

  return res.status(200).send("");
}
