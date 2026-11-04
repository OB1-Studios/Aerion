import { Decimal, dec, MONTH_NAMES, type IsoDate, type Route } from "@ebo/core";
import type { Db } from "../client";
import type * as s from "../schema";
import type { Storage } from "../storage";
import { generated, marketplaceCsv, payoneerCsv, type AdviceFields, type MarketplaceRow, type PayoneerRow } from "./documents";
import { adviceNo, complianceRows, historyMatch, ibanIsValid, payoneerId, pkt, r2, refRate, Rows, storeInbox, uuid, type InboxSpec } from "./helpers";
import type { SeedWorkspaceOptions } from "./office";

/**
 * Ayesha Siddiqui, the simulated freelancer (data spec section 11): a Flutter developer in
 * Islamabad paid through Payoneer, Wise and Upwork. Not registered with PSEB.
 */

export const FREELANCER_CLOCK = "2026-11-02T09:00:00+05:00";
const BANK = "Shalimar Bank Ltd";
const ALERTS = "Shalimar Bank Alerts <alerts@shalimarbank.example>";
const TRADE = "trade.services@shalimarbank.example";
const MAILBOX = "hello@ayeshabuilds.example";
const NAME = "Ayesha Siddiqui";
const IBAN = "PK86DEMO0002007710009876";
const PAYONEER_HAIRCUT = "0.98";

interface ClientSpec {
  ref: string;
  name: string;
  country: string;
  kind: "business" | "individual" | "marketplace";
  currency: string;
  route: Route;
  terms: number;
  contactName: string | null;
  email: string | null;
  payer: string;
  aliases: string[];
  line: string;
}

const CLIENTS: ClientSpec[] = [
  { ref: "F-C1", name: "Harbor & Pine LLC", country: "US", kind: "business", currency: "USD", route: "payoneer", terms: 30, contactName: "Dana Whitfield", email: "ap@harborandpine.example", payer: "HARBOR AND PINE LLC", aliases: ["HARBOR AND PINE LLC"], line: "Flutter app development, monthly retainer" },
  { ref: "F-C2", name: "Tobias Lindqvist", country: "SE", kind: "individual", currency: "EUR", route: "wise_pkr", terms: 14, contactName: "Tobias Lindqvist", email: "tobias@lindqvist.example", payer: "TOBIAS LINDQVIST", aliases: [], line: "Mobile app bug fixes" },
  { ref: "F-UP", name: "Upwork", country: "US", kind: "marketplace", currency: "USD", route: "platform", terms: 0, contactName: null, email: null, payer: "Upwork", aliases: ["UPWORK"], line: "Marketplace earnings" },
];

const HISTORY: Array<[string, string, string, IsoDate, IsoDate, IsoDate]> = [
  ["INV-AS-2026-013", "F-C1", "2400.00", "2026-07-01", "2026-07-31", "2026-07-24"],
  ["INV-AS-2026-014", "F-C1", "2400.00", "2026-08-01", "2026-08-31", "2026-08-26"],
  ["INV-AS-2026-015", "F-C2", "600.00", "2026-08-10", "2026-08-24", "2026-08-21"],
  ["INV-AS-2026-016", "F-C1", "2400.00", "2026-09-01", "2026-10-01", "2026-09-25"],
];
const OPEN: Array<[string, string, string, IsoDate, IsoDate]> = [
  ["INV-AS-2026-017", "F-C1", "2400.00", "2026-10-01", "2026-10-31"],
  ["INV-AS-2026-018", "F-C2", "600.00", "2026-10-12", "2026-10-26"],
];
/** Upwork: USD 1,800 earned a month, 10% fee, USD 1,620 paid out to Payoneer on the 28th. */
const UPWORK_MONTHS: Array<{ earned: IsoDate; payout: IsoDate }> = [
  { earned: "2026-07-25", payout: "2026-07-28" },
  { earned: "2026-08-25", payout: "2026-08-28" },
  { earned: "2026-09-25", payout: "2026-09-28" },
];
const MONTH_ENDS: IsoDate[] = ["2026-07-31", "2026-08-31", "2026-09-30"];

