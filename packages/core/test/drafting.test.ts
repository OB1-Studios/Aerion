import { describe, expect, it } from "vitest";
import { planDrafts, type DraftContext } from "../src/drafting";
import { evaluateFlags } from "../src/flags";
import type { ApprovalPolicy } from "../src/policy";
import { mondaySnapshot } from "./monday";
import { rules } from "./fixtures";

const ACCOUNT_INSTRUCTIONS = "Shalimar Bank Ltd, SWIFT DEMOPKKA, IBAN PK41DEMO0001004470005678 (USD account of Ravi Code Works (Pvt) Ltd)";

function context(policy: ApprovalPolicy = { mode: "supervised", delayMinutes: 30 }): DraftContext {
  const s = mondaySnapshot();
  return {
    today: s.today,
    rules,
    policy,
    grouping: "western",
    workspace: { legalName: "Ravi Code Works (Pvt) Ltd", ntn: "SIM-1234567", psebRegNo: "PSEB/SIM/2025/0417", domain: "ravicodeworks.example" },
    sender: { name: "Hamza", title: "Finance" },
    director: { name: "Sana", title: "Director", userId: "u-sana" },
    clients: new Map([
      ["C4", { name: "Thames Ledger Ltd", contactName: "Oliver Grant", contactEmails: ["accounts@thamesledger.example"] }],
      ["C6", { name: "Al Noor Trading FZ-LLC", contactName: "Omar Haddad", contactEmails: ["ap@alnoortrading.example"] }],
      ["C7", { name: "Dr. Elena Varga", contactName: "Dr. Elena Varga", contactEmails: ["elena@varga.example"] }],
      ["C8", { name: "Brightlane Health LLC", contactName: "Priya Raman", contactEmails: ["ap@brightlane.example"] }],
    ]),
    invoices: new Map(s.invoices.map((i) => [i.id, { ...i, receivingAccountId: "esfca" }])),
    transactions: new Map(
      s.transactions.map((t) => [t.id, { ...t, receivingAccountId: t.accountKind === "esfca" ? "esfca" : "pkr", adviceNumber: `ADV-${t.id.toUpperCase()}` }]),
    ),
    accounts: new Map([
      ["esfca", { label: "ESFCA", bankName: "Shalimar Bank Ltd", iban: "PK41DEMO0001004470005678", paymentInstructions: ACCOUNT_INSTRUCTIONS, tradeServicesEmail: "trade.services@shalimarbank.example" }],
      ["pkr", { label: "Main PKR account", bankName: "Shalimar Bank Ltd", iban: "PK33DEMO0001004410001234", paymentInstructions: "IBAN PK33DEMO0001004410001234", tradeServicesEmail: "trade.services@shalimarbank.example" }],
    ]),
    defaultAccountId: "esfca",
    routeHint: (clientId) => (clientId === "C4" ? { name: "Payoneer (GBP)", instructions: "pay in GBP to our UK receiving account; details on request" } : null),
    openDisputeInvoiceIds: new Set(),
    complianceTransaction: new Map(s.compliance.map((c) => [c.id, { transactionId: c.transactionId, kind: c.kind }])),
  };
}

describe("drafts for the Monday run (data spec section 9)", () => {
  const flags = evaluateFlags(mondaySnapshot());
  const drafts = planDrafts(flags, context());
  const emails = drafts.filter((d) => d.kind !== "internal_task");

  it("drafts the expected emails", () => {
    expect(emails.map((d) => d.template).sort()).toEqual(["T2", "T4", "T5", "T6", "T8"]);
  });

  it("every email passes the numbers check and has no unfilled placeholder", () => {
    for (const d of emails) {
      expect(d.numbersCheck?.failures, `${d.template}: ${d.body}`).toEqual([]);
      expect(d.decision?.mode, `${d.template}`).toBe("approve");
      expect(d.body).not.toContain("{{");
      expect(d.subject).not.toContain("{{");
    }
  });

  it("the short-payment email shows the breakdown", () => {
    const t5 = emails.find((d) => d.template === "T5")!;
    expect(t5.to).toBe("ap@alnoortrading.example");
    expect(t5.subject).toBe("INV-2026-029: USD 750.00 short");
    expect(t5.body).toContain("We received USD 6,750.00 on 28 October 2026 against an invoice of USD 7,500.00");
  });

  it("the purpose-code email goes to the bank's trade services, citing the IT code", () => {
    const t6 = emails.find((d) => d.template === "T6")!;
    expect(t6.to).toBe("trade.services@shalimarbank.example");
    expect(t6.body).toContain("It has been coded 9471 (home remittance, verify)");
    expect(t6.body).toContain("should carry purpose code 9186");
  });

  it("H1 and H2 go to the bank in one grouped request", () => {
    const t8 = emails.filter((d) => d.template === "T8");
    expect(t8).toHaveLength(1);
    expect(t8[0]!.flagKeys).toHaveLength(2);
    expect(t8[0]!.body).toContain("ePRC");
    expect(t8[0]!.body).toContain("withholding certificate");
  });

  it("reminder 2 to Thames offers the easier route", () => {
    const t2 = emails.find((d) => d.template === "T2")!;
    expect(t2.subject).toBe("INV-2026-024: now 8 days overdue");
    expect(t2.body).toContain("Payoneer (GBP) is also available");
  });

  it("creates tasks for flags that need a person, not an email", () => {
    expect(drafts.filter((d) => d.kind === "internal_task").map((d) => d.subject).sort()).toEqual([
      "Check the ePRC for INV-2026-018 with the accountant",
      "Renew PSEB registration",
    ]);
  });
});

describe("autopilot (Proposed)", () => {
  it("sends routine emails and holds the short-payment email for 30 minutes", () => {
    const drafts = planDrafts(evaluateFlags(mondaySnapshot()), context({ mode: "autopilot", delayMinutes: 30 }));
    const modes = Object.fromEntries(drafts.filter((d) => d.template).map((d) => [d.template!, d.decision!.mode]));
    expect(modes).toEqual({ T2: "auto", T4: "auto", T5: "delay", T6: "auto", T8: "auto" });
  });
});
