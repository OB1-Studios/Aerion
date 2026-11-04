/**
 * The whole workflow against a real Postgres (the local dev database, or CI's service):
 * seed both demo workspaces under test slugs, run Monday 2 Nov, approve everything, move
 * the clock to Monday 9 Nov, run again, and check the answers from data spec sections 9-11.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceItem, createDb, createPool, draftAction, flag, invoice, invoiceReminder, localStorage, match, purgeWorkspace, run, task, transaction, workspace, type Db } from "@ebo/db";
import { seedFreelancer, seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { approveAndSend, claimQueuedRun, defaultDeps, queueRun, runWorkspace, type EngineDeps } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);

const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-test-")));
let db: Db;
let deps: EngineDeps;
const ids: Record<string, string> = {};

const flagKinds = async (wsId: string, status: string[] = ["open", "actioned"]) =>
  (await db.select().from(flag).where(eq(flag.workspaceId, wsId))).filter((f) => status.includes(f.status)).map((f) => f.kind).sort();
const drafts = (wsId: string) => db.select().from(draftAction).where(eq(draftAction.workspaceId, wsId));
const setClock = (wsId: string, iso: string) => db.update(workspace).set({ demoClock: new Date(iso) }).where(eq(workspace.id, wsId));
async function approveAll(wsId: string) {
  for (const d of await drafts(wsId)) if (d.status === "draft") expect(await approveAndSend(deps, d.id, "test-user")).toEqual({ ok: true });
}

describe.skipIf(!dbUp)("weekly workflow on the simulated dataset", () => {
  beforeAll(async () => {
    db = createDb(pool);
    deps = defaultDeps({ db, storage });
    await seedReferenceData(db);
    ids.office = (await seedOffice(db, storage, { slug: `test-${tag}-office` })).workspaceId;
    ids.freelancer = (await seedFreelancer(db, storage, { slug: `test-${tag}-freelancer` })).workspaceId;
    ids.autopilot = (await seedOffice(db, storage, { slug: `test-${tag}-autopilot` })).workspaceId;
  }, 60_000);

  afterAll(async () => {
    if (dbUp) for (const id of Object.values(ids)) await purgeWorkspace(db, storage, id);
    await pool.end();
  });

  it("Monday 2 Nov, office: matches, flags, drafts and tasks from the spec", async () => {
    const r = await runWorkspace(deps, ids.office!, { kind: "weekly" });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.counts).toMatchObject({ matched: 7, transfers: 2, transactions: 11, claims: 1 });
    expect(await flagKinds(ids.office!)).toEqual(
      ["bank_detail_change", "eprc_wrong_code", "missing_eprc", "missing_wht_certificate", "overdue", "pseb_renewal", "short_payment", "unconfirmed_payment_claim", "wrong_purpose_code"].sort(),
    );
    const d = await drafts(ids.office!);
    expect(d.map((x) => x.template).sort()).toEqual(["T2", "T4", "T5", "T6", "T8", "T9"]);
    expect(d.every((x) => x.status === "draft" && x.numbersCheck?.ok)).toBe(true); // supervised: nothing goes out on its own
    const tasks = await db.select().from(task).where(eq(task.workspaceId, ids.office!));
    expect(tasks.map((t) => t.title).sort()).toEqual(["Call Kestrel Mobility GmbH to confirm our bank details", "Check the ePRC for INV-2026-018 with the accountant", "Renew PSEB registration"]);

    // Event 5: FX difference against the reference rate, shown as the conversion cost.
    const [inv30] = await db.select().from(invoice).where(and(eq(invoice.workspaceId, ids.office!), eq(invoice.number, "INV-2026-030")));
    const [m30] = await db.select().from(match).where(eq(match.invoiceId, inv30!.id));
    expect(m30).toMatchObject({ fxDifference: "-11700.00", unexplainedAmount: "0.00" });
    // Event 4: the USD 25.00 sender's charges are explained, so the invoice is paid.
    const [inv28] = await db.select().from(invoice).where(and(eq(invoice.workspaceId, ids.office!), eq(invoice.number, "INV-2026-028")));
    expect(inv28!.status).toBe("paid");
  });

  it("running again at the same time changes nothing", async () => {
    const before = (await db.select().from(transaction).where(eq(transaction.workspaceId, ids.office!))).length;
    const r = await runWorkspace(deps, ids.office!, { kind: "manual" });
    expect(r.counts.flags_opened ?? 0).toBe(0);
    expect(r.counts.drafts_draft ?? 0).toBe(0);
    expect((await db.select().from(transaction).where(eq(transaction.workspaceId, ids.office!))).length).toBe(before);
  });

  it("approving sends the emails and records their effects", async () => {
    await approveAll(ids.office!);
    const d = await drafts(ids.office!);
    expect(d.every((x) => x.status === "sent")).toBe(true);
    const [inv24] = await db.select().from(invoice).where(and(eq(invoice.workspaceId, ids.office!), eq(invoice.number, "INV-2026-024")));
    const reminders = await db.select().from(invoiceReminder).where(eq(invoiceReminder.invoiceId, inv24!.id));
    expect(reminders.map((x) => x.stage).sort()).toEqual([1, 2]);
    const requested = await db.select().from(complianceItem).where(and(eq(complianceItem.workspaceId, ids.office!), eq(complianceItem.status, "requested")));
    expect(requested).toHaveLength(2); // H1's ePRC and H2's certificate, in one bank email
  });

  it("Monday 9 Nov, office: the replies close four flags; H2 stays open and gets a chase task", async () => {
    await setClock(ids.office!, "2026-11-09T09:00:00+05:00");
    const r = await runWorkspace(deps, ids.office!, { kind: "weekly" });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.counts.corrections).toBe(1);
    expect(await flagKinds(ids.office!, ["resolved"])).toEqual(["missing_eprc", "short_payment", "unconfirmed_payment_claim", "wrong_purpose_code"]);
    expect(await flagKinds(ids.office!)).toEqual(["bank_detail_change", "eprc_wrong_code", "missing_wht_certificate", "overdue", "pseb_renewal"]);
    const [inv29] = await db.select().from(invoice).where(and(eq(invoice.workspaceId, ids.office!), eq(invoice.number, "INV-2026-029")));
    expect(inv29!.status).toBe("paid");
    const tasks = await db.select().from(task).where(eq(task.workspaceId, ids.office!));
    expect(tasks.some((t) => t.key?.startsWith("chase:missing_wht_certificate"))).toBe(true);
    // Thames is still silent; reminder 2 went out on Nov 2 and reminder 3 isn't due yet (13 business days).
    expect((await drafts(ids.office!)).filter((x) => x.status === "draft")).toHaveLength(0);
  });

  it("freelancer: the SMS credit is matched, coded wrong, then corrected after her email", async () => {
    const r = await runWorkspace(deps, ids.freelancer!, { kind: "weekly" });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.counts).toMatchObject({ matched: 2, transfers: 2 });
    expect(await flagKinds(ids.freelancer!)).toEqual(["atl_status", "pseb_savings_estimate", "wrong_purpose_code"]);
    expect((await drafts(ids.freelancer!)).map((x) => x.template)).toEqual(["T6"]);
    await approveAll(ids.freelancer!);
    await setClock(ids.freelancer!, "2026-11-09T09:00:00+05:00");
    await runWorkspace(deps, ids.freelancer!, { kind: "weekly" });
    expect(await flagKinds(ids.freelancer!, ["resolved"])).toEqual(["wrong_purpose_code"]);
  });

  it("autopilot (Proposed): routine emails go out on their own, the short-payment email waits 30 minutes", async () => {
    await db.update(workspace).set({ approvalPolicy: { mode: "autopilot", delayMinutes: 30 } }).where(eq(workspace.id, ids.autopilot!));
    const r = await runWorkspace(deps, ids.autopilot!, { kind: "weekly" });
    expect(r.status, r.error).toBe("succeeded");
    const byTemplate = Object.fromEntries((await drafts(ids.autopilot!)).map((d) => [d.template, d.status]));
    expect(byTemplate).toEqual({ T2: "sent", T4: "sent", T6: "sent", T8: "sent", T9: "sent", T5: "scheduled" });
    await setClock(ids.autopilot!, "2026-11-02T09:45:00+05:00");
    await runWorkspace(deps, ids.autopilot!, { kind: "manual" });
    expect((await drafts(ids.autopilot!)).find((d) => d.template === "T5")?.status).toBe("sent");
  });

  it("a queued run is claimed once when the worker and the web process race for it", async () => {
    const runId = await queueRun(deps, ids.freelancer!, { kind: "manual" });
    const claims = await Promise.all(Array.from({ length: 4 }, () => claimQueuedRun(db, runId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const [row] = await db.select().from(run).where(eq(run.id, runId));
    expect(row?.status).toBe("running");
    await db.update(run).set({ status: "failed", finishedAt: new Date(), error: "test" }).where(eq(run.id, runId));
  });
});
