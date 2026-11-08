import {
  addDays,
  computeBankingShare,
  dateInZone,
  dec,
  emailDomain,
  fixed2,
  periodLabel,
  referenceMentionsInvoice,
  sumDec,
  taxYearOf,
  type ApprovalPolicy,
  type Decimal,
  type ClientIdentity,
  type DraftContext,
  type FlagSnapshot,
  type InvoiceForMatching,
  type IsoDate,
  type ShareEvent,
} from "@ebo/core";
import {
  client,
  clientAlias,
  clientClaim,
  complianceItem,
  creditNote,
  dispute,
  invoice,
  invoiceReminder,
  match,
  member,
  message,
  openingBalance,
  promiseToPay,
  receivingAccount,
  transaction,
  transferLink,
  type Db,
  type OpeningChannel,
} from "@ebo/db";
import { and, eq, gte } from "drizzle-orm";
import type { WorkspaceContext } from "./context";

/**
 * Everything a run needs to know about a workspace's books, loaded in one go. Workspaces
 * are small (hundreds of rows), so the engine reads them whole and works in memory.
 */
export interface Books {
  clients: Array<typeof client.$inferSelect>;
  aliases: Array<typeof clientAlias.$inferSelect>;
  invoices: Array<typeof invoice.$inferSelect & { balance: string; appliedTotal: string }>;
  matches: Array<typeof match.$inferSelect>;
  transactions: Array<typeof transaction.$inferSelect>;
  accounts: Array<typeof receivingAccount.$inferSelect>;
  compliance: Array<typeof complianceItem.$inferSelect>;
  claims: Array<typeof clientClaim.$inferSelect>;
  promises: Array<typeof promiseToPay.$inferSelect>;
  reminders: Array<typeof invoiceReminder.$inferSelect>;
  disputes: Array<typeof dispute.$inferSelect>;
  transfers: Array<typeof transferLink.$inferSelect>;
  /** Proceeds from before the records began, imported from a spreadsheet (W4). */
  openings: Array<typeof openingBalance.$inferSelect>;
  inbound: Array<typeof message.$inferSelect>;
  owners: string[];
}

export async function loadBooks(db: Db, w: WorkspaceContext): Promise<Books> {
  const id = w.ws.id;
  const [clients, aliases, invoices, matches, transactions, accounts, compliance, claims, promises, reminders, disputes, transfers, credits, inbound, owners, openings] = await Promise.all([
    db.select().from(client).where(eq(client.workspaceId, id)),
    db.select().from(clientAlias).where(eq(clientAlias.workspaceId, id)),
    db.select().from(invoice).where(eq(invoice.workspaceId, id)),
    db.select().from(match).where(eq(match.workspaceId, id)),
    db.select().from(transaction).where(eq(transaction.workspaceId, id)),
    db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, id)),
    db.select().from(complianceItem).where(eq(complianceItem.workspaceId, id)),
    db.select().from(clientClaim).where(eq(clientClaim.workspaceId, id)),
    db.select().from(promiseToPay).where(eq(promiseToPay.workspaceId, id)),
    db.select().from(invoiceReminder).where(eq(invoiceReminder.workspaceId, id)),
    db.select().from(dispute).where(eq(dispute.workspaceId, id)),
    db.select().from(transferLink).where(eq(transferLink.workspaceId, id)),
    db.select().from(creditNote).where(eq(creditNote.workspaceId, id)),
    db
      .select()
      .from(message)
      .where(and(eq(message.workspaceId, id), eq(message.direction, "in"), gte(message.sentAt, new Date(w.clock.getTime() - 45 * 86_400_000)))),
    db.select({ userId: member.userId }).from(member).where(and(eq(member.workspaceId, id), eq(member.role, "owner"))),
    db.select().from(openingBalance).where(eq(openingBalance.workspaceId, id)),
  ]);
  const applied = new Map<string, ReturnType<typeof dec>>();
  for (const m of matches) applied.set(m.invoiceId, (applied.get(m.invoiceId) ?? dec(0)).plus(m.appliedAmount));
  const credited = new Map<string, ReturnType<typeof dec>>();
  for (const c of credits) credited.set(c.invoiceId, (credited.get(c.invoiceId) ?? dec(0)).plus(c.amount));
  return {
    clients,
    aliases,
    invoices: invoices.map((i) => {
      const a = applied.get(i.id) ?? dec(0);
      return { ...i, appliedTotal: fixed2(a), balance: fixed2(dec(i.amount).minus(i.paidBeforeImport).minus(a).minus(credited.get(i.id) ?? 0)) };
    }),
    matches,
    transactions,
    accounts,
    compliance,
    claims,
    promises,
    reminders,
    disputes,
    transfers,
    openings,
    inbound: inbound.filter((m) => m.sentAt <= w.clock),
    owners: owners.map((o) => o.userId),
  };
}

