/**
 * Ask your books (main doc W29). A question in plain words becomes one of a fixed set of
 * read-only queries: what's owed, what's overdue, what came in, export proceeds by month, the
 * banking-channel share, missing paperwork, what getting paid costs, how long clients take to
 * pay, or one invoice from start to finish. Code computes every figure from the same books and
 * reference rates as the financial overview, and each line links to the record behind it.
 *
 * Built-in rules choose the query. When they can't and the workspace allows AI, a model may
 * choose instead, but only the query and its client, invoice and dates: never a number. Its
 * choice is checked against the workspace before it is used. Nothing here changes the books.
 */
import { daysBetween, dec, eprcStatus, fixed2, formatMoney, MONTH_NAMES, taxYearOf, type Decimal, type Grouping, type IsoDate } from "@ebo/core";
import { flag, modelCall, type Db } from "@ebo/db";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import { BANK_ACCOUNT_KINDS, flagSnapshot, loadBooks, taxYearOpenings, type Books } from "./books";
import type { WorkspaceContext } from "./context";
import { dashboard, isMoneyIn } from "./dashboard";
import type { ModelCallRecord } from "./readers/types";

export const ASK_TOOLS = ["owed", "overdue", "received", "proceeds", "banking_share", "missing_paperwork", "cost", "days_to_pay", "invoice"] as const;
export type AskTool = (typeof ASK_TOOLS)[number];

export const ASK_TOOL_LABEL: Record<AskTool, string> = {
  owed: "What clients owe",
  overdue: "Overdue invoices",
  received: "Money received",
  proceeds: "Export proceeds by month",
  banking_share: "Banking-channel share",
  missing_paperwork: "Missing ePRCs and certificates",
  cost: "What getting paid costs",
  days_to_pay: "How long clients take to pay",
  invoice: "One invoice",
};

/** Which queries narrow to a client, and which to a period; the rest describe the books now or the tax year so far. */
const TAKES_CLIENT: Record<AskTool, boolean> = { owed: true, overdue: true, received: true, proceeds: false, banking_share: false, missing_paperwork: true, cost: true, days_to_pay: true, invoice: false };
const TAKES_PERIOD: Record<AskTool, boolean> = { owed: false, overdue: false, received: true, proceeds: true, banking_share: false, missing_paperwork: false, cost: false, days_to_pay: false, invoice: false };

export const ASK_QUESTION_MAX = 300;
/** Model-chosen questions per workspace per day; past it, the rules alone answer. */
export const ASK_MODEL_DAILY_LIMIT = 50;

export interface AskPlan {
  tool: AskTool;
  clientId: string | null;
  invoiceId: string | null;
  from: IsoDate | null;
  to: IsoDate | null;
}

/** What a planner may refer to: the workspace's own clients and invoices, and the date. */
export interface AskScope {
  today: IsoDate;
  taxYear: { start: IsoDate; end: IsoDate; label: string };
  clients: Array<{ id: string; name: string; kind: string; aliases: string[] }>;
  invoices: Array<{ id: string; number: string }>;
}

/** A model that turns a question into a query. The engine checks whatever it returns. */
export interface AskPlanner {
  model: string;
  plan(question: string, scope: AskScope): Promise<{ raw: Record<string, unknown> | null; calls: ModelCallRecord[] }>;
}

export interface AskLine {
  /** Lines with the same group are shown under one heading. */
  group?: string;
  label: string;
  detail?: string;
  value: string;
  /** Relative to the workspace, e.g. "/invoices/<id>". */
  href?: string;
  tone?: "bad" | "warn" | "good";
}

export interface AskAnswer {
  tool: AskTool;
  /** What was answered: the query, the client and the period, in words. */
  title: string;
  headline: string;
  sub: string | null;
  lines: AskLine[];
  /** A long list is cut; this says how many more and where they all are. */
  more: { count: number; label: string; href: string } | null;
  notes: string[];
  /** Where the full picture lives in the app. */
  seeAlso: { label: string; href: string } | null;
}

export type ChosenBy = { by: "rules" } | { by: "model"; model: string };

export type AskResult =
  | { ok: true; question: string; plan: AskPlan; chosenBy: ChosenBy; answer: AskAnswer; modelNote: string | null }
  | { ok: false; question: string; reason: "empty" | "too_long" | "not_understood"; modelNote: string | null };

// ---------------------------------------------------------------------------
// Reading the question
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9%\-/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

/** In order: the first query whose words appear wins. */
const TOOL_WORDS: Array<[AskTool, RegExp]> = [
  ["banking_share", /banking[ -]?(channel|share)|\bshare\b.*\bbanks?\b|through (pakistani |local )?banks|\b80 ?%/],
  ["missing_paperwork", /\be-?prcs?\b|\bprcs?\b|certificates?|paperwork|withholding|\bwht\b|missing (docs?|documents)/],
  ["cost", /\bfees?\b|\bcharges?\b|\bcosts?\b|costing|\bspread\b|conversion|\blose\b|\blost\b|cheapest|expensive/],
  ["days_to_pay", /how (long|quickly|fast|soon)|days to pay|on time|pays? late|late payers?|\bslow(est)?\b|\baverage\b|\bmedian\b/],
  ["overdue", /overdue|past due|\blate\b|behind on|\bchase\b/],
  ["proceeds", /proceeds|export (income|earnings|revenue)|\brevenue\b|turnover|\bincome\b|\bearn(ed|ings)?\b|by month|monthly|each month/],
  ["owed", /\bowe|\bowed\b|owing|outstanding|unpaid|receivables?|open invoices?|\bbalance\b|still due|due to (us|me)/],
  ["received", /receiv|\bpaid\b|\bpayments?\b|came in|come in|collected|transferred|sent (us|me)/],
];

const SUFFIX = /\b(llc|l l c|ltd|limited|inc|incorporated|gmbh|pty|plc|fz|fze|co|corp|corporation|company|pvt|private|the|dr|mr|mrs|ms|and)\b/g;

