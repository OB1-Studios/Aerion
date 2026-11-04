import { addDays, daysBetween, dec, formatMoney, matchCredit, matchTransfer, normalizeName, type CreditForMatching, type MatchContext, type WalletWithdrawal } from "@ebo/core";
import { clientClaim, complianceItem, invoice, match, promiseToPay, transaction, transferLink } from "@ebo/db";
import { eq, inArray } from "drizzle-orm";
import { audit } from "../context";
import { BANK_ACCOUNT_KINDS, forMatching, identities, loadBooks } from "../books";
import { bump, type Step } from "./types";

type TxStatus = "matched" | "unmatched" | "transfer" | "duplicate" | "ignored";
const IGNORED_KINDS = new Set(["platform_earning", "platform_fee", "payoneer_card_spend", "bank_charge", "fx_conversion", "refund_out"]);

/**
 * Reconcile: deterministic matching (core/matching.ts). Money moved between our own
 * accounts is linked as a transfer first; every other credit is matched to invoices or
 * left for a person with the candidates. New bank credits get their ePRC and withholding
 * certificate items; claims and promises are closed when the money arrives.
 */
export const reconcileStep: Step = {
  name: "reconcile",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const books = await loadBooks(db, c.w);
    const tol = c.w.tolerance;
    const accountKind = new Map(books.accounts.map((a) => [a.id, a.kind]));
    const isBankCredit = (t: (typeof books.transactions)[number]) => t.kind === "credit" && BANK_ACCOUNT_KINDS.has(accountKind.get(t.receivingAccountId ?? "") ?? "");
    const invoices = forMatching(books);
    const ctx: MatchContext = { invoices, clients: identities(books), rules: c.w.rules, refRate: c.w.refRate };
    const linkedFrom = new Set(books.transfers.map((l) => l.fromTransactionId));
    const marketplaces = new Set(
      books.clients.filter((x) => x.kind === "marketplace").flatMap((x) => [x.name, ...books.aliases.filter((a) => a.clientId === x.id).map((a) => a.alias)].map(normalizeName)),
    );
    const pending = books.transactions
      .filter((t) => t.matchStatus === "pending" || t.matchStatus === "unmatched")
      .sort((a, b) => a.valueDate.localeCompare(b.valueDate) || a.createdAt.getTime() - b.createdAt.getTime());

    const status = new Map<string, TxStatus>();
    const matched: Array<Record<string, unknown>> = [];
    const unmatched: Array<Record<string, unknown>> = [];
    const transfers: Array<Record<string, unknown>> = [];
    const duplicates: Array<Record<string, unknown>> = [];
    const notes = new Map<string, string>();

    const link = async (fromId: string, toId: string, probable: boolean, what: string) => {
      await db.insert(transferLink).values({ workspaceId: wsId, fromTransactionId: fromId, toTransactionId: toId, probable });
      linkedFrom.add(fromId);
      status.set(fromId, "transfer");
      status.set(toId, "transfer");
      transfers.push({ from: fromId, to: toId, probable, what });
      bump(c, "transfers");
    };

    // 1. Transfers between our own accounts.
    for (const t of pending) {
      if (t.kind === "payoneer_receipt" && marketplaces.has(normalizeName(t.payerName))) {
        const payout = books.transactions.find(
          (w) => w.kind === "platform_withdrawal" && !linkedFrom.has(w.id) && w.currency === t.currency && dec(w.amount).eq(t.amount) && daysBetween(w.valueDate, t.valueDate) >= 0 && daysBetween(w.valueDate, t.valueDate) <= 5,
        );
        if (payout) await link(payout.id, t.id, false, `${t.payerName} payout of ${formatMoney(t.amount, t.currency)} into Payoneer`);
        else {
          status.set(t.id, "unmatched");
          notes.set(t.id, "Marketplace payout: the matching marketplace export hasn't been imported yet.");
        }
      }
      if (isBankCredit(t) && /\bPAYONEER\b/i.test(`${t.payerName ?? ""} ${t.reference ?? ""}`)) {
        const withdrawals: WalletWithdrawal[] = books.transactions
          .filter((w) => w.kind === "payoneer_withdrawal" && !linkedFrom.has(w.id))
          .map((w) => ({ id: w.id, valueDate: w.valueDate, amount: w.amount, currency: w.currency, pkrAmount: w.pkrAmount, linked: false }));
        const found = matchTransfer({ id: t.id, valueDate: t.valueDate, amount: t.amount, currency: t.currency, pkrAmount: t.pkrAmount, payerName: t.payerName, reference: t.reference }, withdrawals);
        if (found) await link(found.withdrawalId, t.id, found.probable, `Payoneer withdrawal of ${formatMoney(t.pkrAmount ?? t.amount, "PKR")} to the bank`);
        else {
          status.set(t.id, "unmatched");
          notes.set(t.id, "Payoneer withdrawal: the Payoneer export with this withdrawal hasn't been imported yet.");
        }
      }
    }

    // 2. Client payments -> invoices.
    for (const t of pending) {
      if (status.has(t.id)) continue;
      if (IGNORED_KINDS.has(t.kind)) {
        status.set(t.id, "ignored");
        continue;
      }
      if (!(isBankCredit(t) || t.kind === "payoneer_receipt")) continue; // withdrawals wait for the money to land
      const credit: CreditForMatching = {
        id: t.id,
        valueDate: t.valueDate,
        amount: t.amount,
        currency: t.currency,
        pkrAmount: t.pkrAmount,
        fxRateApplied: t.fxRateApplied,
        chargesAmount: t.chargesAmount,
        chargesCurrency: t.chargesCurrency,
        chargesCode: t.chargesCode,
        payerName: t.payerName,
        reference: t.reference,
      };
      const outcome = matchCredit(credit, ctx);
      if (outcome.status === "matched") {
        for (const a of outcome.allocations) {
          await db.insert(match).values({
            workspaceId: wsId,
            invoiceId: a.invoiceId,
            transactionId: t.id,
            appliedAmount: a.appliedAmount,
            cashAmount: a.cashAmount,
            feeAmount: a.feeAmount,
            feeProbable: a.feeProbable,
            fxDifference: a.fxDifferencePkr,
            bankRate: a.bankRate,
            referenceRate: a.referenceRate,
            unexplainedAmount: a.unexplainedAmount,
            tier: outcome.tier,
            explanation: outcome.explanation,
            runId: c.runId,
          });
          const inv = invoices.find((i) => i.id === a.invoiceId)!;
          inv.balance = dec(inv.balance).minus(a.appliedAmount).toFixed(2);
          inv.status = dec(inv.balance).lte(tol) ? "paid" : "part_paid";
          matched.push({
            transactionId: t.id,
            invoice: a.invoiceNumber,
            tier: outcome.tier,
            received: formatMoney(a.cashAmount, a.currency),
            fee: a.feeAmount !== "0.00" ? formatMoney(a.feeAmount, a.currency) : null,
            fxDifferencePkr: a.fxDifferencePkr,
            unexplained: a.unexplainedAmount !== "0.00" ? formatMoney(a.unexplainedAmount, a.currency) : null,
            explanation: outcome.explanation,
          });
          bump(c, "matched");
        }
        status.set(t.id, "matched");
        await audit(db, { workspaceId: wsId, actorType: "agent", actorId: c.runId, action: "payment.matched", objectType: "transaction", objectId: t.id, details: { tier: outcome.tier, invoices: outcome.allocations.map((a) => a.invoiceNumber), explanation: outcome.explanation } });
      } else if (outcome.status === "duplicate") {
        status.set(t.id, "duplicate");
        duplicates.push({ transactionId: t.id, invoice: outcome.invoiceNumber, explanation: outcome.explanation });
        bump(c, "duplicates");
      } else {
        status.set(t.id, "unmatched");
        unmatched.push({ transactionId: t.id, amount: formatMoney(t.amount, t.currency), payer: t.payerName, candidates: outcome.candidates.slice(0, 3), explanation: outcome.explanation });
        bump(c, "unmatched");
      }
    }

    // 3. Save statuses; new bank credits get their two compliance items.
    for (const [id, s] of status) {
      const t = books.transactions.find((x) => x.id === id)!;
      if (t.matchStatus !== s) await db.update(transaction).set({ matchStatus: s }).where(eq(transaction.id, id));
    }
    const haveItems = new Set(books.compliance.map((x) => x.transactionId));
    const newItems = pending.filter((t) => isBankCredit(t) && status.get(t.id) !== "duplicate" && !haveItems.has(t.id));
    if (newItems.length) {
      await db.insert(complianceItem).values(
        newItems.flatMap((t) => [
          { workspaceId: wsId, transactionId: t.id, kind: "eprc" as const, status: "missing" as const, dueOn: addDays(t.valueDate, c.w.rules["eprc.wait_days"]) },
          { workspaceId: wsId, transactionId: t.id, kind: "wht_certificate" as const, status: "missing" as const, dueOn: addDays(t.valueDate, c.w.rules["wht.wait_days"]) },
        ]),
      );
      bump(c, "compliance_items", newItems.length * 2);
    }

    // 4. Invoice statuses, claims and promises.
    const before = new Map(books.invoices.map((i) => [i.id, i.status]));
    for (const inv of invoices) {
      if (before.get(inv.id) !== inv.status) await db.update(invoice).set({ status: inv.status }).where(eq(invoice.id, inv.id));
    }
    const paidOn = new Map<string, string[]>();
    const txDate = new Map(books.transactions.map((t) => [t.id, t.valueDate]));
    for (const m of books.matches) paidOn.set(m.invoiceId, [...(paidOn.get(m.invoiceId) ?? []), txDate.get(m.transactionId) ?? ""]);
    for (const m of matched) {
      const inv = invoices.find((i) => i.number === m.invoice)!;
      paidOn.set(inv.id, [...(paidOn.get(inv.id) ?? []), txDate.get(m.transactionId as string) ?? ""]);
    }
    const resolvedClaims = books.claims.filter((cl) => {
      if (cl.status !== "open") return false;
      const inv = invoices.find((i) => i.id === cl.invoiceId);
      return (inv && dec(inv.balance).lte(tol)) || (paidOn.get(cl.invoiceId) ?? []).some((d) => d >= cl.claimedOn);
    });
    if (resolvedClaims.length) await db.update(clientClaim).set({ status: "resolved" }).where(inArray(clientClaim.id, resolvedClaims.map((x) => x.id)));
    const keptPromises = books.promises.filter((p) => p.status === "open" && dec(invoices.find((i) => i.id === p.invoiceId)?.balance ?? "1").lte(tol));
    if (keptPromises.length) await db.update(promiseToPay).set({ status: "kept" }).where(inArray(promiseToPay.id, keptPromises.map((x) => x.id)));

    const tierA = matched.filter((m) => m.tier === "A").length;
    if (matched.length) c.report.push(`Matched ${matched.length} payment${matched.length === 1 ? "" : "s"} to invoices (${tierA} by reference and payer, ${matched.length - tierA} by payer and amount).`);
    if (transfers.length) c.report.push(`Linked ${transfers.length} transfer${transfers.length === 1 ? "" : "s"} between our own accounts.`);
    if (unmatched.length) c.report.push(`${unmatched.length} payment${unmatched.length === 1 ? "" : "s"} could not be matched and wait for a person.`);
    if (resolvedClaims.length) c.report.push(`${resolvedClaims.length} payment claim${resolvedClaims.length === 1 ? " was" : "s were"} confirmed by a credit.`);
    return { matched, transfers, unmatched, duplicates, notes: Object.fromEntries(notes), complianceItemsCreated: newItems.length * 2, claimsResolved: resolvedClaims.length, promisesKept: keptPromises.length };
  },
};
