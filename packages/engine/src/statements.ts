import { addDays, Decimal, dec, formatMoney, normalizeRef, weekday, type IsoDate } from "@ebo/core";
import { receivingAccount, transaction, type Db, type document } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { workspaceToday } from "./invoicing";
import type { Workspace } from "./context";
import { STATEMENT_HEADER } from "./readers/offline";
import { csvRecords, parseAmount, parseDate } from "./readers/text";

/**
 * Bank statements (W11 reading, W25 close). A statement CSV is checked line by line (each
 * running balance must follow from the one before), then each credit on it is tied to the
 * credit already on record from the bank's advice. A credit the bank shows that we never
 * had an advice for is added, so the run can match it. Debits aren't imported (payables are
 * out of scope); they only count toward the balances.
 */

type Account = typeof receivingAccount.$inferSelect;
type Doc = typeof document.$inferSelect;
type Tx = typeof transaction.$inferSelect;

export const STATEMENT_ACCOUNT_KINDS = new Set(["pkr_account", "esfca"]);

export interface StatementRow {
  /** Line in the file; the header is line 1. */
  line: number;
  postedOn: IsoDate;
  valueDate: IsoDate;
  narration: string;
  reference: string | null;
  debit: Decimal;
  credit: Decimal;
  balance: Decimal;
}

export interface ParsedStatement {
  currency: string;
  rows: StatementRow[];
  from: IsoDate;
  to: IsoDate;
  opening: string;
  closing: string;
  /** The first line whose running balance doesn't follow from the line before. */
  broken: { line: number; on: IsoDate; expected: string; stated: string } | null;
  /** The last balance in each calendar month, by posting date. */
  monthEnds: Record<string, { on: IsoDate; balance: string }>;
}

/** What a read statement leaves in its document's outcome; the close checklist reads it back. */
export interface StatementOutcome {
  action: "statement";
  accountId: string;
  account: string;
  currency: string;
  from: IsoDate;
  to: IsoDate;
  rows: number;
  opening: string;
  closing: string;
  monthEnds: ParsedStatement["monthEnds"];
  /** Credits on the statement, as transaction ids: the ones already on record and the ones it added. */
  onStatement: string[];
  linked: number;
  created: number;
  /** Credits on record for the account, inside the statement's dates, that the statement doesn't show. */
  notOnStatement: Array<{ id: string; valueDate: IsoDate; amount: string }>;
}

export function parseStatement(text: string): { ok: true; statement: ParsedStatement } | { ok: false; problem: string } {
  const { header, records } = csvRecords(text);
  if (header.join(",") !== STATEMENT_HEADER) return { ok: false, problem: "The columns aren't the bank statement layout." };
  const rows: StatementRow[] = [];
  const currencies = new Set<string>();
  for (const [i, r] of records.entries()) {
    const line = i + 2;
    if (Object.values(r).every((v) => !v)) continue;
    const valueDate = parseDate(r.value_date);
    const postedOn = parseDate(r.txn_date) ?? valueDate;
    if (!valueDate || !postedOn) return { ok: false, problem: `Line ${line} has no date that can be read.` };
    const balance = parseAmount(r.balance);
    const debit = r.debit ? parseAmount(r.debit) : "0";
    const credit = r.credit ? parseAmount(r.credit) : "0";
    if (balance == null || debit == null || credit == null) return { ok: false, problem: `Line ${line} has an amount that can't be read.` };
    if (dec(debit).abs().gt(0) && dec(credit).abs().gt(0)) return { ok: false, problem: `Line ${line} is both a debit and a credit.` };
    const currency = (r.currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, problem: `Line ${line} has no currency code.` };
    currencies.add(currency);
    rows.push({ line, postedOn, valueDate, narration: r.narration ?? "", reference: r.reference || null, debit: dec(debit).abs(), credit: dec(credit).abs(), balance: dec(balance) });
  }
  if (!rows.length) return { ok: false, problem: "The statement has no lines." };
  if (currencies.size > 1) return { ok: false, problem: `The statement mixes currencies (${[...currencies].sort().join(", ")}). Upload one statement per account.` };

  const first = rows[0]!;
  const opening = first.balance.minus(first.credit).plus(first.debit);
  let broken: ParsedStatement["broken"] = null;
  for (let i = 1; i < rows.length && !broken; i++) {
    const r = rows[i]!;
    const expected = rows[i - 1]!.balance.plus(r.credit).minus(r.debit);
    if (expected.minus(r.balance).abs().gt("0.005")) broken = { line: r.line, on: r.postedOn, expected: expected.toFixed(2), stated: r.balance.toFixed(2) };
  }
  const monthEnds: ParsedStatement["monthEnds"] = {};
  for (const r of rows) monthEnds[r.postedOn.slice(0, 7)] = { on: r.postedOn, balance: r.balance.toFixed(2) };
  const dates = rows.flatMap((r) => [r.postedOn, r.valueDate]).sort();
  return {
    ok: true,
    statement: { currency: [...currencies][0]!, rows, from: dates[0]!, to: dates.at(-1)!, opening: opening.toFixed(2), closing: rows.at(-1)!.balance.toFixed(2), broken, monthEnds },
  };
}

