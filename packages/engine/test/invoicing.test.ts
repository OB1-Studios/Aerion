/**
 * Invoices a person writes, against the local database: numbering, the route picker, the PDF,
 * and sending through the approval inbox (template T11).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, createDb, createPool, draftAction, invoice, invoiceLine, localStorage, purgeWorkspace, receivingAccount, workspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { approveAndSend, defaultDeps, documentText, draftInvoiceEmail, invoicePdf, invoiceRoutes, markInvoiceSent, runWorkspace, saveInvoice, type EngineDeps, type InvoiceInput } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-inv-")));
let db: Db;
let deps: EngineDeps;
let wsId = "";

const ws = async () => (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
const clientNamed = async (name: string) => (await db.select().from(client).where(and(eq(client.workspaceId, wsId), eq(client.name, name))))[0]!;
const accountOfKind = async (kind: "payoneer" | "esfca" | "pkr_account") => (await db.select().from(receivingAccount).where(and(eq(receivingAccount.workspaceId, wsId), eq(receivingAccount.kind, kind))))[0]!;
const input = (over: Partial<InvoiceInput>): InvoiceInput => ({ clientId: "", issuedOn: "2026-11-02", termsDays: 30, currency: "USD", routeChoice: "", purposeWording: "Payment for computer software services (IT export)", lines: [], ...over });

describe.skipIf(!dbUp)("invoices a person writes", () => {
  beforeAll(async () => {
    db = createDb(pool);
    deps = defaultDeps({ db, storage });
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-invoicing`, isDemo: true })).workspaceId;
    // The Monday run matches Thames's wire of 28 Oct, which lost USD 25.00 to fees.
    expect((await runWorkspace(deps, wsId, { kind: "weekly" })).status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("suggests the cheapest route, with the fee the last wire lost", async () => {
    const thames = await clientNamed("Thames Ledger Ltd");
    const gbp = await invoiceRoutes(db, wsId, thames.id, "GBP");
    expect(gbp.map((o) => [o.route, o.suggested])).toEqual([
      ["payoneer", true],
      ["swift_pkr", false],
    ]);
    expect(gbp[0]!.reason).toContain("Thames Ledger Ltd's last bank wire lost USD 25.00 to fees (28 October 2026).");
    // In dollars their usual route, the ESFCA, still works, so it stays the suggestion.
    const usd = await invoiceRoutes(db, wsId, thames.id, "USD");
    expect(usd.find((o) => o.suggested)?.route).toBe("swift_esfca");
  });

  it("checks the form and says what's wrong in plain words", async () => {
    const thames = await clientNamed("Thames Ledger Ltd");
    const w = await ws();
    const bad = await saveInvoice(db, w, input({ clientId: thames.id, lines: [{ description: "", quantity: "0", unitPrice: "abc" }] }), "test-user");
    expect(bad).toEqual({ ok: false, problems: ["Line 1 needs a description.", "Line 1: the quantity should be a number above zero, like 1 or 2.5.", "Line 1: the price should be an amount like 3800 or 3800.00.", "Choose how the client should pay."] });
    // Any currency can be wired to the PKR account (the bank converts it), so yen still has a route.
    expect((await invoiceRoutes(db, wsId, thames.id, "JPY")).map((o) => o.route)).toEqual(["swift_pkr"]);
    const noRoute = await saveInvoice(db, w, input({ clientId: thames.id, currency: "JPY", routeChoice: "payoneer:nope", lines: [{ description: "Work", quantity: "1", unitPrice: "100" }] }), "test-user");
    expect(noRoute.ok ? [] : noRoute.problems).toEqual(["Choose how the client should pay."]);
  });

  it("numbers continue after the highest used, and the PDF says exactly how to pay", async () => {
    const thames = await clientNamed("Thames Ledger Ltd");
    const po = await accountOfKind("payoneer");
    const r = await saveInvoice(
      db,
      await ws(),
      input({ clientId: thames.id, currency: "GBP", routeChoice: `payoneer:${po.id}`, lines: [{ description: "Accounting integrations, November retainer", quantity: "1", unitPrice: "2,950" }, { description: "Extra support hours", quantity: "2.5", unitPrice: "40" }, { description: "", quantity: "", unitPrice: "" }] }),
      "test-user",
    );
    expect(r).toMatchObject({ ok: true, number: "INV-2026-033" });
    const [inv] = await db.select().from(invoice).where(eq(invoice.id, r.ok ? r.id : ""));
    expect(inv).toMatchObject({ status: "draft", amount: "3050.00", currency: "GBP", dueOn: "2026-12-02", route: "payoneer", receivingAccountId: po.id });
    expect((await db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, inv!.id))).map((l) => [l.description, l.quantity, l.amount])).toEqual([
      ["Accounting integrations, November retainer", "1.00", "2950.00"],
      ["Extra support hours", "2.50", "100.00"],
    ]);

    const pdf = await invoicePdf(db, wsId, inv!.id);
    expect(pdf?.name).toBe("INV-2026-033.pdf");
    expect(new TextDecoder().decode(pdf!.bytes.slice(0, 5))).toBe("%PDF-");
    const text = (await documentText(pdf!.bytes, "application/pdf"))!.replace(/\s+/g, " ");
    for (const s of ["INVOICE", "Ravi Code Works (Pvt) Ltd", "INV-2026-033", "Thames Ledger Ltd", "Extra support hours", "Total due", "GBP 3,050.00", "HOW TO PAY: PAYONEER RECEIVING ACCOUNT (GBP)", "Payment reference: INV-2026-033", 'Purpose of payment: "Payment for computer software services (IT export)"', "SIMULATED - NOT A REAL DOCUMENT"]) {
      expect(text).toContain(s);
    }
  });

  it("sending goes through approval with the numbers check, survives a run, and marks the invoice sent", async () => {
    const [inv] = await db.select().from(invoice).where(and(eq(invoice.workspaceId, wsId), eq(invoice.number, "INV-2026-033")));
    const d = await draftInvoiceEmail(db, wsId, inv!.id, "test-user");
    expect(d.ok).toBe(true);
    const [draft] = await db.select().from(draftAction).where(eq(draftAction.id, d.ok ? d.draftId : ""));
    expect(draft).toMatchObject({ template: "T11", status: "draft", toAddress: "accounts@thamesledger.example", invoiceId: inv!.id });
    expect(draft!.numbersCheck?.ok).toBe(true);
    expect(draft!.subject).toBe("INV-2026-033 from Ravi Code Works (Pvt) Ltd: GBP 3,050.00 due 2 December 2026");
    expect(draft!.bodyRendered).toContain("Hi Oliver,");
    expect(draft!.bodyRendered).toContain("Payment reference: INV-2026-033");

    // The next run doesn't tidy it away: it came from a person, not a flag.
    await runWorkspace(deps, wsId, { kind: "manual" });
    expect((await db.select().from(draftAction).where(eq(draftAction.id, draft!.id)))[0]!.status).toBe("draft");

    expect(await approveAndSend(deps, draft!.id, "test-user")).toEqual({ ok: true });
    expect((await db.select().from(invoice).where(eq(invoice.id, inv!.id)))[0]).toMatchObject({ status: "sent" });
    expect(await draftInvoiceEmail(db, wsId, inv!.id, "test-user")).toEqual({ ok: false, reason: "This invoice has already been sent." });
    const change = await saveInvoice(db, await ws(), input({ clientId: inv!.clientId, currency: "GBP", routeChoice: `payoneer:${inv!.receivingAccountId}`, lines: [{ description: "x", quantity: "1", unitPrice: "1" }] }), "test-user", inv!.id);
    expect(change).toEqual({ ok: false, problems: ["Only a draft invoice can be changed; this one has been sent."] });
  });

  it("an invoice sent some other way can be marked as sent, once", async () => {
    const northwind = await clientNamed("Northwind Analytics Inc");
    const esfca = await accountOfKind("esfca");
    const r = await saveInvoice(db, await ws(), input({ clientId: northwind.id, routeChoice: `swift_esfca:${esfca.id}`, lines: [{ description: "Data pipeline, November", quantity: "1", unitPrice: "6400" }] }), "test-user");
    expect(r).toMatchObject({ ok: true, number: "INV-2026-034" });
    expect(await markInvoiceSent(db, await ws(), r.ok ? r.id : "", "test-user")).toBe(true);
    expect(await markInvoiceSent(db, await ws(), r.ok ? r.id : "", "test-user")).toBe(false);
  });
});
