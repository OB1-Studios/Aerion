import { evaluateFlags, type FlagSnapshot } from "../src/flags";
import { computeBankingShare } from "../src/share";
import { octoberInvoices, refRate, rules } from "./fixtures";

export /** The office workspace as the Monday run on 2 Nov 2026 sees it, after matching the demo week. */
function mondaySnapshot(): FlagSnapshot {
  // The office workspace only (the fixture also holds one freelancer invoice).
  const invoices = octoberInvoices().filter((i) => !i.id.startsWith("INV-AS-")).map((i) => {
    const paid = ["INV-2026-025", "INV-2026-026", "INV-2026-027", "INV-2026-028", "INV-2026-030", "INV-2026-031"];
    if (paid.includes(i.id)) return { ...i, balance: "0.00", status: "paid" as const };
    if (i.id === "INV-2026-029") return { ...i, balance: "750.00", status: "part_paid" as const };
    return i;
  });
  // Paid history invoices behind H1, H2 and H3.
  for (const [id, clientId, currency, amount, route, issuedOn, dueOn] of [
    ["INV-2026-018", "C7", "EUR", "1200.00", "wise_pkr", "2026-09-05", "2026-09-19"],
    ["INV-2026-020", "C6", "USD", "7500.00", "swift_esfca", "2026-09-08", "2026-10-08"],
    ["INV-2026-021", "C5", "CAD", "9000.00", "swift_pkr", "2026-09-10", "2026-10-10"],
  ] as const) {
    invoices.push({ id, number: id, clientId, currency, amount, balance: "0.00", route, issuedOn, dueOn, status: "paid" });
  }
  return {
    today: "2026-11-02",
    rules,
    workspace: {
      id: "ws",
      kind: "company",
      name: "Ravi Code Works",
      emailDomain: "ravicodeworks.example",
      psebRegNo: "PSEB/SIM/2025/0417",
      psebValidUntil: "2026-12-15",
      atlStatus: "active",
      atlCheckedOn: "2026-10-16",
    },
    clients: [
      { id: "C4", name: "Thames Ledger Ltd" },
      { id: "C6", name: "Al Noor Trading FZ-LLC" },
      { id: "C7", name: "Dr. Elena Varga" },
      { id: "C8", name: "Brightlane Health LLC" },
    ],
    invoices,
    matches: [
      { invoiceId: "INV-2026-029", transactionId: "t6", cashAmount: "6750.00", feeAmount: "0.00", unexplainedAmount: "750.00", valueDate: "2026-10-28" },
      { invoiceId: "INV-2026-031", transactionId: "t7", cashAmount: "1200.00", feeAmount: "0.00", unexplainedAmount: "0.00", valueDate: "2026-10-30" },
      { invoiceId: "INV-2026-030", transactionId: "t5", cashAmount: "9000.00", feeAmount: "0.00", unexplainedAmount: "0.00", valueDate: "2026-10-29" },
      { invoiceId: "INV-2026-020", transactionId: "h1", cashAmount: "7500.00", feeAmount: "0.00", unexplainedAmount: "0.00", valueDate: "2026-10-06" },
      { invoiceId: "INV-2026-021", transactionId: "h2", cashAmount: "9000.00", feeAmount: "0.00", unexplainedAmount: "0.00", valueDate: "2026-10-09" },
      { invoiceId: "INV-2026-018", transactionId: "h3", cashAmount: "1200.00", feeAmount: "0.00", unexplainedAmount: "0.00", valueDate: "2026-09-17" },
    ],
    transactions: [
      { id: "t5", kind: "credit", accountKind: "pkr_account", bankName: "Shalimar Bank Ltd", valueDate: "2026-10-29", amount: "9000.00", currency: "CAD", pkrAmount: "1817100.00", fxRateApplied: "201.90", purposeCode: "9186", referenceRate: "203.20" },
      { id: "t6", kind: "credit", accountKind: "esfca", bankName: "Shalimar Bank Ltd", valueDate: "2026-10-28", amount: "6750.00", currency: "USD", purposeCode: "9186" },
      { id: "t7", kind: "credit", accountKind: "pkr_account", bankName: "Shalimar Bank Ltd", valueDate: "2026-10-30", amount: "1200.00", currency: "EUR", pkrAmount: "393120.00", fxRateApplied: "327.60", purposeCode: "9471", payerName: "ELENA VARGA" },
      { id: "h1", kind: "credit", accountKind: "esfca", bankName: "Shalimar Bank Ltd", valueDate: "2026-10-06", amount: "7500.00", currency: "USD", purposeCode: "9186" },
      { id: "h2", kind: "credit", accountKind: "pkr_account", bankName: "Shalimar Bank Ltd", valueDate: "2026-10-09", amount: "9000.00", currency: "CAD", purposeCode: "9186" },
      { id: "h3", kind: "credit", accountKind: "pkr_account", bankName: "Shalimar Bank Ltd", valueDate: "2026-09-17", amount: "1200.00", currency: "EUR", purposeCode: "9471" },
    ],
    compliance: [
      { id: "c-t7-eprc", transactionId: "t7", kind: "eprc", status: "missing" },
      { id: "c-t6-eprc", transactionId: "t6", kind: "eprc", status: "missing" },
      { id: "c-h1-eprc", transactionId: "h1", kind: "eprc", status: "missing" },
      { id: "c-h1-wht", transactionId: "h1", kind: "wht_certificate", status: "on_file" },
      { id: "c-h2-eprc", transactionId: "h2", kind: "eprc", status: "on_file", purposeCodeOnDocument: "9186" },
      { id: "c-h2-wht", transactionId: "h2", kind: "wht_certificate", status: "missing" },
      { id: "c-h3-eprc", transactionId: "h3", kind: "eprc", status: "on_file", purposeCodeOnDocument: "9471" },
    ],
    claims: [{ id: "claim-8", clientId: "C8", invoiceId: "INV-2026-032", claimedOn: "2026-10-26", claimedAmount: "5500.00", currency: "USD", status: "open" }],
    promises: [],
    reminders: [{ invoiceId: "INV-2026-024", stage: 1, sentOn: "2026-10-23" }],
    inboundMessages: [],
    duplicates: [],
    bankingShare: computeBankingShare(
      [
        { kind: "bank_credit", id: "b", date: "2026-10-01", currency: "USD", amount: "91890.00" },
        { kind: "wallet_receipt", id: "r", wallet: "Payoneer", date: "2026-08-01", currency: "USD", amount: "25094.00" },
        { kind: "wallet_spend", id: "s", wallet: "Payoneer", date: "2026-08-20", currency: "USD", amount: "1200.00" },
        { kind: "wallet_withdrawal", id: "w", wallet: "Payoneer", date: "2026-09-30", currency: "USD", amount: "23894.00" },
      ],
      refRate,
    ),
  };
}
