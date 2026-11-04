import { addDays, daysBetween, type IsoDate } from "@ebo/core";

/**
 * Simulated reference rates, PKR per unit (data spec section 7). Not forecasts of real rates.
 * A smooth, deterministic wobble before the demo week; flat at the base rates from Oct 26,
 * so the demo-week numbers in the spec (CAD 203.20, EUR 327.60) come out exactly.
 */
export const BASE_RATES: Record<string, string> = { USD: "281.40", GBP: "375.10", EUR: "327.60", CAD: "203.20", AUD: "184.90" };
export const RATES_FROM: IsoDate = "2026-07-01";
export const RATES_TO: IsoDate = "2026-11-13";
const FLAT_FROM: IsoDate = "2026-10-26";
const PHASE: Record<string, number> = { USD: 0, GBP: 1.3, EUR: 2.1, CAD: 3.4, AUD: 4.6 };

export function simulatedRate(currency: string, date: IsoDate): string {
  const base = BASE_RATES[currency];
  if (!base) throw new Error(`no simulated rate for ${currency}`);
  const n = daysBetween(date, FLAT_FROM);
  if (n <= 0) return Number(base).toFixed(2);
  const wobble = 0.004 * Math.sin(n / 13 + (PHASE[currency] ?? 0)) * Math.min(1, n / 21);
  return (Number(base) * (1 + wobble)).toFixed(2);
}

export function rateRows(): Array<{ currency: string; rateDate: IsoDate; midRate: string; source: string }> {
  const rows = [];
  for (let d = RATES_FROM; d <= RATES_TO; d = addDays(d, 1)) {
    for (const currency of Object.keys(BASE_RATES)) rows.push({ currency, rateDate: d, midRate: simulatedRate(currency, d), source: "simulated" });
  }
  return rows;
}
