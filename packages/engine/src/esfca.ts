import { addDays, Decimal, dec, fixed2, taxYearOf, type IsoDate } from "@ebo/core";
import { closePeriod, document, receivingAccount, rule, transaction, transferLink, type Db } from "@ebo/db";
import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { loadBooks, taxYearCredits } from "./books";
import { audit, loadContext, workspaceClock, type Workspace, type WorkspaceContext } from "./context";
import { workspaceToday } from "./invoicing";
import { monthLabel, monthRange } from "./close";
import { parseAmount } from "./readers/text";
import type { StatementOutcome } from "./statements";

/**
 * ESFCA balances and conversions (main doc W14). A conversion is recorded here after the bank
 * has made it; the product never moves money. It's a `fx_conversion` row on the ESFCA.
 *
 * The rupees reach the PKR account as a credit on its statement, but they aren't export
 * proceeds: the money was already counted when it reached the ESFCA. So that statement line is
 * also kept as `fx_conversion`, never `credit`, and linked to the conversion. Everything that
 * adds up proceeds reads `credit` rows only.
 */

/** Days either side of a conversion's date in which a PKR statement line can be its rupees. */
const TIE_DAYS = 3;
/** A rate this far from the reference rate is almost certainly a typing mistake. */
const RATE_SANITY_PCT = 20;

export interface ConversionInput {
  accountId: string;
  on: string;
  amount: string;
  pkr: string;
  reference: string;
}

export type ConversionResult = { ok: true; id: string; rate: string; tiedToStatement: boolean } | { ok: false; problems: string[] };

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const positive = (s: string) => {
  const v = parseAmount(s);
  return v != null && dec(v).gt(0) ? dec(v) : null;
};
const closedMonth = async (db: Pick<Db, "select">, workspaceId: string, on: string) => {
  const [p] = await db.select({ status: closePeriod.status }).from(closePeriod).where(and(eq(closePeriod.workspaceId, workspaceId), eq(closePeriod.month, on.slice(0, 7))));
  return p?.status === "closed";
};

/** Whether a statement's PKR credit can be the rupees from this conversion. */
export const isConversionRupees = (conversion: { valueDate: string; pkrAmount: string | null }, valueDate: string, amount: Decimal) =>
  !!conversion.pkrAmount && dec(conversion.pkrAmount).eq(amount) && valueDate >= addDays(conversion.valueDate, -TIE_DAYS) && valueDate <= addDays(conversion.valueDate, TIE_DAYS);

