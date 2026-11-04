import { describe, expect, it } from "vitest";
import { formatIban, highestSequence, ibanProblem, invoiceNumber, invoiceTotal, lineAmount, paymentInstructions, routeOptions, swiftProblem, type RouteAccount } from "../src";

const ACCOUNTS: RouteAccount[] = [
  { id: "pkr", kind: "pkr_account", label: "Main PKR account", currency: "PKR", bankName: "Shalimar Bank Ltd", iban: "PK33DEMO0001004410001234", swift: "DEMOPKKA", active: true },
  { id: "esf", kind: "esfca", label: "ESFCA", currency: "USD", bankName: "Shalimar Bank Ltd", iban: "PK41DEMO0001004470005678", swift: "DEMOPKKA", active: true },
  { id: "po", kind: "payoneer", label: "Payoneer", currency: "EUR", currencies: ["EUR", "AUD", "GBP"], instructions: "GBP: account 12345678, sort code 23-14-70 (SIMULATED)", active: true },
  { id: "old", kind: "pkr_account", label: "Closed account", currency: "PKR", iban: "PK33DEMO0001004410001234", active: false },
];

describe("IBANs and SWIFT codes", () => {
  it("accepts valid IBANs however they are spaced", () => {
    expect(ibanProblem("PK33DEMO0001004410001234")).toBeNull();
    expect(ibanProblem("pk41 demo 0001 0044 7000 5678")).toBeNull();
    expect(ibanProblem("GB82 WEST 1234 5698 7654 32")).toBeNull();
  });
  it("explains what's wrong with a bad one", () => {
    expect(ibanProblem("PK34DEMO0001004410001234")).toMatch(/check digits/);
    expect(ibanProblem("PK33DEMO000100441000123")).toMatch(/24 characters/);
    expect(ibanProblem("1234")).toMatch(/doesn't look like an IBAN/);
  });
  it("formats and checks SWIFT codes", () => {
    expect(formatIban("PK33DEMO0001004410001234")).toBe("PK33 DEMO 0001 0044 1000 1234");
    expect(swiftProblem("demopkka")).toBeNull();
    expect(swiftProblem("DEMOPKKAXXX")).toBeNull();
    expect(swiftProblem("DEMO")).toMatch(/8 or 11/);
  });
});

describe("route suggestion", () => {
  it("suggests Payoneer for a currency it receives, and says what the last wire cost", () => {
    const opts = routeOptions({ name: "Thames Ledger Ltd", currency: "GBP", lastSwiftFee: { amount: "25.00", currency: "USD", on: "2026-10-28" } }, ACCOUNTS);
    expect(opts.map((o) => [o.route, o.accountId, o.suggested])).toEqual([
      ["payoneer", "po", true],
      ["swift_pkr", "pkr", false],
    ]);
    expect(opts[0]!.reason).toContain("Thames Ledger Ltd's last bank wire lost USD 25.00 to fees (28 October 2026).");
  });
  it("keeps a client's usual route when it still works, and skips inactive accounts", () => {
    const opts = routeOptions({ name: "Northwind Analytics Inc", currency: "USD", preferredRoute: "swift_pkr" }, ACCOUNTS);
    expect(opts.map((o) => o.accountId)).toEqual(["esf", "pkr"]);
    expect(opts.find((o) => o.suggested)?.route).toBe("swift_pkr");
    expect(opts.find((o) => o.suggested)?.reason).toMatch(/^Northwind Analytics Inc's usual route\./);
  });
  it("offers Wise only for currencies Wise sends to Pakistan", () => {
    const wise: RouteAccount = { id: "w", kind: "wise_pkr", label: "Wise", currency: "PKR", iban: "PK86DEMO0002007710009876", active: true };
    expect(routeOptions({ name: "A", currency: "EUR" }, [wise]).map((o) => o.route)).toEqual(["wise_pkr"]);
    expect(routeOptions({ name: "A", currency: "JPY" }, [wise])).toEqual([]);
  });
});

describe("payment instructions", () => {
  it("bank wires get the exact account details, the reference and OUR charges", () => {
    expect(paymentInstructions(ACCOUNTS[1]!, "swift_esfca", "Ravi Code Works (Pvt) Ltd", "INV-2026-033")).toEqual([
      "Beneficiary: Ravi Code Works (Pvt) Ltd",
      "Bank: Shalimar Bank Ltd",
      "IBAN: PK41 DEMO 0001 0044 7000 5678",
      "SWIFT/BIC: DEMOPKKA",
      "Account currency: USD",
      "Payment reference: INV-2026-033",
      "Please send with charges OUR, so the full amount arrives.",
    ]);
  });
  it("Payoneer uses the receiving details as entered", () => {
    expect(paymentInstructions(ACCOUNTS[2]!, "payoneer", "Ravi Code Works (Pvt) Ltd", "INV-2026-033")).toEqual(["GBP: account 12345678, sort code 23-14-70 (SIMULATED)", "Payment reference: INV-2026-033"]);
  });
});

describe("invoice numbers and totals", () => {
  it("numbers continue after the highest one used this year", () => {
    expect(highestSequence(["INV-2026-031", "INV-2026-032", "INV-2025-099", "X-2026-500"], "INV", "2026")).toBe(32);
    expect(invoiceNumber("INV", "2026-11-04", 33)).toBe("INV-2026-033");
    expect(invoiceNumber("AS", "2027-01-02", 1)).toBe("AS-2027-001");
  });
  it("totals are exact decimals", () => {
    expect(lineAmount("1.5", "1200.10").toFixed(2)).toBe("1800.15");
    expect(invoiceTotal([{ description: "a", quantity: "3", unitPrice: "0.10" }, { description: "b", quantity: "1", unitPrice: "3800" }])).toBe("3800.30");
  });
});