/** The ways people refer to a client: the full name, its first word or two, and a person's surname. */
function clientKeys(c: AskScope["clients"][number]): string[] {
  const keys = new Set<string>();
  for (const name of [c.name, ...c.aliases]) {
    const base = norm(name).replace(SUFFIX, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
    if (!base) continue;
    keys.add(base);
    const words = base.split(" ");
    if (words.length > 1 && words[0]!.length <= 3) keys.add(words.slice(0, 2).join(" ")); // "al noor"
    else if (words[0]!.length >= 4) keys.add(words[0]!); // "thames", "brightlane"
    if (c.kind === "individual" && words.length > 1 && words.at(-1)!.length >= 3) keys.add(words.at(-1)!); // "varga"
  }
  return [...keys].filter((k) => k.length >= 3);
}

export function findClient(question: string, scope: Pick<AskScope, "clients">): AskScope["clients"][number] | null {
  const q = norm(question).replace(/-/g, " ").replace(/\s+/g, " ");
  let best: { c: AskScope["clients"][number]; len: number; tie: boolean } | null = null;
  for (const c of scope.clients) {
    for (const k of clientKeys(c)) {
      if (!q.includes(` ${k} `) && !q.includes(` ${k}s `)) continue;
      if (!best || k.length > best.len) best = { c, len: k.length, tie: false };
      else if (k.length === best.len && best.c.id !== c.id) best.tie = true;
    }
  }
  return best && !best.tie ? best.c : null;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function findInvoice(question: string, scope: Pick<AskScope, "invoices">): AskScope["invoices"][number] | null {
  // Invoice numbers written with or without their dashes: "INV-2026-029", "inv 2026 029".
  const tokens = question.toLowerCase().match(/[a-z0-9][a-z0-9\- /]*\d/g) ?? [];
  const wanted = new Set(tokens.flatMap((t) => [compact(t), ...t.split(/\s+/).map(compact)]));
  let hit: AskScope["invoices"][number] | null = null;
  for (const inv of scope.invoices) {
    const k = compact(inv.number);
    if (k.length < 3) continue;
    if (wanted.has(k) || [...wanted].some((w) => w.endsWith(k) && /^[a-z]*$/.test(w.slice(0, -k.length)))) {
      if (!hit || inv.number.length > hit.number.length) hit = inv;
    }
  }
  return hit;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): IsoDate => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthRange = (y: number, m: number): [IsoDate, IsoDate] => [iso(y, m, 1), iso(y, m, lastDay(y, m))];
const shiftMonths = (y: number, m: number, by: number): [number, number] => {
  const k = y * 12 + (m - 1) + by;
  return [Math.floor(k / 12), (k % 12) + 1];
};
const addDaysIso = (d: IsoDate, n: number): IsoDate => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const MONTH_WORD = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?: (\d{4}))?/;
const monthOf = (w: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(w.slice(0, 3)) + 1;

export interface Period {
  from: IsoDate;
  to: IsoDate;
}

/** A period named in the question, or null. Tax years start in the workspace's fiscal month. */
export function parsePeriod(question: string, today: IsoDate, fiscalStartMonth = 7): Period | null {
  const q = norm(question);
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const year = taxYearOf(today, fiscalStartMonth);
  const clip = (p: Period): Period => ({ from: p.from, to: p.to > today ? today : p.to });

  let m = /\b(?:last|past|previous) (\d{1,3}) (day|week|month)s?\b/.exec(q);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === "month") {
      const [y, mm] = shiftMonths(ty, tm, -n);
      return { from: iso(y, mm, Math.min(Number(today.slice(8)), lastDay(y, mm))), to: today };
    }
    return { from: addDaysIso(today, -(n * (m[2] === "week" ? 7 : 1)) + 1), to: today };
  }
  if (/\b(this|current) month\b/.test(q)) return { from: iso(ty, tm, 1), to: today };
  if (/\b(last|previous|past) month\b/.test(q)) {
    const [y, mm] = shiftMonths(ty, tm, -1);
    const [from, to] = monthRange(y, mm);
    return { from, to };
  }
  if (/\b(this|current) week\b/.test(q) || /\b(last|previous|past) week\b/.test(q)) {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
    const monday = addDaysIso(today, -dow);
    return /\b(this|current) week\b/.test(q) ? { from: monday, to: today } : { from: addDaysIso(monday, -7), to: addDaysIso(monday, -1) };
  }
  if (/\b(this|current|last|previous|past) quarter\b/.test(q)) {
    const qStart = Math.floor((tm - 1) / 3) * 3 + 1;
    const [y, mm] = /\b(this|current) quarter\b/.test(q) ? [ty, qStart] : shiftMonths(ty, qStart, -3);
    return clip({ from: iso(y, mm, 1), to: monthRange(...shiftMonths(y, mm, 2))[1] });
  }
  m = /\b(20\d{2})[-/](\d{2})\b/.exec(q); // a tax year written "2025-26"
  if (m && (Number(m[2]) === (Number(m[1]) + 1) % 100)) {
    const t = taxYearOf(iso(Number(m[1]), fiscalStartMonth, 1), fiscalStartMonth);
    return clip({ from: t.start, to: t.end });
  }
  if (/\b(last|previous|past) (tax |financial |fiscal )?year\b/.test(q)) {
    const t = taxYearOf(addDaysIso(year.start, -1), fiscalStartMonth);
    return { from: t.start, to: t.end };
  }
  if (/\b(this|current) (tax |financial |fiscal )?year\b|\bso far\b|\bytd\b|year to date/.test(q)) return { from: year.start, to: today };

  // "since October", "from Sept 2026": the start of that month up to today.
  m = new RegExp(`\\b(?:since|from|after) ${MONTH_WORD.source}`).exec(q);
  if (m) {
    const mm = monthOf(m[1]!);
    const y = m[2] ? Number(m[2]) : mm <= tm ? ty : ty - 1;
    return { from: iso(y, mm, 1), to: today };
  }
  // A month on its own: the most recent one, unless a year is given. "may" only counts with a year or "in May".
  m = MONTH_WORD.exec(q);
  if (m && (m[1] !== "may" || m[2] || /\b(in|during|for|of|since) may\b/.test(q))) {
    const mm = monthOf(m[1]!);
    const y = m[2] ? Number(m[2]) : mm <= tm ? ty : ty - 1;
    const [from, to] = monthRange(y, mm);
    return clip({ from, to });
  }
  m = /\b(?:in|during|for) (20\d{2})\b/.exec(q) ?? /^ (20\d{2}) $/.exec(q);
  if (m) return clip({ from: `${m[1]}-01-01`, to: `${m[1]}-12-31` });
  return null;
}

