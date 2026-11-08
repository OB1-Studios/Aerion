import { daysBetween, type IsoDate } from "./dates";
import { Decimal, dec, fixed2, formatMoney, formatRate, pct2, round2 } from "./money";
import { normalizeName, referenceMentionsInvoice } from "./normalize";
import type { Rules } from "./rules";

/**
 * Deterministic matching of incoming money to invoices (data spec section 4).
 * No model is involved: the same inputs always give the same match and explanation.
 */

export type Route = "swift_esfca" | "swift_pkr" | "payoneer" | "wise_pkr" | "platform" | "other";
/** Routes where the client pays foreign currency and the bank credits PKR. */
export const PKR_CONVERTING_ROUTES: readonly Route[] = ["swift_pkr", "wise_pkr"];
export type InvoiceStatus = "draft" | "sent" | "part_paid" | "paid" | "void";

export interface InvoiceForMatching {
  id: string;
  number: string;
  clientId: string;
  currency: string;
  amount: string;
  /** amount - settled matches - credit notes */
  balance: string;
  route: Route;
  issuedOn: IsoDate;
  dueOn: IsoDate;
  status: InvoiceStatus;
}

export interface CreditForMatching {
  id: string;
  valueDate: IsoDate;
  /** Remitted amount and currency. PKR when the document only states the PKR credited. */
  amount: string;
  currency: string;
  /** PKR credited, when the bank converted (with the foreign amount known). */
  pkrAmount?: string | null;
  fxRateApplied?: string | null;
  chargesAmount?: string | null;
  chargesCurrency?: string | null;
  chargesCode?: "OUR" | "SHA" | "BEN" | null;
  payerName?: string | null;
  reference?: string | null;
}

export interface ClientIdentity {
  clientId: string;
  name: string;
  aliases: string[];
}

/** PKR per one unit of the currency on a date (SBP reference rate in production; simulated in the demo). */
export type RefRate = (currency: string, date: IsoDate) => string | null | undefined;

export interface Allocation {
  invoiceId: string;
  invoiceNumber: string;
  currency: string;
  /** What this settles on the invoice: cash received plus any explained fee. Balance = amount - sum(applied). */
  appliedAmount: string;
  /** Money actually received for this invoice, in the invoice currency. */
  cashAmount: string;
  feeAmount: string;
  /** True when no charges were stated and the gap was small enough to be a probable intermediary fee. */
  feeProbable: boolean;
  /** PKR received minus PKR expected at the reference rate. Negative = conversion cost. */
  fxDifferencePkr: string | null;
  bankRate: string | null;
  referenceRate: string | null;
  /** How far the bank rate sits below the reference, in percent. */
  fxSpreadPct: string | null;
  unexplainedAmount: string;
}

export interface Candidate {
  invoiceId: string;
  invoiceNumber: string;
  clientId: string;
  score: number;
  reasons: string[];
}

export type MatchOutcome =
  | {
      status: "matched";
      tier: "A" | "B";
      clientId: string;
      allocations: Allocation[];
      /** Money left over after settling the invoices, in the credit's currency. */
      unappliedAmount: string;
      explanation: string[];
    }
  | { status: "duplicate"; clientId: string; invoiceId: string; invoiceNumber: string; explanation: string[] }
  | { status: "unmatched"; candidates: Candidate[]; explanation: string[] };

export interface MatchContext {
  invoices: InvoiceForMatching[];
  clients: ClientIdentity[];
  rules: Rules;
  refRate: RefRate;
}

export function payerClientIds(payer: string | null | undefined, clients: ClientIdentity[]): Set<string> {
  const p = normalizeName(payer);
  const ids = new Set<string>();
  if (!p) return ids;
  for (const c of clients) {
    if ([c.name, ...c.aliases].some((n) => normalizeName(n) === p)) ids.add(c.clientId);
  }
  return ids;
}

const isOpen = (inv: InvoiceForMatching, tol: Decimal) =>
  (inv.status === "sent" || inv.status === "part_paid") && dec(inv.balance).gt(tol);

const isCompatible = (inv: InvoiceForMatching, credit: CreditForMatching) =>
  credit.currency === inv.currency || (credit.currency === "PKR" && PKR_CONVERTING_ROUTES.includes(inv.route));

/** Charges the advice says were deducted from the amount. "OUR" means the sender paid them. */
function statedCharges(credit: CreditForMatching): Decimal {
  if (!credit.chargesAmount || credit.chargesCode === "OUR") return new Decimal(0);
  if (credit.chargesCurrency && credit.chargesCurrency !== credit.currency) return new Decimal(0);
  return dec(credit.chargesAmount);
}

