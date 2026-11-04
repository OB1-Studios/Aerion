import { describe, expect, it } from "vitest";
import { checkCredit, creditKindsAllowed, nextCreditNumber, statusAfterCredit } from "../src/index";

const sent = { number: "INV-2026-040", status: "sent" as const, currency: "GBP", applied: "0.00", balance: "1500.00" };

describe("credit notes, write-offs and voids", () => {
  it("allows what the invoice's state allows", () => {
    expect(creditKindsAllowed({ status: "draft", applied: "0", balance: "1500.00" })).toEqual(["void"]);
    expect(creditKindsAllowed(sent)).toEqual(["credit", "write_off", "void"]);
    expect(creditKindsAllowed({ status: "part_paid", applied: "1000.00", balance: "500.00" })).toEqual(["credit", "write_off"]);
    expect(creditKindsAllowed({ status: "paid", applied: "1500.00", balance: "0.00" })).toEqual([]);
    expect(creditKindsAllowed({ status: "void", applied: "0", balance: "0.00" })).toEqual([]);
  });

  it("cleans what was typed, and a void always takes everything still owed", () => {
    expect(checkCredit({ kind: "credit", amount: " 1,250.5 ", reason: "  Late   delivery " }, sent)).toEqual({ problems: [], value: { kind: "credit", amount: "1250.50", reason: "Late delivery" } });
    expect(checkCredit({ kind: "void", amount: "12", reason: "Wrong client" }, sent).value).toEqual({ kind: "void", amount: "1500.00", reason: "Wrong client" });
    expect(checkCredit({ kind: "write_off", amount: "1500.01", reason: "Gone" }, sent).problems).toEqual(["That's more than the GBP 1,500.00 still owed."]);
    expect(checkCredit({ kind: "write_off", amount: "abc", reason: "x".repeat(301) }, sent).problems).toEqual(["The reason is too long (300 characters at most).", "The amount should be more than zero, like 400 or 400.00 (in GBP)."]);
  });

  it("counts an invoice settled this way as paid; only a void makes it void", () => {
    expect(statusAfterCredit("credit", sent, "500.00")).toBe("sent");
    expect(statusAfterCredit("write_off", { status: "part_paid", applied: "1000.00", balance: "500.00" }, "500.00")).toBe("paid");
    expect(statusAfterCredit("credit", sent, "1500.00")).toBe("paid");
    expect(statusAfterCredit("void", sent, "1500.00")).toBe("void");
  });

  it("numbers each kind on its own, starting again each year", () => {
    const used = ["CN-2026-001", "CN-2026-009", "WO-2026-002", "CN-2025-014"];
    expect(nextCreditNumber("credit", 2026, used)).toBe("CN-2026-010");
    expect(nextCreditNumber("write_off", 2026, used)).toBe("WO-2026-003");
    expect(nextCreditNumber("void", 2026, used)).toBe("VD-2026-001");
    expect(nextCreditNumber("credit", 2027, used)).toBe("CN-2027-001");
  });
});