export const BANK_ACCOUNT_KINDS = new Set(["pkr_account", "esfca"]);

/**
 * Export proceeds: credits into the workspace's Pakistani bank accounts this tax year (up to
 * today), each in PKR as credited, or at the reference rate when it stayed in foreign currency.
 */
export function taxYearCredits(b: Books, w: WorkspaceContext): Array<{ t: (typeof b.transactions)[number]; pkr: Decimal }> {
  const accountKind = new Map(b.accounts.map((a) => [a.id, a.kind]));
  const year = taxYearOf(w.today, w.ws.fiscalYearStartMonth);
  return b.transactions
    .filter((t) => t.kind === "credit" && t.valueDate >= year.start && t.valueDate <= w.today && BANK_ACCOUNT_KINDS.has(accountKind.get(t.receivingAccountId ?? "") ?? "") && t.matchStatus !== "duplicate")
    .map((t) => ({ t, pkr: dec(t.pkrAmount ?? (t.currency === "PKR" ? t.amount : dec(t.amount).times(w.refRate(t.currency, t.valueDate) ?? 0))) }));
}

export const OPENING_CHANNEL_LABELS: Record<OpeningChannel, string> = {
  bank: "Into a Pakistani bank account",
  payoneer_withdrawn: "Through Payoneer, withdrawn to a Pakistani bank",
  payoneer_held: "Kept in Payoneer",
  platform: "Left on a marketplace",
  other: "Some other way, outside Pakistani banks",
};

export interface OpeningLine {
  id: string;
  month: string;
  channel: OpeningChannel;
  currency: string;
  amount: string;
  /** In PKR: as credited, or at the reference rate (then `pkrEstimated`). Null when no rate is known. */
  pkr: Decimal | null;
  pkrEstimated: boolean;
  /** Reached a Pakistani bank (directly or withdrawn from Payoneer), so it's export proceeds banked here. */
  banked: boolean;
  /** The day it's valued on: the 15th of its month, or today in the current month. */
  date: IsoDate;
  eprcOnFile: boolean | null;
}

/**
 * Imported opening balances in this tax year (up to today), each valued in PKR. They count in the
 * proceeds and the banking-channel share like recorded money, so every total stays the same one.
 */
export function taxYearOpenings(b: Books, w: WorkspaceContext): OpeningLine[] {
  const year = taxYearOf(w.today, w.ws.fiscalYearStartMonth);
  return b.openings
    .filter((o) => `${o.month}-01` >= year.start && `${o.month}-01` <= w.today)
    .sort((x, y) => x.month.localeCompare(y.month) || x.channel.localeCompare(y.channel) || x.currency.localeCompare(y.currency))
    .map((o) => {
      const mid = `${o.month}-15` as IsoDate;
      const date = mid < w.today ? mid : w.today;
      const rate = o.currency === "PKR" ? "1" : w.refRate(o.currency, date);
      const pkr = o.pkrAmount ? dec(o.pkrAmount) : rate ? dec(o.amount).times(rate) : null;
      return { id: o.id, month: o.month, channel: o.channel, currency: o.currency, amount: o.amount, pkr, pkrEstimated: !o.pkrAmount && o.currency !== "PKR", banked: o.channel === "bank" || o.channel === "payoneer_withdrawn", date, eprcOnFile: o.eprcOnFile };
    });
}

/** An opening balance as the banking-channel share sees it: Payoneer money shares the wallet's queue. */
function openingEvents(o: OpeningLine): ShareEvent[] {
  const label = `Opening balance for ${periodLabel(o.month)}`;
  const base = { id: `opening:${o.id}`, date: o.date, currency: o.currency, amount: o.amount };
  switch (o.channel) {
    case "bank":
      return [{ ...base, kind: "bank_credit", note: `${label}: received into a Pakistani bank account` }];
    case "payoneer_withdrawn":
      return [
        { ...base, kind: "wallet_receipt", wallet: "Payoneer", note: `${label}: received into Payoneer` },
        { ...base, id: `opening:${o.id}:withdrawn`, kind: "wallet_withdrawal", wallet: "Payoneer", note: `${label}: withdrawn from Payoneer to a Pakistani bank` },
      ];
    case "payoneer_held":
      return [{ ...base, kind: "wallet_receipt", wallet: "Payoneer", note: `${label}: kept in Payoneer; counts as banked only when withdrawn` }];
    case "platform":
      return [{ ...base, kind: "wallet_receipt", wallet: "Marketplace (opening balance)", note: `${label}: left on a marketplace, not banked in Pakistan` }];
    default:
      return [{ ...base, kind: "wallet_receipt", wallet: "Other (opening balance)", note: `${label}: received outside Pakistani banks` }];
  }
}