interface WindowResult {
  inside: boolean;
  expected: Decimal;
  received: Decimal;
  unit: string;
}

/** Spec step 6: received >= expected - (fee allowance + tolerance); PKR credits within the FX allowance. */
export function amountWindow(inv: InvoiceForMatching, credit: CreditForMatching, ctx: MatchContext): WindowResult {
  const tol = dec(ctx.rules["tolerance.abs"]);
  if (credit.currency === inv.currency) {
    const expected = dec(inv.balance);
    const received = dec(credit.amount);
    const allowance = Decimal.max(dec(ctx.rules["fee.max_unstated"][credit.currency] ?? 0), statedCharges(credit));
    const inside = received.gte(expected.minus(allowance).minus(tol)) && received.lte(expected.plus(tol));
    return { inside, expected, received, unit: inv.currency };
  }
  const ref = ctx.refRate(inv.currency, credit.valueDate);
  const received = dec(credit.amount);
  if (!ref) return { inside: false, expected: new Decimal(0), received, unit: "PKR" };
  const expected = dec(inv.balance).times(ref);
  const pct = dec(ctx.rules["fx.window_pct"]).div(100);
  return { inside: received.minus(expected).abs().lte(expected.times(pct)), expected, received, unit: "PKR" };
}

export function matchCredit(credit: CreditForMatching, ctx: MatchContext): MatchOutcome {
  const tol = dec(ctx.rules["tolerance.abs"]);
  const payerIds = payerClientIds(credit.payerName, ctx.clients);
  const clientName = (id: string) => ctx.clients.find((c) => c.clientId === id)?.name ?? id;

  const referenced = ctx.invoices.filter((inv) => inv.status !== "void" && referenceMentionsInvoice(credit.reference, inv.number));
  const referencedOpen = referenced.filter((inv) => isOpen(inv, tol) && isCompatible(inv, credit) && payerIds.has(inv.clientId));

  // Tier A: the reference names the invoice(s) and the payer is that client.
  if (referencedOpen.length) {
    const clientId = referencedOpen[0]!.clientId;
    const sameClient = referencedOpen.filter((inv) => inv.clientId === clientId);
    const { allocations, unapplied, notes } = allocate(sameClient, credit, ctx);
    return {
      status: "matched",
      tier: "A",
      clientId,
      allocations,
      unappliedAmount: fixed2(unapplied),
      explanation: [
        `Reference "${credit.reference}" names ${sameClient.map((i) => i.number).join(", ")} and the payer "${credit.payerName}" is ${clientName(clientId)}.`,
        ...notes,
      ],
    };
  }

  // Spec step 8: a clear reference to an invoice that is already paid is a duplicate, not a match.
  const referencedPaid = referenced.find((inv) => !isOpen(inv, tol) && payerIds.has(inv.clientId));
  if (referencedPaid) {
    return {
      status: "duplicate",
      clientId: referencedPaid.clientId,
      invoiceId: referencedPaid.id,
      invoiceNumber: referencedPaid.number,
      explanation: [
        `Reference "${credit.reference}" names ${referencedPaid.number}, which is already paid. Possible duplicate payment: refund it or issue a credit note.`,
      ],
    };
  }

  // Tier B: the payer is a known client and exactly one of their open invoices fits the amount.
  const inWindow = ctx.invoices.filter(
    (inv) => payerIds.has(inv.clientId) && isOpen(inv, tol) && isCompatible(inv, credit) && amountWindow(inv, credit, ctx).inside,
  );
  if (inWindow.length === 1) {
    const inv = inWindow[0]!;
    const { allocations, unapplied, notes } = allocate([inv], credit, ctx);
    return {
      status: "matched",
      tier: "B",
      clientId: inv.clientId,
      allocations,
      unappliedAmount: fixed2(unapplied),
      explanation: [
        `Payer "${credit.payerName}" is ${clientName(inv.clientId)}, and ${inv.number} is the only open invoice of theirs that fits the amount.`,
        ...notes,
      ],
    };
  }

  // No match: suggest the three most likely invoices for a person to choose.
  const candidates: Candidate[] = ctx.invoices
    .filter((inv) => isOpen(inv, tol) && isCompatible(inv, credit))
    .map((inv) => {
      const reasons: string[] = [];
      let score = 0;
      if (referenceMentionsInvoice(credit.reference, inv.number)) {
        score += 100;
        reasons.push("the reference mentions it");
      }
      if (payerIds.has(inv.clientId)) {
        score += 50;
        reasons.push("the payer is this client");
      }
      const w = amountWindow(inv, credit, ctx);
      if (w.expected.gt(0)) {
        const rel = w.received.minus(w.expected).abs().div(w.expected).times(100);
        score += Math.max(0, 50 - rel.toNumber());
        reasons.push(`amount differs by ${pct2(rel)}%`);
      }
      return { invoiceId: inv.id, invoiceNumber: inv.number, clientId: inv.clientId, score: Math.round(score * 100) / 100, reasons };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const why =
    payerIds.size === 0
      ? `The payer "${credit.payerName ?? "unknown"}" doesn't match any client or alias.`
      : inWindow.length > 1
        ? `More than one open invoice of ${clientName([...payerIds][0]!)} fits the amount.`
        : `No open invoice of ${clientName([...payerIds][0]!)} fits the amount.`;
  return { status: "unmatched", candidates, explanation: [why, "A person needs to choose; their choice is saved as a manual match."] };
}

function allocate(
  invoices: InvoiceForMatching[],
  credit: CreditForMatching,
  ctx: MatchContext,
): { allocations: Allocation[]; unapplied: Decimal; notes: string[] } {
  const sorted = [...invoices].sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.number.localeCompare(b.number));
  const pkrOnly = credit.currency === "PKR" && sorted.some((inv) => inv.currency !== "PKR");
  return pkrOnly ? allocatePkrOnly(sorted, credit, ctx) : allocateSameCurrency(sorted, credit, ctx);
}

function allocateSameCurrency(sorted: InvoiceForMatching[], credit: CreditForMatching, ctx: MatchContext) {
  const tol = dec(ctx.rules["tolerance.abs"]);
  const maxUnstated = dec(ctx.rules["fee.max_unstated"][credit.currency] ?? 0);
  const notes: string[] = [];
  let remaining = dec(credit.amount);
  let chargesLeft = statedCharges(credit);

  // The bank converted to PKR: compare its rate with the reference rate.
  const bankRate =
    credit.pkrAmount && dec(credit.amount).gt(0)
      ? credit.fxRateApplied
        ? dec(credit.fxRateApplied)
        : dec(credit.pkrAmount).div(credit.amount).toDecimalPlaces(6)
      : null;
  const refRaw = bankRate ? ctx.refRate(credit.currency, credit.valueDate) : null;
  const refRate = refRaw ? dec(refRaw) : null;

  const allocations: Allocation[] = sorted.map((inv) => {
    const balance = dec(inv.balance);
    const cash = Decimal.min(balance, remaining);
    remaining = remaining.minus(cash);
    const gap = balance.minus(cash);
    let fee = new Decimal(0);
    let feeProbable = false;
    if (gap.gt(tol)) {
      if (chargesLeft.gt(0)) {
        fee = Decimal.min(chargesLeft, gap);
        chargesLeft = chargesLeft.minus(fee);
        notes.push(`${formatMoney(fee, inv.currency)} in charges stated on the advice explain the difference on ${inv.number}.`);
      } else if (gap.lte(maxUnstated)) {
        fee = gap;
        feeProbable = true;
        notes.push(
          `${formatMoney(fee, inv.currency)} is missing on ${inv.number} with no charges stated; treated as a probable intermediary fee and marked for review.`,
        );
      }
    }
    const unexplained = gap.minus(fee);
    if (unexplained.gt(tol)) notes.push(`${formatMoney(unexplained, inv.currency)} on ${inv.number} is unexplained.`);

    let fx: string | null = null;
    let spread: string | null = null;
    if (bankRate && refRate && refRate.gt(0)) {
      const diff = round2(cash.times(bankRate.minus(refRate)));
      fx = diff.toFixed(2);
      const spreadPct = refRate.minus(bankRate).div(refRate).times(100);
      spread = pct2(spreadPct);
      if (!diff.isZero()) {
        notes.push(
          `Bank rate ${formatRate(bankRate)} against the reference ${formatRate(refRate)}: conversion ${diff.isNegative() ? "cost" : "gain"} ${formatMoney(diff.abs(), "PKR")} (${pct2(spreadPct.abs())}%).`,
        );
      }
    }
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      currency: inv.currency,
      appliedAmount: fixed2(cash.plus(fee)),
      cashAmount: fixed2(cash),
      feeAmount: fixed2(fee),
      feeProbable,
      fxDifferencePkr: fx,
      bankRate: bankRate ? bankRate.toString() : null,
      referenceRate: refRate ? refRate.toString() : null,
      fxSpreadPct: spread,
      unexplainedAmount: fixed2(Decimal.max(unexplained, 0)),
    };
  });
  if (remaining.gt(tol)) notes.push(`${formatMoney(remaining, credit.currency)} is more than the invoice(s) and stays unapplied.`);
  return { allocations, unapplied: Decimal.max(remaining, 0), notes };
}