export async function recordConversion(db: Db, ws: Workspace, input: ConversionInput, userId: string): Promise<ConversionResult> {
  const [acc] = await db
    .select()
    .from(receivingAccount)
    .where(and(eq(receivingAccount.workspaceId, ws.id), eq(receivingAccount.id, input.accountId), eq(receivingAccount.kind, "esfca")));
  if (!acc) return { ok: false, problems: ["Choose one of this workspace's ESFCA accounts."] };

  const problems: string[] = [];
  const today = workspaceToday(ws);
  const on = input.on.trim();
  if (!isDate(on)) problems.push("Enter the date the bank converted the money.");
  else if (on > today) problems.push("The date can't be in the future. Record a conversion once the bank has made it.");
  else if (await closedMonth(db, ws.id, on)) problems.push(`${monthLabel(on.slice(0, 7))} is closed. An owner has to reopen it first.`);
  const amount = positive(input.amount);
  if (!amount) problems.push(`Enter the ${acc.currency} amount converted.`);
  const pkr = positive(input.pkr);
  if (!pkr) problems.push("Enter the PKR amount the bank credited.");

  const w = await loadContext(db, ws.id);
  const rate = amount && pkr ? pkr.div(amount) : null;
  if (rate && isDate(on)) {
    const ref = w.refRate(acc.currency, on);
    if (ref && rate.minus(ref).abs().div(ref).times(100).gt(RATE_SANITY_PCT)) {
      problems.push(`That works out at ${rate.toFixed(2)} PKR per ${acc.currency}, but the reference rate was ${dec(ref).toFixed(2)}. Check both amounts.`);
    }
  }
  if (problems.length || !amount || !pkr || !rate) return { ok: false, problems };

  const at = workspaceClock(ws);
  const reference = input.reference.trim().slice(0, 120) || null;
  const done = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(transaction)
      .values({
        workspaceId: ws.id,
        kind: "fx_conversion",
        receivingAccountId: acc.id,
        valueDate: on,
        amount: amount.toFixed(2),
        currency: acc.currency,
        pkrAmount: pkr.toFixed(2),
        fxRateApplied: rate.toFixed(4),
        adviceNumber: reference,
        dedupeKey: `conversion:${acc.id}:${on}:${amount.toFixed(2)}:${pkr.toFixed(2)}`,
        matchStatus: "ignored",
        createdAt: at,
      })
      .onConflictDoNothing({ target: [transaction.workspaceId, transaction.dedupeKey] })
      .returning({ id: transaction.id });
    if (!row) return null;

    // A statement read before this was recorded has already added the rupees as an unknown
    // credit, waiting for someone to match it. Now we know what it is.
    const waiting = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.workspaceId, ws.id), eq(transaction.kind, "credit"), inArray(transaction.matchStatus, ["pending", "unmatched"]), like(transaction.dedupeKey, "statement:%")));
    const self = { valueDate: on, pkrAmount: pkr.toFixed(2) };
    const rupees = waiting.find((t) => t.currency === "PKR" && isConversionRupees(self, t.valueDate, dec(t.amount)));
    if (rupees) {
      await tx.update(transaction).set({ kind: "fx_conversion", matchStatus: "ignored" }).where(eq(transaction.id, rupees.id));
      await tx.insert(transferLink).values({ workspaceId: ws.id, fromTransactionId: row.id, toTransactionId: rupees.id });
    }
    return { id: row.id, tied: !!rupees };
  });
  if (!done) return { ok: false, problems: ["This conversion is already recorded: same account, date and amounts."] };

  await audit(db, {
    workspaceId: ws.id,
    actorType: "user",
    actorId: userId,
    action: "esfca.conversion_recorded",
    objectType: "transaction",
    objectId: done.id,
    details: { account: acc.label, on, amount: amount.toFixed(2), currency: acc.currency, pkr: pkr.toFixed(2), rate: rate.toFixed(4), reference, tiedToStatement: done.tied },
  });
  return { ok: true, id: done.id, rate: rate.toFixed(4), tiedToStatement: done.tied };
}

/** Takes back a conversion recorded by mistake. Its rupees, if tied, go back to waiting for a match. */
export async function removeConversion(db: Db, ws: Workspace, id: string, userId: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  const [row] = await db
    .select({ tx: transaction })
    .from(transaction)
    .innerJoin(receivingAccount, eq(receivingAccount.id, transaction.receivingAccountId))
    .where(and(eq(transaction.workspaceId, ws.id), eq(transaction.id, id), eq(transaction.kind, "fx_conversion"), eq(receivingAccount.kind, "esfca")));
  if (!row) return { ok: false, problem: "That conversion doesn't exist." };
  const t = row.tx;
  if (await closedMonth(db, ws.id, t.valueDate)) return { ok: false, problem: `${monthLabel(t.valueDate.slice(0, 7))} is closed. An owner has to reopen it first.` };
  await db.transaction(async (tx) => {
    const links = await tx.select({ to: transferLink.toTransactionId }).from(transferLink).where(and(eq(transferLink.workspaceId, ws.id), eq(transferLink.fromTransactionId, id)));
    if (links.length) await tx.update(transaction).set({ kind: "credit", matchStatus: "pending" }).where(inArray(transaction.id, links.map((l) => l.to)));
    await tx.delete(transaction).where(eq(transaction.id, id));
  });
  await audit(db, {
    workspaceId: ws.id,
    actorType: "user",
    actorId: userId,
    action: "esfca.conversion_removed",
    objectType: "transaction",
    objectId: id,
    details: { on: t.valueDate, amount: t.amount, currency: t.currency, pkr: t.pkrAmount, rate: t.fxRateApplied, reference: t.adviceNumber },
  });
  return { ok: true };
}

export interface ConversionLine {
  id: string;
  on: IsoDate;
  amount: string;
  currency: string;
  pkr: string;
  rate: string;
  reference: string | null;
  referenceRate: string | null;
  /** PKR lost against the reference rate; negative when the bank's rate was better. */
  costPkr: string | null;
  costPct: string | null;
  /** Below the reference rate by more than the fx.spread_warn_pct rule. */
  wide: boolean;
  closed: boolean;
  tiedToStatement: boolean;
}

