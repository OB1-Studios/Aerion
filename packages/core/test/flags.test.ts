import { describe, expect, it } from "vitest";
import { evaluateFlags, type FlagSnapshot } from "../src/flags";
import { mondaySnapshot } from "./monday";

const byKind = (s: FlagSnapshot) => {
  const flags = evaluateFlags(s);
  return Object.fromEntries(flags.map((f) => [f.kind, f]));
};

describe("the Monday run's flags (data spec section 9, expected summary)", () => {
  const flags = evaluateFlags(mondaySnapshot());
  const kinds = flags.map((f) => f.kind).sort();

  it("raises exactly the expected flags", () => {
    expect(kinds).toEqual(
      [
        "eprc_wrong_code", // H3
        "missing_eprc", // H1
        "missing_wht_certificate", // H2
        "overdue", // event 9
        "pseb_renewal", // H5
        "short_payment", // event 6
        "unconfirmed_payment_claim", // event 8
        "wrong_purpose_code", // event 7
      ].sort(),
    );
  });

  it("short payment: USD 750.00 of USD 7,500.00 is 10%, so high", () => {
    const f = byKind(mondaySnapshot()).short_payment!;
    expect(f.severity).toBe("high");
    expect(f.evidence.difference).toEqual({ type: "money", amount: "750.00", currency: "USD" });
  });

  it("overdue: INV-2026-024 is 8 business days late, so reminder 2 is due", () => {
    const f = byKind(mondaySnapshot()).overdue!;
    expect(f.evidence["days.overdue"]).toEqual({ type: "int", value: 8 });
    expect(f.evidence["reminder.stage"]).toEqual({ type: "int", value: 2 });
    expect(f.evidence["reminder.last_sent_stage"]).toEqual({ type: "int", value: 1 });
  });

  it("missing ePRC for H1 is 27 days old; the new credits are still inside the 14-day wait", () => {
    const missing = flags.filter((f) => f.kind === "missing_eprc");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.evidence["days.since"]).toEqual({ type: "int", value: 27 });
  });

  it("the claim waited 5 business days for a SWIFT payment", () => {
    expect(byKind(mondaySnapshot()).unconfirmed_payment_claim!.evidence["days.waited"]).toEqual({ type: "int", value: 5 });
  });

  it("PSEB renewal 43 days out", () => {
    expect(byKind(mondaySnapshot()).pseb_renewal!.evidence["days.left"]).toEqual({ type: "int", value: 43 });
  });

  it("the share is 98.97%, above the warning level, so no flag", () => {
    expect(mondaySnapshot().bankingShare!.sharePct).toBe("98.97");
  });
});

describe("flags close when their condition stops holding (follow-up week)", () => {
  it("the short payment closes once the balance is paid", () => {
    const s = mondaySnapshot();
    s.invoices = s.invoices.map((i) => (i.id === "INV-2026-029" ? { ...i, balance: "0.00", status: "paid" as const } : i));
    expect(evaluateFlags(s).some((f) => f.kind === "short_payment")).toBe(false);
  });

  it("the wrong code closes once the bank re-codes the credit", () => {
    const s = mondaySnapshot();
    s.transactions = s.transactions.map((t) => (t.id === "t7" ? { ...t, purposeCode: "9186" } : t));
    expect(evaluateFlags(s).some((f) => f.kind === "wrong_purpose_code")).toBe(false);
  });

  it("the claim closes once the money arrives", () => {
    const s = mondaySnapshot();
    s.matches.push({ invoiceId: "INV-2026-032", transactionId: "t8", cashAmount: "5500.00", feeAmount: "0.00", unexplainedAmount: "0.00", valueDate: "2026-11-05" });
    s.today = "2026-11-09";
    expect(evaluateFlags(s).some((f) => f.kind === "unconfirmed_payment_claim")).toBe(false);
  });
});

describe("other flags", () => {
  it("a lookalike sender domain is a bank-detail change", () => {
    const s = mondaySnapshot();
    s.inboundMessages = [{ id: "m10", from: "accounts@ravicodework.example", fromDomain: "ravicodework.example", receivedOn: "2026-10-30" }];
    const f = byKind(s).bank_detail_change!;
    expect(f.severity).toBe("high");
  });

  it("ATL checked more than 30 days ago raises a reminder", () => {
    const s = mondaySnapshot();
    s.workspace.atlCheckedOn = "2026-08-15";
    expect(byKind(s).atl_status!.evidence["days.since"]).toEqual({ type: "int", value: 79 });
  });

  it("freelancer not registered with PSEB: estimate on PKR 4.92 million is about PKR 36,900", () => {
    const s = mondaySnapshot();
    s.workspace = { ...s.workspace, kind: "freelancer", psebRegNo: null, psebValidUntil: null };
    s.taxYearProceedsPkr = "4920000.00";
    const f = byKind(s).pseb_savings_estimate!;
    expect(f.evidence["saving.pkr"]).toEqual({ type: "money", amount: "36900.00", currency: "PKR" });
    expect(f.severity).toBe("info");
  });

  it("a bank rate well below the reference is an info flag", () => {
    const s = mondaySnapshot();
    s.transactions = s.transactions.map((t) => (t.id === "t5" ? { ...t, fxRateApplied: "199.00" } : t));
    expect(byKind(s).fx_spread_high!.severity).toBe("info");
  });
});
