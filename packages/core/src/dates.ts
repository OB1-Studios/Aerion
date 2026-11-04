/**
 * Calendar dates are ISO strings ("2026-11-02") and are compared as strings.
 * Value dates, due dates and certificate dates have no time zone; instants
 * (timestamps) are converted to a Pakistan date only when needed.
 */
export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const PK_TIME_ZONE = "Asia/Karachi";

export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== "string") return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.toISOString().slice(0, 10) === s;
}

function toUtc(s: IsoDate): Date {
  if (!isIsoDate(s)) throw new Error(`Not an ISO date: ${String(s)}`);
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(dt: Date): IsoDate {
  return dt.toISOString().slice(0, 10);
}

export function addDays(s: IsoDate, n: number): IsoDate {
  const dt = toUtc(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
}

/** Calendar days from a to b (positive when b is later). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(s: IsoDate): number {
  return toUtc(s).getUTCDay();
}

export function isBusinessDay(s: IsoDate, holidays?: ReadonlySet<IsoDate>): boolean {
  const w = weekday(s);
  return w !== 0 && w !== 6 && !holidays?.has(s);
}

/** Business days d with from < d <= to. Due Oct 21, checked Nov 2 -> 8. */
export function businessDaysBetween(from: IsoDate, to: IsoDate, holidays?: ReadonlySet<IsoDate>): number {
  if (to <= from) return 0;
  let n = 0;
  let d = from;
  while (d < to) {
    d = addDays(d, 1);
    if (isBusinessDay(d, holidays)) n++;
  }
  return n;
}

export function addBusinessDays(s: IsoDate, n: number, holidays?: ReadonlySet<IsoDate>): IsoDate {
  let d = s;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d, holidays)) left--;
  }
  return d;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTH_NAMES: readonly string[] = MONTHS;

/** "2 November 2026" */
export function formatDateLong(s: IsoDate): string {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "02/11/2026" (DD/MM/YYYY, as used in Pakistan) */
export function formatDateShort(s: IsoDate): string {
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
}

/** The calendar date of an instant in a time zone (Pakistan by default). */
export function dateInZone(instant: Date, timeZone: string = PK_TIME_ZONE): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

type Env = Record<string, string | undefined>;
const defaultEnv = (): Env => (globalThis as { process?: { env: Env } }).process?.env ?? {};

/**
 * The one place that answers "what time is it?". Demo workspaces set APP_CLOCK
 * (e.g. 2026-11-02T09:00:00+05:00) so the demo looks the same whatever day it is opened.
 */
export function clockNow(env: Env = defaultEnv()): Date {
  const v = env.APP_CLOCK;
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function today(env?: Env): IsoDate {
  return dateInZone(clockNow(env));
}

/** Pakistan's tax year runs July to June. 2026-11-02 -> { start: 2026-07-01, end: 2027-06-30, label: "2026-27" }. */
export function taxYearOf(s: IsoDate, startMonth = 7): { start: IsoDate; end: IsoDate; label: string } {
  const [y, m] = s.split("-").map(Number) as [number, number];
  const startYear = m >= startMonth ? y : y - 1;
  const mm = String(startMonth).padStart(2, "0");
  const start = `${startYear}-${mm}-01`;
  const end = addDays(`${startYear + 1}-${mm}-01`, -1);
  return { start, end, label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}` };
}
