import { Decimal, dec, eprcStatus, taxYearOf, type IsoDate } from "@ebo/core";
import { complianceItem, invoice, match, receivingAccount, transaction, transferLink, type Db } from "@ebo/db";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { flagSnapshot, loadBooks } from "./books";
import type { WorkspaceContext } from "./context";

export interface CreditLine {
  id: string;
  valueDate: string;
  account: string;
  payer: string | null;
  reference: string | null;
  currency: string;
  amount: string;
  pkrAmount: string | null;
  purposeCode: string | null;
  /** Money we moved from our own wallet (Payoneer) rather than a client payment. */
  ownTransfer: boolean;
  invoices: string[];
  eprc: string;
  whtCertificate: string;
}

/**
 * The context as of the end of a tax year: today for the current year, its last day for an
 * earlier one. Everything worked out "for the tax year so far" then covers that year.
 */
export function contextForYear(w: WorkspaceContext, yearStart?: IsoDate): WorkspaceContext {
  if (!yearStart) return w;
  const year = taxYearOf(yearStart, w.ws.fiscalYearStartMonth);
  return year.end < w.today ? { ...w, today: year.end } : w;
}

/**
 * The tax-year file: every export credit into a Pakistani bank with its paperwork, plus the
 * banking-channel share working. Built from the same books and rules as the weekly run.
 * `yearStart` picks an earlier tax year (any date in it works); by default, the current one.
 */
export async function taxYearFile(db: Db, w0: WorkspaceContext, yearStart?: IsoDate) {
  const w = contextForYear(w0, yearStart);
  const ws = w.ws;
  const books = await loadBooks(db, w);
  const snap = flagSnapshot(books, w);
  const year = taxYearOf(w.today, ws.fiscalYearStartMonth);

  const [credits, items, matches, links] = await Promise.all([
    db
      .select({ tx: transaction, account: receivingAccount.label })
      .from(transaction)
      .innerJoin(receivingAccount, eq(receivingAccount.id, transaction.receivingAccountId))
      .where(and(eq(transaction.workspaceId, ws.id), eq(transaction.kind, "credit"), inArray(receivingAccount.kind, ["pkr_account", "esfca"]), gte(transaction.valueDate, year.start), lte(transaction.valueDate, year.end)))
      .orderBy(asc(transaction.valueDate), asc(transaction.createdAt)),
    db.select().from(complianceItem).where(eq(complianceItem.workspaceId, ws.id)),
    db.select({ txId: match.transactionId, number: invoice.number }).from(match).innerJoin(invoice, eq(invoice.id, match.invoiceId)).where(eq(match.workspaceId, ws.id)),
    db.select({ to: transferLink.toTransactionId }).from(transferLink).where(eq(transferLink.workspaceId, ws.id)),
  ]);
  const itemOf = (txId: string, kind: "eprc" | "wht_certificate") => items.find((i) => i.transactionId === txId && i.kind === kind);
  const transfersIn = new Set(links.map((l) => l.to));
  const label = (s: string | undefined) => (s ? s.replace(/_/g, " ") : "not tracked");

  const lines: CreditLine[] = credits.map(({ tx, account }) => {
    const e = itemOf(tx.id, "eprc");
    const es = e ? eprcStatus(e, w.rules) : undefined;
    return {
      id: tx.id,
      valueDate: tx.valueDate,
      account,
      payer: tx.payerName,
      reference: tx.reference,
      currency: tx.currency,
      amount: tx.amount,
      pkrAmount: tx.pkrAmount,
      purposeCode: tx.purposeCode,
      ownTransfer: transfersIn.has(tx.id),
      invoices: matches.filter((m) => m.txId === tx.id).map((m) => m.number),
      eprc: es === "wrong_code" ? `wrong code ${e?.purposeCodeOnDocument ?? ""}`.trim() : label(es),
      whtCertificate: label(itemOf(tx.id, "wht_certificate")?.status),
    };
  });

  const proceeds = snap.taxYearProceedsPkr ? dec(snap.taxYearProceedsPkr) : null;
  const pseb = dec(w.rules["tax.rate.pseb_final"]);
  const standard = dec(w.rules["tax.rate.default_final"]);
  // Only for freelancers not yet registered with PSEB (same rule as the pseb_savings_estimate flag).
  const rupees = (x: Decimal) => x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(2);
  const estimate =
    proceeds && ws.kind === "freelancer" && !ws.psebRegNo
      ? { proceedsPkr: proceeds.toFixed(2), psebRatePct: pseb.toString(), standardRatePct: standard.toString(), withPseb: rupees(proceeds.times(pseb).div(100)), without: rupees(proceeds.times(standard).div(100)), saving: rupees(proceeds.times(standard.minus(pseb)).div(100)) }
      : null;

  return { year, today: w.today, share: snap.bankingShare ?? null, proceedsPkr: snap.taxYearProceedsPkr ?? null, lines, estimate, rules: w.rules, context: w, books };
}

export type TaxYearFile = Awaited<ReturnType<typeof taxYearFile>>;

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    // Quote when needed; a leading = + - @ is neutralised so spreadsheets don't run it as a formula.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Every export credit into a Pakistani bank, with its paperwork. */
export function creditsCsv(f: TaxYearFile): string {
  return toCsv([
    ["value_date", "account", "payer", "reference", "currency", "amount", "pkr_amount", "purpose_code", "own_transfer", "invoices", "eprc", "wht_certificate"],
    ...f.lines.map((l) => [l.valueDate, l.account, l.payer, l.reference, l.currency, l.amount, l.pkrAmount, l.purposeCode, l.ownTransfer ? "yes" : "no", l.invoices.join(" "), l.eprc, l.whtCertificate]),
  ]);
}

/** The banking-channel share working: what counts toward each side, at reference rates. */
export function shareCsv(f: TaxYearFile): string {
  return toCsv([["date", "kind", "currency", "amount", "usd_at_reference_rate", "counts_as", "note"], ...(f.share?.lines ?? []).map((l) => [l.date, l.kind, l.currency, l.amount, l.usd, l.counts, l.note])]);
}