function allocatePkrOnly(sorted: InvoiceForMatching[], credit: CreditForMatching, ctx: MatchContext) {
  const notes: string[] = [];
  const pct = dec(ctx.rules["fx.window_pct"]).div(100);
  let remaining = dec(credit.amount);
  const allocations: Allocation[] = [];

  sorted.forEach((inv, i) => {
    const isLast = i === sorted.length - 1;
    const refRaw = ctx.refRate(inv.currency, credit.valueDate);
    if (!refRaw) {
      notes.push(`No reference rate for ${inv.currency} on ${credit.valueDate}; ${inv.number} needs a manual match.`);
      return;
    }
    const ref = dec(refRaw);
    const balance = dec(inv.balance);
    const expected = balance.times(ref);
    const pkr = isLast ? remaining : Decimal.min(expected, remaining);
    remaining = remaining.minus(pkr);

    let applied: Decimal;
    let unexplained = new Decimal(0);
    let fx = new Decimal(0);
    if (pkr.minus(expected).abs().lte(expected.times(pct)) || pkr.gt(expected)) {
      applied = balance;
      fx = round2(pkr.minus(expected));
      if (!fx.isZero()) {
        notes.push(
          `${formatMoney(pkr, "PKR")} received for ${inv.number}; at the reference ${formatRate(ref)} that's ${formatMoney(round2(expected), "PKR")}, so the bank's rate made a ${fx.isNegative() ? "cost" : "gain"} of ${formatMoney(fx.abs(), "PKR")}.`,
        );
      }
    } else {
      applied = round2(pkr.div(ref));
      unexplained = balance.minus(applied);
      notes.push(
        `${formatMoney(pkr, "PKR")} is worth ${formatMoney(applied, inv.currency)} at the reference ${formatRate(ref)}; ${formatMoney(unexplained, inv.currency)} on ${inv.number} is unexplained.`,
      );
    }
    const bankRate = applied.gt(0) ? pkr.div(applied).toDecimalPlaces(6) : null;
    allocations.push({
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      currency: inv.currency,
      appliedAmount: fixed2(applied),
      cashAmount: fixed2(applied),
      feeAmount: "0.00",
      feeProbable: false,
      fxDifferencePkr: fx.toFixed(2),
      bankRate: bankRate ? bankRate.toString() : null,
      referenceRate: ref.toString(),
      fxSpreadPct: bankRate ? pct2(ref.minus(bankRate).div(ref).times(100)) : null,
      unexplainedAmount: fixed2(unexplained),
    });
  });
  return { allocations, unapplied: new Decimal(0), notes };
}

