/** The agenda: dated obligations in the next two weeks, from explicit inputs (no database). */
import { describe, expect, it } from "vitest";
import { agenda, type AgendaInput } from "../src/agenda";

const base = (over: Partial<AgendaInput> = {}): AgendaInput => ({
  today: "2026-11-02",
  kind: "company",
  invoices: [],
  retainers: [],
  pseb: { regNo: null, validUntil: null },
  months: [],
  ...over,
});
const inv = (number: string, dueOn: string, status = "sent", balance = "100.00") => ({ id: number, number, client: "Thames Ledger Ltd", currency: "USD", balance, dueOn, status });

describe("agenda", () => {
  it("lists open invoices falling due in the next 14 days, soonest first", () => {
    const items = agenda(
      base({
        invoices: [
          inv("INV-3", "2026-11-14"),
          inv("INV-1", "2026-11-02"),
          inv("INV-2", "2026-11-16"), // the 14th day ahead counts
          inv("INV-4", "2026-11-17"), // too far
          inv("INV-5", "2026-11-01"), // already overdue: shown with the overdue invoices, not here
          inv("INV-6", "2026-11-05", "paid", "0.00"),
          inv("INV-7", "2026-11-05", "draft"),
          inv("INV-8", "2026-11-06", "part_paid", "40.00"),
        ],
      }),
    );
    expect(items.map((i) => [i.title, i.inDays])).toEqual([
      ["INV-1 falls due", 0],
      ["INV-8 falls due", 4],
      ["INV-3 falls due", 12],
      ["INV-2 falls due", 14],
    ]);
    expect(items[1]).toMatchObject({ detail: "Thames Ledger Ltd, part paid", amount: { value: "40.00", currency: "USD" }, ref: { type: "invoice", id: "INV-8" } });
  });

  it("shows the next retainer invoice only when its billing day is within reach", () => {
    const retainer = (id: string, billingDay: number, lastPeriod: string | null) => ({ id, clientId: `c-${id}`, client: `Client ${id}`, currency: "USD", amount: "3000.00", terms: { billingDay, startsOn: null, endsOn: null, lastPeriod } });
    const items = agenda(base({ retainers: [retainer("a", 10, "2026-10"), retainer("b", 1, "2026-11"), retainer("c", 25, "2026-10")] }));
    // a bills on 10 Nov; b already drafted November, next is 1 Dec (beyond 14 days); c bills on 25 Nov (beyond).
    expect(items.map((i) => [i.kind, i.date, i.ref.id])).toEqual([["retainer", "2026-11-10", "c-a"]]);
  });

  it("warns about the PSEB registration 60 days ahead, and once it has lapsed", () => {
    expect(agenda(base({ pseb: { regNo: "Z-123", validUntil: "2027-01-31" } }))).toEqual([]);
    expect(agenda(base({ pseb: { regNo: "Z-123", validUntil: "2026-12-31" } }))[0]).toMatchObject({ kind: "pseb", title: "PSEB registration lapses", inDays: 59 });
    expect(agenda(base({ pseb: { regNo: "Z-123", validUntil: "2026-10-30" } }))[0]).toMatchObject({ title: "PSEB registration has lapsed", inDays: -3 });
    expect(agenda(base({ pseb: { regNo: null, validUntil: "2026-10-30" } }))).toEqual([]);
  });

  it("asks offices to close ended months, oldest first, and not freelancers", () => {
    const months = [
      { month: "2026-11", label: "November 2026", ended: false, status: "in_progress" as const, todo: 0, waiting: 0 },
      { month: "2026-10", label: "October 2026", ended: true, status: "todo" as const, todo: 2, waiting: 1 },
      { month: "2026-09", label: "September 2026", ended: true, status: "closed" as const, todo: 0, waiting: 0 },
      { month: "2026-08", label: "August 2026", ended: true, status: "ready" as const, todo: 0, waiting: 0 },
    ];
    expect(agenda(base({ months })).map((i) => [i.title, i.date, i.detail])).toEqual([
      ["Close August 2026", "2026-09-01", "Everything is in: ready to close"],
      ["Close October 2026", "2026-11-01", "2 items to do, 1 item waiting on others"],
    ]);
    expect(agenda(base({ kind: "freelancer", months }))).toEqual([]);
  });
});