/** A credit's amount in the account's own currency: PKR as credited for a PKR account. */
export function amountInAccount(t: Pick<Tx, "amount" | "currency" | "pkrAmount">, accountCurrency: string): Decimal | null {
  if (accountCurrency === "PKR") return t.pkrAmount ? dec(t.pkrAmount) : t.currency === "PKR" ? dec(t.amount) : null;
  return t.currency === accountCurrency ? dec(t.amount) : null;
}

const mentions = (row: StatementRow, t: Tx) => {
  const hay = normalizeRef(`${row.narration} ${row.reference ?? ""}`);
  return [t.adviceNumber, t.reference, t.uetr].some((ref) => {
    const r = normalizeRef(ref);
    return r.length >= 6 && hay.includes(r);
  });
};

/** Ties each credit line to a credit on record (same account, value date and amount; a quoted reference breaks ties). */
function tieCredits(rows: StatementRow[], credits: Tx[], currency: string): { pairs: Map<StatementRow, Tx>; unmatched: StatementRow[] } {
  const used = new Set<string>();
  const pairs = new Map<StatementRow, Tx>();
  const unmatched: StatementRow[] = [];
  for (const row of rows.filter((r) => r.credit.gt(0))) {
    const candidates = credits.filter((t) => !used.has(t.id) && t.valueDate === row.valueDate && amountInAccount(t, currency)?.eq(row.credit));
    const pick = candidates.find((t) => mentions(row, t)) ?? candidates[0];
    if (pick) {
      used.add(pick.id);
      pairs.set(row, pick);
    } else unmatched.push(row);
  }
  return { pairs, unmatched };
}

/** "INWARD REMITTANCE NORTHWIND ANALYTICS INC PC 9186" -> "NORTHWIND ANALYTICS INC" */
function payerFrom(narration: string): string | null {
  const s = narration
    .replace(/\b(INWARD|REMITTANCE|IBFT|FT|FROM|CREDIT|CR|TRANSFER|FUNDS)\b/gi, " ")
    .replace(/\bPC\s*\d{4}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, 120) : null;
}

/**
 * Reads a statement into the books: picks the account (by currency, then by which account's
 * credits it shows), ties its credits to the ones on record, and adds the rest.
 * Returns `{ review }` instead when a person needs to look at it.
 */
