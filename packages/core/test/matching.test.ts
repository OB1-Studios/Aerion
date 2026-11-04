import { describe, expect, it } from "vitest";
import { matchCredit, matchTransfer, type MatchOutcome } from "../src/matching";
import { ctx, octoberInvoices } from "./fixtures";

function matched(o: MatchOutcome) {
  if (o.status !== "matched") throw new Error(`expected a match, got ${o.status}: ${o.explanation.join(" ")}`);
  return o;
}

describe("demo week events (data spec section 9)", () => {
  it("event 1: Northwind, reference and alias, OUR charges -> tier A, nothing to explain", () => {
    const o = matched(
      matchCredit(
        { id: "t1", valueDate: "2026-10-27", amount: "6400.00", currency: "USD", chargesCode: "OUR", payerName: "NORTHWIND ANALYTICS INC", reference: "INV-2026-025" },
        ctx(),
      ),
    );
    expect(o.tier).toBe("A");
    expect(o.allocations).toHaveLength(1);
    expect(o.allocations[0]).toMatchObject({ invoiceNumber: "INV-2026-025", appliedAmount: "6400.00", feeAmount: "0.00", unexplainedAmount: "0.00" });
  });

  it("event 2: Kestrel via Payoneer, invoice number written with spaces -> tier A", () => {
    const o = matched(
      matchCredit({ id: "t2", valueDate: "2026-10-27", amount: "4250.00", currency: "EUR", payerName: "Kestrel Mobility GmbH", reference: "Payment for INV 2026-026" }, ctx()),
    );
    expect(o.tier).toBe("A");
    expect(o.allocations[0]?.invoiceNumber).toBe("INV-2026-026");
  });

  it("event 3: Wattle with no invoice number, one open invoice fits -> tier B", () => {
    const o = matched(matchCredit({ id: "t3", valueDate: "2026-10-29", amount: "5200.00", currency: "AUD", payerName: "WATTLE DIGITAL PTY LTD" }, ctx()));
    expect(o.tier).toBe("B");
    expect(o.allocations[0]).toMatchObject({ invoiceNumber: "INV-2026-027", appliedAmount: "5200.00", unexplainedAmount: "0.00" });
  });

  it("event 4: Thames short by the USD 25.00 sender's charges stated on the advice -> fee explained", () => {
    const o = matched(
      matchCredit(
        { id: "t4", valueDate: "2026-10-28", amount: "3775.00", currency: "USD", chargesCode: "SHA", chargesAmount: "25.00", chargesCurrency: "USD", payerName: "THAMES LEDGER LTD", reference: "INV-2026-028" },
        ctx(),
      ),
    );
    expect(o.allocations[0]).toMatchObject({ cashAmount: "3775.00", feeAmount: "25.00", feeProbable: false, appliedAmount: "3800.00", unexplainedAmount: "0.00" });
  });

  it("event 5: Maplecroft CAD converted to PKR at 201.90 -> FX cost PKR 11,700.00 (0.64%)", () => {
    const o = matched(
      matchCredit(
        { id: "t5", valueDate: "2026-10-29", amount: "9000.00", currency: "CAD", pkrAmount: "1817100.00", fxRateApplied: "201.90", payerName: "MAPLECROFT STUDIO INC", reference: "INV-2026-030" },
        ctx(),
      ),
    );
    expect(o.allocations[0]).toMatchObject({ appliedAmount: "9000.00", fxDifferencePkr: "-11700.00", fxSpreadPct: "0.64", unexplainedAmount: "0.00" });
    expect(o.explanation.join(" ")).toContain("conversion cost PKR 11,700.00 (0.64%)");
  });

  it("event 6: Al Noor short by USD 750.00 with no charges stated -> unexplained, invoice stays open", () => {
    const o = matched(matchCredit({ id: "t6", valueDate: "2026-10-28", amount: "6750.00", currency: "USD", payerName: "AL NOOR TRADING FZ LLC", reference: "INV-2026-029" }, ctx()));
    expect(o.tier).toBe("A");
    expect(o.allocations[0]).toMatchObject({ appliedAmount: "6750.00", feeAmount: "0.00", unexplainedAmount: "750.00" });
  });

  it("event 7: Varga via Wise at the reference rate, no reference on the advice -> tier B, no FX difference", () => {
    const o = matched(
      matchCredit({ id: "t7", valueDate: "2026-10-30", amount: "1200.00", currency: "EUR", pkrAmount: "393120.00", fxRateApplied: "327.60", payerName: "ELENA VARGA" }, ctx()),
    );
    expect(o.tier).toBe("B");
    expect(o.allocations[0]).toMatchObject({ invoiceNumber: "INV-2026-031", appliedAmount: "1200.00", fxDifferencePkr: "0.00" });
  });

  it("freelancer F3: a PKR-only bank SMS for a EUR invoice -> converted at the reference rate", () => {
    const o = matched(matchCredit({ id: "f3", valueDate: "2026-10-29", amount: "196560.00", currency: "PKR", payerName: "TOBIAS LINDQVIST" }, ctx()));
    expect(o.tier).toBe("B");
    expect(o.allocations[0]).toMatchObject({ invoiceNumber: "INV-AS-2026-018", appliedAmount: "600.00", fxDifferencePkr: "0.00", unexplainedAmount: "0.00" });
  });
});

