import { describe, expect, it } from "vitest";
import { checkRetainer, nextRetainerDate, periodLabel, retainerDue, type RetainerTerms } from "../src";

const harbor: RetainerTerms = { billingDay: 1, startsOn: "2026-07-01", endsOn: null, lastPeriod: "2026-10" };

describe("when a retainer invoice is due", () => {
  it("drafts the month once its billing day has come, and only once", () => {
    expect(retainerDue(harbor, "2026-10-31")).toBeNull();
    expect(retainerDue(harbor, "2026-11-01")).toEqual({ period: "2026-11", billingDate: "2026-11-01" });
    expect(retainerDue(harbor, "2026-11-02")).toEqual({ period: "2026-11", billingDate: "2026-11-01" });
    expect(retainerDue({ ...harbor, lastPeriod: "2026-11" }, "2026-11-20")).toBeNull();
    expect(retainerDue({ ...harbor, billingDay: 15 }, "2026-11-14")).toBeNull();
    expect(retainerDue({ ...harbor, billingDay: 15 }, "2026-11-15")).toEqual({ period: "2026-11", billingDate: "2026-11-15" });
  });

  it("never back-fills: a retainer added mid-month starts at the next billing day", () => {
    const added = { billingDay: 1, startsOn: "2026-11-15", endsOn: null, lastPeriod: null };
    expect(retainerDue(added, "2026-11-20")).toBeNull();
    expect(nextRetainerDate(added, "2026-11-20")).toBe("2026-12-01");
    expect(retainerDue(added, "2026-12-07")).toEqual({ period: "2026-12", billingDate: "2026-12-01" });
    // Missed months stay missed: a run in January drafts January only.
    expect(retainerDue({ ...added, lastPeriod: "2026-11" }, "2027-01-04")).toEqual({ period: "2027-01", billingDate: "2027-01-01" });
  });

  it("stops after the end date, but bills the last month it covered", () => {
    expect(retainerDue({ ...harbor, endsOn: "2026-10-31" }, "2026-11-02")).toBeNull();
    expect(retainerDue({ ...harbor, endsOn: "2026-11-20" }, "2026-11-25")).toEqual({ period: "2026-11", billingDate: "2026-11-01" });
    expect(nextRetainerDate({ ...harbor, endsOn: "2026-10-31" }, "2026-11-02")).toBeNull();
  });

  it("says when the next invoice will be drafted", () => {
    expect(nextRetainerDate(harbor, "2026-11-02")).toBe("2026-11-01"); // due now: the next run drafts it
    expect(nextRetainerDate({ ...harbor, lastPeriod: "2026-11" }, "2026-11-02")).toBe("2026-12-01");
    expect(nextRetainerDate({ ...harbor, lastPeriod: "2026-12" }, "2026-12-09")).toBe("2027-01-01");
    expect(nextRetainerDate({ ...harbor, billingDay: 28, lastPeriod: "2026-10" }, "2026-11-02")).toBe("2026-11-28");
  });

  it("names the month", () => {
    expect(periodLabel("2026-11")).toBe("November 2026");
    expect(periodLabel("2027-01")).toBe("January 2027");
  });
});

describe("checking a new retainer", () => {
  const ok = { description: "  Flutter app development,   monthly retainer ", amount: "2,400", currency: "usd", billingDay: "1", startsOn: "2026-11-01" };
  it("cleans what was typed", () => {
    expect(checkRetainer(ok)).toEqual({ problems: [], value: { description: "Flutter app development, monthly retainer", amount: "2400.00", currency: "USD", billingDay: 1, startsOn: "2026-11-01" } });
  });
  it("explains each problem in plain words", () => {
    expect(checkRetainer({ description: "", amount: "0", currency: "dollars", billingDay: "31", startsOn: "2026-02-30" }).problems).toEqual([
      "Describe the work, as it should read on the invoice.",
      "The monthly amount should be more than zero, like 2400 or 2400.00.",
      "The currency should be a three-letter code, like USD.",
      "The billing day should be from 1 to 28, so it falls in every month.",
      "The start date isn't a date.",
    ]);
    expect(checkRetainer({ ...ok, amount: "12.345" }).problems).toEqual(["The monthly amount should be more than zero, like 2400 or 2400.00."]);
  });
});
