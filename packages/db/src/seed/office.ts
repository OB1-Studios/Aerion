import { Decimal, dec, MONTH_NAMES, type IsoDate, type Route } from "@ebo/core";
import type { Db } from "../client";
import type * as s from "../schema";
import type { Storage } from "../storage";
import { eprcText, fakeUetr, generated, payoneerCsv, type AdviceFields, type PayoneerRow } from "./documents";
import { adviceNo, complianceRows, historyMatch, ibanIsValid, payoneerId, pkt, r2, refRate, Rows, storeFile, storeInbox, uuid, type InboxSpec } from "./helpers";

/**
 * Ravi Code Works (Pvt) Ltd, the simulated software house (data spec sections 7 to 10).
 * History Jul-Oct is loaded as already processed; the demo week (Oct 26 - Nov 1) and the
 * follow-up week (Nov 2-8) wait in the simulated mailbox for the runs to pick up.
 */

export interface SeedWorkspaceOptions {
  slug: string;
  name?: string;
  members?: Array<{ userId: string; role: s.Role }>;
  isDemo?: boolean;
  expiresAt?: Date | null;
}

export const OFFICE_CLOCK = "2026-11-02T09:00:00+05:00";
const BANK = "Shalimar Bank Ltd";
const BANK_SWIFT = "DEMOPKKA";
const ALERTS = "Shalimar Bank Alerts <alerts@shalimarbank.example>";
const TRADE = "trade.services@shalimarbank.example";
const MAILBOX = "accounts@ravicodeworks.example";
const LEGAL = "Ravi Code Works (Pvt) Ltd";
const NTN = "SIM-1234567";
const PSEB = "PSEB/SIM/2025/0417";
const IBAN_PKR = "PK33DEMO0001004410001234";
const IBAN_ESFCA = "PK41DEMO0001004470005678";
/** Payoneer's conversion when withdrawing to a Pakistani bank: about 2% below the reference rate (simulated). */
const PAYONEER_HAIRCUT = "0.98";
/** Maplecroft's bank converts CAD about 0.64% below the reference rate (data spec event 5). */
const BANK_CONVERSION = "0.9936";

interface ClientSpec {
  ref: string;
  name: string;
  country: string;
  kind: "business" | "individual";
  currency: string;
  route: Route;
  terms: number;
  contactName: string;
  email: string;
  payer: string;
  remitterBank: string;
  swift: string | null;
  charges: "OUR" | "SHA" | null;
  aliases: string[];
  line: string;
}

const CLIENTS: ClientSpec[] = [
  { ref: "C1", name: "Northwind Analytics Inc", country: "US", kind: "business", currency: "USD", route: "swift_esfca", terms: 30, contactName: "Megan Ross", email: "ap@northwind-analytics.example", payer: "NORTHWIND ANALYTICS INC", remitterBank: "NORTHGATE DEMO BANK, NEW YORK", swift: "DEMOUS33", charges: "OUR", aliases: ["NORTHWIND ANALYTICS INC"], line: "Data platform engineering, monthly retainer" },
  { ref: "C2", name: "Kestrel Mobility GmbH", country: "DE", kind: "business", currency: "EUR", route: "payoneer", terms: 30, contactName: "Jonas Weber", email: "ap@kestrelmobility.example", payer: "Kestrel Mobility GmbH", remitterBank: "Payoneer", swift: null, charges: null, aliases: [], line: "Fleet app development, monthly retainer" },
  { ref: "C3", name: "Wattle Digital Pty Ltd", country: "AU", kind: "business", currency: "AUD", route: "payoneer", terms: 30, contactName: "Chloe Nguyen", email: "accounts@wattledigital.example", payer: "WATTLE DIGITAL PTY LTD", remitterBank: "Payoneer", swift: null, charges: null, aliases: [], line: "Web platform maintenance" },
  { ref: "C4", name: "Thames Ledger Ltd", country: "GB", kind: "business", currency: "USD", route: "swift_esfca", terms: 30, contactName: "Oliver Grant", email: "accounts@thamesledger.example", payer: "THAMES LEDGER LTD", remitterBank: "RIVERSIDE DEMO BANK, LONDON", swift: "DEMOGB2L", charges: "SHA", aliases: [], line: "Accounting integrations, monthly retainer" },
  { ref: "C5", name: "Maplecroft Studio Inc", country: "CA", kind: "business", currency: "CAD", route: "swift_pkr", terms: 30, contactName: "Liam Tremblay", email: "payables@maplecroft.example", payer: "MAPLECROFT STUDIO INC", remitterBank: "MAPLE DEMO BANK, TORONTO", swift: "DEMOCATT", charges: null, aliases: [], line: "Game backend services" },
  { ref: "C6", name: "Al Noor Trading FZ-LLC", country: "AE", kind: "business", currency: "USD", route: "swift_esfca", terms: 30, contactName: "Omar Haddad", email: "ap@alnoortrading.example", payer: "AL NOOR TRADING FZ LLC", remitterBank: "GULF DEMO BANK, DUBAI", swift: "DEMOAEAD", charges: null, aliases: [], line: "ERP customisation, monthly retainer" },
  { ref: "C7", name: "Dr. Elena Varga", country: "IE", kind: "individual", currency: "EUR", route: "wise_pkr", terms: 14, contactName: "Dr. Elena Varga", email: "elena@varga.example", payer: "ELENA VARGA", remitterBank: "WISE (SIMULATED)", swift: "DEMOBEBB", charges: null, aliases: [], line: "Clinic booking app support" },
  { ref: "C8", name: "Brightlane Health LLC", country: "US", kind: "business", currency: "USD", route: "swift_esfca", terms: 30, contactName: "Priya Raman", email: "ap@brightlane.example", payer: "BRIGHTLANE HEALTH LLC", remitterBank: "NORTHGATE DEMO BANK, NEW YORK", swift: "DEMOUS33", charges: null, aliases: [], line: "Patient portal development" },
];