/** Built-in rules: the query, client, invoice and period the words name, or null when no query fits. */
export function planByRules(question: string, scope: AskScope): AskPlan | null {
  const q = norm(question);
  const invoice = findInvoice(question, scope);
  const client = findClient(question, scope);
  let tool: AskTool | null = invoice && !/\b(e-?prcs?|certificates?|paperwork)\b/.test(q) ? "invoice" : (TOOL_WORDS.find(([, re]) => re.test(q))?.[0] ?? null);
  // A client named on its own ("Al Noor?"): what they owe.
  if (!tool && client) tool = "owed";
  if (!tool) return null;
  const period = TAKES_PERIOD[tool] ? parsePeriod(question, scope.today, Number(scope.taxYear.start.slice(5, 7))) : null;
  return { tool, clientId: TAKES_CLIENT[tool] ? (client?.id ?? null) : null, invoiceId: tool === "invoice" ? (invoice?.id ?? null) : null, from: period?.from ?? null, to: period?.to ?? null };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): IsoDate | null | false => {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? false : v;
};

/**
 * Checks a model's choice against the workspace: a known query, a client from the list, an
 * invoice that exists, real dates in order. Anything else is refused with the reason.
 */
export function planFromModel(raw: Record<string, unknown>, scope: AskScope): { plan: AskPlan } | { none: true } | { problem: string } {
  const tool = raw.tool;
  if (tool == null || tool === "none" || tool === "") return { none: true };
  if (typeof tool !== "string" || !(ASK_TOOLS as readonly string[]).includes(tool)) return { problem: `it chose a query that doesn't exist ("${String(tool).slice(0, 40)}")` };
  const t = tool as AskTool;
  let clientId: string | null = null;
  if (raw.client != null && raw.client !== "") {
    const n = Number(raw.client);
    const c = Number.isInteger(n) ? scope.clients[n - 1] : undefined;
    if (!c) return { problem: "it named a client that isn't in this workspace" };
    clientId = c.id;
  }
  let invoiceId: string | null = null;
  if (raw.invoice_number != null && raw.invoice_number !== "") {
    const inv = findInvoice(String(raw.invoice_number), scope);
    if (!inv) return { problem: "it named an invoice that isn't in this workspace" };
    invoiceId = inv.id;
  }
  if (t === "invoice" && !invoiceId) return { problem: "it asked about an invoice without naming one" };
  const from = validDay(raw.from);
  const to = validDay(raw.to);
  if (from === false || to === false) return { problem: "it gave a date that isn't a real day" };
  if (from && to && from > to) return { problem: "it gave a period that ends before it starts" };
  return { plan: { tool: t, clientId: TAKES_CLIENT[t] ? clientId : null, invoiceId, from: TAKES_PERIOD[t] ? from : null, to: TAKES_PERIOD[t] ? (to && to > scope.today ? scope.today : to) : null } };
}

// ---------------------------------------------------------------------------
// Answering: code, from the books
// ---------------------------------------------------------------------------

const SHORT_MONTHS = MONTH_NAMES.map((m) => m.slice(0, 3));
const shortDay = (d: IsoDate) => `${Number(d.slice(8))} ${SHORT_MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const longDay = (d: IsoDate) => `${Number(d.slice(8))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function periodLabel(p: Period, today: IsoDate, fiscalStartMonth = 7): string {
  const year = taxYearOf(p.from, fiscalStartMonth);
  if (p.from === year.start && (p.to === year.end || (p.to === today && today <= year.end))) return p.to === today && today < year.end ? `tax year ${year.label} so far` : `tax year ${year.label}`;
  const [fy, fm] = p.from.split("-").map(Number) as [number, number];
  const [first, last] = monthRange(fy, fm);
  if (p.from === first && (p.to === last || (p.to === today && today < last))) return `${MONTH_NAMES[fm - 1]} ${fy}${p.to === today && today < last ? " so far" : ""}`;
  return `${shortDay(p.from)} to ${shortDay(p.to)}`;
}

const LIST_MAX = 12;

interface Ctx {
  b: Books;
  w: WorkspaceContext;
  flags: Array<{ id: string; kind: string; severity: string; summary: string; subjectType: string; subjectId: string }>;
  money: (x: Decimal.Value, ccy: string) => string;
  pkr: (x: Decimal.Value) => string;
  clientName: (id: string) => string;
}

function byCurrency(rows: Array<{ currency: string; amount: Decimal.Value }>): Map<string, Decimal> {
  const m = new Map<string, Decimal>();
  for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? dec(0)).plus(r.amount));
  return new Map([...m].sort(([a], [b]) => a.localeCompare(b)));
}

function cut(lines: AskLine[], label: string, href: string): Pick<AskAnswer, "lines" | "more"> {
  return lines.length > LIST_MAX ? { lines: lines.slice(0, LIST_MAX), more: { count: lines.length - LIST_MAX, label, href } } : { lines, more: null };
}