export function identities(b: Books): ClientIdentity[] {
  return b.clients.map((c) => ({ clientId: c.id, name: c.name, aliases: b.aliases.filter((a) => a.clientId === c.id).map((a) => a.alias) }));
}

export function forMatching(b: Books): InvoiceForMatching[] {
  return b.invoices
    .filter((i) => i.status !== "void" && i.status !== "draft")
    .map((i) => ({ id: i.id, number: i.number, clientId: i.clientId, currency: i.currency, amount: i.amount, balance: i.balance, route: i.route, issuedOn: i.issuedOn, dueOn: i.dueOn, status: i.status }));
}

const addressOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();

/** The flag rules' view of the workspace (core/flags.ts). */
export function flagSnapshot(b: Books, w: WorkspaceContext): FlagSnapshot {
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const txById = new Map(b.transactions.map((t) => [t.id, t]));
  const invoices = forMatching(b);
  const year = taxYearOf(w.today, w.ws.fiscalYearStartMonth);
  const inYear = (d: string) => d >= year.start && d <= w.today;

  // Banking-channel share: wallet money counts once it reaches a Pakistani bank.
  const events: ShareEvent[] = [];
  for (const t of b.transactions) {
    if (!inYear(t.valueDate)) continue;
    const acc = t.receivingAccountId ? accountById.get(t.receivingAccountId) : undefined;
    if (t.kind === "credit" && acc && BANK_ACCOUNT_KINDS.has(acc.kind) && t.matchStatus !== "transfer" && t.matchStatus !== "duplicate") {
      events.push({ kind: "bank_credit", id: t.id, date: t.valueDate, currency: t.currency, amount: t.amount });
    } else if (t.kind === "payoneer_receipt") {
      events.push({ kind: "wallet_receipt", id: t.id, wallet: "Payoneer", date: t.valueDate, currency: t.currency, amount: t.amount });
    } else if (t.kind === "payoneer_withdrawal") {
      events.push({ kind: "wallet_withdrawal", id: t.id, wallet: "Payoneer", date: t.valueDate, currency: t.currency, amount: t.amount });
    } else if (t.kind === "payoneer_card_spend") {
      events.push({ kind: "wallet_spend", id: t.id, wallet: "Payoneer", date: t.valueDate, currency: t.currency, amount: t.amount });
    }
  }
  const openings = taxYearOpenings(b, w);
  for (const o of openings) events.push(...openingEvents(o));
  const bankingShare = events.length ? computeBankingShare(events, w.refRate) : null;

  const proceeds = sumDec([...taxYearCredits(b, w).map((c) => c.pkr), ...openings.flatMap((o) => (o.banked && o.pkr ? [o.pkr] : []))]);

  return {
    today: w.today,
    rules: w.rules,
    workspace: {
      id: w.ws.id,
      kind: w.ws.kind,
      name: w.ws.name,
      emailDomain: w.ws.emailDomain,
      psebRegNo: w.ws.psebRegNo,
      psebValidUntil: w.ws.psebValidUntil,
      atlStatus: w.ws.atlStatus,
      atlCheckedOn: w.ws.atlCheckedOn,
    },
    clients: b.clients.map((c) => ({ id: c.id, name: c.name })),
    invoices,
    matches: b.matches.map((m) => ({
      invoiceId: m.invoiceId,
      transactionId: m.transactionId,
      cashAmount: m.cashAmount,
      feeAmount: m.feeAmount,
      unexplainedAmount: m.unexplainedAmount,
      valueDate: txById.get(m.transactionId)?.valueDate ?? w.today,
    })),
    transactions: b.transactions
      .filter((t) => t.kind === "credit" || t.kind === "payoneer_receipt")
      .map((t) => {
        const acc = t.receivingAccountId ? accountById.get(t.receivingAccountId) : undefined;
        const converted = t.kind === "credit" && !!t.fxRateApplied && t.currency !== "PKR";
        return {
          id: t.id,
          kind: t.kind,
          accountKind: (acc?.kind ?? "platform") as FlagSnapshot["transactions"][number]["accountKind"],
          bankName: acc?.bankName ?? null,
          valueDate: t.valueDate,
          amount: t.amount,
          currency: t.currency,
          pkrAmount: t.pkrAmount,
          fxRateApplied: t.fxRateApplied,
          purposeCode: t.purposeCode,
          payerName: t.payerName,
          referenceRate: converted ? (w.refRate(t.currency, t.valueDate) ?? null) : null,
        };
      }),
    compliance: b.compliance.map((c) => ({ id: c.id, transactionId: c.transactionId, kind: c.kind, status: c.status, purposeCodeOnDocument: c.purposeCodeOnDocument })),
    claims: b.claims.map((c) => ({ id: c.id, clientId: c.clientId, invoiceId: c.invoiceId, claimedOn: c.claimedOn, claimedAmount: c.claimedAmount, currency: c.currency, status: c.status })),
    promises: b.promises.map((p) => ({ id: p.id, invoiceId: p.invoiceId, promisedOn: p.promisedOn, amount: p.amount, status: p.status })),
    reminders: b.reminders.map((r) => ({ invoiceId: r.invoiceId, stage: r.stage, sentOn: r.sentOn })),
    inboundMessages: b.inbound.map((m) => {
      const forwarded = typeof m.extracted?.forwardedFrom === "string" ? m.extracted.forwardedFrom : null;
      const from = forwarded ?? addressOf(m.fromAddress);
      return { id: m.id, from, fromDomain: emailDomain(from), receivedOn: dateInZone(m.sentAt, w.ws.timezone), intent: m.intent, clientId: m.clientId };
    }),
    duplicates: b.transactions
      .filter((t) => t.matchStatus === "duplicate")
      .flatMap((t) => {
        const inv = invoices.find((i) => referenceMentionsInvoice(t.reference, i.number));
        return inv ? [{ transactionId: t.id, invoiceId: inv.id }] : [];
      }),
    bankingShare,
    taxYearProceedsPkr: proceeds.gt(0) ? fixed2(proceeds) : null,
  };
}