/** Data spec section 8: number, client, amount, issued, due, paid. */
const HISTORY: Array<[string, string, string, IsoDate, IsoDate, IsoDate]> = [
  ["INV-2026-001", "C1", "6400.00", "2026-07-01", "2026-07-31", "2026-07-24"],
  ["INV-2026-002", "C2", "4250.00", "2026-07-01", "2026-07-31", "2026-07-20"],
  ["INV-2026-003", "C3", "5200.00", "2026-07-03", "2026-08-02", "2026-07-29"],
  ["INV-2026-004", "C4", "3800.00", "2026-07-06", "2026-08-05", "2026-08-04"],
  ["INV-2026-005", "C6", "7500.00", "2026-07-08", "2026-08-07", "2026-08-05"],
  ["INV-2026-006", "C5", "9000.00", "2026-07-10", "2026-08-09", "2026-08-07"],
  ["INV-2026-007", "C8", "5500.00", "2026-07-15", "2026-08-14", "2026-08-12"],
  ["INV-2026-008", "C1", "6400.00", "2026-08-01", "2026-08-31", "2026-08-26"],
  ["INV-2026-009", "C2", "4250.00", "2026-08-01", "2026-08-31", "2026-08-21"],
  ["INV-2026-010", "C7", "1200.00", "2026-08-05", "2026-08-19", "2026-08-18"],
  ["INV-2026-011", "C3", "5200.00", "2026-08-03", "2026-09-02", "2026-08-28"],
  ["INV-2026-012", "C4", "3800.00", "2026-08-06", "2026-09-05", "2026-09-03"],
  ["INV-2026-013", "C6", "7500.00", "2026-08-08", "2026-09-07", "2026-09-04"],
  ["INV-2026-014", "C5", "9000.00", "2026-08-10", "2026-09-09", "2026-09-08"],
  ["INV-2026-015", "C8", "5500.00", "2026-08-15", "2026-09-14", "2026-09-14"],
  ["INV-2026-016", "C1", "6400.00", "2026-09-01", "2026-10-01", "2026-09-25"],
  ["INV-2026-017", "C2", "4250.00", "2026-09-01", "2026-10-01", "2026-09-22"],
  ["INV-2026-018", "C7", "1200.00", "2026-09-05", "2026-09-19", "2026-09-17"],
  ["INV-2026-019", "C3", "5200.00", "2026-09-03", "2026-10-03", "2026-09-30"],
  ["INV-2026-020", "C6", "7500.00", "2026-09-08", "2026-10-08", "2026-10-06"],
  ["INV-2026-021", "C5", "9000.00", "2026-09-10", "2026-10-10", "2026-10-09"],
  ["INV-2026-022", "C8", "5500.00", "2026-09-15", "2026-10-15", "2026-10-14"],
  ["INV-2026-023", "C4", "3800.00", "2026-09-06", "2026-10-06", "2026-10-05"],
];

/** Data spec section 9: open October invoices. */
const OCTOBER: Array<[string, string, string, IsoDate, IsoDate, string?]> = [
  ["INV-2026-024", "C4", "2900.00", "2026-09-21", "2026-10-21", "Change request: ledger export module (one-off)"],
  ["INV-2026-025", "C1", "6400.00", "2026-10-01", "2026-10-31"],
  ["INV-2026-026", "C2", "4250.00", "2026-10-01", "2026-10-31"],
  ["INV-2026-027", "C3", "5200.00", "2026-10-03", "2026-11-02"],
  ["INV-2026-028", "C4", "3800.00", "2026-10-06", "2026-11-05"],
  ["INV-2026-029", "C6", "7500.00", "2026-10-08", "2026-11-07"],
  ["INV-2026-030", "C5", "9000.00", "2026-10-10", "2026-11-09"],
  ["INV-2026-031", "C7", "1200.00", "2026-10-12", "2026-10-26"],
  ["INV-2026-032", "C8", "5500.00", "2026-10-15", "2026-11-14"],
];

const MONTH_ENDS: IsoDate[] = ["2026-07-31", "2026-08-31", "2026-09-30"];