function openInvoices(c: Ctx, clientId: string | null) {
  return c.b.invoices.filter((i) => (i.status === "sent" || i.status === "part_paid") && dec(i.balance).gt(0) && (!clientId || i.clientId === clientId));
}

function owed(c: Ctx, plan: AskPlan, onlyLate: boolean): AskAnswer {
  const { today, refRate } = c.w;
  const who = plan.clientId ? c.clientName(plan.clientId) : null;
  const rows = openInvoices(c, plan.clientId)
    .map((i) => ({ i, late: daysBetween(i.dueOn, today) }))
    .filter((r) => !onlyLate || r.late > 0)
    .sort((a, b) => (onlyLate ? b.late - a.late : a.i.dueOn.localeCompare(b.i.dueOn)) || a.i.number.localeCompare(b.i.number));
  const tool = onlyLate ? "overdue" : "owed";
  const title = onlyLate ? (who ? `${who}: overdue invoices` : "Overdue invoices") : who ? `What ${who} owes` : "What clients owe";
  const seeAlso = { label: "Open invoices", href: "/invoices" };
  if (!rows.length) {
    return { tool, title, headline: onlyLate ? `Nothing is overdue${who ? ` from ${who}` : ""}.` : who ? `${who} owes nothing right now.` : "No client owes anything right now.", sub: null, lines: [], more: null, notes: [], seeAlso };
  }
  const totals = byCurrency(rows.map((r) => ({ currency: r.i.currency, amount: r.i.balance })));
  let pkrTotal = dec(0);
  const unpriced = new Set<string>();
  for (const r of rows) {
    const rate = r.i.currency === "PKR" ? "1" : refRate(r.i.currency, today);
    if (rate == null) unpriced.add(r.i.currency);
    else pkrTotal = pkrTotal.plus(dec(r.i.balance).times(rate));
  }
  const oldest = rows.reduce((m, r) => Math.max(m, r.late), 0);
  const lines = rows.map(
    (r): AskLine => ({
      label: r.i.number,
      detail: `${who ? "" : `${c.clientName(r.i.clientId)} · `}due ${shortDay(r.i.dueOn)}${r.late > 0 ? ` · ${plural(r.late, "day")} late` : r.late === 0 ? " · due today" : ""}${r.i.status === "part_paid" ? " · part paid" : ""}`,
      value: c.money(r.i.balance, r.i.currency),
      href: `/invoices/${r.i.id}`,
      tone: r.late > 0 ? "bad" : undefined,
    }),
  );
  const onlyPkr = totals.size === 1 && totals.has("PKR");
  return {
    tool,
    title,
    headline: andList([...totals].map(([ccy, v]) => c.money(v, ccy))),
    sub: `${plural(rows.length, onlyLate ? "overdue invoice" : "open invoice")}${onlyLate ? `, the oldest ${plural(oldest, "day")} late` : ""}${!onlyPkr && pkrTotal.gt(0) ? `; about ${c.pkr(pkrTotal)} at today's reference rates` : ""}.`,
    ...cut(lines, "See them all", "/invoices"),
    notes: [
      "Each balance is the invoice less the payments matched to it and any credit notes.",
      ...(onlyLate ? ["Days late are calendar days after the due date."] : []),
      ...(unpriced.size ? [`No reference rate for ${andList([...unpriced])}, so ${unpriced.size === 1 ? "it is" : "they are"} left out of the PKR figure.`] : []),
    ],
    seeAlso,
  };
}

function received(c: Ctx, plan: AskPlan, period: Period): AskAnswer {
  const { b } = c;
  const who = plan.clientId ? c.clientName(plan.clientId) : null;
  const invoiceById = new Map(b.invoices.map((i) => [i.id, i]));
  const matchesOf = new Map<string, Array<{ number: string; clientId: string }>>();
  for (const m of b.matches) {
    const i = invoiceById.get(m.invoiceId);
    if (i) matchesOf.set(m.transactionId, [...(matchesOf.get(m.transactionId) ?? []), { number: i.number, clientId: i.clientId }]);
  }
  const txs = b.transactions
    .filter((t) => isMoneyIn(t) && t.valueDate >= period.from && t.valueDate <= period.to)
    .filter((t) => !plan.clientId || ((matchesOf.get(t.id) ?? []).length > 0 && (matchesOf.get(t.id) ?? []).every((x) => x.clientId === plan.clientId)))
    .sort((a, b) => b.valueDate.localeCompare(a.valueDate) || Number(b.amount) - Number(a.amount));
  const label = periodLabel(period, c.w.today, c.w.ws.fiscalYearStartMonth);
  const title = `${who ? `Received from ${who}` : "Money received"}, ${label}`;
  const month = period.from.slice(0, 7) === period.to.slice(0, 7) ? period.from.slice(0, 7) : null;
  const listHref = month ? `/payments?month=${month}` : "/payments";
  if (!txs.length) return { tool: "received", title, headline: `Nothing received${who ? ` from ${who}` : ""} in ${label}.`, sub: null, lines: [], more: null, notes: [], seeAlso: { label: "Payments", href: listHref } };
  let pkrTotal = dec(0);
  let unpriced = false;
  for (const t of txs) {
    const v = t.pkrAmount ?? (t.currency === "PKR" ? t.amount : null);
    const rate = v == null ? c.w.refRate(t.currency, t.valueDate) : null;
    if (v != null) pkrTotal = pkrTotal.plus(v);
    else if (rate != null) pkrTotal = pkrTotal.plus(dec(t.amount).times(rate));
    else unpriced = true;
  }
  const totals = byCurrency(txs.map((t) => ({ currency: t.currency, amount: t.amount })));
  const unmatched = txs.filter((t) => t.matchStatus !== "matched").length;
  const lines = txs.map((t): AskLine => {
    const paid = matchesOf.get(t.id) ?? [];
    const from = paid[0] ? c.clientName(paid[0].clientId) : (t.payerName ?? "Unknown payer");
    return {
      label: `${shortDay(t.valueDate)} · ${from}`,
      detail: paid.length ? `Paid ${andList(paid.map((p) => p.number))}` : "Not matched to an invoice yet",
      value: c.money(t.amount, t.currency),
      href: `/payments/${t.id}`,
      tone: paid.length ? undefined : "warn",
    };
  });
  const onlyPkr = totals.size === 1 && totals.has("PKR");
  return {
    tool: "received",
    title,
    headline: andList([...totals].map(([ccy, v]) => c.money(v, ccy))),
    sub: `${plural(txs.length, "payment")}${!onlyPkr && pkrTotal.gt(0) ? `, worth about ${c.pkr(pkrTotal)} as credited or at the reference rate of each day` : ""}${unmatched ? `; ${unmatched} not matched to an invoice yet` : ""}.`,
    ...cut(lines, "See them all", listHref),
    notes: ["Transfers between your own accounts (such as Payoneer withdrawals) are left out, so nothing is counted twice.", ...(unpriced ? ["Some payments have no reference rate for their day, so they're left out of the PKR figure."] : [])],
    seeAlso: { label: "Payments", href: listHref },
  };
}