/** A cheaper way to pay for clients in these countries (main doc, routes table). Verify before relying on it. */
const ROUTE_HINTS: Record<string, { currency: string; name: string; instructions: string }> = {
  GB: { currency: "GBP", name: "Payoneer (GBP)", instructions: "pay in GBP to our UK receiving account through Payoneer, which avoids intermediary bank charges. Details on request." },
};

/** What drafting needs (core/drafting.ts). */
export function draftContext(b: Books, w: WorkspaceContext): DraftContext {
  const s = w.ws.settings ?? {};
  const invoices = forMatching(b);
  const payoneer = b.accounts.find((a) => a.kind === "payoneer" && a.active);
  const payoneerCurrencies = new Set([payoneer?.currency, ...((payoneer?.receivingDetails?.currencies as string[] | undefined) ?? [])].filter(Boolean));
  const details = (a: (typeof b.accounts)[number]) => (a.receivingDetails ?? {}) as { paymentInstructions?: string; tradeServicesEmail?: string };
  const defaultAccount = b.accounts.find((a) => a.kind === "esfca") ?? b.accounts.find((a) => a.kind === "pkr_account");
  return {
    today: w.today,
    rules: w.rules,
    policy: w.ws.approvalPolicy as ApprovalPolicy,
    grouping: w.ws.numberGrouping,
    workspace: { legalName: w.ws.legalName ?? w.ws.name, ntn: w.ws.ntn, psebRegNo: w.ws.psebRegNo, phone: s.phone ?? null, domain: w.ws.emailDomain },
    sender: { name: s.senderName ?? w.ws.name, title: s.senderTitle ?? "Finance" },
    director: { name: s.directorName ?? s.senderName ?? w.ws.name, title: s.directorTitle ?? "Director", userId: b.owners[0] ?? null },
    clients: new Map(b.clients.map((c) => [c.id, { name: c.name, contactName: c.contactName, contactEmails: c.contactEmails }])),
    invoices: new Map(
      invoices.map((i) => [i.id, { number: i.number, clientId: i.clientId, currency: i.currency, amount: i.amount, balance: i.balance, issuedOn: i.issuedOn, dueOn: i.dueOn, receivingAccountId: b.invoices.find((x) => x.id === i.id)?.receivingAccountId ?? null }]),
    ),
    transactions: new Map(
      b.transactions.map((t) => [t.id, { reference: t.reference, adviceNumber: t.adviceNumber, receivingAccountId: t.receivingAccountId, valueDate: t.valueDate, amount: t.amount, currency: t.currency, payerName: t.payerName, purposeCode: t.purposeCode }]),
    ),
    accounts: new Map(b.accounts.map((a) => [a.id, { label: a.label, bankName: a.bankName, iban: a.iban, paymentInstructions: details(a).paymentInstructions ?? (a.iban ? `IBAN ${a.iban}` : a.label), tradeServicesEmail: details(a).tradeServicesEmail ?? null }])),
    defaultAccountId: defaultAccount?.id ?? null,
    routeHint: (clientId) => {
      const c = b.clients.find((x) => x.id === clientId);
      const hint = c?.country ? ROUTE_HINTS[c.country] : undefined;
      if (!hint || !payoneerCurrencies.has(hint.currency) || c?.preferredRoute === "payoneer") return null;
      return { name: hint.name, instructions: hint.instructions };
    },
    openDisputeInvoiceIds: new Set(b.disputes.filter((d) => d.status === "open").map((d) => d.invoiceId)),
    complianceTransaction: new Map(b.compliance.map((c) => [c.id, { transactionId: c.transactionId, kind: c.kind }])),
  };
}

export { addressOf, addDays };
