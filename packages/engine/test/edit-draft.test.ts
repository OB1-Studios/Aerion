/**
 * A person rewrites an email before it goes: their text gets the same numbers check as the
 * agent's, a later run keeps their words, and a number that doesn't trace holds the email.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvent, createDb, createPool, draftAction, localStorage, purgeWorkspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { approveAndSend, defaultDeps, editDraft, runWorkspace, type EngineDeps } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);

const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-edit-")));
let db: Db;
let deps: EngineDeps;
let wsId = "";

const shortPaymentDraft = async () => (await db.select().from(draftAction).where(and(eq(draftAction.workspaceId, wsId), eq(draftAction.template, "T5"))))[0]!;

describe.skipIf(!dbUp)("editing a draft", () => {
  beforeAll(async () => {
    db = createDb(pool);
    deps = defaultDeps({ db, storage });
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-edit` })).workspaceId;
    const r = await runWorkspace(deps, wsId, { kind: "weekly" });
    expect(r.status, r.error).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("refuses an empty subject or text, and changes nothing", async () => {
    const d = await shortPaymentDraft();
    const r = await editDraft(db, d.id, "test-user", { subject: "  ", body: "\n \n" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(["The email needs a subject.", "The email needs some text."]);
    expect((await shortPaymentDraft()).bodyRendered).toBe(d.bodyRendered);
  });

  it("keeps a person's wording when every number still traces, and logs the text it replaced", async () => {
    const d = await shortPaymentDraft();
    const body = d.bodyRendered!.replace("Could you send", "Could you please send");
    const r = await editDraft(db, d.id, "test-user", { subject: `${d.subject!}\r\n`, body: body.replace(/\n/g, "\r\n") });
    expect(r).toMatchObject({ ok: true, changed: true });
    const after = await shortPaymentDraft();
    expect(after).toMatchObject({ status: "draft", model: "person", subject: d.subject, bodyRendered: body });
    expect(after.numbersCheck?.ok).toBe(true);
    const [log] = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, wsId), eq(auditEvent.action, "draft.edited")));
    expect(log?.details).toMatchObject({ previousText: d.bodyRendered, numbersOk: true });
  });

  it("holds an email whose edited text has a number that isn't in the records", async () => {
    const d = await shortPaymentDraft();
    const r = await editDraft(db, d.id, "test-user", { subject: d.subject!, body: d.bodyRendered!.replace("USD 750.00", "USD 705.00") });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.check.failures.map((f) => f.text)).toEqual(["705.00"]);
    expect((await shortPaymentDraft()).status).toBe("blocked");
    // A held email can't be approved; fixing the number makes it approvable again.
    expect((await approveAndSend(deps, d.id, "test-user")).ok).toBe(false);
    const fixed = await editDraft(db, d.id, "test-user", { subject: d.subject!, body: d.bodyRendered!.replace("Could you send", "Could you please send") });
    expect(fixed.ok && fixed.check.ok).toBe(true);
    expect((await shortPaymentDraft()).status).toBe("draft");
  });

  it("a later run keeps the person's words instead of redrafting from the template", async () => {
    const before = await shortPaymentDraft();
    expect(before.bodyRendered).toContain("Could you please send");
    const r = await runWorkspace(deps, wsId, { kind: "manual" });
    expect(r.status, r.error).toBe("succeeded");
    const after = await shortPaymentDraft();
    expect(after).toMatchObject({ status: "draft", model: "person", bodyRendered: before.bodyRendered });
  });

  it("a sent email can't be edited", async () => {
    const d = await shortPaymentDraft();
    expect((await approveAndSend(deps, d.id, "test-user")).ok).toBe(true);
    const r = await editDraft(db, d.id, "test-user", { subject: "Changed", body: "Changed" });
    expect(r).toEqual({ ok: false, problems: ["This email has been sent, so it can't be changed."] });
  });
});