function proceeds(c: Ctx, period: Period): AskAnswer {
  const { b, w } = c;
  const accountKind = new Map(b.accounts.map((a) => [a.id, a.kind]));
  const months = new Map<string, { pkr: Decimal; credits: number; opening: Decimal }>();
  for (let [y, m] = period.from.split("-").map(Number) as [number, number]; iso(y, m, 1) <= period.to; [y, m] = shiftMonths(y, m, 1)) months.set(`${y}-${pad(m)}`, { pkr: dec(0), credits: 0, opening: dec(0) });
  let unpriced = 0;
  for (const t of b.transactions) {
    if (t.kind !== "credit" || t.matchStatus === "duplicate" || t.valueDate < period.from || t.valueDate > period.to || !BANK_ACCOUNT_KINDS.has(accountKind.get(t.receivingAccountId ?? "") ?? "")) continue;
    const v = t.pkrAmount ?? (t.currency === "PKR" ? t.amount : null);
    const rate = v == null ? w.refRate(t.currency, t.valueDate) : null;
    if (v == null && rate == null) {
      unpriced++;
      continue;
    }
    const row = months.get(t.valueDate.slice(0, 7));
    if (!row) continue;
    row.pkr = row.pkr.plus(v ?? dec(t.amount).times(rate!));
    row.credits++;
  }
  // Opening balances imported for months before the records began count the same way (this tax year's).
  for (const o of taxYearOpenings(b, w)) {
    const row = months.get(o.month);
    if (!row || !o.banked || !o.pkr) continue;
    row.pkr = row.pkr.plus(o.pkr);
    row.opening = row.opening.plus(o.pkr);
  }
  const total = [...months.values()].reduce((s, r) => s.plus(r.pkr), dec(0));
  const label = periodLabel(period, w.today, w.ws.fiscalYearStartMonth);
  const lines = [...months].map(
    ([m, r]): AskLine => ({
      label: `${MONTH_NAMES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`,
      detail: r.credits || r.opening.gt(0) ? `${plural(r.credits, "credit")}${r.opening.gt(0) ? ` + ${c.pkr(r.opening)} imported opening balance` : ""}` : "Nothing credited",
      value: c.pkr(r.pkr),
      href: `/payments?month=${m}`,
    }),
  );
  return {
    tool: "proceeds",
    title: `Export proceeds, ${label}`,
    headline: c.pkr(total),
    sub: `credited to your Pakistani bank accounts over ${plural(months.size, "month")}.`,
    lines,
    more: null,
    notes: [
      "Proceeds are credits into your PKR account and ESFCA, in PKR as credited, or at the reference rate of the day while they stay in foreign currency. Wallet money counts when it is withdrawn to the bank.",
      ...(unpriced ? [`${plural(unpriced, "credit")} had no reference rate for the day and ${unpriced === 1 ? "is" : "are"} left out.`] : []),
    ],
    seeAlso: { label: "Tax year", href: "/export" },
  };
}

function bankingShare(c: Ctx): AskAnswer {
  const { w } = c;
  const s = flagSnapshot(c.b, w).bankingShare;
  const year = taxYearOf(w.today, w.ws.fiscalYearStartMonth);
  const min = w.rules["banking_share.min_pct"];
  const warn = w.rules["banking_share.warn_pct"];
  const title = `Banking-channel share, tax year ${year.label} so far`;
  if (!s || s.denominatorUsd === "0.00") return { tool: "banking_share", title, headline: "No export proceeds yet this tax year.", sub: null, lines: [], more: null, notes: [], seeAlso: { label: "The working", href: "/export#share" } };
  const pct = dec(s.sharePct);
  const usd = (x: string) => c.money(x, "USD");
  return {
    tool: "banking_share",
    title,
    headline: `${s.sharePct}%`,
    sub: `of export proceeds this tax year came through Pakistani banks. The minimum is ${min}%; Aerion warns below ${warn}%.`,
    lines: [
      { label: "Received straight into Pakistani banks", value: usd(s.directBankUsd) },
      { label: "Received into wallets such as Payoneer", value: usd(s.walletReceivedUsd) },
      { label: "Withdrawn from wallets to your bank", detail: "Counts as banked", value: usd(s.walletWithdrawnUsd) },
      { label: "Spent from wallets", detail: "Never reached a Pakistani bank", value: usd(s.walletSpentUsd), tone: dec(s.walletSpentUsd).gt(0) ? "warn" : undefined },
      { label: "Still held in wallets", detail: "Counts once withdrawn", value: usd(s.walletHeldUsd) },
      { label: "Share through banks", value: `${s.sharePct}%`, tone: pct.lt(min) ? "bad" : pct.lt(warn) ? "warn" : "good" },
    ],
    more: null,
    notes: ["Measured in US dollars at the reference rate of each day, oldest wallet money withdrawn first.", "The 80% rule and how it is measured are unverified: confirm with your adviser."],
    seeAlso: { label: "The working", href: "/export#share" },
  };
}

