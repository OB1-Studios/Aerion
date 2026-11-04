/**
 * Retainers on a real workspace, against the local database: a retainer added to a client
 * makes the run draft the month's invoice and its email once the billing day comes, each
 * month once; stopping it ends the drafts; and when a draft can't be made, a person is asked.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, contract, createDb, createPool, draftAction, invoice, invoiceLine, localStorage, purgeWorkspace, receivingAccount, task, user, workspace, type Db } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { addReceivingAccount, addRetainer, createWorkspace, defaultDeps, draftDueRetainers, loadContext, runWorkspace, saveClient, saveInvoice, stopRetainer, type EngineDeps } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const userId = `test-retainer-${tag}`;
let db: Db;
let deps: EngineDeps;
let wsId = "";
let clientId = "";

const ws = async () => (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
const setClock = (iso: string) => db.update(workspace).set({ demoClock: new Date(iso) }).where(eq(workspace.id, wsId));
const retainerInput = { description: "Platform engineering, monthly retainer", amount: "3,000", currency: "USD", billingDay: "5", startsOn: "2026-10-20" };
const invoicesFor = (period: string) =>
  db.select({ inv: invoice, line: invoiceLine }).from(invoiceLine).innerJoin(invoice, eq(invoice.id, invoiceLine.invoiceId)).where(and(eq(invoice.workspaceId, wsId), eq(invoiceLine.milestoneLabel, period)));

describe.skipIf(!dbUp)("retainers", () => {
  beforeAll(async () => {
    db = createDb(pool);
    deps = defaultDeps({ db, storage: localStorage(mkdtempSync(join(tmpdir(), "ebo-retainer-"))) });
    await db.insert(user).values({ id: userId, name: "Bilal Ahmed", email: `bilal-${tag}@example.invalid`, emailVerified: false });
    const w = await createWorkspace(db, { kind: "company", name: `Retainer Test ${tag}`, legalName: `Retainer Test ${tag} (Pvt) Ltd`, city: "Lahore" }, { id: userId, name: "Bilal Ahmed" });
    if (!w.ok) throw new Error("no workspace");
    wsId = w.id;
    const acc = await addReceivingAccount(db, await ws(), { kind: "esfca", label: "Dollar ESFCA", bankName: "Shalimar Bank Ltd", iban: "PK41DEMO0001004470005678", swift: "DEMOPKKA", currency: "USD", currencies: "", instructions: "" }, userId);
    if (!acc.ok) throw new Error(acc.problems.join(" "));
    const c = await saveClient(db, wsId, { name: "Northwind Analytics Inc", kind: "business", country: "us", currency: "usd", termsDays: "30", preferredRoute: "", contactName: "Megan Ross", contactEmails: "ap@northwind.example", aliases: "", notes: "" }, userId);
    if (!c.ok) throw new Error(c.problems.join(" "));
    clientId = c.id;
  });

  afterAll(async () => {
    if (dbUp) {
      if (wsId) await purgeWorkspace(db, null, wsId);
      await db.delete(user).where(eq(user.id, userId));
    }
    await pool.end();
  });

  it("checks a new retainer, including that something can receive its currency", async () => {
    expect(await addRetainer(db, await ws(), clientId, { ...retainerInput, amount: "", billingDay: "30" }, userId)).toEqual({
      ok: false,
      problems: ["The monthly amount should be more than zero, like 2400 or 2400.00.", "The billing day should be from 1 to 28, so it falls in every month."],
    });
    expect(await addRetainer(db, await ws(), clientId, { ...retainerInput, currency: "JPY" }, userId)).toEqual({ ok: false, problems: ["None of your receiving accounts can take JPY. Add one in Setup first."] });
    expect(await addRetainer(db, await ws(), randomUUID(), retainerInput, userId)).toEqual({ ok: false, problems: ["That client doesn't exist."] });
    const r = await addRetainer(db, await ws(), clientId, retainerInput, userId);
    expect(r.ok).toBe(true);
    expect((await db.select().from(contract).where(eq(contract.workspaceId, wsId)))[0]).toMatchObject({ kind: "retainer", amountOrRate: "3000.00", currency: "USD", billingDay: 5, startsOn: "2026-10-20", lastPeriod: null });
  });

  it("starts at the first billing day after the start date, then drafts each month once", async () => {
    // Started Oct 20, so October (billed Oct 5) isn't back-filled.
    await setClock("2026-10-26T09:00:00+05:00");
    expect((await runWorkspace(deps, wsId, { kind: "manual" })).counts.retainer_invoices).toBeUndefined();
    await setClock("2026-11-04T09:00:00+05:00");
    expect((await runWorkspace(deps, wsId, { kind: "manual" })).counts.retainer_invoices).toBeUndefined();

    await setClock("2026-11-09T09:00:00+05:00");
    const r = await runWorkspace(deps, wsId, { kind: "weekly" });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.counts).toMatchObject({ retainer_invoices: 1, awaiting_approval: 1 });
    expect(r.summary).toContain("Drafted the November 2026 retainer invoice for Northwind Analytics Inc (INV-2026-001, USD 3,000.00); the email that sends it waits for approval.");
    const [{ inv, line }] = (await invoicesFor("2026-11")) as [{ inv: typeof invoice.$inferSelect; line: typeof invoiceLine.$inferSelect }];
    expect(inv).toMatchObject({ status: "draft", issuedOn: "2026-11-05", dueOn: "2026-12-05", amount: "3000.00", route: "swift_esfca" });
    expect(line.description).toBe("Platform engineering, monthly retainer, November 2026");
    const [email] = await db.select().from(draftAction).where(and(eq(draftAction.workspaceId, wsId), eq(draftAction.invoiceId, inv.id)));
    expect(email).toMatchObject({ template: "T11", status: "draft", runId: r.runId, toAddress: "ap@northwind.example" });

    // Running again, or editing the draft, doesn't draft November twice.
    await runWorkspace(deps, wsId, { kind: "manual" });
    const edited = await saveInvoice(db, await ws(), { clientId, issuedOn: "2026-11-05", termsDays: 30, currency: "USD", routeChoice: `swift_esfca:${inv.receivingAccountId}`, purposeWording: "", lines: [{ description: "Platform engineering, November", quantity: "1", unitPrice: "3000" }, { description: "Extra hours", quantity: "2", unitPrice: "50" }] }, userId, inv.id);
    expect(edited.ok).toBe(true);
    const after = await db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, inv.id));
    expect(after.map((l) => [l.position, l.milestoneLabel]).sort()).toEqual([[0, "2026-11"], [1, null]]);
    await runWorkspace(deps, wsId, { kind: "manual" });
    expect(await invoicesFor("2026-11")).toHaveLength(1);
    expect((await db.select().from(invoice).where(eq(invoice.workspaceId, wsId))).length).toBe(1);
  });

  it("stopping ends the drafts, including a month that's due but not drafted yet", async () => {
    const [r] = await db.select().from(contract).where(eq(contract.workspaceId, wsId));
    await setClock("2026-12-07T09:00:00+05:00"); // December is due (billed on the 5th) but no run has drafted it
    expect(await stopRetainer(db, await ws(), r!.id, userId, "2026-12-07")).toBe(true);
    expect(await stopRetainer(db, await ws(), r!.id, userId, "2026-12-07")).toBe(false);
    await runWorkspace(deps, wsId, { kind: "manual" });
    expect(await invoicesFor("2026-12")).toHaveLength(0);
    await setClock("2027-01-11T09:00:00+05:00");
    await runWorkspace(deps, wsId, { kind: "manual" });
    expect(await invoicesFor("2027-01")).toHaveLength(0);
  });

  it("when a month can't be drafted, a person is asked and the next run tries again", async () => {
    const added = await addRetainer(db, await ws(), clientId, { ...retainerInput, description: "Support", amount: "500", billingDay: "1", startsOn: "2027-01-01" }, userId);
    if (!added.ok) throw new Error("not added");
    // The only USD account stops being offered after the retainer was set up.
    await db.update(receivingAccount).set({ active: false }).where(eq(receivingAccount.workspaceId, wsId));
    const failed = await draftDueRetainers(db, await loadContext(db, wsId), randomUUID());
    expect(failed).toMatchObject([{ number: null, period: "2027-01", problem: "None of your receiving accounts can take USD. Add one in Setup first." }]);
    expect((await db.select().from(contract).where(eq(contract.id, added.id)))[0]!.lastPeriod).toBeNull();
    const [t] = await db.select().from(task).where(and(eq(task.workspaceId, wsId), eq(task.key, `retainer:${added.id}:2027-01`)));
    expect(t).toMatchObject({ title: "Draft the January 2027 retainer invoice for Northwind Analytics Inc", status: "open" });

    // Fixed; the client has no email address though, so the invoice is drafted and a person sends it.
    await db.update(receivingAccount).set({ active: true }).where(eq(receivingAccount.workspaceId, wsId));
    await db.update(client).set({ contactEmails: [] }).where(eq(client.id, clientId));
    const drafted = await draftDueRetainers(db, await loadContext(db, wsId), randomUUID());
    expect(drafted).toMatchObject([{ number: "INV-2027-002", draftId: null, problem: "Northwind Analytics Inc has no email address on file. Add one to the client first." }]);
    const [t2] = await db.select().from(task).where(eq(task.id, t!.id));
    expect(t2).toMatchObject({ title: "Send INV-2027-002 to Northwind Analytics Inc", status: "open" });
    expect(await draftDueRetainers(db, await loadContext(db, wsId), randomUUID())).toEqual([]);
  });
});
