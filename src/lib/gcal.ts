/**
 * Google Calendar 클라이언트 (서비스 계정 + JWT, 외부 라이브러리 없음)
 *
 * 준비: Google Cloud에서 서비스 계정 생성 → JSON 키 다운로드 →
 *       내 캘린더를 서비스 계정 이메일과 "일정 변경" 권한으로 공유.
 */
import { createSign } from "node:crypto";
import { config } from "./config.js";
import { ensureOk } from "./http.js";
import type { VaultTask } from "./vault.js";
import { addDays } from "./dates.js";

const SCOPE = "https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";

let cached: { token: string; exp: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = JSON.parse(config.google.serviceAccountJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const headerPart = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimPart = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerPart}.${claimPart}`);
  const jwt = `${headerPart}.${claimPart}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  await ensureOk(res, "Google 토큰 발급");
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

async function gcal<T = any>(path: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  await ensureOk(res, `Google Calendar ${init.method ?? "GET"} ${path}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  htmlLink: string;
  location?: string;
  vaultPath?: string;
}

function toEvent(e: any): CalEvent {
  return {
    id: e.id,
    summary: e.summary ?? "(제목 없음)",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    allDay: Boolean(e.start?.date),
    htmlLink: e.htmlLink,
    location: e.location,
    vaultPath: e.extendedProperties?.private?.vaultPath,
  };
}

const cal = () => encodeURIComponent(config.google.calendarId);

export async function listEvents(timeMin: string, timeMax: string): Promise<CalEvent[]> {
  const qs = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "50" });
  const data = await gcal(`/calendars/${cal()}/events?${qs}`);
  return (data.items ?? []).map(toEvent);
}

async function findEventForTask(path: string): Promise<CalEvent | null> {
  const qs = new URLSearchParams({ privateExtendedProperty: `vaultPath=${path}`, maxResults: "1", showDeleted: "false" });
  const data = await gcal(`/calendars/${cal()}/events?${qs}`);
  return data.items?.length ? toEvent(data.items[0]) : null;
}

/** 볼트 할일 → 마감일 종일 일정 생성/갱신, 완료·마감 없음이면 삭제 */
export async function syncTaskToCalendar(t: VaultTask): Promise<"created" | "updated" | "deleted" | "skipped"> {
  const existing = await findEventForTask(t.path);
  const shouldExist = Boolean(t.due) && t.status !== "done";
  if (!shouldExist) {
    if (existing) { await gcal(`/calendars/${cal()}/events/${existing.id}`, { method: "DELETE" }); return "deleted"; }
    return "skipped";
  }
  const startDate = t.due!;
  const endDate = addDays(t.due!, 1);
  const body = {
    summary: `[할일] ${t.title}`,
    description: `볼트: ${t.path}\n프로젝트: ${t.project || "-"}\n우선순위: ${t.priority || "-"}\n상태: ${t.status}${t.notionUrl ? `\nNotion: ${t.notionUrl}` : ""}`,
    start: { date: startDate },
    end: { date: endDate },
    extendedProperties: { private: { vaultPath: t.path.slice(0, 1000), source: "jlaw-workhub" } },
    transparency: "transparent",
  };
  if (existing) {
    if (existing.summary === body.summary && existing.start === startDate && existing.end === endDate) return "skipped";
    await gcal(`/calendars/${cal()}/events/${existing.id}`, { method: "PATCH", body });
    return "updated";
  }
  await gcal(`/calendars/${cal()}/events`, { method: "POST", body });
  return "created";
}

/** Slack에서 직접 만든 일정 */
export async function createTimedEvent(input: { summary: string; date: string; startTime?: string; endTime?: string; description?: string }): Promise<CalEvent> {
  const body: any = { summary: input.summary, description: input.description };
  if (input.startTime) {
    const end = input.endTime ?? plusOneHour(input.startTime);
    body.start = { dateTime: `${input.date}T${input.startTime}:00`, timeZone: config.timezone };
    body.end = { dateTime: `${input.date}T${end}:00`, timeZone: config.timezone };
  } else {
    body.start = { date: input.date };
    body.end = { date: addDays(input.date, 1) };
  }
  return toEvent(await gcal(`/calendars/${cal()}/events`, { method: "POST", body }));
}

function plusOneHour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