export async function importStatement(db: Db, workspaceId: string, doc: Doc, text: string, accounts: Account[]): Promise<StatementOutcome | { review: string }> {
  const parsed = parseStatement(text);
  if (!parsed.ok) return { review: parsed.problem };
  const s = parsed.statement;
  if (s.broken) return { review: `The running balance doesn't add up on line ${s.broken.line} (${s.broken.on}): it should be ${formatMoney(s.broken.expected, s.currency)}, the statement says ${formatMoney(s.broken.stated, s.currency)}. Upload the bank's own statement.` };

  const banks = accounts.filter((a) => a.active && STATEMENT_ACCOUNT_KINDS.has(a.kind) && a.currency === s.currency);
  if (!banks.length) return { review: `None of this workspace's bank accounts is in ${s.currency}.` };
  const credits = await db.select().from(transaction).where(and(eq(transaction.workspaceId, workspaceId), eq(transaction.kind, "credit")));
  const forAccount = (a: Account) => credits.filter((t) => t.receivingAccountId === a.id && t.matchStatus !== "duplicate");
  const scored = banks.map((a) => ({ a, tied: tieCredits(s.rows, forAccount(a), s.currency).pairs.size })).sort((x, y) => y.tied - x.tied);
  if (scored.length > 1 && scored[0]!.tied === scored[1]!.tied) return { review: `Two ${s.currency} accounts could hold this statement (${scored.map((x) => x.a.label).join(", ")}). Upload it again with the account chosen.` };
  const acc = scored[0]!.a;
  const recorded = forAccount(acc);
  const { pairs, unmatched } = tieCredits(s.rows, recorded, s.currency);

  const onStatement = [...pairs.values()].map((t) => t.id);
  let created = 0;
  for (const row of unmatched) {
    const key = `statement:${acc.id}:${row.valueDate}:${row.credit.toFixed(2)}:${normalizeRef(row.reference ?? row.narration).slice(0, 40)}`;
    const [row0] = await db
      .insert(transaction)
      .values({
        workspaceId,
        kind: "credit",
        receivingAccountId: acc.id,
        valueDate: row.valueDate,
        amount: row.credit.toFixed(2),
        currency: s.currency,
        pkrAmount: s.currency === "PKR" ? row.credit.toFixed(2) : null,
        payerName: payerFrom(row.narration),
        reference: row.reference,
        purposeCode: /\bPC\s*(\d{4})\b/i.exec(row.narration)?.[1] ?? null,
        sourceDocumentId: doc.id,
        sourceLocator: { document: doc.originalName, row: row.line },
        dedupeKey: key,
        matchStatus: "pending",
      })
      .onConflictDoNothing({ target: [transaction.workspaceId, transaction.dedupeKey] })
      .returning({ id: transaction.id });
    if (row0) {
      created++;
      onStatement.push(row0.id);
    } else {
      const [again] = await db.select({ id: transaction.id }).from(transaction).where(and(eq(transaction.workspaceId, workspaceId), eq(transaction.dedupeKey, key)));
      if (again) onStatement.push(again.id);
    }
  }
  const shown = new Set(onStatement);
  const notOnStatement = recorded
    .filter((t) => !shown.has(t.id) && t.valueDate >= s.from && t.valueDate <= s.to)
    .map((t) => ({ id: t.id, valueDate: t.valueDate, amount: (amountInAccount(t, s.currency) ?? dec(t.amount)).toFixed(2) }));
  return { action: "statement", accountId: acc.id, account: acc.label, currency: s.currency, from: s.from, to: s.to, rows: s.rows.length, opening: s.opening, closing: s.closing, monthEnds: s.monthEnds, onStatement, linked: pairs.size, created, notOnStatement };
}

// ---------------------------------------------------------------------------
// Sample statements for the demo (SIMULATED)
// ---------------------------------------------------------------------------

const monthName = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
const lastDay = (m: string): IsoDate => addDays(`${addMonth(m)}-01`, -1);
function addMonth(m: string): string {
  const [y, mm] = m.split("-").map(Number) as [number, number];
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
}
/** A weekday on or after `d` (or on or before it, for month-end entries), as banks post them. */
const businessDay = (d: IsoDate, back = false) => {
  let x = d;
  while (weekday(x) >= 6) x = addDays(x, back ? -1 : 1);
  return x;
};
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Last month's statement for each bank account that received money, built from the books
 * so it agrees with them, with the month's usual debits (payroll, rent, bills) added. For
 * trying the statement upload and the month-end close. All of it SIMULATED.
 */