export interface WalletWithdrawal {
  id: string;
  valueDate: IsoDate;
  amount: string;
  currency: string;
  pkrAmount?: string | null;
  linked: boolean;
}

/**
 * A PKR credit from Payoneer is the business moving its own money home, not a
 * client payment: link it to the Payoneer withdrawal it came from.
 */
export function matchTransfer(
  credit: CreditForMatching,
  withdrawals: WalletWithdrawal[],
  windowDays = 5,
): { withdrawalId: string; probable: boolean } | null {
  const who = `${normalizeName(credit.payerName)} ${normalizeName(credit.reference)}`;
  if (!/\bPAYONEER\b/.test(who)) return null;
  const pkr = credit.pkrAmount ?? (credit.currency === "PKR" ? credit.amount : null);
  const nearby = withdrawals.filter((w) => {
    if (w.linked) return false;
    const gap = daysBetween(w.valueDate, credit.valueDate);
    return gap >= 0 && gap <= windowDays;
  });
  const exactPkr = pkr ? nearby.filter((w) => w.pkrAmount && dec(w.pkrAmount).minus(pkr).abs().lte(1)) : [];
  if (exactPkr.length === 1) return { withdrawalId: exactPkr[0]!.id, probable: false };
  const sameForeign = nearby.filter((w) => w.currency === credit.currency && dec(w.amount).eq(dec(credit.amount)));
  if (sameForeign.length === 1) return { withdrawalId: sameForeign[0]!.id, probable: false };
  if (nearby.length === 1) return { withdrawalId: nearby[0]!.id, probable: true };
  return null;
}
