/**
 * W14 ESFCA conversions on the simulated software house, against the dev database. The rupees
 * from a conversion must never count as export proceeds, in whichever order the conversion and
 * the PKR statement arrive.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dec } from "@ebo/core";
import { auditEvent, createDb, createPool, document, localStorage, purgeWorkspace, receivingAccount, transaction, transferLink, workspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUpload, defaultDeps, esfcaView, flagSnapshot, loadBooks, loadContext, recordConversion, removeConversion, retentionLimitPkr, runWorkspace, sampleStatements, type EngineDeps } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-esfca-")));
let db: Db;
let deps: EngineDeps;
let wsId = "";
let esfcaId = "";
let pkrId = "";

const ws = async () => (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
const view = async () => esfcaView(db, await loadContext(db, wsId));
const proceeds = async () => {
  const w = await loadContext(db, wsId);
  return flagSnapshot(await loadBooks(db, w), w).taxYearProceedsPkr;
};
const input = (over: Partial<{ on: string; amount: string; pkr: string; reference: string }> = {}) => ({ accountId: esfcaId, on: "2026-10-30", amount: "1,000", pkr: "277,000", reference: "FXC-1", ...over });

describe("the retention limit", () => {
  const rule = { min_usd: "5000", pct: "50" };
  it("is the fixed amount until half the proceeds pass it", () => {
    expect(retentionLimitPkr(dec("1000000"), "280", rule)!.toFixed(2)).toBe("1400000.00");
    expect(retentionLimitPkr(dec("4000000"), "280", rule)!.toFixed(2)).toBe("2000000.00");
  });
  it("can't be worked out without a USD rate", () => {
    expect(retentionLimitPkr(dec("4000000"), null, rule)).toBeNull();
  });
});

describe.skipIf(!dbUp)("ESFCA conversions (W14)", () => {
  beforeAll(async () => {
    db = createDb(pool);
    deps = defaultDeps({ db, storage });
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-esfca` })).workspaceId;
    expect((await runWorkspace(deps, wsId, { kind: "weekly" })).status).toBe("succeeded");
    const accounts = await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, wsId));
    esfcaId = accounts.find((a) => a.kind === "esfca")!.id;
    pkrId = accounts.find((a) => a.kind === "pkr_account")!.id;
  }, 60_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("shows the seeded conversions with their cost against the reference rate", async () => {
    const v = await view();
    const list = v.accounts[0]!.conversions;
    expect(list.map((c) => c.on)).toEqual(["2026-09-16", "2026-08-12"]);
    expect(list.every((c) => c.closed && !c.tiedToStatement)).toBe(true);
    expect(list[0]).toMatchObject({ costPct: "2.00", wide: true });
    expect(list[1]).toMatchObject({ costPct: "1.00", wide: false });
    expect(v.accounts[0]!.basis.kind).toBe("records");
    expect(v.rule).toEqual({ minUsd: "5000", pct: "50", verified: false });
  });

  it("refuses what can't be right, and keeps closed months closed", async () => {
    const w = await ws();
    const problems = async (o: Parameters<typeof input>[0]) => {
      const r = await recordConversion(db, w, input(o), "u");
      return r.ok ? [] : r.problems.join(" ");
    };
    expect(await problems({ on: "2026-11-20" })).toContain("future");
    expect(await problems({ on: "not a date" })).toContain("Enter the date");
    expect(await problems({ on: "2026-09-20" })).toContain("September 2026 is closed");
    expect(await problems({ amount: "0" })).toContain("USD amount");
    expect(await problems({ pkr: "" })).toContain("PKR amount");
    expect(await problems({ pkr: "27,700" })).toContain("Check both amounts");
    expect(await recordConversion(db, w, { ...input(), accountId: pkrId }, "u")).toMatchObject({ ok: false, problems: ["Choose one of this workspace's ESFCA accounts."] });
  });

  it("takes a conversion off the balance, doesn't change proceeds, and records it once", async () => {
    const w = await ws();
    const before = await view();
    const was = await proceeds();
    const r = await recordConversion(db, w, input(), "u");
    expect(r).toMatchObject({ ok: true, rate: "277.0000", tiedToStatement: false });
    expect(await recordConversion(db, w, input(), "u")).toMatchObject({ ok: false, problems: [expect.stringContaining("already recorded")] });
    const after = await view();
    expect(dec(before.accounts[0]!.balance).minus(after.accounts[0]!.balance).toFixed(2)).toBe("1000.00");
    expect(await proceeds()).toBe(was);
    const events = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, wsId), eq(auditEvent.action, "esfca.conversion_recorded")));
    expect(events).toHaveLength(1);
  });

  it("a statement read after the conversion ties its rupees, as neither a credit nor proceeds", async () => {
    const w = await ws();
    const was = await proceeds();
    const samples = await sampleStatements(db, w);
    const pkrFile = samples.find((s) => /main|pkr/i.test(s.account)) ?? samples[0]!;
    expect(new TextDecoder().decode(pkrFile.bytes)).toContain("FX CONVERSION PROCEEDS FROM ESFCA");
    for (const s of samples) await addUpload(deps, w, { name: s.name, bytes: s.bytes }, { kindHint: "statement", userId: "u" });
    expect((await runWorkspace(deps, wsId, { kind: "manual" })).status).toBe("succeeded");

    const docs = await db.select().from(document).where(and(eq(document.workspaceId, wsId), eq(document.kind, "statement")));
    expect(docs.every((d) => d.parseStatus === "parsed")).toBe(true);
    const rupees = await db.select().from(transaction).where(and(eq(transaction.workspaceId, wsId), eq(transaction.receivingAccountId, pkrId), eq(transaction.kind, "fx_conversion")));
    expect(rupees).toHaveLength(1);
    expect(rupees[0]).toMatchObject({ amount: "277000.00", currency: "PKR", matchStatus: "ignored" });
    expect(await db.select().from(transferLink).where(eq(transferLink.toTransactionId, rupees[0]!.id))).toHaveLength(1);
    expect(await proceeds()).toBe(was);

    const v = await view();
    const a = v.accounts[0]!;
    expect(a.basis).toMatchObject({ kind: "statement", on: "2026-10-30" });
    expect(a.monthEnds.map((m) => m.month)).toEqual(["2026-10"]);
    expect(a.conversions.find((c) => c.on === "2026-10-30")?.tiedToStatement).toBe(true);
  });

  it("a statement read first: recording the conversion claims the waiting credit, and removing it gives it back", async () => {
    const w = await ws();
    const was = await proceeds();
    // The bank shows rupees nobody has explained yet.
    const [waiting] = await db
      .insert(transaction)
      .values({ workspaceId: wsId, kind: "credit", receivingAccountId: pkrId, valueDate: "2026-11-02", amount: "555000.00", currency: "PKR", pkrAmount: "555000.00", dedupeKey: `statement:${pkrId}:2026-11-02:555000.00:x`, matchStatus: "unmatched" })
      .returning({ id: transaction.id });
    const withWaiting = await proceeds();
    expect(dec(withWaiting!).minus(was!).toFixed(2)).toBe("555000.00");

    const r = await recordConversion(db, w, input({ on: "2026-11-01", amount: "2000", pkr: "555,000", reference: "" }), "u");
    expect(r).toMatchObject({ ok: true, tiedToStatement: true });
    const [claimed] = await db.select().from(transaction).where(eq(transaction.id, waiting!.id));
    expect(claimed).toMatchObject({ kind: "fx_conversion", matchStatus: "ignored" });
    expect(await proceeds()).toBe(was);

    expect(r.ok && (await removeConversion(db, w, r.id, "u"))).toEqual({ ok: true });
    const [back] = await db.select().from(transaction).where(eq(transaction.id, waiting!.id));
    expect(back).toMatchObject({ kind: "credit", matchStatus: "pending" });
    expect(await proceeds()).toBe(withWaiting);
    await db.delete(transaction).where(eq(transaction.id, waiting!.id));
  });

  it("won't remove a conversion in a closed month, or one from another workspace", async () => {
    const w = await ws();
    const closed = (await view()).accounts[0]!.conversions.find((c) => c.closed)!;
    expect(await removeConversion(db, w, closed.id, "u")).toMatchObject({ ok: false, problem: expect.stringContaining("is closed") });
    expect(await removeConversion(db, { ...w, id: "00000000-0000-0000-0000-000000000000" }, closed.id, "u")).toEqual({ ok: false, problem: "That conversion doesn't exist." });
  });

  it("checks each month against the limit, on the same proceeds as everywhere else", async () => {
    const v = await view();
    expect(v.retention[0]!.month).toBe("2026-10");
    for (const m of v.retention) {
      expect(dec(m.retainedPkr).lte(m.proceedsPkr)).toBe(true);
      expect(dec(m.retainedPkr).toFixed(2)).toBe(dec(m.intoPkr).minus(m.convertedPkr).toFixed(2));
      expect(m.over).toBe(dec(m.retainedPkr).gt(m.limitPkr!));
    }
    // September's conversion counts against what was kept, valued at the reference rate.
    const sep = v.retention.find((m) => m.month === "2026-09")!;
    const conv = v.accounts[0]!.conversions.find((c) => c.on === "2026-09-16")!;
    expect(sep.convertedPkr).toBe(dec(conv.amount).times(conv.referenceRate!).toFixed(2));
  });
});