const PAPER: Record<string, string> = { eprc: "ePRC", wht_certificate: "Withholding certificate" };

function missingPaperwork(c: Ctx, plan: AskPlan): AskAnswer {
  const { b, w } = c;
  const who = plan.clientId ? c.clientName(plan.clientId) : null;
  const txById = new Map(b.transactions.map((t) => [t.id, t]));
  const invoiceById = new Map(b.invoices.map((i) => [i.id, i]));
  const clientsOf = new Map<string, string[]>();
  for (const m of b.matches) {
    const i = invoiceById.get(m.invoiceId);
    if (i) clientsOf.set(m.transactionId, [...(clientsOf.get(m.transactionId) ?? []), i.clientId]);
  }
  const items = b.compliance
    .map((ci) => ({ ci, status: eprcStatus(ci, w.rules), t: txById.get(ci.transactionId) }))
    .filter((x) => x.status !== "on_file" && x.t && (!plan.clientId || (clientsOf.get(x.ci.transactionId) ?? []).includes(plan.clientId)))
    .sort((a, b) => a.t!.valueDate.localeCompare(b.t!.valueDate));
  const title = who ? `Paperwork still missing for ${who}'s payments` : "ePRCs and certificates still missing";
  const seeAlso = { label: "Tax-year file", href: "/export" };
  if (!items.length) return { tool: "missing_paperwork", title, headline: "Everything is on file.", sub: who ? `Every ePRC and withholding certificate for ${who}'s payments is on file.` : "Every ePRC and withholding certificate Aerion expects is on file.", lines: [], more: null, notes: [], seeAlso };
  const due = items.filter((x) => !x.ci.dueOn || x.ci.dueOn <= w.today);
  const lines = items.map((x): AskLine => {
    const t = x.t!;
    const waiting = x.ci.dueOn && x.ci.dueOn > w.today;
    const state = x.status === "wrong_code" ? `Issued with code ${x.ci.purposeCodeOnDocument ?? "?"}, not an IT code` : x.status === "requested" ? "Requested from the bank" : waiting ? `Not due from the bank until ${shortDay(x.ci.dueOn!)}` : `Missing for ${plural(daysBetween(t.valueDate, w.today), "day")}`;
    const payer = (clientsOf.get(t.id) ?? [])[0];
    return {
      label: `${PAPER[x.ci.kind] ?? x.ci.kind} · ${shortDay(t.valueDate)}`,
      detail: `${payer ? c.clientName(payer) : (t.payerName ?? "Unknown payer")} · ${state}`,
      value: c.money(t.amount, t.currency),
      href: `/payments/${t.id}`,
      tone: x.status === "wrong_code" ? "bad" : waiting || x.status === "requested" ? undefined : "warn",
    };
  });
  return {
    tool: "missing_paperwork",
    title,
    headline: plural(items.length, "document"),
    sub: `${due.length} past the bank's usual wait${items.length - due.length ? `, ${items.length - due.length} not due yet` : ""}.`,
    ...cut(lines, "See the tax year", "/export"),
    notes: ["Banks issue an ePRC for each export credit; your income tax return relies on them. Waits come from the Rules page."],
    seeAlso,
  };
}

function cost(c: Ctx, plan: AskPlan): AskAnswer {
  const d = dashboard(c.b, c.w);
  const who = plan.clientId ? c.clientName(plan.clientId) : null;
  const line = who ? (d.clients.find((x) => x.clientId === plan.clientId)?.cost ?? null) : d.cost.total;
  const title = `What getting paid cost${who ? ` with ${who}` : ""}, tax year ${d.year.label} so far`;
  const seeAlso = { label: "Financial overview", href: "/dashboard" };
  if (!line || line.payments === 0) return { tool: "cost", title, headline: `No payments${who ? ` from ${who}` : ""} this tax year yet.`, sub: null, lines: [], more: null, notes: [], seeAlso };
  const lines: AskLine[] = [
    { group: "Where it went", label: "Bank and intermediary fees", value: c.pkr(line.feesPkr) },
    { group: "Where it went", label: "Converting below the reference rate", detail: line.estimated ? "Partly estimated from wallet withdrawals" : undefined, value: c.pkr(line.conversionPkr) },
  ];
  if (!who) {
    for (const r of d.cost.byRoute) lines.push({ group: "By route", label: r.label, detail: `${plural(r.payments, "payment")} · ${c.pkr(r.costPkr)}`, value: r.pct == null ? "—" : `${r.pct}%` });
    const clients = d.clients.filter((x) => x.cost && x.cost.payments > 0).sort((a, b) => Number(b.cost!.pct ?? 0) - Number(a.cost!.pct ?? 0));
    for (const x of clients.slice(0, 5)) lines.push({ group: "Costliest clients to get paid by", label: x.name, detail: `${plural(x.cost!.payments, "payment")} · ${c.pkr(x.cost!.costPkr)}`, value: x.cost!.pct == null ? "—" : `${x.cost!.pct}%`, href: `/clients/${x.clientId}` });
  }
  return {
    tool: "cost",
    title,
    headline: c.pkr(line.costPkr),
    sub: `${line.pct ?? "0.00"}% of the ${c.pkr(line.valuePkr)} that ${plural(line.payments, "payment")} settled.`,
    lines,
    more: null,
    notes: ["Fees are what banks took off the payments. Conversion is the PKR lost against the reference rate of the day; for Payoneer it is estimated from what the wallet's withdrawals actually paid out."],
    seeAlso,
  };
}