export async function seedFreelancer(db: Db, storage: Storage, opts: SeedWorkspaceOptions): Promise<{ workspaceId: string }> {
  if (!ibanIsValid(IBAN)) throw new Error(`seed: bad IBAN ${IBAN}`);
  const rows = new Rows();
  const ws = uuid();
  rows.workspace.push({
    id: ws,
    slug: opts.slug,
    name: opts.name ?? NAME,
    kind: "freelancer",
    legalName: NAME,
    city: "Islamabad",
    ntn: "SIM-7654321",
    psebRegNo: null,
    atlStatus: "active",
    atlCheckedOn: "2026-08-15",
    emailDomain: "ayeshabuilds.example",
    approvalPolicy: { mode: "supervised", delayMinutes: 30 },
    numberGrouping: "western",
    invoicePrefix: "INV-AS",
    nextInvoiceSeq: 19,
    timezone: "Asia/Karachi",
    settings: { senderName: NAME, senderTitle: "Flutter developer", directorName: NAME, directorTitle: "Owner", mailboxAddress: MAILBOX },
    isDemo: opts.isDemo ?? true,
    demoClock: new Date(FREELANCER_CLOCK),
    expiresAt: opts.expiresAt ?? null,
  });
  for (const m of opts.members ?? []) rows.member.push({ workspaceId: ws, userId: m.userId, role: m.role });

  const acc = { pkr: uuid(), payoneer: uuid(), upwork: uuid() };
  rows.receivingAccount.push(
    { id: acc.pkr, workspaceId: ws, kind: "pkr_account", label: "Personal PKR account", bankName: BANK, iban: IBAN, swift: "DEMOPKKA", currency: "PKR", receivingDetails: { tradeServicesEmail: TRADE, alertsFrom: "alerts@shalimarbank.example", paymentInstructions: `${BANK}, SWIFT DEMOPKKA, IBAN ${IBAN} (${NAME})` } },
    { id: acc.payoneer, workspaceId: ws, kind: "payoneer", label: "Payoneer", currency: "USD", platformName: "Payoneer", receivingDetails: { simulated: true, paymentInstructions: "Payoneer USD receiving account (SIMULATED details): ACH or wire; details on the invoice", withdrawsTo: "Personal PKR account" } },
    { id: acc.upwork, workspaceId: ws, kind: "platform", label: "Upwork", currency: "USD", platformName: "Upwork", receivingDetails: { simulated: true, paysOutTo: "Payoneer" } },
  );
  const accountForRoute = (route: Route) => (route === "payoneer" ? acc.payoneer : route === "platform" ? acc.upwork : acc.pkr);

  const clientId = new Map<string, string>();
  for (const c of CLIENTS) {
    const id = uuid();
    clientId.set(c.ref, id);
    rows.client.push({ id, workspaceId: ws, name: c.name, country: c.country, kind: c.kind, defaultCurrency: c.currency, preferredRoute: c.route, paymentTermsDays: c.terms, contactName: c.contactName, contactEmails: c.email ? [c.email] : [] });
    for (const alias of c.aliases) rows.clientAlias.push({ workspaceId: ws, clientId: id, alias, source: "manual" });
  }
  const spec = (ref: string) => CLIENTS.find((c) => c.ref === ref)!;

  const invoiceId = new Map<string, string>();
  const addInvoice = (num: string, ref: string, amount: string, issued: IsoDate, due: IsoDate, status: s.InvoiceStatus) => {
    const c = spec(ref);
    const id = uuid();
    invoiceId.set(num, id);
    rows.invoice.push({ id, workspaceId: ws, number: num, clientId: clientId.get(ref)!, currency: c.currency, amount, issuedOn: issued, dueOn: due, route: c.route, receivingAccountId: accountForRoute(c.route), purposeWording: "Payment for IT services exported", status, sentAt: pkt(issued, "11:00") });
    rows.invoiceLine.push({ workspaceId: ws, invoiceId: id, position: 0, description: `${c.line}, ${MONTH_NAMES[Number(issued.slice(5, 7)) - 1]} 2026`, quantity: "1", unitPrice: amount, amount });
  };
  for (const [num, ref, amount, issued, due] of HISTORY) addInvoice(num, ref, amount, issued, due, "paid");
  for (const [num, ref, amount, issued, due] of OPEN) addInvoice(num, ref, amount, issued, due, "sent");

  const wallet: Array<{ date: IsoDate; amount: Decimal }> = [];
  for (const [num, ref, amount, issued, due, paid] of HISTORY) {
    const c = spec(ref);
    const txId = uuid();
    const inv = { id: invoiceId.get(num)!, number: num, clientId: clientId.get(ref)!, currency: c.currency, amount, route: c.route, issuedOn: issued, dueOn: due };
    const client = { id: clientId.get(ref)!, name: c.name, aliases: c.aliases };
    if (c.route === "payoneer") {
      const poId = payoneerId(paid, num);
      rows.transaction.push({ id: txId, workspaceId: ws, kind: "payoneer_receipt", receivingAccountId: acc.payoneer, valueDate: paid, amount, currency: "USD", payerName: c.payer, payerBank: "Payoneer", adviceNumber: poId, reference: `Payment for ${num}`, dedupeKey: `payoneer:${poId}`, matchStatus: "matched" });
      rows.match.push(historyMatch(ws, inv, client, { id: txId, valueDate: paid, amount, currency: "USD", payerName: c.payer, reference: `Payment for ${num}` }));
      wallet.push({ date: paid, amount: dec(amount) });
    } else {
      const rate = r2(refRate("EUR", paid));
      const pkr = r2(dec(amount).times(rate));
      const advice = adviceNo("PKR", paid, num);
      rows.transaction.push({ id: txId, workspaceId: ws, kind: "credit", receivingAccountId: acc.pkr, valueDate: paid, amount, currency: "EUR", pkrAmount: pkr, fxRateApplied: rate, payerName: c.payer, payerBank: "WISE (SIMULATED)", adviceNumber: advice, reference: num, purposeCode: "9186", dedupeKey: `advice:${advice}`, matchStatus: "matched" });
      rows.match.push(historyMatch(ws, inv, client, { id: txId, valueDate: paid, amount, currency: "EUR", pkrAmount: pkr, fxRateApplied: rate, payerName: c.payer, reference: num }));
      rows.complianceItem.push(...complianceRows(ws, txId, paid, { status: "on_file", purposeCode: "9186" }, { status: "on_file" }));
    }
  }

  // Upwork history: earnings and fees on the platform, payouts linked to the Payoneer receipts.
  for (const m of UPWORK_MONTHS) {
    const month = MONTH_NAMES[Number(m.earned.slice(5, 7)) - 1];
    const ref = (k: string) => `UP-${m.earned.slice(2, 7).replace("-", "")}-${k}`;
    const payoutId = uuid();
    const receiptId = uuid();
    const poId = payoneerId(m.payout, `upwork-${m.payout}`);
    rows.transaction.push(
      { workspaceId: ws, kind: "platform_earning", receivingAccountId: acc.upwork, valueDate: m.earned, amount: "1800.00", currency: "USD", payerName: "Fieldnote Labs", reference: `Flutter app development - ${month}`, adviceNumber: ref("E"), dedupeKey: `marketplace:${ref("E")}`, matchStatus: "ignored" },
      { workspaceId: ws, kind: "platform_fee", receivingAccountId: acc.upwork, valueDate: m.earned, amount: "180.00", currency: "USD", reference: "Service fee", adviceNumber: ref("F"), dedupeKey: `marketplace:${ref("F")}`, matchStatus: "ignored" },
      { id: payoutId, workspaceId: ws, kind: "platform_withdrawal", receivingAccountId: acc.upwork, valueDate: m.payout, amount: "1620.00", currency: "USD", reference: "Withdrawal to Payoneer", adviceNumber: ref("P"), dedupeKey: `marketplace:${ref("P")}`, matchStatus: "transfer" },
      { id: receiptId, workspaceId: ws, kind: "payoneer_receipt", receivingAccountId: acc.payoneer, valueDate: m.payout, amount: "1620.00", currency: "USD", payerName: "Upwork", payerBank: "Payoneer", adviceNumber: poId, reference: "Upwork payout", dedupeKey: `payoneer:${poId}`, matchStatus: "transfer" },
    );
    rows.transferLink.push({ workspaceId: ws, fromTransactionId: payoutId, toTransactionId: receiptId, probable: false });
    wallet.push({ date: m.payout, amount: dec("1620.00") });
  }

  for (const end of MONTH_ENDS) {
    const balance = wallet.filter((w) => w.date <= end).reduce((a, w) => a.plus(w.amount), new Decimal(0));
    if (balance.lte(0)) continue;
    wallet.push({ date: end, amount: balance.neg() });
    const rate = r2(dec(refRate("USD", end)).times(PAYONEER_HAIRCUT));
    const pkr = r2(balance.times(rate));
    const poId = payoneerId(end, "withdraw-USD");
    const wId = uuid();
    const cId = uuid();
    const advice = adviceNo("PKR", end, `ayesha-payoneer-${end}`);
    rows.transaction.push(
      { id: wId, workspaceId: ws, kind: "payoneer_withdrawal", receivingAccountId: acc.payoneer, valueDate: end, amount: r2(balance), currency: "USD", pkrAmount: pkr, fxRateApplied: rate, adviceNumber: poId, reference: `Withdrawal to bank account ****9876 (PKR ${pkr})`, dedupeKey: `payoneer:${poId}`, matchStatus: "transfer" },
      { id: cId, workspaceId: ws, kind: "credit", receivingAccountId: acc.pkr, valueDate: end, amount: pkr, currency: "PKR", pkrAmount: pkr, payerName: "PAYONEER INC", payerBank: "DEMO CLEARING PARTNER, KARACHI", adviceNumber: advice, reference: `PAYONEER WITHDRAWAL ${poId}`, purposeCode: "9186", dedupeKey: `advice:${advice}`, matchStatus: "transfer" },
    );
    rows.transferLink.push({ workspaceId: ws, fromTransactionId: wId, toTransactionId: cId, probable: false });
    rows.complianceItem.push(...complianceRows(ws, cId, end, { status: "on_file", purposeCode: "9186" }, { status: "on_file" }));
  }

  await storeInbox(rows, storage, ws, freelancerInbox());
  rows.auditEvent.push({ workspaceId: ws, actorType: "system", actorId: "seed", action: "workspace.seeded", objectType: "workspace", objectId: ws, at: new Date(), details: { dataset: "freelancer", note: "All names, numbers and documents are fictional." } });
  await rows.write(db);
  return { workspaceId: ws };
}