export interface EsfcaAccountView {
  id: string;
  label: string;
  currency: string;
  iban: string | null;
  balance: string;
  /** Where the balance starts from: the newest statement read, or only the movements on record. */
  basis: { kind: "statement"; on: IsoDate; closing: string; document: string | null } | { kind: "records" };
  monthEnds: Array<{ month: string; label: string; on: IsoDate; balance: string }>;
  conversions: ConversionLine[];
  totals: { amount: string; pkr: string; costPkr: string };
}

export interface RetentionMonth {
  month: string;
  label: string;
  proceedsPkr: string;
  /** Reached the ESFCA this month. */
  intoPkr: string;
  /** Converted out this month, at the reference rate so it's measured like the credits it came from. */
  convertedPkr: string;
  /** What stayed: the figure the limit applies to. Never below zero. */
  retainedPkr: string;
  /** Null when there's no USD reference rate to value the fixed limit with. */
  limitPkr: string | null;
  over: boolean;
}

export interface EsfcaView {
  today: IsoDate;
  accounts: EsfcaAccountView[];
  retention: RetentionMonth[];
  rule: { minUsd: string; pct: string; verified: boolean };
}

/** Rule 9: the greater of a fixed USD amount a month or a share of the month's export proceeds. */
export function retentionLimitPkr(proceedsPkr: Decimal, usdRate: string | null, rule: { min_usd: string; pct: string }): Decimal | null {
  if (!usdRate) return null;
  return Decimal.max(dec(rule.min_usd).times(usdRate), proceedsPkr.times(rule.pct).div(100));
}