function daysToPay(c: Ctx, plan: AskPlan): AskAnswer {
  const d = dashboard(c.b, c.w);
  const seeAlso = { label: "Financial overview", href: "/dashboard" };
  const fmt = (n: number | null) => (n == null ? "—" : plural(n, "day"));
  const lateText = (n: number | null) => (n == null ? "" : n > 0 ? `${plural(n, "day")} after the due date` : n < 0 ? `${plural(-n, "day")} before the due date` : "on the due date");
  if (plan.clientId) {
    const who = c.clientName(plan.clientId);
    const x = d.clients.find((y) => y.clientId === plan.clientId);
    const title = `How long ${who} takes to pay, tax year ${d.year.label} so far`;
    if (!x || !x.paidInvoices) return { tool: "days_to_pay", title, headline: `No invoices from ${who} were paid this tax year.`, sub: null, lines: [], more: null, notes: [], seeAlso };
    return {
      tool: "days_to_pay",
      title,
      headline: fmt(x.medianDaysToPay),
      sub: `from invoice to payment, the median over ${plural(x.paidInvoices, "paid invoice")}: ${lateText(x.medianDaysLate)}. Their terms are ${x.termsDays} days.`,
      lines: [],
      more: null,
      notes: ["An invoice counts once it is paid in full, on the day of its last payment."],
      seeAlso: { label: who, href: `/clients/${plan.clientId}` },
    };
  }
  const title = `How long clients take to pay, tax year ${d.year.label} so far`;
  if (!d.daysToPay.invoices) return { tool: "days_to_pay", title, headline: "No invoices were paid this tax year yet.", sub: null, lines: [], more: null, notes: [], seeAlso };
  const lines = d.clients
    .filter((x) => x.paidInvoices > 0)
    .sort((a, b) => (b.medianDaysLate ?? -999) - (a.medianDaysLate ?? -999) || a.name.localeCompare(b.name))
    .map(
      (x): AskLine => ({
        label: x.name,
        detail: `terms ${x.termsDays} days · ${plural(x.paidInvoices, "paid invoice")}${x.medianDaysLate != null ? ` · ${lateText(x.medianDaysLate)}` : ""}`,
        value: fmt(x.medianDaysToPay),
        href: `/clients/${x.clientId}`,
        tone: (x.medianDaysLate ?? 0) > 0 ? "warn" : undefined,
      }),
    );
  return {
    tool: "days_to_pay",
    title,
    headline: fmt(d.daysToPay.medianDays),
    sub: `from invoice to payment, the median over ${plural(d.daysToPay.invoices, "paid invoice")}: ${lateText(d.daysToPay.medianLate)}.`,
    ...cut(lines, "See every client", "/clients"),
    notes: ["Medians, so one very late invoice doesn't hide how a client usually pays. An invoice counts once it is paid in full."],
    seeAlso,
  };
}

function invoiceStory(c: Ctx, plan: AskPlan): AskAnswer {
  const { b, w } = c;
  const i = b.invoices.find((x) => x.id === plan.invoiceId)!;
  const who = c.clientName(i.clientId);
  const balance = dec(i.balance);
  const late = daysBetween(i.dueOn, w.today);
  const open = (i.status === "sent" || i.status === "part_paid") && balance.gt(0);
  const headline = i.status === "void" ? "Void" : i.status === "draft" ? "Not sent yet" : !balance.gt(0) ? "Paid in full" : `${c.money(i.balance, i.currency)} still owed`;
  const sub = open ? (late > 0 ? `${plural(late, "day")} past the due date of ${longDay(i.dueOn)}.` : late === 0 ? "Due today." : `Due ${longDay(i.dueOn)}, in ${plural(-late, "day")}.`) : null;
  const txById = new Map(b.transactions.map((t) => [t.id, t]));
  const accountName = new Map(b.accounts.map((a) => [a.id, a.label]));
  const lines: AskLine[] = [
    { group: "The invoice", label: "Amount", detail: `issued ${shortDay(i.issuedOn)}, due ${shortDay(i.dueOn)}`, value: c.money(i.amount, i.currency) },
    ...(dec(i.paidBeforeImport).gt(0) ? [{ group: "The invoice", label: "Paid before your records began", value: c.money(i.paidBeforeImport, i.currency) }] : []),
    { group: "The invoice", label: "Paid through matched payments", value: c.money(i.appliedTotal, i.currency) },
    { group: "The invoice", label: "Still owed", value: c.money(balance.gt(0) ? i.balance : "0", i.currency), tone: open && late > 0 ? "bad" : undefined },
  ];
  for (const m of b.matches.filter((x) => x.invoiceId === i.id)) {
    const t = txById.get(m.transactionId);
    if (!t) continue;
    const into = accountName.get(t.receivingAccountId ?? "");
    lines.push({
      group: "Payments",
      label: `${shortDay(t.valueDate)}${into ? ` · into ${into}` : ""}`,
      detail: `${c.money(t.amount, t.currency)} received${t.payerName ? ` from ${t.payerName}` : ""}${dec(m.feeAmount).gt(0) ? `; ${c.money(m.feeAmount, i.currency)} in bank fees` : ""}`,
      value: c.money(m.appliedAmount, i.currency),
      href: `/payments/${t.id}`,
    });
  }
  const named = new RegExp(`(^|[^A-Za-z0-9])${i.number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`);
  for (const f of c.flags.filter((x) => x.subjectId === i.id || named.test(x.summary))) {
    lines.push({ group: "Open flags", label: f.summary, value: f.severity === "high" ? "High" : f.severity === "medium" ? "Medium" : "Low", href: `/flags/${f.id}`, tone: f.severity === "high" ? "bad" : "warn" });
  }
  return { tool: "invoice", title: `${i.number} · ${who}`, headline, sub, lines, more: null, notes: [], seeAlso: { label: `Open ${i.number}`, href: `/invoices/${i.id}` } };
}

