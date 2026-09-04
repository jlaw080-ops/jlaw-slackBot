/**
 * Notion → 할당 감지 → Slack에 "할일로 등록할까요?" 후보 카드 (확인 후 볼트 노트 생성)
 *
 * 설정 (둘 중 하나, 둘 다도 가능)
 *  A) Notion DB 자동화: 트리거 "담당자 속성 변경" → 작업 "웹훅 보내기"
 *     URL: https://<배포주소>/api/notion/webhook?secret=NOTION_WEBHOOK_SECRET
 *  B) Notion 통합(Integration) 웹훅 구독: page.properties_updated, comment.created
 *
 * 놓치는 경우를 대비해 아침 브리핑과 /티켓 할당 명령이 Notion을 직접 조회해 보완합니다.
 * notion-todo-sync 스킬 규칙대로, 확인 없이 노트를 만들지 않습니다.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { json } from "../../src/lib/http.js";
import { config } from "../../src/lib/config.js";
import { findMentionInComments, getTicket, TICKET_ACTIVE } from "../../src/lib/notion.js";
import { candidateCard, context, notifyMe, section } from "../../src/lib/slack.js";
import { collectNotionLinks, readIgnored } from "../../src/lib/vault.js";

function findPageId(body: any): string | null {
  const cands = [body?.data?.id, body?.page?.id, body?.entity?.id, body?.data?.parent?.id, body?.data?.page_id, body?.id, body?.data?.page?.id];
  for (const c of cands) if (typeof c === "string" && /^[0-9a-f-]{32,36}$/i.test(c)) return c;
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { ok: false });
  if (config.notion.webhookSecret) {
    const q = req.query?.secret;
    if ((Array.isArray(q) ? q[0] : q) !== config.notion.webhookSecret) return json(res, 401, { ok: false, error: "unauthorized" });
  }
  if (!config.notion.enabled) return json(res, 200, { ok: false, reason: "notion disabled" });
  if (req.body?.verification_token) {
    console.log("Notion verification_token:", req.body.verification_token);
    return json(res, 200, { ok: true });
  }

  const body = req.body ?? {};
  const eventType: string = String(body.type ?? "");
  const foundId = findPageId(body);
  if (!foundId) return json(res, 200, { ok: false, reason: "page id not found", received: Object.keys(body) });
  let pageId: string = foundId;

  try {
    let reason: "assigned" | "mentioned" | null = null;
    let mention: Awaited<ReturnType<typeof findMentionInComments>> = null;
    if (eventType.startsWith("comment")) {
      pageId = body?.data?.parent?.id ?? body?.entity?.parent?.id ?? pageId;
      mention = await findMentionInComments(pageId);
      if (mention) reason = "mentioned";
    }
    const ticket = await getTicket(pageId);
    if (ticket.assigneeIds.includes(config.notion.meUserId)) reason = reason ?? "assigned";
    if (!reason) return json(res, 200, { ok: true, skipped: "not assigned/mentioned to me", ticket: ticket.title });
    if (!TICKET_ACTIVE.includes(ticket.status)) return json(res, 200, { ok: true, skipped: `inactive status ${ticket.status}` });

    const [links, ignored] = await Promise.all([collectNotionLinks(), readIgnored()]);
    if (links.has(ticket.id)) return json(res, 200, { ok: true, skipped: "already in vault", path: links.get(ticket.id) });
    if (ignored.has(ticket.id)) return json(res, 200, { ok: true, skipped: "ignored" });

    const label = reason === "mentioned" ? "댓글에서 멘션됨" : "담당자로 지정됨";
    await notifyMe(config.slack.channelWork, `📌 Notion 티켓 ${label}: ${ticket.title}`, [
      section(`📌 *Notion 티켓 ${label}* — 할일로 등록할까요?`),
      ...candidateCard({ ticket, reason, mention: mention ?? undefined }),
      context(`Notion 상태 ${ticket.status || "-"} · 우선순위 ${ticket.priority || "-"} · 등록하면 \`06_To Do/\`에 \`notion: assigned\` 노트가 생깁니다`),
    ]);
    return json(res, 200, { ok: true, reason, ticket: ticket.title, notified: true });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
