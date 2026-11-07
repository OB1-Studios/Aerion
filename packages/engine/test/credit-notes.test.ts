/**
 * Credit notes, write-offs and voids (main doc W9) on the simulated software house after its
 * Monday 2 Nov run, against the local database. At that point:
 * - INV-2026-024 (Thames, USD 2,900) is overdue, with an overdue flag and a T2 reminder waiting
 * - INV-2026-029 (USD 7,500) was short-paid by USD 750, with a short-payment flag and a T5 email
 * - INV-2026-031 is paid
 * - INV-2026-032 (USD 5,500) isn't due yet and has a T4 email waiting
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvent, client, createDb, createPool, creditNote, dispute, draftAction, flag, invoice, localStorage, purgeWorkspace, workspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, asc, eq, inArray } from "drizzle-orm";
import { dashboard, defaultDeps, draftInvoiceEmail, invoiceRoutes, issueCredit, loadBooks, loadContext, markInvoiceSent, runWorkspace, saveInvoice, type EngineDeps } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-credit-")));
const userId = `test-credit-${tag}`;
let db: Db;
let deps: EngineDeps;
let wsId = "";

const ws = async () => (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
const inv = async (number: string) => (await db.select().from(invoice).where(and(eq(invoice.workspaceId, wsId), eq(invoice.number, number))))[0]!;
const flagsOn = async (invoiceId: string) => (await db.select().from(flag).where(and(eq(flag.workspaceId, wsId), eq(flag.subjectType, "invoice"), eq(flag.subjectId, invoiceId)))).map((f) => [f.kind, f.status]);
const draftsOn = (invoiceId: string) => db.select().from(draftAction).where(and(eq(draftAction.workspaceId, wsId), eq(draftAction.invoiceId, invoiceId))).orderBy(asc(draftAction.createdAt));
const balanceOf = async (invoiceId: string) => {
  const w = await loadContext(db, wsId);
  return (await loadBooks(db, w)).invoices.find((i) => i.id === invoiceId)!.balance;
};
/** A new USD invoice for Northwind, saved as a draft. */
const newInvoice = async (amount: string) => {
  const [c] = await db.select().from(client).where(and(eq(client.workspaceId, wsId), eq(client.name, "Northwind Analytics Inc")));
  const route = (await invoiceRoutes(db, wsId, c!.id, "USD"))[0]!;
  const saved = await saveInvoice(db, await ws(), { clientId: c!.id, issuedOn: "2026-11-02", termsDays: 30, currency: "USD", routeChoice: `${route.route}:${route.accountId}`, purposeWording: "Payment for IT services exported", lines: [{ description: "Data pipeline work, November", quantity: "1", unitPrice: amount }] }, userId);
  if (!saved.ok) throw new Error(saved.problems.join(" "));
  return saved;
};

