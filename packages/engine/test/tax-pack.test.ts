/**
 * The year-end tax pack (main doc W27) for the simulated software house after its Monday
 * 2 Nov run, against the local database: one zip with the year's proceeds by month, every
 * credit with its paperwork, the share working, invoices, credit notes, exceptions, and the
 * certificate files on record. Plus the zip format itself.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, exportJob, flag, localStorage, purgeWorkspace, workspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq, inArray } from "drizzle-orm";
import { buildTaxPack, defaultDeps, flagSnapshot, gatherTaxPack, loadBooks, loadContext, runWorkspace, taxPackKey, taxPacks, unzip, zip } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-pack-")));
const by = { id: `test-pack-${tag}`, name: "Sana Malik" };
let db: Db;
let wsId = "";

const rows = (csv: string) => csv.trim().split("\r\n").slice(1);

describe("zip files", () => {
  it("round-trips text and binary entries, compressed or stored, with UTF-8 names", () => {
    const noise = randomBytes(2048);
    const bytes = zip([
      { name: "pack/README.txt", data: "Tax pack\r\n".repeat(50) },
      { name: "pack/documents/ePRC-Lahore-رسید.pdf", data: noise },
    ]);
    const out = unzip(bytes);
    expect([...out.keys()]).toEqual(["pack/README.txt", "pack/documents/ePRC-Lahore-رسید.pdf"]);
    expect(out.get("pack/README.txt")!.toString()).toBe("Tax pack\r\n".repeat(50));
    expect(out.get("pack/documents/ePRC-Lahore-رسید.pdf")!.equals(noise)).toBe(true);
    expect(() => zip([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }])).toThrow("Two files in the zip are called a.txt.");
    const damaged = Buffer.from(bytes);
    const body = 30 + Buffer.byteLength("pack/README.txt") + 2;
    damaged[body] = damaged[body]! ^ 0xff; // inside the first entry's compressed body
    expect(() => unzip(damaged)).toThrow();
  });
});

describe.skipIf(!dbUp)("tax pack", () => {
  beforeAll(async () => {
    db = createDb(pool);
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-pack` })).workspaceId;
    expect((await runWorkspace(defaultDeps({ db, storage }), wsId, { kind: "weekly" })).status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("packs the tax year so far, and agrees with the books", async () => {
    const [ws] = await db.select().from(workspace).where(eq(workspace.id, wsId));
    const r = await buildTaxPack(db, storage, ws!, { by });
    if (!r.ok) throw new Error(r.reason);
    expect(r.name).toBe(`test-${tag}-pack-tax-pack-2026-27.zip`);
    expect(await taxPacks(db, wsId)).toEqual([expect.objectContaining({ id: r.jobId, kind: "tax_pack", period: "2026-27", status: "done", requestedBy: by.id })]);

    const files = unzip(await storage.get(taxPackKey(wsId, r.jobId)));
    const folder = `test-${tag}-pack-tax-pack-2026-27/`;
    const csv = (name: string) => files.get(folder + name)!.toString("utf8");
    const names = [...files.keys()].map((n) => n.slice(folder.length));
    expect(names.slice(0, 9)).toEqual(["README.txt", "income-by-month.csv", "export-credits.csv", "banking-share.csv", "eprc-list.csv", "wht-certificates.csv", "invoices.csv", "credit-notes.csv", "exceptions.csv"]);

    // Proceeds by month add up to the same total as the PSEB estimate and the share.
    const w = await loadContext(db, wsId);
    const snap = flagSnapshot(await loadBooks(db, w), w);
    const income = rows(csv("income-by-month.csv"));
    const credits = income.slice(0, -1).reduce((s, l) => s + Number(l.split(",")[2]), 0);
    expect(income.slice(0, -1).every((l) => /^2026-(0[7-9]|1[01]),[A-Z]{3},\d+,\d+\.\d\d,\d+\.\d\d$/.test(l))).toBe(true);
    expect(income.at(-1)).toBe(`total,PKR,${credits},,${snap.taxYearProceedsPkr}`);
    expect(r.summary).toMatchObject({ year: { label: "2026-27" }, asOf: "2026-11-02", proceedsPkr: snap.taxYearProceedsPkr, sharePct: snap.bankingShare!.sharePct, minSharePct: "80" });

    // Each credit's certificates, with the files on record in documents/.
    const eprc = rows(csv("eprc-list.csv"));
    expect(eprc).toHaveLength(r.summary.eprc.needed);
    expect(r.summary.eprc.onFile).toBeGreaterThan(0);
    const docs = names.filter((n) => n.startsWith("documents/"));
    expect(docs).toHaveLength(r.summary.files);
    expect(r.summary.files).toBeGreaterThan(0);
    const listed = [...eprc, ...rows(csv("wht-certificates.csv"))].map((l) => l.split(",").at(-1)!).filter(Boolean);
    expect(listed.sort()).toEqual([...docs].sort());
    for (const d of docs) expect(files.get(folder + d)!.length).toBeGreaterThan(0);
    // Varga's September ePRC came with a home-remittance code: listed as such, with its copy.
    expect(eprc.find((l) => l.startsWith("2026-09-17,"))).toMatch(/,9471,wrong code,EPRC-26-0924-0412,documents\/eprc\/2026-09-17-.+\.txt$/);
    expect(r.summary.eprc.wrongCode).toBe(1);
    expect(rows(csv("export-credits.csv")).find((l) => l.startsWith("2026-09-17,"))).toContain(",wrong code 9471,");
    expect(rows(csv("export-credits.csv"))).toHaveLength(r.summary.credits);
    expect(rows(csv("invoices.csv"))).toHaveLength(r.summary.invoices);
    expect(rows(csv("credit-notes.csv"))).toHaveLength(0);
    const open = await db.select().from(flag).where(and(eq(flag.workspaceId, wsId), inArray(flag.status, ["open", "actioned"])));
    expect(rows(csv("exceptions.csv"))).toHaveLength(open.length);

    // The page's preview (no files read) promises exactly what the build delivered.
    expect((await gatherTaxPack(db, null, w)).summary).toEqual(r.summary);

    const readme = csv("README.txt");
    expect(readme).toContain("Tax pack: Ravi Code Works (Pvt) Ltd, tax year 2026-27 (1 July 2026 to 30 June 2027)");
    expect(readme).toContain("by Sana Malik, from the records as of 2 November 2026.");
    expect(readme).toContain("SIMULATED: this is demo data for a fictional business.");
    expect(readme).toContain("PSEB registration: PSEB/SIM/2025/0417, valid until 15 December 2026 (lapses before the tax year ends: renew it)");
    expect(readme).toContain(`- Banking-channel share: ${snap.bankingShare!.sharePct}% (the rule is at least 80%)`);
    expect(readme).toContain(`- Certificate copies included: ${r.summary.files} (under documents/`);
    expect(readme).toMatch(/- ePRCs: \d+ of \d+ on file; \d+ missing or requested; 1 with the wrong purpose code/);
  });

  it("says when there's nothing to pack for a year", async () => {
    const [ws] = await db.select().from(workspace).where(eq(workspace.id, wsId));
    expect(await buildTaxPack(db, storage, ws!, { yearStart: "2025-09-01", by })).toEqual({ ok: false, reason: "There's nothing to pack for 2025-26: no export credits or invoices in that tax year." });
    expect(await db.select().from(exportJob).where(eq(exportJob.workspaceId, wsId))).toHaveLength(1);
  });
});
