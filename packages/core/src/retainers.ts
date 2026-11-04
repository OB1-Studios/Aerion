import { isIsoDate, MONTH_NAMES, type IsoDate } from "./dates";
import { dec } from "./money";

/**
 * Retainers (main doc W7): the same amount billed on the same day every month. Each run
 * drafts the current month's invoice once its billing day has come, and a person reviews it
 * before it goes out. Earlier months are never back-filled: a retainer added mid-month starts
 * with the first billing day on or after its start date.
 */

export interface RetainerTerms {
  /** 1 to 28, so the day exists in every month. */
  billingDay: number;
  startsOn: IsoDate | null;
  endsOn: IsoDate | null;
  /** The last month drafted, like "2026-10". */
  lastPeriod: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const billingDate = (period: string, day: number): IsoDate => `${period}-${pad2(day)}`;

function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`;
}

/** "2026-11" → "November 2026" */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** The month whose invoice should be drafted today, if there is one. */
export function retainerDue(r: RetainerTerms, today: IsoDate): { period: string; billingDate: IsoDate } | null {
  const period = today.slice(0, 7);
  const date = billingDate(period, r.billingDay);
  if (r.lastPeriod && r.lastPeriod >= period) return null;
  if (today < date) return null;
  if (r.startsOn && date < r.startsOn) return null;
  if (r.endsOn && date > r.endsOn) return null;
  return { period, billingDate: date };
}

/**
 * The billing date of the next invoice the agent will draft, or null once the retainer has
 * ended. A date on or before today means the next run drafts it.
 */
export function nextRetainerDate(r: RetainerTerms, today: IsoDate): IsoDate | null {
  let period = today.slice(0, 7);
  for (let i = 0; i < 36; i++, period = nextPeriod(period)) {
    const date = billingDate(period, r.billingDay);
    if (r.endsOn && date > r.endsOn) return null;
    if (r.lastPeriod && period <= r.lastPeriod) continue;
    if (r.startsOn && date < r.startsOn) continue;
    return date;
  }
  return null;
}

export interface RetainerInput {
  description: string;
  amount: string;
  currency: string;
  billingDay: string;
  startsOn: string;
}

export interface RetainerValue {
  description: string;
  amount: string;
  currency: string;
  billingDay: number;
  startsOn: IsoDate;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/** Checks a new retainer and returns it cleaned, or what's wrong in plain words. */
export function checkRetainer(input: RetainerInput): { problems: string[]; value: RetainerValue | null } {
  const problems: string[] = [];
  const description = input.description.trim().replace(/\s+/g, " ");
  const amount = input.amount.trim().replace(/,/g, "");
  const currency = input.currency.trim().toUpperCase();
  const day = input.billingDay.trim();
  const startsOn = input.startsOn.trim();
  if (!description) problems.push("Describe the work, as it should read on the invoice.");
  else if (description.length > 200) problems.push("The description is too long (200 characters at most).");
  if (!AMOUNT_RE.test(amount) || dec(amount).lte(0)) problems.push("The monthly amount should be more than zero, like 2400 or 2400.00.");
  if (!/^[A-Z]{3}$/.test(currency)) problems.push("The currency should be a three-letter code, like USD.");
  if (!/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 28) problems.push("The billing day should be from 1 to 28, so it falls in every month.");
  if (!isIsoDate(startsOn)) problems.push("The start date isn't a date.");
  if (problems.length) return { problems, value: null };
  return { problems, value: { description, amount: dec(amount).toFixed(2), currency, billingDay: Number(day), startsOn } };
}