describe.skipIf(!dbUp)("credit notes, write-offs and voids", () => {
  beforeAll(async () => {
    db = createDb(pool);
    deps = defaultDeps({ db, storage });
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-credit` })).workspaceId;
    expect((await runWorkspace(deps, wsId, { kind: "weekly" })).status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("checks what a person asks for against the invoice as it stands", async () => {
    const w = await ws();
    const [i24, i29, i31] = await Promise.all([inv("INV-2026-024"), inv("INV-2026-029"), inv("INV-2026-031")]);
    expect(await issueCredit(db, w, i24.id, { kind: "credit", amount: "3,000", reason: " " }, userId)).toEqual({
      ok: false,
      problems: ["Say why, in a few words. It's kept with the invoice and shown to the accountant.", "That's more than the USD 2,900.00 still owed."],
    });
    expect(await issueCredit(db, w, i24.id, { kind: "credit", amount: "0", reason: "Discount" }, userId)).toEqual({ ok: false, problems: ["The amount should be more than zero, like 400 or 400.00 (in USD)."] });
    expect(await issueCredit(db, w, i24.id, { kind: "refund", amount: "10", reason: "Refund" }, userId)).toEqual({ ok: false, problems: ["Choose a credit note, a write-off or a void."] });
    expect(await issueCredit(db, w, i29.id, { kind: "void", amount: "", reason: "Wrong client" }, userId)).toEqual({
      ok: false,
      problems: ["Money has come in against INV-2026-029, so it can't be voided. Credit or write off what's left instead."],
    });
    expect(await issueCredit(db, w, i31.id, { kind: "write_off", amount: "10", reason: "Bank charges" }, userId)).toEqual({ ok: false, problems: ["Nothing is owed on INV-2026-031."] });
    expect(await issueCredit(db, w, randomUUID(), { kind: "credit", amount: "10", reason: "Discount" }, userId)).toEqual({ ok: false, problems: ["That invoice doesn't exist."] });
    expect(await db.select().from(creditNote).where(eq(creditNote.workspaceId, wsId))).toEqual([]);
  });

  it("a credit note lowers the balance and settles the dispute; the reminder is held, then redrafted by the next run", async () => {
    const i24 = await inv("INV-2026-024");
    await db.insert(dispute).values({ workspaceId: wsId, invoiceId: i24.id, reason: "Two days of testing were billed twice" });
    const r = await issueCredit(db, await ws(), i24.id, { kind: "credit", amount: "400", reason: "Two testing days were billed twice" }, userId);
    expect(r).toMatchObject({ ok: true, number: "CN-2026-001", kind: "credit", amount: "400.00", currency: "USD", balance: "2500.00", status: "sent", flagsResolved: 0, draftsHeld: 1, draftsCancelled: 0 });
    expect(await balanceOf(i24.id)).toBe("2500.00");
    expect((await db.select().from(dispute).where(eq(dispute.invoiceId, i24.id)))[0]).toMatchObject({ status: "credited", creditNoteId: r.ok ? r.id : "" });
    expect(await flagsOn(i24.id)).toEqual([["overdue", "open"]]);
    expect((await draftsOn(i24.id))[0]).toMatchObject({
      template: "T2",
      status: "blocked",
      rejectedReason: "INV-2026-024 changed after this was drafted (Credit note CN-2026-001, USD 400.00). The next run redrafts it with the new balance.",
    });

    expect((await runWorkspace(deps, wsId, { kind: "manual" })).status).toBe("succeeded");
    const [t2] = await draftsOn(i24.id);
    expect(t2).toMatchObject({ template: "T2", status: "draft", rejectedReason: null });
    expect(t2!.bodyRendered).toContain("Invoice INV-2026-024 for USD 2,500.00 is now");
    expect(t2!.numbersCheck?.ok).toBe(true);
  }, 60_000);

  it("writing off the rest settles an invoice: paid, its flag resolved, its email cancelled", async () => {
    const [i24, i29] = await Promise.all([inv("INV-2026-024"), inv("INV-2026-029")]);
    const r = await issueCredit(db, await ws(), i24.id, { kind: "write_off", amount: "2,500.00", reason: "Thames Ledger went into administration" }, userId);
    expect(r).toMatchObject({ ok: true, number: "WO-2026-001", balance: "0.00", status: "paid", flagsResolved: 1, draftsHeld: 0, draftsCancelled: 1 });
    expect(await flagsOn(i24.id)).toEqual([["overdue", "resolved"]]);
    expect((await draftsOn(i24.id))[0]).toMatchObject({ status: "cancelled", rejectedReason: "No longer needed: Write-off WO-2026-001, USD 2,500.00 settled INV-2026-024." });

    // The short payment: the USD 750 gap was intermediary charges the client won't cover.
    const r2 = await issueCredit(db, await ws(), i29.id, { kind: "write_off", amount: "750", reason: "Intermediary bank charges the client won't cover" }, userId);
    expect(r2).toMatchObject({ ok: true, number: "WO-2026-002", balance: "0.00", status: "paid", flagsResolved: 1, draftsCancelled: 1 });
    expect(await flagsOn(i29.id)).toEqual([["short_payment", "resolved"]]);
  });

  it("voids an invoice nothing came in against, and a draft one along with its email", async () => {
    const i32 = await inv("INV-2026-032");
    const r = await issueCredit(db, await ws(), i32.id, { kind: "void", amount: "999", reason: "Raised against the wrong purchase order" }, userId);
    expect(r).toMatchObject({ ok: true, number: "VD-2026-001", amount: "5500.00", balance: "0.00", status: "void", draftsCancelled: 1 });
    expect((await draftsOn(i32.id))[0]).toMatchObject({ template: "T4", status: "cancelled", rejectedReason: "INV-2026-032 was voided (VD-2026-001): Raised against the wrong purchase order" });
    expect(await issueCredit(db, await ws(), i32.id, { kind: "void", amount: "", reason: "Again" }, userId)).toEqual({ ok: false, problems: ["INV-2026-032 is already void."] });

    const draft = await newInvoice("1200");
    expect((await draftInvoiceEmail(db, wsId, draft.id, userId)).ok).toBe(true);
    expect(await issueCredit(db, await ws(), draft.id, { kind: "credit", amount: "100", reason: "Discount" }, userId)).toEqual({
      ok: false,
      problems: [`${draft.number} hasn't been sent, so there's nothing to credit or write off. Edit it, or void it.`],
    });
    expect(await issueCredit(db, await ws(), draft.id, { kind: "void", amount: "", reason: "Raised twice" }, userId)).toMatchObject({ ok: true, number: "VD-2026-002", amount: "1200.00", status: "void", draftsCancelled: 1 });
    expect((await draftsOn(draft.id))[0]).toMatchObject({ template: "T11", status: "cancelled" });
  });

  it("two people taking the last of an invoice at once: only one gets it", async () => {
    const sent = await newInvoice("800");
    expect(await markInvoiceSent(db, await ws(), sent.id, userId)).toBe(true);
    const w = await ws();
    const both = await Promise.all([
      issueCredit(db, w, sent.id, { kind: "write_off", amount: "800", reason: "Client closed" }, userId),
      issueCredit(db, w, sent.id, { kind: "credit", amount: "800", reason: "Agreed discount" }, userId),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, problems: [`Nothing is owed on ${sent.number}.`] });
    expect(await balanceOf(sent.id)).toBe("0.00");
  });

  it("keeps a numbered record of each, in the audit log too, and the dashboard follows", async () => {
    const notes = await db.select().from(creditNote).where(eq(creditNote.workspaceId, wsId)).orderBy(asc(creditNote.number));
    // Either side can win the race above, and its number decides where it sorts.
    const raced = notes.filter((n) => n.amount === "800.00");
    expect(raced.map((n) => [n.number, n.kind, n.approvedBy])).toEqual([[raced[0]!.kind === "credit" ? "CN-2026-002" : "WO-2026-003", raced[0]!.kind, userId]]);
    expect(notes.filter((n) => n.amount !== "800.00").map((n) => [n.number, n.kind, n.amount, n.approvedBy])).toEqual([
      ["CN-2026-001", "credit", "400.00", userId],
      ["VD-2026-001", "void", "5500.00", userId],
      ["VD-2026-002", "void", "1200.00", userId],
      ["WO-2026-001", "write_off", "2500.00", userId],
      ["WO-2026-002", "write_off", "750.00", userId],
    ]);
    expect(notes[0]!.createdAt.toISOString()).toBe("2026-11-02T04:00:00.000Z"); // the demo clock, Mon 2 Nov 09:00 PKT

    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.workspaceId, wsId), inArray(auditEvent.action, ["invoice.credited", "invoice.written_off", "invoice.voided"])))
      .orderBy(asc(auditEvent.id));
    expect(events).toHaveLength(6);
    expect(events.find((e) => e.action === "invoice.credited")).toMatchObject({
      actorType: "user",
      actorId: userId,
      details: { invoice: "INV-2026-024", number: "CN-2026-001", kind: "credit", amount: "400.00", currency: "USD", balanceBefore: "2900.00", balanceAfter: "2500.00", status: "sent", disputes: 1, reason: "Two testing days were billed twice" },
    });

    const w = await loadContext(db, wsId);
    const d = dashboard(await loadBooks(db, w), w);
    expect(d.owed).toMatchObject({ open: 0, overdue: 0, totalPkr: "0.00" });
  });
});