export async function esfcaView(db: Db, w: WorkspaceContext): Promise<EsfcaView> {
  const id = w.ws.id;
  const accounts = (await db.select().from(receivingAccount).where(and(eq(receivingAccount.workspaceId, id), eq(receivingAccount.kind, "esfca")))).filter((a) => a.active);
  const [rows, docs, closed, links, ruleRows, books] = await Promise.all([
    db.select().from(transaction).where(and(eq(transaction.workspaceId, id), inArray(transaction.kind, ["credit", "fx_conversion"]))).orderBy(desc(transaction.valueDate), desc(transaction.createdAt)),
    db.select().from(document).where(and(eq(document.workspaceId, id), eq(document.kind, "statement"), eq(document.parseStatus, "parsed"))),
    db.select({ month: closePeriod.month }).from(closePeriod).where(and(eq(closePeriod.workspaceId, id), eq(closePeriod.status, "closed"))),
    db.select({ from: transferLink.fromTransactionId }).from(transferLink).where(eq(transferLink.workspaceId, id)),
    db.select({ status: rule.status, workspaceId: rule.workspaceId }).from(rule).where(and(eq(rule.key, "esfca.retention"), or(isNull(rule.workspaceId), eq(rule.workspaceId, id)))),
    loadBooks(db, w),
  ]);
  const closedMonths = new Set(closed.map((c) => c.month));
  const tied = new Set(links.map((l) => l.from));
  const statements = docs.flatMap((d) => {
    const o = (d.extracted as { outcome?: StatementOutcome } | null)?.outcome;
    return o?.action === "statement" ? [{ name: d.originalName, o }] : [];
  });
  const warnPct = dec(w.rules["fx.spread_warn_pct"]);

  const views: EsfcaAccountView[] = accounts.map((a) => {
    const credits = rows.filter((t) => t.kind === "credit" && t.receivingAccountId === a.id && t.matchStatus !== "duplicate" && t.currency === a.currency && t.valueDate <= w.today);
    const moved = rows.filter((t) => t.kind === "fx_conversion" && t.receivingAccountId === a.id);
    const mine = statements.filter((s) => s.o.accountId === a.id).sort((x, y) => x.o.to.localeCompare(y.o.to));
    const latest = mine.at(-1);
    const after = (t: { valueDate: string }) => !latest || t.valueDate > latest.o.to;
    let balance = latest ? dec(latest.o.closing) : dec(0);
    for (const t of credits) if (after(t)) balance = balance.plus(t.amount);
    for (const t of moved) if (after(t)) balance = balance.minus(t.amount);

    const ends = new Map<string, { on: IsoDate; balance: string }>();
    for (const s of mine) for (const [m, e] of Object.entries(s.o.monthEnds)) ends.set(m, e);

    const conversions: ConversionLine[] = moved.map((t) => {
      const ref = w.refRate(a.currency, t.valueDate) ?? null;
      const atRef = ref ? dec(t.amount).times(ref) : null;
      const cost = atRef ? atRef.minus(t.pkrAmount ?? "0") : null;
      const pct = cost && atRef?.gt(0) ? cost.div(atRef).times(100) : null;
      return {
        id: t.id,
        on: t.valueDate,
        amount: t.amount,
        currency: t.currency,
        pkr: t.pkrAmount ?? "0.00",
        rate: t.fxRateApplied ?? "0",
        reference: t.adviceNumber,
        referenceRate: ref,
        costPkr: cost ? fixed2(cost) : null,
        costPct: pct ? pct.toFixed(2) : null,
        wide: !!pct && pct.gt(warnPct),
        closed: closedMonths.has(t.valueDate.slice(0, 7)),
        tiedToStatement: tied.has(t.id),
      };
    });
    const sum = (f: (c: ConversionLine) => string | null) => conversions.reduce((n, c) => n.plus(f(c) ?? "0"), dec(0));
    return {
      id: a.id,
      label: a.label,
      currency: a.currency,
      iban: a.iban,
      balance: fixed2(balance),
      basis: latest ? { kind: "statement", on: latest.o.to, closing: latest.o.closing, document: latest.name } : { kind: "records" },
      monthEnds: [...ends].sort(([x], [y]) => y.localeCompare(x)).map(([month, e]) => ({ month, label: monthLabel(month), ...e })),
      conversions,
      totals: { amount: fixed2(sum((c) => c.amount)), pkr: fixed2(sum((c) => c.pkr)), costPkr: fixed2(sum((c) => c.costPkr)) },
    };
  });

  // Rule 9, month by month this tax year, on the same credits as every other proceeds figure.
  const r = w.rules["esfca.retention"];
  const esfcaIds = new Set(accounts.map((a) => a.id));
  const byMonth = new Map<string, { proceeds: Decimal; into: Decimal; converted: Decimal }>();
  const monthRow = (m: string) => {
    const row = byMonth.get(m) ?? { proceeds: dec(0), into: dec(0), converted: dec(0) };
    byMonth.set(m, row);
    return row;
  };
  for (const { t, pkr } of taxYearCredits(books, w)) {
    const row = monthRow(t.valueDate.slice(0, 7));
    row.proceeds = row.proceeds.plus(pkr);
    if (esfcaIds.has(t.receivingAccountId ?? "")) row.into = row.into.plus(pkr);
  }
  const year = taxYearOf(w.today, w.ws.fiscalYearStartMonth);
  for (const t of rows) {
    if (t.kind !== "fx_conversion" || !esfcaIds.has(t.receivingAccountId ?? "") || t.valueDate < year.start || t.valueDate > w.today) continue;
    const row = monthRow(t.valueDate.slice(0, 7));
    row.converted = row.converted.plus(dec(t.amount).times(w.refRate(t.currency, t.valueDate) ?? t.fxRateApplied ?? 0));
  }
  const retention: RetentionMonth[] = [...byMonth]
    .sort(([x], [y]) => y.localeCompare(x))
    .map(([month, v]) => {
      const end = monthRange(month).end;
      const limit = retentionLimitPkr(v.proceeds, w.refRate("USD", end < w.today ? end : w.today) ?? null, r);
      const retained = Decimal.max(v.into.minus(v.converted), 0);
      return { month, label: monthLabel(month), proceedsPkr: fixed2(v.proceeds), intoPkr: fixed2(v.into), convertedPkr: fixed2(v.converted), retainedPkr: fixed2(retained), limitPkr: limit ? fixed2(limit) : null, over: !!limit && retained.gt(limit) };
    });

  const own = ruleRows.find((x) => x.workspaceId === id) ?? ruleRows[0];
  return { today: w.today, accounts: views, retention, rule: { minUsd: r.min_usd, pct: r.pct, verified: own?.status === "verified" } };
}
