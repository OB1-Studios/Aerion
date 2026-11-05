/**
 * W4 imports from spreadsheets: clients, open invoices and opening balances. Every row is checked
 * first, problems come back by row and column, nothing is written unless every row is right, and
 * opening balances count in the same totals as recorded money. Needs the dev database.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dec } from "@ebo/core";
import { client, clientAlias, createDb, createPool, document, importJob, invoice, invoiceLine, localStorage, openingBalance, purgeWorkspace, workspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyImport, closeOverview, countryCode, numberedCsvRows, dashboard, flagSnapshot, IMPORT_SPECS, importTemplate, importView, loadBooks, loadContext, parseImportFile, startImport, taxYearOpenings, type Workspace } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-import-")));
const by = { id: `test-import-${tag}`, name: "Sana Malik" };
const csv = (lines: string[]) => new TextEncoder().encode(lines.join("\r\n") + "\r\n");
let db: Db;
let wsId = "";
let ws: Workspace;

const start = (kind: "clients" | "invoices" | "opening_balances", name: string, lines: string[]) => startImport(db, storage, ws, kind, { name, bytes: csv(lines) }, by.id);

describe("reading spreadsheet files", () => {
  it("numbers rows as a spreadsheet does, blank rows included", () => {
    expect(numberedCsvRows('a,b\r\n\r\n"x, y","say ""hi"""\n1,2')).toEqual([
      { row: 1, cells: ["a", "b"] },
      { row: 3, cells: ["x, y", 'say "hi"'] },
      { row: 4, cells: ["1", "2"] },
    ]);
  });

  it("knows countries by code or name", () => {
    expect(["US", "usa", "United States", "UK", "Türkiye", "turkey", "Netherlands", "U.A.E."].map(countryCode)).toEqual(["US", "US", "US", "GB", "TR", "TR", "NL", null]);
    expect(countryCode("Narnia")).toBeNull();
    expect(countryCode("EU")).toBeNull();
  });

  it("refuses the template's example rows, so they can't slip in", () => {
    for (const kind of ["clients", "invoices", "opening_balances"] as const) {
      const parsed = parseImportFile(kind, importTemplate(kind));
      expect(parsed.columns.map(([, k]) => k)).toEqual(IMPORT_SPECS[kind].columns.map((c) => c.key));
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.fatal).toBe(false);
      expect(parsed.problems.map((p) => p.row)).toEqual([2, 3]);
    }
  });

  it("reads the usual headings and says which it left out", () => {
    const parsed = parseImportFile("invoices", "Inv #,Customer,Invoice Date,Amount (USD),Colour\r\nX-1,A,2026-10-01,10,red\r\n");
    expect(parsed.columns).toEqual([
      ["Inv #", "number"],
      ["Customer", "client_name"],
      ["Invoice Date", "issued_on"],
      ["Amount (USD)", "amount"],
    ]);
    expect(parsed.currency).toBe("USD");
    expect(parsed.ignored).toEqual(["Colour"]);
    expect(parsed.problems).toEqual([]);
    const missing = parseImportFile("clients", "Customer,Country\r\nA,US\r\n");
    expect(missing.fatal).toBe(true);
    expect(missing.problems.map((p) => p.column)).toEqual(["kind", "default_currency"]);
  });
});

describe.skipIf(!dbUp)("imports (W4)", () => {
  beforeAll(async () => {
    db = createDb(pool);
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-import` })).workspaceId;
    ws = (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
  }, 120_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("imports clients, with their payer names, all at once", async () => {
    const r = await start("clients", "clients.csv", [
      "Customer,Country,Type,Currency,Terms,Email,Payer names,Phone",
      "Fjord Analytics AS,Norway,business,nok,45 days,AP@fjord.example,FJORD ANALYTICS AS; FJORD ANALYTICS,+47 2100 0000",
      "Casey Morgan,USA,individual,USD,,casey@example.org;,,",
    ]);
    expect(r).toMatchObject({ ok: true, valid: true });
    if (!r.ok) return;
    const view = await importView(db, storage, ws, r.jobId);
    expect(view).toMatchObject({ kind: "clients", status: "validated", file: "clients.csv", errors: [] });
    expect(view!.plan?.rows).toHaveLength(2);
    expect(view!.summary.columns?.[0]).toEqual(["Customer", "name"]);

    // The file is kept, and the weekly run won't try to read it.
    const [doc] = await db.select().from(document).where(and(eq(document.workspaceId, wsId), eq(document.kind, "import")));
    expect(doc).toMatchObject({ parseStatus: "skipped", originalName: "clients.csv", mimeType: "text/csv" });

    expect(await applyImport(db, storage, ws, r.jobId, by)).toEqual({ ok: true, kind: "clients", created: 2, replaced: 0 });
    const [fjord] = await db.select().from(client).where(and(eq(client.workspaceId, wsId), eq(client.name, "Fjord Analytics AS")));
    expect(fjord).toMatchObject({ country: "NO", kind: "business", defaultCurrency: "NOK", paymentTermsDays: 45, contactEmails: ["ap@fjord.example"], notes: "Phone: +47 2100 0000" });
    const aliases = await db.select().from(clientAlias).where(eq(clientAlias.clientId, fjord!.id));
    expect(aliases.map((a) => a.alias).sort()).toEqual(["FJORD ANALYTICS", "FJORD ANALYTICS AS"]);
    const [casey] = await db.select().from(client).where(and(eq(client.workspaceId, wsId), eq(client.name, "Casey Morgan")));
    expect(casey).toMatchObject({ country: "US", kind: "individual", paymentTermsDays: 30, contactEmails: ["casey@example.org"] });

    // Once only.
    expect(await applyImport(db, storage, ws, r.jobId, by)).toMatchObject({ ok: false, problems: ["This file has already been imported."] });
    expect((await importView(db, storage, ws, r.jobId))?.status).toBe("applied");
  });

  it("lists every problem by row and column, and writes nothing", async () => {
    const before = (await db.select().from(client).where(eq(client.workspaceId, wsId))).length;
    const r = await start("clients", "bad-clients.csv", [
      "name,country,kind,default_currency,contact_emails",
      "Casey Morgan,US,individual,USD,",
      "New Co,Narnia,business,USD,",
      "New Co,US,partnership,DOLLARS,not-an-email",
      "",
      "Fine Client Ltd,GB,business,GBP,ok@fine.example",
    ]);
    expect(r).toMatchObject({ ok: true, valid: false });
    if (!r.ok) return;
    const view = await importView(db, storage, ws, r.jobId);
    expect(view!.status).toBe("failed");
    expect(view!.errors.map((e) => [e.row, e.column])).toEqual([
      [2, "name"],
      [3, "country"],
      [4, "name"],
      [4, "kind"],
      [4, "default_currency"],
      [4, "contact_emails"],
    ]);
    expect(view!.errors[0]!.error).toBe('There\'s already a client called "Casey Morgan".');
    expect(view!.errors[2]!.error).toBe("Row 3 has the same name.");
    expect(await applyImport(db, storage, ws, r.jobId, by)).toMatchObject({ ok: false });
    expect(await db.select().from(client).where(eq(client.workspaceId, wsId))).toHaveLength(before);
  });

  it("refuses Excel files and asks for CSV", async () => {
    const r = await startImport(db, storage, ws, "clients", { name: "clients.xlsx", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) }, by.id);
    expect(r).toEqual({ ok: false, problems: [expect.stringContaining("save or download it as CSV")] });
  });

  it("imports open invoices, with money already received taken off what's owed", async () => {
    const months = (await closeOverview(db, await loadContext(db, wsId))).map((m) => m.month);
    const [existing] = await db.select({ number: invoice.number }).from(invoice).where(eq(invoice.workspaceId, wsId)).limit(1);
    const bad = await start("invoices", "bad-invoices.csv", [
      "Invoice No,Client,Date,Due,Amount (USD),Paid",
      `${existing!.number},Casey Morgan,2026-10-01,,100,`,
      "INV-IMP-9,Nobody Ltd,2026-10-01,,100,",
      "INV-IMP-10,Casey Morgan,31/02/2026,,100,",
      "INV-IMP-11,Casey Morgan,2026-10-01,2026-09-01,100,100",
      "INV-IMP-12,Casey Morgan,2026-12-01,,abc,",
    ]);
    if (!bad.ok) throw new Error("not started");
    const errs = (await importView(db, storage, ws, bad.jobId))!.errors;
    expect(errs.map((e) => [e.row, e.column])).toEqual([
      [2, "number"],
      [3, "client_name"],
      [4, "issued_on"],
      [5, "due_on"],
      [5, "amount_paid"],
      [6, "issued_on"],
      [6, "amount"],
    ]);

    const r = await start("invoices", "open-invoices.csv", [
      "Invoice No,Client,Date,Amount (USD),Paid,Details",
      'INV-IMP-001,casey morgan,15/09/2026,"1,200.00",200,Website audit',
      "INV-IMP-002,Fjord Analytics AS,2026-10-20,800,,",
      'INV-IMP-003,Casey Morgan,01/03/2026,450.50,,"Old work, still owed"',
    ]);
    expect(r).toMatchObject({ ok: true, valid: true });
    if (!r.ok) return;
    expect(await applyImport(db, storage, ws, r.jobId, by)).toEqual({ ok: true, kind: "invoices", created: 3, replaced: 0 });
    const rows = await db.select().from(invoice).where(and(eq(invoice.workspaceId, wsId), eq(invoice.importJobId, r.jobId)));
    const one = rows.find((i) => i.number === "INV-IMP-001")!;
    expect(one).toMatchObject({ currency: "USD", amount: "1200.00", paidBeforeImport: "200.00", issuedOn: "2026-09-15", dueOn: "2026-10-15", status: "part_paid", pdfDocumentId: null });
    expect(rows.find((i) => i.number === "INV-IMP-002")).toMatchObject({ amount: "800.00", paidBeforeImport: "0.00", dueOn: "2026-12-04", status: "sent" });
    expect((await db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, one.id)))[0]).toMatchObject({ description: "Website audit", amount: "1200.00" });

    // What's owed, everywhere: the run's books, the flags, the dashboard.
    const w = await loadContext(db, wsId);
    const books = await loadBooks(db, w);
    expect(books.invoices.find((i) => i.id === one.id)!.balance).toBe("1000.00");
    expect(flagSnapshot(books, w).invoices.find((i) => i.id === one.id)!.balance).toBe("1000.00");
    // The March invoice doesn't add months before the records began to Month-end.
    expect((await closeOverview(db, w)).map((m) => m.month)).toEqual(months);
  });

  it("counts opening balances in the share and the PSEB proceeds, and replaces them on a new import", async () => {
    const w = await loadContext(db, wsId);
    const before = flagSnapshot(await loadBooks(db, w), w);

    const bad = await start("opening_balances", "bad-openings.csv", ["month,channel,currency,amount", "2025-05,bank,USD,10", "2026-12,bank,USD,10", "2026-08,wallet,USD,10", "2026-08,bank,NOK,10", "2026-09,bank,USD,10", "Sep 2026,bank,usd,20"]);
    if (!bad.ok) throw new Error("not started");
    expect((await importView(db, storage, ws, bad.jobId))!.errors.map((e) => [e.row, e.column])).toEqual([
      [2, "month"],
      [3, "month"],
      [4, "channel"],
      [5, "currency"],
      [7, "month"],
    ]);

    const r = await start("opening_balances", "openings.csv", ["month,channel,currency,amount,pkr_amount,eprc_on_file", "2026-07,bank,USD,1000.00,280000.00,yes", "2026-08,payoneer_held,USD,500.00,,", "Aug 2026,payoneer_withdrawn,USD,300,,no"]);
    expect(r).toMatchObject({ ok: true, valid: true });
    if (!r.ok) return;
    expect(await applyImport(db, storage, ws, r.jobId, by)).toEqual({ ok: true, kind: "opening_balances", created: 3, replaced: 0 });

    const books = await loadBooks(db, w);
    const lines = taxYearOpenings(books, w);
    expect(lines.map((l) => [l.month, l.channel, l.banked, l.pkrEstimated])).toEqual([
      ["2026-07", "bank", true, false],
      ["2026-08", "payoneer_held", false, true],
      ["2026-08", "payoneer_withdrawn", true, true],
    ]);
    const withdrawnPkr = dec(300).times(w.refRate("USD", "2026-08-15")!);
    const after = flagSnapshot(books, w);
    expect(dec(after.taxYearProceedsPkr!).minus(before.taxYearProceedsPkr!).toFixed(2)).toBe(dec(280000).plus(withdrawnPkr).toFixed(2));
    expect(dec(after.bankingShare!.numeratorUsd).minus(before.bankingShare!.numeratorUsd).toFixed(2)).toBe("1300.00");
    expect(dec(after.bankingShare!.denominatorUsd).minus(before.bankingShare!.denominatorUsd).toFixed(2)).toBe("1800.00");
    expect(after.bankingShare!.lines.filter((l) => l.id.startsWith("opening:")).map((l) => l.note)).toContain("Opening balance for July 2026: received into a Pakistani bank account");
    // The dashboard's months add up to the same proceeds.
    const d = dashboard(books, w);
    expect(d.proceeds.totalPkr).toBe(after.taxYearProceedsPkr);
    expect(d.proceeds.months.find((m) => m.month === "2026-07")!.openingPkr).toBe("280000.00");

    const again = await start("opening_balances", "openings-2.csv", ["month,channel,currency,amount", "2026-07,bank,USD,900"]);
    if (!again.ok) throw new Error("not started");
    expect((await importView(db, storage, ws, again.jobId))!.plan).toMatchObject({ kind: "opening_balances", replaces: 3 });
    expect(await applyImport(db, storage, ws, again.jobId, by)).toEqual({ ok: true, kind: "opening_balances", created: 1, replaced: 3 });
    expect(await db.select().from(openingBalance).where(eq(openingBalance.workspaceId, wsId))).toHaveLength(1);
  });

  it("checks again when applying, so a change in between can't sneak through", async () => {
    const r = await start("clients", "late.csv", ["name,country,kind,default_currency", "Late Arrival Ltd,GB,business,GBP"]);
    if (!r.ok || !r.valid) throw new Error("not valid");
    await db.insert(client).values({ workspaceId: wsId, name: "Late Arrival Ltd", defaultCurrency: "GBP" });
    const out = await applyImport(db, storage, ws, r.jobId, by);
    expect(out).toMatchObject({ ok: false, errors: [{ row: 2, column: "name" }] });
    const [job] = await db.select().from(importJob).where(eq(importJob.id, r.jobId));
    expect(job!.status).toBe("failed");
  });
});
