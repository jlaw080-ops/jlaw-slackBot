/** 한국시간(KST) 기준 날짜 유틸리티. 서버는 UTC로 돌기 때문에 항상 이 함수들을 거칩니다. */
const TZ = "Asia/Seoul";

/** YYYY-MM-DD (KST) */
export function todayKST(base: Date = new Date()): string {
  return formatDateKST(base);
}

export function formatDateKST(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0=일 ... 6=토 */
export function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** KST 하루의 시작/끝 (Google Calendar 조회용) */
export function dayRangeKST(isoDate: string, days = 1): { timeMin: string; timeMax: string } {
  return {
    timeMin: `${isoDate}T00:00:00+09:00`,
    timeMax: `${addDays(isoDate, days)}T00:00:00+09:00`,
  };
}

/** 2026-09-03 → "9/3(목)" */
export function prettyKST(isoDate: string): string {
  const [, m, d] = isoDate.split("-").map(Number);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][weekdayOf(isoDate)];
  return `${m}/${d}(${wd})`;
}

/** ISO datetime → "HH:MM" (KST) */
export function timeKST(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

/**
 * Slack에 입력한 날짜 표현을 YYYY-MM-DD로 해석합니다.
 * 지원: 오늘, 내일, 모레, 이번주(=이번 주 금요일), 다음주(=다음 주 금요일),
 *       월/일 (9/10), 2026-09-10, +3 (3일 뒤)
 */
export function parseDateInput(text: string, base: string = todayKST()): string | null {
  const t = text.trim().replace(/\s+/g, "");
  if (!t) return null;
  if (t === "오늘") return base;
  if (t === "내일") return addDays(base, 1);
  if (t === "모레") return addDays(base, 2);
  const plus = /^\+(\d{1,3})$/.exec(t);
  if (plus) return addDays(base, Number(plus[1]));
  if (t === "이번주" || t === "금요일") return thisFriday(base);
  if (t === "다음주") return addDays(thisFriday(base), 7);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[\/\-.](\d{1,2})$/.exec(t);
  if (m) {
    const year = Number(base.slice(0, 4));
    let candidate = iso(year, Number(m[1]), Number(m[2]));
    if (candidate < base) candidate = iso(year + 1, Number(m[1]), Number(m[2]));
    return candidate;
  }
  return null;
}

function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/** base가 속한 주의 금요일 (base가 토/일이면 다음 주 금요일) */
function thisFriday(base: string): string {
  const diff = (5 - weekdayOf(base) + 7) % 7;
  return addDays(base, diff);
}