export async function seedOffice(db: Db, storage: Storage, opts: SeedWorkspaceOptions): Promise<{ workspaceId: string }> {
  for (const iban of [IBAN_PKR, IBAN_ESFCA]) if (!ibanIsValid(iban)) throw new Error(`seed: bad IBAN ${iban}`);
  const rows = new Rows();
  const ws = uuid();
  rows.workspace.push({
    id: ws,
    slug: opts.slug,
    name: opts.name ?? "Ravi Code Works",
    kind: "company",
    legalName: LEGAL,
    city: "Lahore",
    ntn: NTN,
    secpRegNo: "SIM-0098765",
    psebRegNo: PSEB,
    psebValidUntil: "2026-12-15",
    atlStatus: "active",
    // The spec says Oct 1, but the 30-day ATL check would then fire on Nov 2 and the expected run has none.
    atlCheckedOn: "2026-10-16",
    emailDomain: "ravicodeworks.example",
    approvalPolicy: { mode: "supervised", delayMinutes: 30 },
    numberGrouping: "western",
    invoicePrefix: "INV",
    nextInvoiceSeq: 33,
    timezone: "Asia/Karachi",
    settings: { senderName: "Hamza Rafiq", senderTitle: "Finance", directorName: "Sana Malik", directorTitle: "Director", phone: "+92 42 0000 0417", mailboxAddress: MAILBOX, purposeWording: "Payment for IT services exported" },
    isDemo: opts.isDemo ?? true,
    demoClock: new Date(OFFICE_CLOCK),
    expiresAt: opts.expiresAt ?? null,
  });
  for (const m of opts.members ?? []) rows.member.push({ workspaceId: ws, userId: m.userId, role: m.role });

  // Receiving accounts
  const acc = { pkr: uuid(), esfca: uuid(), payoneer: uuid() };
  const bankDetails = (iban: string, label: string) => ({
    tradeServicesEmail: TRADE,
    alertsFrom: "alerts@shalimarbank.example",
    paymentInstructions: `${BANK}, SWIFT ${BANK_SWIFT}, IBAN ${iban} (${label} of ${LEGAL})`,
  });
  rows.receivingAccount.push(
    { id: acc.pkr, workspaceId: ws, kind: "pkr_account", label: "Main PKR account", bankName: BANK, iban: IBAN_PKR, swift: BANK_SWIFT, currency: "PKR", receivingDetails: bankDetails(IBAN_PKR, "PKR account") },
    { id: acc.esfca, workspaceId: ws, kind: "esfca", label: "ESFCA", bankName: BANK, iban: IBAN_ESFCA, swift: BANK_SWIFT, currency: "USD", receivingDetails: bankDetails(IBAN_ESFCA, "USD account") },
    {
      id: acc.payoneer,
      workspaceId: ws,
      kind: "payoneer",
      label: "Payoneer",
      currency: "EUR",
      platformName: "Payoneer",
      receivingDetails: {
        simulated: true,
        currencies: ["EUR", "AUD", "GBP"],
        paymentInstructions: "Payoneer receiving account (SIMULATED details): EUR by SEPA, AUD by local transfer, GBP by UK transfer; details on the invoice",
        withdrawsTo: "Main PKR account",
      },
    },
  );
  const accountForRoute = (route: Route) => (route === "swift_esfca" ? acc.esfca : route === "payoneer" ? acc.payoneer : acc.pkr);

  // Clients
  const clientId = new Map<string, string>();
  for (const c of CLIENTS) {
    const id = uuid();
    clientId.set(c.ref, id);
    rows.client.push({ id, workspaceId: ws, name: c.name, country: c.country, kind: c.kind, defaultCurrency: c.currency, preferredRoute: c.route, paymentTermsDays: c.terms, contactName: c.contactName, contactEmails: [c.email] });
    for (const alias of c.aliases) rows.clientAlias.push({ workspaceId: ws, clientId: id, alias, source: "manual" });
  }
  const spec = (ref: string) => CLIENTS.find((c) => c.ref === ref)!;

  // Invoices
  const invoiceId = new Map<string, string>();
  const addInvoice = (num: string, ref: string, amount: string, issued: IsoDate, due: IsoDate, status: s.InvoiceStatus, line?: string) => {
    const c = spec(ref);
    const id = uuid();
    invoiceId.set(num, id);
    const month = MONTH_NAMES[Number(issued.slice(5, 7)) - 1];
    rows.invoice.push({
      id,
      workspaceId: ws,
      number: num,
      clientId: clientId.get(ref)!,
      currency: c.currency,
      amount,
      issuedOn: issued,
      dueOn: due,
      route: c.route,
      receivingAccountId: accountForRoute(c.route),
      purposeWording: "Payment for IT services exported",
      status,
      sentAt: pkt(issued, "11:00"),
    });
    rows.invoiceLine.push({ workspaceId: ws, invoiceId: id, position: 0, description: line ?? `${c.line}, ${month} 2026`, quantity: "1", unitPrice: amount, amount });
    return id;
  };
  for (const [num, ref, amount, issued, due] of HISTORY) addInvoice(num, ref, amount, issued, due, "paid");
  for (const [num, ref, amount, issued, due, line] of OCTOBER) addInvoice(num, ref, amount, issued, due, "sent", line);

  // History payments, matched as earlier runs would have done
  const wallet: Array<{ date: IsoDate; currency: string; amount: Decimal }> = [];
  let h3EprcDoc: string | null = null;
  for (const [num, ref, amount, issued, due, paid] of HISTORY) {
    const c = spec(ref);
    const txId = uuid();
    const inv = { id: invoiceId.get(num)!, number: num, clientId: clientId.get(ref)!, currency: c.currency, amount, route: c.route, issuedOn: issued, dueOn: due };
    const client = { id: clientId.get(ref)!, name: c.name, aliases: c.aliases };
    if (c.route === "payoneer") {
      const poId = payoneerId(paid, num);
      rows.transaction.push({ id: txId, workspaceId: ws, kind: "payoneer_receipt", receivingAccountId: acc.payoneer, valueDate: paid, amount, currency: c.currency, payerName: c.payer, payerBank: "Payoneer", adviceNumber: poId, reference: `Payment for ${num}`, dedupeKey: `payoneer:${poId}`, matchStatus: "matched" });
      rows.match.push(historyMatch(ws, inv, client, { id: txId, valueDate: paid, amount, currency: c.currency, payerName: c.payer, reference: `Payment for ${num}` }));
      wallet.push({ date: paid, currency: c.currency, amount: dec(amount) });
      continue;
    }
    const converted = c.route === "swift_pkr" || c.route === "wise_pkr";
    const rate = c.route === "swift_pkr" ? r2(dec(refRate(c.currency, paid)).times(BANK_CONVERSION)) : c.route === "wise_pkr" ? r2(refRate(c.currency, paid)) : null;
    const pkrAmount = rate ? r2(dec(amount).times(rate)) : null;
    const purposeCode = num === "INV-2026-018" ? "9471" : "9186"; // H3: Varga's September payment was coded as a home remittance
    const advice = adviceNo(converted ? "PKR" : "ESF", paid, num);
    rows.transaction.push({
      id: txId,
      workspaceId: ws,
      kind: "credit",
      receivingAccountId: accountForRoute(c.route),
      valueDate: paid,
      amount,
      currency: c.currency,
      pkrAmount,
      fxRateApplied: rate,
      chargesCode: c.charges,
      payerName: c.payer,
      payerBank: c.remitterBank,
      adviceNumber: advice,
      reference: num,
      purposeCode,
      uetr: c.swift && c.route !== "wise_pkr" ? fakeUetr(num) : null,
      dedupeKey: `advice:${advice}`,
      matchStatus: "matched",
    });
    rows.match.push(historyMatch(ws, inv, client, { id: txId, valueDate: paid, amount, currency: c.currency, pkrAmount, fxRateApplied: rate, chargesCode: c.charges, payerName: c.payer, reference: num }));

    if (num === "INV-2026-018") {
      // H3: the ePRC is on file but carries the home-remittance code.
      const text = eprcText({ bankName: BANK, certificateNumber: "EPRC-26-0924-0412", issueDate: "2026-09-24", exporter: LEGAL, ntn: NTN, psebRegNo: PSEB, adviceNumber: advice, valueDate: paid, amount, currency: c.currency, pkrAmount, purposeCode });
      const f = await storeFile(storage, ws, `ePRC-${advice}.txt`, "text/plain", text, "eprc");
      h3EprcDoc = uuid();
      rows.document.push({ id: h3EprcDoc, workspaceId: ws, kind: "eprc", storagePath: f.storagePath, sha256: f.sha256, originalName: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, source: "email", receivedAt: pkt("2026-09-24", "12:30"), parseStatus: "parsed", extracted: { certificate_number: "EPRC-26-0924-0412", advice_number: advice, purpose_code: purposeCode }, model: "seed" });
    }
    rows.complianceItem.push(
      ...complianceRows(
        ws,
        txId,
        paid,
        { status: num === "INV-2026-020" ? "missing" : "on_file", purposeCode, documentId: num === "INV-2026-018" ? h3EprcDoc : null }, // H1: no ePRC
        { status: num === "INV-2026-021" ? "missing" : "on_file" }, // H2: no withholding certificate
      ),
    );
  }

  // H4: USD 1,200 of software subscriptions paid by card from the EUR balance, never withdrawn.
  const spendDate: IsoDate = "2026-08-24";
  const spendEur = r2(dec("1200").times(refRate("USD", spendDate)).div(refRate("EUR", spendDate)));
  const spendId = payoneerId(spendDate, "card-spend");
  rows.transaction.push({ workspaceId: ws, kind: "payoneer_card_spend", receivingAccountId: acc.payoneer, valueDate: spendDate, amount: spendEur, currency: "EUR", adviceNumber: spendId, reference: "Card purchase: software subscriptions (USD 1,200.00)", dedupeKey: `payoneer:${spendId}`, matchStatus: "ignored" });
  wallet.push({ date: spendDate, currency: "EUR", amount: dec(spendEur).neg() });

  // Month-end Payoneer withdrawals of the whole EUR and AUD balance, each arriving as a PKR credit.
  for (const end of MONTH_ENDS) {
    for (const ccy of ["EUR", "AUD"]) {
      const balance = wallet.filter((w) => w.currency === ccy && w.date <= end).reduce((a, w) => a.plus(w.amount), new Decimal(0));
      if (balance.lte(0)) continue;
      wallet.push({ date: end, currency: ccy, amount: balance.neg() });
      const rate = r2(dec(refRate(ccy, end)).times(PAYONEER_HAIRCUT));
      const pkr = r2(balance.times(rate));
      const poId = payoneerId(end, `withdraw-${ccy}`);
      const wId = uuid();
      const cId = uuid();
      const advice = adviceNo("PKR", end, `payoneer-${ccy}-${end}`);
      rows.transaction.push(
        { id: wId, workspaceId: ws, kind: "payoneer_withdrawal", receivingAccountId: acc.payoneer, valueDate: end, amount: r2(balance), currency: ccy, pkrAmount: pkr, fxRateApplied: rate, adviceNumber: poId, reference: `Withdrawal to bank account ****1234 (PKR ${pkr})`, dedupeKey: `payoneer:${poId}`, matchStatus: "transfer" },
        { id: cId, workspaceId: ws, kind: "credit", receivingAccountId: acc.pkr, valueDate: end, amount: pkr, currency: "PKR", pkrAmount: pkr, payerName: "PAYONEER INC", payerBank: "DEMO CLEARING PARTNER, KARACHI", adviceNumber: advice, reference: `PAYONEER WITHDRAWAL ${poId}`, purposeCode: "9186", dedupeKey: `advice:${advice}`, matchStatus: "transfer" },
      );
      rows.transferLink.push({ workspaceId: ws, fromTransactionId: wId, toTransactionId: cId, probable: false });
      rows.complianceItem.push(...complianceRows(ws, cId, end, { status: "on_file", purposeCode: "9186" }, { status: "on_file" }));
    }
  }

  // Thames: invoice INV-2026-024 sent Sep 21, reminder 1 on Oct 23, no reply (event 9).
  const thames = spec("C4");
  rows.message.push(
    { workspaceId: ws, threadKey: "INV-2026-024", direction: "out", fromAddress: MAILBOX, toAddress: thames.email, subject: `INV-2026-024 from ${LEGAL}: USD 2,900.00 due 21 October 2026`, sentAt: pkt("2026-09-21", "11:00"), bodyText: `Hi Oliver,\n\nPlease find attached invoice INV-2026-024 for USD 2,900.00, due on 21 October 2026.\n\nHamza Rafiq\nFinance, ${LEGAL}`, clientId: clientId.get("C4") },
    { workspaceId: ws, threadKey: "INV-2026-024", direction: "out", fromAddress: MAILBOX, toAddress: thames.email, subject: "INV-2026-024: payment reminder", sentAt: pkt("2026-10-23", "10:30"), bodyText: `Hi Oliver,\n\nA quick reminder that invoice INV-2026-024 for USD 2,900.00 was due on 21 October 2026. If it's already on its way, thank you, and please ignore this.\n\nBest regards,\nHamza Rafiq\nFinance, ${LEGAL}`, clientId: clientId.get("C4") },
  );
  rows.invoiceReminder.push({ workspaceId: ws, invoiceId: invoiceId.get("INV-2026-024")!, stage: 1, sentOn: "2026-10-23" });

  // Two conversions from the ESFCA, in months already closed (W14). Rates sit a little under the reference.
  for (const [on, amount, ratePct, ref] of [["2026-08-12", "8000.00", "0.990", "FXC-0812-0041"], ["2026-09-16", "10000.00", "0.980", "FXC-0916-0057"]] as const) {
    const fxRate = dec(refRate("USD", on)).times(ratePct).toFixed(4);
    const pkrAmount = dec(amount).times(fxRate).toFixed(2);
    rows.transaction.push({ workspaceId: ws, kind: "fx_conversion", receivingAccountId: acc.esfca, valueDate: on, amount, currency: "USD", pkrAmount, fxRateApplied: fxRate, adviceNumber: ref, dedupeKey: `conversion:${acc.esfca}:${on}:${amount}:${pkrAmount}`, matchStatus: "ignored", createdAt: pkt(on, "12:00") });
  }

  await storeInbox(rows, storage, ws, officeInbox());
  // July to September were closed by finance before the demo begins (without the app's report);
  // October is the month to close after the Monday run.
  const closer = (opts.members ?? []).find((m) => m.role === "finance")?.userId ?? null;
  for (const [month, on] of [["2026-07", "2026-08-05"], ["2026-08", "2026-09-03"], ["2026-09", "2026-10-05"]] as const) {
    const at = pkt(on, "11:00");
    rows.closePeriod.push({ workspaceId: ws, month, status: "closed", closedBy: closer, createdAt: at, checklist: { closedAt: at.toISOString(), seeded: true, note: "Closed before the demo began, so there's no report from the app." } });
  }
  rows.auditEvent.push({ workspaceId: ws, actorType: "system", actorId: "seed", action: "workspace.seeded", objectType: "workspace", objectId: ws, at: new Date(), details: { dataset: "office", note: "All names, numbers and documents are fictional." } });
  await rows.write(db);
  return { workspaceId: ws };
}

