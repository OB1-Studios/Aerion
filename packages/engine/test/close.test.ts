/**
 * Bank statements and the month-end close (main doc W25) for the simulated software house
 * after its Monday 2 Nov run, against the local database. July to September were closed
 * before the demo; October is the month to close.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvent, closePeriod, complianceItem, createDb, createPool, document, flag, localStorage, purgeWorkspace, transaction, workspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq, inArray } from "drizzle-orm";
import { addUpload, closeMonth, closeOverview, closeView, defaultDeps, documentText, loadContext, parseStatement, reopenMonth, runWorkspace, sampleStatements, STATEMENT_HEADER } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-close-")));
const by = { id: `test-close-${tag}`, name: "Hamza Rafiq" };
let db: Db;
let wsId = "";

const csv = (...lines: string[]) => [STATEMENT_HEADER, ...lines].join("\r\n") + "\r\n";

describe("bank statements", () => {
  it("checks every running balance, in one currency", () => {
    const good = csv("2026-10-01,2026-10-01,BALANCE BROUGHT FORWARD,,,,1000.00,PKR", "2026-10-02,2026-10-02,INWARD REMITTANCE ACME LLC PC 9186,ADV-1,,500.00,1500.00,PKR", "2026-10-31,2026-10-31,OFFICE RENT,,200.00,,1300.00,PKR");
    const r = parseStatement(good);
    if (!r.ok) throw new Error(r.problem);
    expect(r.statement).toMatchObject({ currency: "PKR", from: "2026-10-01", to: "2026-10-31", opening: "1000.00", closing: "1300.00", broken: null, monthEnds: { "2026-10": { on: "2026-10-31", balance: "1300.00" } } });
    expect(r.statement.rows).toHaveLength(3);

    const off = parseStatement(good.replace("1300.00,PKR", "1350.00,PKR"));
    expect(off.ok && off.statement.broken).toEqual({ line: 4, on: "2026-10-31", expected: "1300.00", stated: "1350.00" });
    expect(parseStatement(good.replace("1300.00,PKR", "1300.00,USD"))).toEqual({ ok: false, problem: "The statement mixes currencies (PKR, USD). Upload one statement per account." });
    expect(parseStatement("date,amount\r\n2026-10-01,5\r\n")).toEqual({ ok: false, problem: "The columns aren't the bank statement layout." });
    expect(parseStatement(csv("2026-10-02,2026-10-02,BOTH,,5.00,5.00,10.00,PKR"))).toEqual({ ok: false, problem: "Line 2 is both a debit and a credit." });
  });
});

describe.skipIf(!dbUp)("month-end close", () => {
  beforeAll(async () => {
    db = createDb(pool);
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-close` })).workspaceId;
    expect((await runWorkspace(defaultDeps({ db, storage }), wsId, { kind: "weekly" })).status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  const ws = async () => (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
  const october = async () => closeView(db, await loadContext(db, wsId), "2026-10");
  const item = (v: Awaited<ReturnType<typeof october>>, key: string) => v.items.find((i) => i.key === key)!;

  it("lists the months: July to September closed before the demo, October to do", async () => {
    const months = await closeOverview(db, await loadContext(db, wsId));
    expect(months.map((m) => [m.month, m.status])).toEqual([
      ["2026-11", "in_progress"],
      ["2026-10", "todo"],
      ["2026-09", "closed"],
      ["2026-08", "closed"],
      ["2026-07", "closed"],
    ]);
  });

  it("won't close October while checks are still to do", async () => {
    const v = await october();
    expect(v.items.map((i) => [i.key, i.state])).toEqual([
      ["credits", "done"],
      ["certificates", "todo"],
      ["statements", "todo"],
      ["flags", "todo"],
      ["documents", "done"],
    ]);
    expect(item(v, "statements").lines.map((l) => l.text)).toEqual(["No October 2026 statement for the Main PKR account yet. Upload it on Documents.", "No October 2026 statement for the ESFCA yet. Upload it on Documents."]);
    // The two certificates the flags already chase are to do; the rest aren't due yet.
    const certs = item(v, "certificates");
    expect(certs.lines.filter((l) => l.state === "todo").map((l) => l.text)).toEqual([
      "ePRC for USD 7,500.00 from AL NOOR TRADING FZ LLC (6 October 2026): overdue since 20 October 2026. Ask the bank for it.",
      "Withholding certificate for CAD 9,000.00 from MAPLECROFT STUDIO INC (9 October 2026): overdue since 23 October 2026. Ask the bank for it.",
    ]);
    expect(certs.lines.filter((l) => l.state === "waiting").every((l) => /due from the bank by 1\d November 2026\.$/.test(l.text))).toBe(true);
    expect(v.blocked).toBe("3 checks still to do.");
    expect(v.numbers.owed).toEqual([{ currency: "USD", amount: "9150.00", invoices: 3, bands: { current: "6250.00", "1-30": "2900.00", "31-60": "0.00", "61-90": "0.00", "90+": "0.00" } }]);

    const w = await ws();
    expect(await closeMonth(db, storage, w, "2026-10", by)).toEqual({ ok: false, reason: "3 checks still to do." });
    expect(await closeMonth(db, storage, w, "2026-11", by)).toEqual({ ok: false, reason: "November 2026 isn't over until the end of 30 November 2026." });
    expect(await closeMonth(db, storage, w, "2026-13", by)).toEqual({ ok: false, reason: "That isn't a month." });
  });

  it("reads the bank's statements and ties every credit to its advice", async () => {
    const w = await ws();
    const samples = await sampleStatements(db, w);
    expect(samples.map((s) => [s.name, s.account, s.month])).toEqual([
      ["SIMULATED-statement-main-pkr-account-2026-10.csv", "Main PKR account", "2026-10"],
      ["SIMULATED-statement-esfca-2026-10.csv", "ESFCA", "2026-10"],
    ]);
    for (const s of samples) expect((await addUpload({ db, storage }, w, { name: s.name, bytes: s.bytes }, { kindHint: "statement", userId: by.id })).status).toBe("added");
    expect((await runWorkspace(defaultDeps({ db, storage }), wsId, { kind: "manual" })).status).toBe("succeeded");

    const docs = await db.select().from(document).where(and(eq(document.workspaceId, wsId), eq(document.kind, "statement")));
    expect(docs.map((d) => d.parseStatus)).toEqual(["parsed", "parsed"]);
    for (const d of docs) expect((d.extracted as { outcome: Record<string, unknown> }).outcome).toMatchObject({ action: "statement", created: 0, notOnStatement: [] });

    const v = await october();
    expect(item(v, "statements").state).toBe("done");
    expect(item(v, "statements").lines.map((l) => l.text)).toEqual([
      expect.stringMatching(/^Main PKR account: every credit on record is on the statement; balance PKR [\d,]+\.\d\d on 30 October 2026\.$/),
      expect.stringMatching(/^ESFCA: every credit on record is on the statement; balance USD [\d,]+\.\d\d on 30 October 2026\.$/),
    ]);
    expect(v.numbers.statements.map((s) => s.account)).toEqual(["Main PKR account", "ESFCA"]);
  });

  it("sends a statement whose balances don't add up to a person, and imports nothing from it", async () => {
    const w = await ws();
    const [pkr] = await sampleStatements(db, w);
    const lines = new TextDecoder().decode(pkr!.bytes).trim().split("\r\n");
    const cells = lines[3]!.split(",");
    cells[6] = (Number(cells[6]) + 1000).toFixed(2); // someone edited a balance
    lines[3] = cells.join(",");
    const before = (await db.select().from(transaction).where(eq(transaction.workspaceId, wsId))).length;
    expect((await addUpload({ db, storage }, w, { name: "statement-edited.csv", bytes: new TextEncoder().encode(lines.join("\r\n")) }, { kindHint: "statement", userId: by.id })).status).toBe("added");
    await runWorkspace(defaultDeps({ db, storage }), wsId, { kind: "manual" });
    const [doc] = await db.select().from(document).where(and(eq(document.workspaceId, wsId), eq(document.originalName, "statement-edited.csv")));
    expect(doc!.parseStatus).toBe("needs_review");
    expect(doc!.reviewReasons?.[0]).toMatch(/^The running balance doesn't add up on line 4 \(2026-10-\d\d\): it should be PKR [\d,]+\.\d\d, the statement says PKR [\d,]+\.\d\d\. Upload the bank's own statement\.$/);
    expect((await db.select().from(transaction).where(eq(transaction.workspaceId, wsId))).length).toBe(before);

    // Until a person sets it aside, October has a document to check.
    expect(item(await october(), "documents").lines.map((l) => l.text)).toEqual([expect.stringMatching(/^statement-edited\.csv: The running balance doesn't add up/)]);
    await db.update(document).set({ parseStatus: "skipped", reviewReasons: ["Set aside by Hamza Rafiq: an edited copy."] }).where(eq(document.id, doc!.id));
  });

  it("closes October once nothing is left to do, with a report for the director", async () => {
    // A person handles the flags (in the app: approving the drafted emails, dismissing the lookalike warning).
    await db.update(flag).set({ status: "actioned" }).where(and(eq(flag.workspaceId, wsId), eq(flag.status, "open")));
    const v = await october();
    expect(v.items.map((i) => [i.key, i.state])).toEqual([
      ["credits", "done"],
      ["certificates", "waiting"],
      ["statements", "done"],
      ["flags", "waiting"],
      ["documents", "done"],
    ]);
    expect(v.canClose).toBe(true);

    // Two people press Close at once: one closes it, the other is told.
    const w = await ws();
    const results = await Promise.all([closeMonth(db, storage, w, "2026-10", by), closeMonth(db, storage, w, "2026-10", by)]);
    const done = results.filter((r) => r.ok);
    expect(done).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "October 2026 is closed." });
    const r = done[0]!;
    if (!r.ok) throw new Error("not closed");
    expect(r.name).toBe(`test-${tag}-close-month-end-2026-10.pdf`);

    const [row] = await db.select().from(closePeriod).where(and(eq(closePeriod.workspaceId, wsId), eq(closePeriod.month, "2026-10")));
    expect(row).toMatchObject({ status: "closed", closedBy: by.id, reportDocumentId: r.documentId });
    expect((row!.checklist as { fingerprint: string }).fingerprint).toBe(v.fingerprint);
    const [doc] = await db.select().from(document).where(eq(document.id, r.documentId));
    expect(doc).toMatchObject({ kind: "report", source: "generated", parseStatus: "skipped", mimeType: "application/pdf" });

    const text = (await documentText(await storage.get(doc!.storagePath), "application/pdf"))!.replace(/\s+/g, " ");
    for (const s of ["MONTH-END REPORT", "October 2026: 1 October 2026 to 31 October 2026", "Closed by Hamza Rafiq on 2 November 2026", "THE MONTH IN NUMBERS", "Owed at month end", "USD 9,150.00 on 3 invoices", "Statement: Main PKR account", "CHECKLIST AT CLOSE", "STILL OUTSTANDING AT CLOSE", "SIMULATED - NOT A REAL DOCUMENT"]) expect(text).toContain(s);
    expect(text).toMatch(/ePRC for USD 7,500\.00 from AL NOOR TRADING FZ LLC \(6 October 2026\): overdue since 20 October 2026; the bank has been asked for it\./);
    expect(text).toMatch(/ePRC for USD 6,400\.00 from NORTHWIND ANALYTICS INC \(27 October 2026\): due from the bank by 10\s+November 2026\./);

    const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, wsId), eq(auditEvent.action, "month.closed")));
    expect(audits).toHaveLength(1);
    expect((await closeOverview(db, await loadContext(db, wsId))).find((m) => m.month === "2026-10")).toMatchObject({ status: "closed", changedSinceClose: false });
  });

  it("notices when a closed month changes, and an owner can reopen it with a reason", async () => {
    // The bank's ePRC for a late-October credit arrives after the close.
    const [late] = await db
      .select({ id: complianceItem.id })
      .from(complianceItem)
      .innerJoin(transaction, eq(transaction.id, complianceItem.transactionId))
      .where(and(eq(complianceItem.workspaceId, wsId), eq(complianceItem.kind, "eprc"), eq(complianceItem.status, "missing"), eq(transaction.valueDate, "2026-10-27")));
    await db.update(complianceItem).set({ status: "on_file" }).where(eq(complianceItem.id, late!.id));
    const v = await october();
    expect(v.record?.status).toBe("closed");
    expect(v.changedSinceClose).toBe(true);

    const w = await ws();
    expect(await reopenMonth(db, w, "2026-10", by, " ")).toEqual({ ok: false, reason: "Say why it's being reopened, in a few words. It's kept in the audit log." });
    expect(await reopenMonth(db, w, "2026-10", by, "The bank's ePRC for Northwind arrived")).toEqual({ ok: true });
    const [row] = await db.select().from(closePeriod).where(and(eq(closePeriod.workspaceId, wsId), eq(closePeriod.month, "2026-10")));
    expect(row).toMatchObject({ status: "open", closedBy: null, reportDocumentId: null });
    const history = (row!.checklist as { history: Array<{ reason: string; reportDocumentId: string }> }).history;
    expect(history).toEqual([expect.objectContaining({ reason: "The bank's ePRC for Northwind arrived", reopenedBy: by.id })]);
    expect(await db.select().from(document).where(inArray(document.id, [history[0]!.reportDocumentId]))).toHaveLength(1); // the old report stays on file
    expect(await reopenMonth(db, w, "2026-10", by, "again")).toEqual({ ok: false, reason: "October 2026 isn't closed." });
  });

  it("adds a credit the bank shows but no advice did", async () => {
    // A September statement with Maplecroft's credit (on record) and one that came without an advice.
    const [maple] = await db.select().from(transaction).where(and(eq(transaction.workspaceId, wsId), eq(transaction.valueDate, "2026-09-08"), eq(transaction.currency, "CAD")));
    const pkr = Number(maple!.pkrAmount);
    const extra = csv(
      `2026-09-01,2026-09-01,BALANCE BROUGHT FORWARD,,,,500000.00,PKR`,
      `2026-09-08,2026-09-08,INWARD REMITTANCE MAPLECROFT STUDIO INC PC 9186,${maple!.adviceNumber},,${pkr.toFixed(2)},${(500000 + pkr).toFixed(2)},PKR`,
      `2026-09-21,2026-09-21,INWARD REMITTANCE BRIGHTLANE HEALTH LLC PC 9186,FT26264ZX91,,150000.00,${(650000 + pkr).toFixed(2)},PKR`,
    );
    const w = await ws();
    expect((await addUpload({ db, storage }, w, { name: "statement-september.csv", bytes: new TextEncoder().encode(extra) }, { kindHint: "statement", userId: by.id })).status).toBe("added");
    await runWorkspace(defaultDeps({ db, storage }), wsId, { kind: "manual" });
    const [doc] = await db.select().from(document).where(and(eq(document.workspaceId, wsId), eq(document.originalName, "statement-september.csv")));
    expect(doc!.parseStatus).toBe("parsed");
    const outcome = (doc!.extracted as { outcome: { linked: number; created: number; onStatement: string[]; notOnStatement: unknown[] } }).outcome;
    expect(outcome).toMatchObject({ linked: 1, created: 1 });
    expect(outcome.onStatement).toContain(maple!.id);
    expect(outcome.notOnStatement.length).toBeGreaterThan(0); // a partial statement: the rest of September isn't on it
    const [added] = await db.select().from(transaction).where(and(eq(transaction.workspaceId, wsId), eq(transaction.reference, "FT26264ZX91")));
    expect(added).toMatchObject({ kind: "credit", amount: "150000.00", currency: "PKR", pkrAmount: "150000.00", payerName: "BRIGHTLANE HEALTH LLC", purposeCode: "9186", sourceDocumentId: doc!.id });
  });
});