export async function sampleStatements(db: Db, ws: Workspace): Promise<Array<{ name: string; bytes: Uint8Array; month: string; account: string }>> {
  const today = workspaceToday(ws);
  const month = (() => {
    const [y, m] = today.split("-").map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  })();
  const start = `${month}-01`;
  const end = lastDay(month);
  const accounts = (await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, ws.id))).filter((a) => a.active && STATEMENT_ACCOUNT_KINDS.has(a.kind));
  const credits = await db.select().from(transaction).where(and(eq(transaction.workspaceId, ws.id), eq(transaction.kind, "credit")));
  const out: Array<{ name: string; bytes: Uint8Array; month: string; account: string }> = [];
  const label = monthName(month).toUpperCase();
  for (const a of accounts) {
    const mine = credits
      .filter((t) => t.receivingAccountId === a.id && t.matchStatus !== "duplicate" && t.valueDate >= start && t.valueDate <= end && amountInAccount(t, a.currency))
      .sort((x, y) => x.valueDate.localeCompare(y.valueDate) || x.createdAt.getTime() - y.createdAt.getTime());
    if (!mine.length) continue;
    type Line = { on: IsoDate; narration: string; reference: string; debit: Decimal; credit: Decimal };
    const lines: Line[] = mine.map((t) => ({
      on: t.valueDate,
      narration: /payoneer/i.test(t.payerName ?? "") ? `IBFT ${t.payerName}` : `INWARD REMITTANCE ${t.payerName ?? "UNKNOWN REMITTER"}${t.purposeCode ? ` PC ${t.purposeCode}` : ""}`,
      reference: t.adviceNumber ?? t.reference ?? "",
      debit: dec(0),
      credit: amountInAccount(t, a.currency)!,
    }));
    const debit = (on: IsoDate, narration: string, amount: string) => lines.push({ on: businessDay(on, on === end), narration, reference: "", debit: dec(amount), credit: dec(0) });
    if (a.currency === "PKR") {
      debit(start, `SALARY TRANSFER ${label} PAYROLL`, "2350000.00");
      debit(`${month}-05`, `OFFICE RENT ${label}`, "380000.00");
      debit(`${month}-12`, "ELECTRICITY BILL LESCO", "46210.00");
      debit(`${month}-15`, "INTERNET PTCL FLASH FIBER", "18500.00");
      debit(end, "SMS ALERT CHARGES", "250.00");
    } else {
      debit(end, "ACCOUNT MAINTENANCE FEE", "10.00");
    }
    lines.sort((x, y) => x.on.localeCompare(y.on) || Number(x.credit.isZero()) - Number(y.credit.isZero()));
    let balance = dec(a.currency === "PKR" ? "4750000.00" : "3200.00");
    const rows = [STATEMENT_HEADER];
    for (const l of [...lines, { on: lines.at(-1)!.on, narration: "SIMULATED STATEMENT FOR THE DEMO - NOT A BANK DOCUMENT", reference: "", debit: dec(0), credit: dec(0) }]) {
      balance = balance.plus(l.credit).minus(l.debit);
      rows.push([l.on, l.on, l.narration, l.reference, l.debit.isZero() ? "" : l.debit.toFixed(2), l.credit.isZero() ? "" : l.credit.toFixed(2), balance.toFixed(2), a.currency].map(csvCell).join(","));
    }
    const slug = a.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    out.push({ name: `SIMULATED-statement-${slug}-${month}.csv`, bytes: new TextEncoder().encode(rows.join("\r\n") + "\r\n"), month, account: a.label });
  }
  return out;
}