/** The answer to a checked plan, from the books as they are now. */
export function answerPlan(plan: AskPlan, b: Books, w: WorkspaceContext, flags: Ctx["flags"]): AskAnswer {
  const grouping: Grouping = w.ws.numberGrouping;
  const names = new Map(b.clients.map((x) => [x.id, x.name]));
  const c: Ctx = {
    b,
    w,
    flags,
    money: (x, ccy) => formatMoney(x, ccy, { grouping }),
    pkr: (x) => formatMoney(fixed2(dec(x)), "PKR", { grouping }),
    clientName: (id) => names.get(id) ?? "A former client",
  };
  const year = taxYearOf(w.today, w.ws.fiscalYearStartMonth);
  const period: Period = { from: plan.from ?? year.start, to: plan.to ?? w.today };
  switch (plan.tool) {
    case "owed":
      return owed(c, plan, false);
    case "overdue":
      return owed(c, plan, true);
    case "received":
      return received(c, plan, period);
    case "proceeds":
      return proceeds(c, period);
    case "banking_share":
      return bankingShare(c);
    case "missing_paperwork":
      return missingPaperwork(c, plan);
    case "cost":
      return cost(c, plan);
    case "days_to_pay":
      return daysToPay(c, plan);
    case "invoice":
      return invoiceStory(c, plan);
  }
}

export function askScope(b: Books, w: WorkspaceContext): AskScope {
  const aliases = new Map<string, string[]>();
  for (const a of b.aliases) aliases.set(a.clientId, [...(aliases.get(a.clientId) ?? []), a.alias]);
  return {
    today: w.today,
    taxYear: taxYearOf(w.today, w.ws.fiscalYearStartMonth),
    clients: [...b.clients].sort((x, y) => x.name.localeCompare(y.name)).map((x) => ({ id: x.id, name: x.name, kind: x.kind, aliases: aliases.get(x.id) ?? [] })),
    invoices: b.invoices.map((i) => ({ id: i.id, number: i.number })),
  };
}

/**
 * Answers a question about the books. The rules try first; a model only when they find no
 * query, when one is given, and while the workspace's daily allowance lasts. Every model call
 * is recorded with its tokens and cost, like the document readers' calls.
 */
export async function askBooks(db: Db, w: WorkspaceContext, question: string, planner: AskPlanner | null = null, books?: Books): Promise<AskResult> {
  const q = question.replace(/\s+/g, " ").trim();
  if (!q) return { ok: false, question: q, reason: "empty", modelNote: null };
  if (q.length > ASK_QUESTION_MAX) return { ok: false, question: q.slice(0, ASK_QUESTION_MAX), reason: "too_long", modelNote: null };
  const b = books ?? (await loadBooks(db, w));
  const scope = askScope(b, w);
  let plan = planByRules(q, scope);
  let chosenBy: ChosenBy = { by: "rules" };
  let modelNote: string | null = null;
  if (!plan && planner) {
    const since = new Date(Date.now() - 86_400_000);
    const [used] = await db
      .select({ n: count() })
      .from(modelCall)
      .where(and(eq(modelCall.workspaceId, w.ws.id), eq(modelCall.purpose, "assistant"), gte(modelCall.createdAt, since)));
    if (Number(used?.n ?? 0) >= ASK_MODEL_DAILY_LIMIT) modelNote = "This workspace has used today's AI questions, so only the built-in rules read this one.";
    else {
      let raw: Record<string, unknown> | null = null;
      try {
        const res = await planner.plan(q, scope);
        raw = res.raw;
        if (res.calls.length) await db.insert(modelCall).values(res.calls.map((x) => ({ ...x, workspaceId: w.ws.id })));
      } catch {
        modelNote = `${planner.model} couldn't be reached, so only the built-in rules read this question.`;
      }
      if (raw) {
        const checked = planFromModel(raw, scope);
        if ("plan" in checked) {
          plan = checked.plan;
          chosenBy = { by: "model", model: planner.model };
        } else if ("problem" in checked) modelNote = `${planner.model} read the question, but its choice was refused: ${checked.problem}.`;
        else modelNote = `${planner.model} read the question and found nothing in the books that answers it.`;
      } else if (!modelNote) modelNote = `${planner.model} didn't give a usable reply.`;
    }
  }
  if (!plan) return { ok: false, question: q, reason: "not_understood", modelNote };
  const flags =
    plan.tool === "invoice"
      ? await db
          .select({ id: flag.id, kind: flag.kind, severity: flag.severity, summary: flag.summary, subjectType: flag.subjectType, subjectId: flag.subjectId })
          .from(flag)
          .where(and(eq(flag.workspaceId, w.ws.id), inArray(flag.status, ["open", "actioned"])))
      : [];
  return { ok: true, question: q, plan, chosenBy, answer: answerPlan(plan, b, w, flags), modelNote };
}

/** Questions the rules answer, worded for this workspace's own clients. */
export function exampleQuestions(scope: AskScope): string[] {
  const named = scope.clients.find((c) => c.kind !== "marketplace");
  const short = named ? (clientKeys(named).sort((a, b) => a.length - b.length)[0] ?? named.name) : null;
  const title = (s: string) => s.replace(/\b[a-z]/g, (x) => x.toUpperCase());
  const lastMonth = shiftMonths(Number(scope.today.slice(0, 4)), Number(scope.today.slice(5, 7)), -1);
  return [
    "What's overdue?",
    short ? `What does ${title(short)} owe?` : "What do clients owe?",
    `How much did we receive in ${MONTH_NAMES[lastMonth[1] - 1]}?`,
    "Which ePRCs are still missing?",
    "What's our banking-channel share?",
    "What did fees and conversion cost us this year?",
    "Who pays late?",
    ...(scope.invoices[0] ? [`Where is ${[...scope.invoices].sort((a, b) => b.number.localeCompare(a.number))[0]!.number}?`] : []),
  ];
}
