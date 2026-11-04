/**
 * The dashboard on the simulated dataset after the Monday 2 Nov run, against the local
 * database. The expected figures come from the data spec's events: Thames's USD 2,900 is the
 * one overdue invoice, event 4's USD 25.00 is the only bank charge, wires converted to PKR
 * lost PKR 46,800 against the reference rate (event 5's 11,700 included), and Payoneer
 * withdrawals land 2% below it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, localStorage, purgeWorkspace, type Db } from "@ebo/db";
import { seedFreelancer, seedOffice, seedReferenceData } from "@ebo/db/seed";
import { dashboard, defaultDeps, flagSnapshot, loadBooks, loadContext, runWorkspace } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-dash-")));
const ids: Record<string, string> = {};
let db: Db;

const view = async (wsId: string) => {
  const w = await loadContext(db, wsId);
  const books = await loadBooks(db, w);
  return { d: dashboard(books, w), snap: flagSnapshot(books, w) };
};

describe.skipIf(!dbUp)("dashboard", () => {
  beforeAll(async () => {
    db = createDb(pool);
    const deps = defaultDeps({ db, storage });
    await seedReferenceData(db);
    ids.office = (await seedOffice(db, storage, { slug: `test-${tag}-dash-office` })).workspaceId;
    ids.freelancer = (await seedFreelancer(db, storage, { slug: `test-${tag}-dash-freelancer` })).workspaceId;
    for (const id of Object.values(ids)) expect((await runWorkspace(deps, id, { kind: "weekly" })).status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (dbUp) for (const id of Object.values(ids)) await purgeWorkspace(db, storage, id);
    await pool.end();
  });

  it("office: what's owed by age, and the most overdue first", async () => {
    const { d } = await view(ids.office!);
    expect(d.year).toEqual({ start: "2026-07-01", end: "2027-06-30", label: "2026-27" });
    expect(d.owed).toMatchObject({ open: 3, overdue: 1, overduePkr: "816060.00", unpriced: [] });
    expect(d.owed.buckets.map((b) => [b.key, b.invoices])).toEqual([["current", 2], ["1-30", 1], ["31-60", 0], ["61-90", 0], ["90+", 0]]);
    expect(d.owed.buckets.reduce((s, b) => s + Number(b.pkr), 0).toFixed(2)).toBe(d.owed.totalPkr);
    expect(d.owed.mostOverdue).toEqual([expect.objectContaining({ number: "INV-2026-024", client: "Thames Ledger Ltd", balance: "2900.00", currency: "USD", daysLate: 12 })]);
  });

  it("office: what getting paid cost, by route", async () => {
    const { d } = await view(ids.office!);
    expect(d.cost.byRoute.map((r) => [r.key, r.pct, r.feesPkr, r.conversionPkr, r.estimated])).toEqual([
      ["payoneer", "2.00", "0.00", "188247.55", true],
      ["swift_pkr", "0.64", "0.00", "46800.00", false],
      ["swift_esfca", "0.03", "7035.00", "0.00", false],
      ["wise_pkr", "0.00", "0.00", "0.00", false],
    ]);
    const sum = (k: "valuePkr" | "costPkr") => d.cost.byRoute.reduce((s, r) => s + Number(r[k]), 0).toFixed(2);
    expect([d.cost.total.valuePkr, d.cost.total.costPkr]).toEqual([sum("valuePkr"), sum("costPkr")]);
    expect(d.daysToPay).toEqual({ invoices: 29, medianDays: 26, medianLate: -3 });
  });

  it("export proceeds by month add up to the figure the PSEB estimate and the share use", async () => {
    for (const id of Object.values(ids)) {
      const { d, snap } = await view(id);
      expect(d.proceeds.months.map((m) => m.label)).toEqual(["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"]);
      expect(d.proceeds.months.filter((m) => m.future).map((m) => m.month)).toEqual(["2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"]);
      expect(d.proceeds.months.reduce((s, m) => s + Number(m.pkr), 0).toFixed(2)).toBe(d.proceeds.totalPkr);
      expect(d.proceeds.totalPkr).toBe(snap.taxYearProceedsPkr);
      expect(d.proceeds.sharePct).toBe(snap.bankingShare?.sharePct);
    }
  });

  it("freelancer: nothing owed; Payoneer costs her 2%, Wise nothing", async () => {
    const { d } = await view(ids.freelancer!);
    expect(d.owed).toMatchObject({ open: 0, totalPkr: "0.00" });
    expect(d.cost.byRoute.map((r) => [r.key, r.pct, r.estimated])).toEqual([["payoneer", "2.00", true], ["wise_pkr", "0.00", false]]);
    expect(d.clients.map((c) => [c.name, c.paidInvoices, c.medianDaysToPay, c.cost?.pct])).toEqual([["Harbor & Pine LLC", 4, 25, "2.00"], ["Tobias Lindqvist", 2, 14, "0.00"]]);
  });
});
