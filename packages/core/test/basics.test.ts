import { describe, expect, it } from "vitest";
import { addBusinessDays, businessDaysBetween, daysBetween, formatDateLong, formatDateShort, taxYearOf, dateInZone, clockNow } from "../src/dates";
import { checkNumbers, ev, missingPlaceholders, renderTemplate } from "../src/evidence";
import { formatMoney, formatRate } from "../src/money";
import { isLookalikeDomain, normalizeName, referenceMentionsInvoice } from "../src/normalize";
import { decideSend } from "../src/policy";
import { computeBankingShare } from "../src/share";
import { refRate } from "./fixtures";

describe("dates", () => {
  it("counts business days the way the spec does", () => {
    expect(businessDaysBetween("2026-10-21", "2026-11-02")).toBe(8);
    expect(businessDaysBetween("2026-10-26", "2026-11-02")).toBe(5);
    expect(addBusinessDays("2026-10-26", 5)).toBe("2026-11-02");
  });
  it("counts calendar days", () => {
    expect(daysBetween("2026-10-06", "2026-11-02")).toBe(27);
    expect(daysBetween("2026-11-02", "2026-12-15")).toBe(43);
  });
  it("formats dates for letters and for Pakistan", () => {
    expect(formatDateLong("2026-11-02")).toBe("2 November 2026");
    expect(formatDateShort("2026-11-02")).toBe("02/11/2026");
  });
  it("knows the tax year runs July to June", () => {
    expect(taxYearOf("2026-11-02")).toEqual({ start: "2026-07-01", end: "2027-06-30", label: "2026-27" });
    expect(taxYearOf("2027-03-15").label).toBe("2026-27");
  });
  it("uses the simulated clock when APP_CLOCK is set", () => {
    const now = clockNow({ APP_CLOCK: "2026-11-02T09:00:00+05:00" });
    expect(dateInZone(now)).toBe("2026-11-02");
  });
});

describe("money", () => {
  it("formats western and lakh grouping", () => {
    expect(formatMoney("1899450", "PKR")).toBe("PKR 1,899,450.00");
    expect(formatMoney("1899450", "PKR", { grouping: "lakh" })).toBe("PKR 18,99,450.00");
    expect(formatMoney("-11700", "PKR")).toBe("PKR -11,700.00");
    expect(formatRate("201.9")).toBe("201.90");
  });
});

describe("names, references and domains", () => {
  it("normalises payer names", () => {
    expect(normalizeName("Al Noor Trading FZ-LLC")).toBe("AL NOOR TRADING FZ LLC");
    expect(normalizeName("Harbor & Pine LLC")).toBe("HARBOR AND PINE LLC");
    expect(normalizeName("Dr. Elena Varga")).toBe("ELENA VARGA");
  });
  it("finds invoice numbers in references", () => {
    expect(referenceMentionsInvoice("INV 2026-026", "INV-2026-026")).toBe(true);
    expect(referenceMentionsInvoice("INV-2026-0261", "INV-2026-026")).toBe(false);
    expect(referenceMentionsInvoice(null, "INV-2026-026")).toBe(false);
  });
  it("spots lookalike domains", () => {
    expect(isLookalikeDomain("ravicodework.example", "ravicodeworks.example", 2)).toBe(true);
    expect(isLookalikeDomain("ravicodeworks.example", "ravicodeworks.example", 2)).toBe(false);
    expect(isLookalikeDomain("northwind.example", "ravicodeworks.example", 2)).toBe(false);
  });
});

describe("numbers check (data spec section 6)", () => {
  const evidence = {
    "invoice.number": ev.text("INV-2026-029"),
    "invoice.amount": ev.money("7500", "USD"),
    received: ev.money("6750", "USD"),
    difference: ev.money("750", "USD"),
    "payment.date": ev.date("2026-10-28"),
  };
  const template =
    "We received {{received}} on {{payment.date}} against {{invoice.number}} for {{invoice.amount}}, which leaves {{difference}} unpaid.";

  it("renders placeholders with proper formatting", () => {
    const r = renderTemplate(template, evidence);
    expect(r.text).toBe("We received USD 6,750.00 on 28 October 2026 against INV-2026-029 for USD 7,500.00, which leaves USD 750.00 unpaid.");
    expect(r.unknown).toEqual([]);
  });

  it("passes when every number came from the evidence", () => {
    const r = checkNumbers(renderTemplate(template, evidence).text, evidence);
    expect(r.ok).toBe(true);
    expect(r.found.map((f) => f.text)).toEqual(["28 October 2026", "6,750.00", "7,500.00", "750.00"]);
  });

  it("blocks a number the model typed itself", () => {
    const r = checkNumbers("Please pay the remaining USD 700.00 within 7 days.", evidence);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.text)).toEqual(["700.00", "7"]);
  });

  it("blocks a date that isn't in the evidence", () => {
    expect(checkNumbers("Payment was received on 29 October 2026.", evidence).ok).toBe(false);
  });

  it("accepts lakh-grouped amounts", () => {
    const e = { pkr: ev.money("1899450", "PKR") };
    expect(checkNumbers(renderTemplate("Credited {{pkr}}.", e, { grouping: "lakh" }).text, e).ok).toBe(true);
  });

  it("notices placeholders a rewrite dropped", () => {
    expect(missingPlaceholders(template, "We received {{received}}. Thanks!")).toEqual(["payment.date", "invoice.number", "invoice.amount", "difference"]);
  });
});

describe("banking-channel share", () => {
  it("counts Payoneer money only when withdrawn, valued first in, first out", () => {
    const s = computeBankingShare(
      [
        { kind: "wallet_receipt", id: "r1", wallet: "Payoneer", date: "2026-07-20", currency: "EUR", amount: "1000.00" },
        { kind: "wallet_receipt", id: "r2", wallet: "Payoneer", date: "2026-08-20", currency: "EUR", amount: "1000.00" },
        { kind: "wallet_withdrawal", id: "w1", wallet: "Payoneer", date: "2026-08-31", currency: "EUR", amount: "1500.00" },
        { kind: "bank_credit", id: "b1", date: "2026-08-05", currency: "USD", amount: "1000.00" },
      ],
      refRate,
    );
    // EUR 1 = 327.60 / 281.40 USD at the fixture rates
    expect(s.walletReceivedUsd).toBe("2328.36");
    expect(s.walletWithdrawnUsd).toBe("1746.27");
    expect(s.walletHeldUsd).toBe("582.09");
    // (1000 + 1746.27) / (1000 + 2328.36) = 82.51%
    expect(s.sharePct).toBe("82.51");
  });
});

describe("send policy", () => {
  const base = { numbersCheckOk: true, missingPlaceholders: [], recipientOnFile: true, clientHasOpenDispute: false };
  it("supervised workspaces approve everything", () => {
    expect(decideSend({ ...base, template: "T1" }, { mode: "supervised", delayMinutes: 30 }).mode).toBe("approve");
  });
  it("autopilot sends routine messages and delays sensitive ones", () => {
    const p = { mode: "autopilot" as const, delayMinutes: 30 };
    expect(decideSend({ ...base, template: "T1" }, p).mode).toBe("auto");
    expect(decideSend({ ...base, template: "T5" }, p).mode).toBe("delay");
    expect(decideSend({ ...base, template: "T1", recipientOnFile: false }, p).mode).toBe("approve");
  });
  it("never sends a draft that fails the numbers check", () => {
    expect(decideSend({ ...base, template: "T1", numbersCheckOk: false }, { mode: "autopilot", delayMinutes: 30 }).mode).toBe("blocked");
  });
});