// ---------------------------------------------------------------------------
// The simulated mailbox: demo week and follow-up week
// ---------------------------------------------------------------------------

function advice(a: Omit<AdviceFields, "bankName" | "beneficiary" | "adviceDate"> & { adviceDate?: IsoDate }): AdviceFields {
  return { bankName: BANK, beneficiary: LEGAL, adviceDate: a.adviceDate ?? a.valueDate, ...a };
}

function adviceEmail(at: Date, a: AdviceFields, extra: Partial<InboxSpec> = {}): InboxSpec {
  return {
    at,
    channel: "email",
    from: ALERTS,
    to: MAILBOX,
    subject: `${a.corrects ? "Corrected advice" : "Inward remittance credited"}: ${a.adviceNumber}`,
    body: `Dear Customer,\n\n${a.corrects ? "Please find attached the corrected credit advice for the inward remittance below." : "An inward remittance has been credited to your account. The credit advice is attached."}\n\nAdvice No. ${a.adviceNumber}\n\n${BANK} - Trade Services\nThis is an automated message. (SIMULATED)`,
    attachments: [generated(`advice-${a.adviceNumber}.txt`, { type: "advice", fields: a })],
    ...extra,
  };
}

/** The office's simulated mailbox: the demo week and the follow-up week. Pure, so the answer key can use it too. */
export function officeInbox(): InboxSpec[] {
  const items: InboxSpec[] = [];
  const day = (d: IsoDate, t: string) => pkt(d, t);

  // Event 8 (Mon Oct 26): Brightlane says it paid, with a screenshot. No credit arrives.
  items.push({
    at: day("2026-10-26", "18:40"),
    channel: "email",
    from: "Priya Raman <ap@brightlane.example>",
    to: MAILBOX,
    subject: "RE: Invoice INV-2026-032",
    body: "Hi Hamza,\n\nPayment sent today, see attached.\n\nThanks,\nPriya Raman\nAccounts Payable, Brightlane Health LLC",
    attachments: [generated("transfer-confirmation.svg", { type: "screenshot", fields: { amount: "5500.00", currency: "USD", beneficiary: LEGAL, accountTail: IBAN_ESFCA.slice(-4), date: "2026-10-26", reference: "INV-2026-032" } })],
  });

  // Event 1 (Tue Oct 27): Northwind, reference and OUR charges.
  items.push(adviceEmail(day("2026-10-27", "11:15"), advice({ adviceNumber: adviceNo("ESF", "2026-10-27", "INV-2026-025"), valueDate: "2026-10-27", iban: IBAN_ESFCA, amount: "6400.00", currency: "USD", remitter: "NORTHWIND ANALYTICS INC", remitterBank: "NORTHGATE DEMO BANK, NEW YORK", remitterSwift: "DEMOUS33", reference: "INV-2026-025", chargesCode: "OUR", purposeCode: "9186", uetr: fakeUetr("INV-2026-025") })));

  // Event 4 (Wed Oct 28): Thames, USD 25.00 sender's charges stated.
  items.push(adviceEmail(day("2026-10-28", "10:20"), advice({ adviceNumber: adviceNo("ESF", "2026-10-28", "INV-2026-028"), valueDate: "2026-10-28", iban: IBAN_ESFCA, amount: "3775.00", currency: "USD", remitter: "THAMES LEDGER LTD", remitterBank: "RIVERSIDE DEMO BANK, LONDON", remitterSwift: "DEMOGB2L", reference: "INV-2026-028", chargesCode: "SHA", chargesAmount: "25.00", purposeCode: "9186", uetr: fakeUetr("INV-2026-028") })));

  // Event 6 (Wed Oct 28): Al Noor pays USD 6,750.00 against USD 7,500.00, no charges stated.
  items.push(adviceEmail(day("2026-10-28", "12:05"), advice({ adviceNumber: adviceNo("ESF", "2026-10-28", "INV-2026-029"), valueDate: "2026-10-28", iban: IBAN_ESFCA, amount: "6750.00", currency: "USD", remitter: "AL NOOR TRADING FZ LLC", remitterBank: "GULF DEMO BANK, DUBAI", remitterSwift: "DEMOAEAD", reference: "INV-2026-029", purposeCode: "9186", uetr: fakeUetr("INV-2026-029") })));

  // Event 5 (Thu Oct 29): Maplecroft CAD converted to PKR at 201.90.
  items.push(adviceEmail(day("2026-10-29", "11:30"), advice({ adviceNumber: adviceNo("PKR", "2026-10-29", "INV-2026-030"), valueDate: "2026-10-29", iban: IBAN_PKR, amount: "9000.00", currency: "CAD", pkrAmount: "1817100.00", fxRate: "201.90", remitter: "MAPLECROFT STUDIO INC", remitterBank: "MAPLE DEMO BANK, TORONTO", remitterSwift: "DEMOCATT", reference: "INV-2026-030", purposeCode: "9186", uetr: fakeUetr("INV-2026-030") })));

  // Event 7 (Fri Oct 30): Varga via Wise, coded as a home remittance.
  const vargaAdvice = advice({ adviceNumber: adviceNo("PKR", "2026-10-30", "INV-2026-031"), valueDate: "2026-10-30", iban: IBAN_PKR, amount: "1200.00", currency: "EUR", pkrAmount: "393120.00", fxRate: "327.60", remitter: "ELENA VARGA", remitterBank: "WISE (SIMULATED)", remitterSwift: "DEMOBEBB", reference: "INV-2026-031", purposeCode: "9471" });
  items.push(adviceEmail(day("2026-10-30", "10:45"), vargaAdvice));

  // Event 10 (Fri Oct 30): Kestrel forwards an email from a lookalike domain with "new bank details".
  items.push({
    at: day("2026-10-30", "13:25"),
    channel: "email",
    from: "Jonas Weber <ap@kestrelmobility.example>",
    to: MAILBOX,
    subject: "Fwd: Updated bank details for future payments",
    body: [
      "Hi Hamza,",
      "",
      "We received the email below from your accounts team. Before we change anything in our system, can you confirm these are your new bank details? Our November payment run is next week.",
      "",
      "Best regards,",
      "Jonas Weber",
      "Accounts Payable, Kestrel Mobility GmbH",
      "",
      "---------- Forwarded message ----------",
      "From: Accounts Team <accounts@ravicodework.example>",
      "Date: Thu, 29 Oct 2026 16:42",
      "Subject: Updated bank details for future payments",
      "",
      "Dear Kestrel Mobility team,",
      "",
      "Please note that our bank details have changed. With immediate effect, please send all payments to our new account:",
      "",
      "Bank: Continental Demo Bank, Riga",
      "IBAN: LV00 DEMO 0000 0000 0000 0",
      "",
      "Please ignore any previous instructions and update your vendor records today. Payments to the old account will be returned.",
      "",
      "Regards,",
      "Accounts Team",
      "Ravi Code Works",
    ].join("\n"),
    attachments: [],
  });

  // Payoneer withdrawal on Oct 30 of the EUR and AUD received this week, arriving as two PKR credits.
  const withdrawals = [
    { ccy: "EUR", amount: "4250.00", rate: r2(dec(refRate("EUR", "2026-10-30")).times(PAYONEER_HAIRCUT)) },
    { ccy: "AUD", amount: "5200.00", rate: r2(dec(refRate("AUD", "2026-10-30")).times(PAYONEER_HAIRCUT)) },
  ].map((w) => ({ ...w, pkr: r2(dec(w.amount).times(w.rate)), poId: payoneerId("2026-10-30", `withdraw-${w.ccy}`) }));
  withdrawals.forEach((w, i) => {
    items.push(adviceEmail(day("2026-10-30", `16:1${i}`), advice({ adviceNumber: adviceNo("PKR", "2026-10-30", `payoneer-${w.ccy}`), valueDate: "2026-10-30", iban: IBAN_PKR, amount: w.pkr, currency: "PKR", pkrAmount: w.pkr, remitter: "PAYONEER INC", remitterBank: "DEMO CLEARING PARTNER, KARACHI", reference: `PAYONEER WITHDRAWAL ${w.poId}`, purposeCode: "9186" })));
  });

  // Hamza uploads the week's Payoneer export on Friday evening (events 2 and 3, and the withdrawals).
  const payoneerRows: PayoneerRow[] = [
    { date: "2026-10-27", description: "Payment from Kestrel Mobility GmbH - Payment for INV 2026-026", amount: "4250.00", currency: "EUR", payer: "Kestrel Mobility GmbH", transactionId: payoneerId("2026-10-27", "INV-2026-026") },
    { date: "2026-10-29", description: "Payment from WATTLE DIGITAL PTY LTD - October services", amount: "5200.00", currency: "AUD", payer: "WATTLE DIGITAL PTY LTD", transactionId: payoneerId("2026-10-29", "INV-2026-027") },
    ...withdrawals.map((w) => ({ date: "2026-10-30", description: `Withdrawal to bank account ****1234 (PKR ${w.pkr})`, amount: `-${w.amount}`, currency: w.ccy, transactionId: w.poId })),
  ];
  items.push({ at: day("2026-10-30", "18:30"), channel: "upload", attachments: [{ name: "payoneer-activity-2026-10-26_2026-10-30.csv", mimeType: "text/csv", content: payoneerCsv(payoneerRows), kind: "payoneer_export" }], kindHint: "payoneer_export" });

  // ---- Follow-up week (Nov 2-8). Replies only come if our email went out first. ----

  // Nov 3: the bank re-codes event 7 after the purpose-code email (T6).
  items.push(
    adviceEmail(day("2026-11-03", "11:00"), { ...vargaAdvice, adviceDate: "2026-11-03", purposeCode: "9186", corrects: "2026-10-30" }, {
      from: `Shalimar Bank Trade Services <${TRADE}>`,
      subject: `RE: Purpose code correction: inward remittance ${vargaAdvice.adviceNumber}`,
      body: `Dear Customer,\n\nAs requested, the purpose code of the remittance has been corrected to 9186. The corrected advice is attached; the ePRC will be issued with the corrected code.\n\nRegards,\nTrade Services, ${BANK} (SIMULATED)`,
      requires: "T6",
    }),
  );

  // Nov 4: the ePRC for INV-2026-020 (H1) after the missing-documents email (T8).
  const h1Advice = adviceNo("ESF", "2026-10-06", "INV-2026-020");
  items.push({
    at: day("2026-11-04", "10:30"),
    channel: "email",
    from: `Shalimar Bank Trade Services <${TRADE}>`,
    to: MAILBOX,
    subject: `ePRC issued: ${h1Advice}`,
    body: `Dear Customer,\n\nPlease find attached the ePRC for the inward remittance ${h1Advice}. The withholding certificate will follow separately.\n\nRegards,\nTrade Services, ${BANK} (SIMULATED)`,
    attachments: [generated(`ePRC-${h1Advice}.txt`, { type: "eprc", fields: { bankName: BANK, certificateNumber: "EPRC-26-1104-0233", issueDate: "2026-11-04", exporter: LEGAL, ntn: NTN, psebRegNo: PSEB, adviceNumber: h1Advice, valueDate: "2026-10-06", amount: "7500.00", currency: "USD", purposeCode: "9186" } })],
    requires: "T8",
  });

  // Nov 4: Al Noor explains the USD 750.00 after the short-payment email (T5); the balance arrives Nov 6.
  items.push({
    at: day("2026-11-04", "15:00"),
    channel: "email",
    from: "Omar Haddad <ap@alnoortrading.example>",
    to: MAILBOX,
    subject: "RE: INV-2026-029: USD 750.00 short",
    body: "Dear Hamza,\n\nApologies for this. Our treasury team withheld USD 750.00 by mistake. We will send the balance this week.\n\nKind regards,\nOmar Haddad\nAl Noor Trading FZ-LLC",
    attachments: [],
    requires: "T5",
  });
  items.push(adviceEmail(day("2026-11-06", "11:00"), advice({ adviceNumber: adviceNo("ESF", "2026-11-06", "INV-2026-029-balance"), valueDate: "2026-11-06", iban: IBAN_ESFCA, amount: "750.00", currency: "USD", remitter: "AL NOOR TRADING FZ LLC", remitterBank: "GULF DEMO BANK, DUBAI", remitterSwift: "DEMOAEAD", reference: "INV-2026-029 BALANCE", purposeCode: "9186", uetr: fakeUetr("INV-2026-029-balance") }), { requires: "T5" }));

  // Nov 5: Brightlane sends the MT103 after our request (T4); the traced wire lands the same day.
  const uetr = fakeUetr("INV-2026-032");
  items.push({
    at: day("2026-11-05", "09:40"),
    channel: "email",
    from: "Priya Raman <ap@brightlane.example>",
    to: MAILBOX,
    subject: "RE: INV-2026-032: we haven't received the payment yet",
    body: `Hi Hamza,\n\nOur bank confirmed the wire was held at an intermediary. The MT103 is attached; the UETR is ${uetr}.\n\nThanks,\nPriya`,
    attachments: [generated("MT103-BLH2610260032.txt", { type: "mt103", fields: { reference: "BLH2610260032", valueDate: "2026-10-26", currency: "USD", amount: "5500.00", orderingCustomer: "BRIGHTLANE HEALTH LLC", senderSwift: "DEMOUS33", beneficiaryIban: IBAN_ESFCA, beneficiary: LEGAL, remittanceInfo: "INV-2026-032", uetr } })],
    requires: "T4",
  });
  items.push(adviceEmail(day("2026-11-05", "12:00"), advice({ adviceNumber: adviceNo("ESF", "2026-11-05", "INV-2026-032"), valueDate: "2026-11-05", iban: IBAN_ESFCA, amount: "5500.00", currency: "USD", remitter: "BRIGHTLANE HEALTH LLC", remitterBank: "NORTHGATE DEMO BANK, NEW YORK", remitterSwift: "DEMOUS33", reference: "INV-2026-032", chargesCode: "OUR", purposeCode: "9186", uetr }), { requires: "T4" }));

  return items;
}

export const OFFICE_FACTS = { workspaceName: "Ravi Code Works", legalName: LEGAL, ibanPkr: IBAN_PKR, ibanEsfca: IBAN_ESFCA, mailbox: MAILBOX };
