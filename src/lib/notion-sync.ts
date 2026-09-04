/**
 * Notion ↔ 볼트 접점 3가지
 *  pullAssignedTickets  : 나에게 할당된 Notion 티켓 → 볼트 할일 등록 (+Slack 알림)
 *  refreshTicketStatus  : 볼트 할일에 연결된 티켓의 진행 상태 갱신 (Notion에서 완료되면 볼트도 완료)
 *  issueTicket          : 볼트 할일 → Notion 티켓 발급 후 서로 연결
 */
import { config } from "./config.js";
import { createTicket, getTicketsStatus, listTicketsAssignedToMe, ticketToVaultStatus, TICKET_DONE, type Ticket } from "./notion.js";
import { createTask, listOpenTasks, updateTask, type VaultTask } from "./vault.js";
import { notifyMe, section, taskCard, context } from "./slack.js";
import { syncTaskToCalendar } from "./gcal.js";

export interface PullResult { registered: VaultTask[]; alreadyLinked: number }

/** 담당자가 나인 Notion 티켓 중 볼트에 없는 것을 등록하고 Slack에 알립니다 */
export async function pullAssignedTickets(opts: { notify?: boolean } = {}): Promise<PullResult> {
  if (!config.notion.enabled) return { registered: [], alreadyLinked: 0 };
  const [tickets, open] = await Promise.all([listTicketsAssignedToMe(), listOpenTasks()]);
  const linked = new Set(open.map((t) => t.notionId).filter(Boolean));
  const registered: VaultTask[] = [];
  for (const tk of tickets) {
    if (linked.has(tk.id)) continue;
    const task = await registerTicketAsTask(tk);
    registered.push(task);
  }
  if (opts.notify !== false && registered.length) {
    await notifyMe(config.slack.channelWork, `📌 Notion에서 할당된 티켓 ${registered.length}건을 할일로 등록했어요`, [
      section(`📌 *Notion 할당 → 할일 등록* (${registered.length})`),
      ...registered.flatMap(taskCard),
      context("볼트 `WorkHub/Tasks/`에 파일이 생겼습니다. 상태는 Slack 버튼 또는 Obsidian에서 바꿀 수 있어요."),
    ]);
  }
  return { registered, alreadyLinked: linked.size };
}

/** 티켓 하나를 볼트 할일로 등록 (웹훅에서도 사용). 이미 있으면 그것을 반환 */
export async function registerTicketAsTask(tk: Ticket): Promise<VaultTask> {
  const open = await listOpenTasks();
  const existing = open.find((t) => t.notionId === tk.id);
  if (existing) return existing;
  const task = await createTask({
    title: tk.title,
    due: tk.due,
    priority: tk.priority || undefined,
    tags: tk.tags,
    source: "notion",
    status: ticketToVaultStatus(tk.status) === "완료" ? "할일" : ticketToVaultStatus(tk.status),
    notionTicket: tk.url,
    notionId: tk.id,
    notionStatus: tk.status,
    body: `Notion 티켓에서 할당됨: ${tk.url}\n`,
  });
  if (config.google.enabled && task.due) { try { await syncTaskToCalendar(task); } catch { /* ignore */ } }
  return task;
}

export interface RefreshResult { checked: number; changed: Array<{ task: VaultTask; from: string | null; to: string }>; completed: VaultTask[] }

/** 볼트 할일에 연결된 티켓 상태를 Notion에서 다시 읽어 갱신 */
export async function refreshTicketStatus(tasks?: VaultTask[]): Promise<RefreshResult> {
  const result: RefreshResult = { checked: 0, changed: [], completed: [] };
  if (!config.notion.enabled) return result;
  const open = tasks ?? await listOpenTasks();
  const linked = open.filter((t) => t.notionId);
  if (!linked.length) return result;
  const statuses = await getTicketsStatus(linked.map((t) => t.notionId!));
  result.checked = statuses.size;
  for (const t of linked) {
    const tk = statuses.get(t.notionId!);
    if (!tk || tk.status === t.notionStatus) continue;
    const patch: Partial<VaultTask> = { notionStatus: tk.status };
    // Notion에서 티켓이 끝나면(완료/보관/업무제외) 볼트 할일도 닫습니다 — 내가 발급한 티켓의 완료 확인
    if (TICKET_DONE.includes(tk.status) && (t.status === "할일" || t.status === "진행중" || t.status === "보류")) {
      patch.status = ticketToVaultStatus(tk.status);
    }
    const updated = await updateTask(t, patch);
    result.changed.push({ task: updated, from: t.notionStatus, to: tk.status });
    if (patch.status) {
      result.completed.push(updated);
      if (config.google.enabled) { try { await syncTaskToCalendar(updated); } catch { /* ignore */ } }
    }
  }
  return result;
}

/** 볼트 할일 → Notion 티켓 발급 + 볼트 파일에 링크 기록 */
export async function issueTicket(task: VaultTask, opts: { slackLink?: string } = {}): Promise<{ task: VaultTask; ticket: Ticket }> {
  if (task.notionTicket) throw new Error(`이미 티켓이 연결되어 있어요: ${task.notionTicket}`);
  const ticket = await createTicket({
    title: task.title,
    due: task.due,
    priority: task.priority || undefined,
    tags: task.tags,
    request: task.body,
    slackLink: opts.slackLink,
  });
  const updated = await updateTask(task, { notionTicket: ticket.url, notionId: ticket.id, notionStatus: ticket.status });
  return { task: updated, ticket };
}