describe("other matching rules", () => {
  it("a payment naming an invoice that is already paid is a duplicate", () => {
    const invoices = octoberInvoices().map((i) => (i.id === "INV-2026-025" ? { ...i, balance: "0.00", status: "paid" as const } : i));
    const o = matchCredit({ id: "d", valueDate: "2026-10-30", amount: "6400.00", currency: "USD", payerName: "NORTHWIND ANALYTICS INC", reference: "INV-2026-025" }, ctx(invoices));
    expect(o.status).toBe("duplicate");
  });

  it("an unknown payer is left for a person, with the referenced invoice suggested first", () => {
    const o = matchCredit({ id: "u", valueDate: "2026-10-30", amount: "3800.00", currency: "USD", payerName: "SOMEONE ELSE LTD", reference: "INV-2026-028" }, ctx());
    expect(o.status).toBe("unmatched");
    if (o.status === "unmatched") {
      expect(o.candidates[0]?.invoiceNumber).toBe("INV-2026-028");
      expect(o.candidates.length).toBeLessThanOrEqual(3);
    }
  });

  it("one payment covering two invoices settles the oldest first", () => {
    const o = matched(
      matchCredit({ id: "m", valueDate: "2026-10-30", amount: "6700.00", currency: "USD", payerName: "THAMES LEDGER LTD", reference: "INV-2026-024 and INV-2026-028" }, ctx()),
    );
    expect(o.allocations.map((a) => [a.invoiceNumber, a.appliedAmount, a.unexplainedAmount])).toEqual([
      ["INV-2026-024", "2900.00", "0.00"],
      ["INV-2026-028", "3800.00", "0.00"],
    ]);
  });

  it("a small gap with no charges stated is a probable intermediary fee, marked for review", () => {
    const o = matched(matchCredit({ id: "p", valueDate: "2026-10-30", amount: "3770.00", currency: "USD", payerName: "THAMES LEDGER LTD", reference: "INV-2026-028" }, ctx()));
    expect(o.allocations[0]).toMatchObject({ feeAmount: "30.00", feeProbable: true, appliedAmount: "3800.00", unexplainedAmount: "0.00" });
  });

  it("an invoice number must not run on into more digits", () => {
    const o = matchCredit({ id: "x", valueDate: "2026-10-30", amount: "1.00", currency: "USD", payerName: "THAMES LEDGER LTD", reference: "INV-2026-0281" }, ctx());
    expect(o.status).toBe("unmatched");
  });

  it("a PKR credit from Payoneer is linked to the withdrawal, not matched to an invoice", () => {
    const link = matchTransfer(
      { id: "w", valueDate: "2026-10-30", amount: "2350000.00", currency: "PKR", payerName: "PAYONEER INC", reference: "Withdrawal" },
      [
        { id: "pw1", valueDate: "2026-10-30", amount: "4250.00", currency: "EUR", pkrAmount: "2350000.00", linked: false },
        { id: "pw2", valueDate: "2026-09-30", amount: "5200.00", currency: "AUD", pkrAmount: "961480.00", linked: false },
      ],
    );
    expect(link).toEqual({ withdrawalId: "pw1", probable: false });
  });
});
