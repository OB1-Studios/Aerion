import Decimal from "decimal.js";

export { Decimal };
export type DecimalLike = Decimal.Value;

/**
 * Money is a decimal string everywhere (database numeric, JSON, model output).
 * JavaScript floats never touch an amount.
 */
export function dec(x: DecimalLike | null | undefined): Decimal {
  if (x === null || x === undefined || x === "") return new Decimal(0);
  return new Decimal(x);
}

export function round2(x: DecimalLike): Decimal {
  return dec(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** "6750" -> "6750.00" */
export function fixed2(x: DecimalLike): string {
  return round2(x).toFixed(2);
}

export function sumDec(xs: Iterable<DecimalLike | null | undefined>): Decimal {
  let s = new Decimal(0);
  for (const x of xs) s = s.plus(dec(x));
  return s;
}

export function minDec(a: DecimalLike, b: DecimalLike): Decimal {
  return Decimal.min(dec(a), dec(b));
}

export function maxDec(a: DecimalLike, b: DecimalLike): Decimal {
  return Decimal.max(dec(a), dec(b));
}

export type Grouping = "western" | "lakh";

/** "1899450" -> "1,899,450" (western) or "18,99,450" (lakh). */
export function groupDigits(intPart: string, grouping: Grouping = "western"): string {
  if (grouping === "western") return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

export interface FormatOptions {
  grouping?: Grouping;
  decimals?: number;
}

export function formatAmount(x: DecimalLike, opts: FormatOptions = {}): string {
  const decimals = opts.decimals ?? 2;
  const d = dec(x).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  const negative = d.isNegative() && !d.isZero();
  const [int = "0", frac] = d.abs().toFixed(decimals).split(".");
  return `${negative ? "-" : ""}${groupDigits(int, opts.grouping)}${frac ? `.${frac}` : ""}`;
}

/** "USD 6,750.00" */
export function formatMoney(x: DecimalLike, currency: string, opts: FormatOptions = {}): string {
  return `${currency} ${formatAmount(x, opts)}`;
}

/** Exchange rates keep their precision but show at least two decimals: "201.9" -> "201.90". */
export function formatRate(x: DecimalLike): string {
  const d = dec(x);
  return d.decimalPlaces() < 2 ? d.toFixed(2) : d.toString();
}

/** Percentage to two decimals, without the % sign: 0.6392 -> "0.64". */
export function pct2(x: DecimalLike): string {
  return dec(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
