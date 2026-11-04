import { describe, expect, it } from "vitest";
import { creditStatus, describeCredit } from "../src/platform";

const at = (iso: string) => new Date(iso);

describe("Vultr credit left", () => {
  it("reads the API's example: a negative balance is credit, pending charges come off it", () => {
    const c = creditStatus({ balance: -100.55, pending_charges: 60.25 }, [], at("2026-11-11T00:00:00Z"));
    expect(c.remainingUsd).toBeCloseTo(40.3, 2);
    expect(c.spendPerDayUsd).toBeCloseTo(6.025, 3); // 10 days into the month
    expect(c.daysLeft).toBeCloseTo(6.69, 2);
    expect(c.low).toBe(true);
  });

  it("counts spending from when this month's first charge started, not the 1st", () => {
    const c = creditStatus({ balance: -200, pending_charges: 2 }, [{ start_date: "2026-11-05T00:00:00+00:00" }], at("2026-11-06T00:00:00Z"));
    expect(c.spendPerDayUsd).toBeCloseTo(2, 5);
    expect(c.daysLeft).toBeCloseTo(99, 5);
    expect(c.low).toBe(false);
  });

  it("clamps charges that started last month to the 1st, and the first hours of a month to one day", () => {
    const c = creditStatus({ balance: -200, pending_charges: 0.5 }, [{ start_date: "2026-10-20T00:00:00Z" }], at("2026-11-01T03:00:00Z"));
    expect(c.spendPerDayUsd).toBeCloseTo(0.5, 5);
  });

  it("nothing running means no end date; owing money means no credit", () => {
    expect(creditStatus({ balance: -200, pending_charges: 0 }, [], at("2026-11-04T00:00:00Z"))).toMatchObject({ daysLeft: null, low: false, remainingUsd: 200 });
    expect(creditStatus({ balance: 5, pending_charges: 3 }, [], at("2026-11-04T00:00:00Z"))).toMatchObject({ remainingUsd: 0, low: true });
  });

  it("ignores line items without a usable start date", () => {
    const c = creditStatus({ balance: -50, pending_charges: 3 }, [{ start_date: "soon" }, { description: "x" }], at("2026-11-04T00:00:00Z"));
    expect(c.spendPerDayUsd).toBeCloseTo(1, 5); // 3 days since Nov 1
  });

  it("says it in one line", () => {
    expect(describeCredit(creditStatus({ balance: -200, pending_charges: 2 }, [{ start_date: "2026-11-05T00:00:00Z" }], at("2026-11-06T00:00:00Z")))).toBe(
      "USD 198.00 credit left, about 99 days at USD 2.00 a day",
    );
    expect(describeCredit(creditStatus({ balance: -10, pending_charges: 0 }, [], at("2026-11-06T00:00:00Z")))).toBe(
      "USD 10.00 credit left, nothing charged yet this month (LOW: top up or scale down)",
    );
  });
});
