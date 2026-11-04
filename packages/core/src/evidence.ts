import { formatDateLong, isIsoDate, MONTH_NAMES, type IsoDate } from "./dates";
import { Decimal, dec, formatMoney, formatRate, pct2, type Grouping } from "./money";

/**
 * The numbers behind a flag or draft, each with a name. Models write placeholders
 * ({{invoice.amount}}); code fills them in from this set and then checks that every
 * number in the final text came from it (data spec section 6).
 */
export type EvidenceValue =
  | { type: "money"; amount: string; currency: string }
  | { type: "date"; value: IsoDate }
  | { type: "int"; value: number }
  | { type: "pct"; value: string }
  | { type: "rate"; value: string }
  /** Names, identifiers and codes: inserted verbatim and allowed to contain digits. */
  | { type: "text"; value: string };

export type Evidence = Record<string, EvidenceValue>;

export const ev = {
  money: (amount: Decimal.Value, currency: string): EvidenceValue => ({ type: "money", amount: dec(amount).toFixed(2), currency }),
  date: (value: IsoDate): EvidenceValue => ({ type: "date", value }),
  int: (value: number): EvidenceValue => ({ type: "int", value }),
  pct: (value: Decimal.Value): EvidenceValue => ({ type: "pct", value: pct2(value) }),
  rate: (value: Decimal.Value): EvidenceValue => ({ type: "rate", value: dec(value).toString() }),
  text: (value: string): EvidenceValue => ({ type: "text", value }),
};

export interface RenderOptions {
  grouping?: Grouping;
}

export function formatEvidence(v: EvidenceValue, opts: RenderOptions = {}): string {
  switch (v.type) {
    case "money":
      return formatMoney(v.amount, v.currency, { grouping: opts.grouping });
    case "date":
      return formatDateLong(v.value);
    case "int":
      return String(v.value);
    case "pct":
      return `${v.value}%`;
    case "rate":
      return formatRate(v.value);
    case "text":
      return v.value;
  }
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!))];
}

/** Placeholders the template has that a model's rewrite dropped. */
export function missingPlaceholders(template: string, rewritten: string): string[] {
  const have = new Set(placeholdersIn(rewritten));
  return placeholdersIn(template).filter((p) => !have.has(p));
}

export interface RenderResult {
  text: string;
  /** Placeholders with no value in the evidence set; the draft can't be sent. */
  unknown: string[];
  used: string[];
}

export function renderTemplate(template: string, evidence: Evidence, opts: RenderOptions = {}): RenderResult {
  const unknown = new Set<string>();
  const used = new Set<string>();
  const text = template.replace(PLACEHOLDER_RE, (whole, key: string) => {
    const v = evidence[key];
    if (!v) {
      unknown.add(key);
      return whole;
    }
    used.add(key);
    return formatEvidence(v, opts);
  });
  return { text, unknown: [...unknown], used: [...used] };
}

export interface FoundNumber {
  text: string;
  kind: "date" | "number";
  ok: boolean;
  /** Evidence names this value matches. */
  matches: string[];
}

export interface NumbersCheckResult {
  ok: boolean;
  found: FoundNumber[];
  failures: FoundNumber[];
}

const MONTH_RE = MONTH_NAMES.join("|");
const DATE_PATTERNS: Array<{ re: RegExp; toIso: (m: RegExpMatchArray) => string | null }> = [
  {
    // 2 November 2026
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\s+(\\d{4})\\b`, "gi"),
    toIso: (m) => iso(Number(m[3]), monthIndex(m[2]!), Number(m[1])),
  },
  {
    // November 2, 2026
    re: new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
    toIso: (m) => iso(Number(m[3]), monthIndex(m[1]!), Number(m[2])),
  },
  {
    // 2026-11-02
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    toIso: (m) => iso(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  {
    // 02/11/2026 (DD/MM/YYYY)
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    toIso: (m) => iso(Number(m[3]), Number(m[2]), Number(m[1])),
  },
];

function monthIndex(name: string): number {
  return MONTH_NAMES.findIndex((n) => n.toLowerCase() === name.toLowerCase()) + 1;
}

function iso(y: number, m: number, d: number): string | null {
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(s) ? s : null;
}

function mask(text: string, start: number, length: number): string {
  return text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
}

/**
 * Every number and date in the rendered text must equal a value in the evidence set.
 * Identifiers (invoice numbers, IBANs, purpose codes) are text evidence or on the
 * allow-list, so their digits don't count as numbers. Anything else blocks the draft.
 */
export function checkNumbers(rendered: string, evidence: Evidence, allow: string[] = []): NumbersCheckResult {
  const found: FoundNumber[] = [];
  let text = rendered;

  // 1. Mask verbatim identifiers, longest first.
  const verbatim = [
    ...Object.values(evidence)
      .filter((v): v is Extract<EvidenceValue, { type: "text" }> => v.type === "text")
      .map((v) => v.value),
    ...allow,
  ]
    .filter((s) => /\d/.test(s))
    .sort((a, b) => b.length - a.length);
  for (const s of verbatim) {
    let idx = text.indexOf(s);
    while (idx !== -1) {
      text = mask(text, idx, s.length);
      idx = text.indexOf(s, idx + s.length);
    }
  }

  // 2. Dates.
  const dateValues = new Map<string, string[]>();
  for (const [k, v] of Object.entries(evidence)) {
    if (v.type === "date") dateValues.set(v.value, [...(dateValues.get(v.value) ?? []), k]);
  }
  for (const { re, toIso } of DATE_PATTERNS) {
    for (const m of [...text.matchAll(re)]) {
      const isoValue = toIso(m);
      const matches = isoValue ? (dateValues.get(isoValue) ?? []) : [];
      found.push({ text: m[0], kind: "date", ok: matches.length > 0, matches });
      text = mask(text, m.index!, m[0].length);
    }
  }

  // 3. Remaining numbers.
  const numberValues: Array<{ key: string; value: Decimal }> = [];
  for (const [k, v] of Object.entries(evidence)) {
    if (v.type === "money") numberValues.push({ key: k, value: dec(v.amount) });
    else if (v.type === "int") numberValues.push({ key: k, value: dec(v.value) });
    else if (v.type === "pct" || v.type === "rate") numberValues.push({ key: k, value: dec(v.value) });
  }
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,+$/, "");
    const value = dec(raw.replace(/,/g, ""));
    const matches = numberValues.filter((n) => n.value.eq(value)).map((n) => n.key);
    found.push({ text: raw, kind: "number", ok: matches.length > 0, matches });
  }

  const failures = found.filter((f) => !f.ok);
  return { ok: failures.length === 0, found, failures };
}