const advice = (a: Omit<AdviceFields, "bankName" | "beneficiary" | "adviceDate"> & { adviceDate?: IsoDate }): AdviceFields => ({ bankName: BANK, beneficiary: NAME, adviceDate: a.adviceDate ?? a.valueDate, ...a });

/** Ayesha's simulated mailbox and uploads. Pure, so the answer key can use it too. */
export function freelancerInbox(): InboxSpec[] {
  const items: InboxSpec[] = [];
  const rate = r2(dec(refRate("USD", "2026-10-30")).times(PAYONEER_HAIRCUT));
  const pkr = r2(dec("4020.00").times(rate));
  const withdrawId = payoneerId("2026-10-30", "withdraw-USD");

  // F2 (Wed Oct 28): October Upwork earnings export.
  const upworkRows: MarketplaceRow[] = [
    { date: "2026-10-25", type: "earning", description: "Flutter app development - October", client: "Fieldnote Labs", amount: "1800.00", currency: "USD", reference: "UP-2610-E" },
    { date: "2026-10-25", type: "fee", description: "Service fee", amount: "-180.00", currency: "USD", reference: "UP-2610-F" },
    { date: "2026-10-28", type: "payout", description: "Withdrawal to Payoneer", amount: "-1620.00", currency: "USD", reference: "UP-2610-P" },
  ];
  items.push({ at: pkt("2026-10-28", "19:00"), channel: "upload", attachments: [{ name: "upwork-earnings-2026-10.csv", mimeType: "text/csv", content: marketplaceCsv(upworkRows), kind: "marketplace_export" }], kindHint: "marketplace_export" });

  // F3 (Thu Oct 29): bank SMS pasted into the app; coded as a home remittance.
  items.push({
    at: pkt("2026-10-29", "14:05"),
    channel: "paste",
    attachments: [generated("pasted-sms-2026-10-29.txt", { type: "sms", fields: { pkrAmount: "196560.00", accountTail: IBAN.slice(-4), payer: "TOBIAS LINDQVIST", via: "WISE", date: "2026-10-29", purposeCode: "9471", bankName: BANK } })],
    kindHint: "pasted_text",
  });

  // F4 (Fri Oct 30): the Payoneer balance (F1 + F2) arrives as a PKR credit.
  const withdrawalAdvice = advice({ adviceNumber: adviceNo("PKR", "2026-10-30", "ayesha-payoneer-2026-10-30"), valueDate: "2026-10-30", iban: IBAN, amount: pkr, currency: "PKR", pkrAmount: pkr, remitter: "PAYONEER INC", remitterBank: "DEMO CLEARING PARTNER, KARACHI", reference: `PAYONEER WITHDRAWAL ${withdrawId}`, purposeCode: "9186" });
  items.push({
    at: pkt("2026-10-30", "16:20"),
    channel: "email",
    from: ALERTS,
    to: MAILBOX,
    subject: `Inward remittance credited: ${withdrawalAdvice.adviceNumber}`,
    body: `Dear Customer,\n\nAn inward remittance has been credited to your account. The credit advice is attached.\n\n${BANK} - Trade Services\nThis is an automated message. (SIMULATED)`,
    attachments: [generated(`advice-${withdrawalAdvice.adviceNumber}.txt`, { type: "advice", fields: withdrawalAdvice })],
  });

  // F1 + the Upwork payout + the withdrawal, in her Payoneer export.
  const payoneerRows: PayoneerRow[] = [
    { date: "2026-10-27", description: "Payment from HARBOR AND PINE LLC - Payment for INV-AS-2026-017", amount: "2400.00", currency: "USD", payer: "HARBOR AND PINE LLC", transactionId: payoneerId("2026-10-27", "INV-AS-2026-017") },
    { date: "2026-10-28", description: "Payment from Upwork - Upwork payout", amount: "1620.00", currency: "USD", payer: "Upwork", transactionId: payoneerId("2026-10-28", "upwork-2026-10-28") },
    { date: "2026-10-30", description: `Withdrawal to bank account ****9876 (PKR ${pkr})`, amount: "-4020.00", currency: "USD", transactionId: withdrawId },
  ];
  items.push({ at: pkt("2026-10-30", "19:00"), channel: "upload", attachments: [{ name: "payoneer-activity-2026-10.csv", mimeType: "text/csv", content: payoneerCsv(payoneerRows), kind: "payoneer_export" }], kindHint: "payoneer_export" });

  // Follow-up week: on Nov 3 the bank re-codes F3, if she sent the purpose-code email (T6).
  const corrected = advice({ adviceNumber: adviceNo("PKR", "2026-10-29", "ayesha-lindqvist-oct"), adviceDate: "2026-11-03", valueDate: "2026-10-29", iban: IBAN, amount: "600.00", currency: "EUR", pkrAmount: "196560.00", fxRate: "327.60", remitter: "TOBIAS LINDQVIST", remitterBank: "WISE (SIMULATED)", remitterSwift: "DEMOBEBB", reference: "INV-AS-2026-018", purposeCode: "9186", corrects: "2026-10-29" });
  items.push({
    at: pkt("2026-11-03", "11:30"),
    channel: "email",
    from: `Shalimar Bank Trade Services <${TRADE}>`,
    to: MAILBOX,
    subject: "RE: Purpose code correction: inward remittance of 29 October 2026",
    body: `Dear Customer,\n\nAs requested, the purpose code of the remittance has been corrected to 9186. The corrected advice is attached.\n\nRegards,\nTrade Services, ${BANK} (SIMULATED)`,
    attachments: [generated(`advice-${corrected.adviceNumber}.txt`, { type: "advice", fields: corrected })],
    requires: "T6",
  });

  return items;
}

export const FREELANCER_FACTS = { workspaceName: NAME, legalName: NAME, iban: IBAN, mailbox: MAILBOX };
