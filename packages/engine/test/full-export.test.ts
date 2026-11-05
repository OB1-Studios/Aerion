/**
 * W32 full export: every record and document of one workspace in a zip, secrets left out,
 * amounts exact, dates unshifted, spreadsheets safe to open. Needs the dev database.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvent, client, createDb, createPool, document, exportJob, invitation, invoice, localStorage, mailboxConnection, purgeWorkspace, workspace, type Db } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { buildFullExport, defaultDeps, exportKey, fullExports, runWorkspace, unzip } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-export-")));
const by = { id: `test-export-${tag}`, name: "Sana Malik" };
const SECRET = `SEALED-MAILBOX-SECRET-${tag}`;
const TOKEN = `INVITATION-TOKEN-${tag}`;
let db: Db;
let wsId = "";

describe.skipIf(!dbUp)("full export (W32)", () => {
  beforeAll(async () => {
    db = createDb(pool);
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-export` })).workspaceId;
    expect((await runWorkspace(defaultDeps({ db, storage }), wsId, { kind: "weekly" })).status).toBe("succeeded");
    await db.insert(mailboxConnection).values({ workspaceId: wsId, imapHost: "imap.example.test", smtpHost: "smtp.example.test", username: "accounts@example.test", secretEncrypted: SECRET });
    await db.insert(invitation).values({ workspaceId: wsId, email: "new@example.test", role: "viewer", token: TOKEN, invitedBy: by.id, expiresAt: new Date(Date.now() + 86_400_000) });
    // A client name a spreadsheet would run as a formula.
    const [first] = await db.select({ id: client.id }).from(client).where(eq(client.workspaceId, wsId)).limit(1);
    await db.update(client).set({ name: "=HYPERLINK(1)" }).where(eq(client.id, first!.id));
  }, 120_000);

  afterAll(async () => {
    if (dbUp && wsId) await purgeWorkspace(db, storage, wsId);
    await pool.end();
  });

  it("puts every record and document in one zip, without the secrets", async () => {
    const [ws] = await db.select().from(workspace).where(eq(workspace.id, wsId));
    const r = await buildFullExport(pool, db, storage, ws!, by);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const files = unzip(await storage.get(exportKey(wsId, r.jobId)));
    const folder = r.name.replace(/\.zip$/, "");
    const at = (p: string) => files.get(`${folder}/${p}`)?.toString("utf8");

    expect(at("README.txt")).toContain("SIMULATED");
    const data = JSON.parse(at("data.json")!) as { tables: Record<string, Array<Record<string, unknown>>>; workspace: Record<string, unknown> };
    expect(data.workspace.id).toBe(wsId);

    // Every invoice, with amounts as exact text and dates as they were written.
    const invoices = await db.select().from(invoice).where(eq(invoice.workspaceId, wsId));
    expect(data.tables.invoice).toHaveLength(invoices.length);
    const one = invoices[0]!;
    const exported = data.tables.invoice!.find((i) => i.id === one.id)!;
    expect(exported.amount).toBe(one.amount);
    expect(exported.issued_on).toBe(one.issuedOn);
    expect(String(exported.created_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/);

    // The secrets stay behind, everywhere in the zip.
    expect(data.tables.mailbox_connection![0]).not.toHaveProperty("secret_encrypted");
    expect(data.tables.invitation![0]).not.toHaveProperty("token");
    const everything = [...files.values()].map((b) => b.toString("latin1")).join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(TOKEN);

    // One spreadsheet per table with rows; formulas neutralised.
    expect(at("csv/invoice.csv")!.split("\r\n")[0]).toContain("number");
    expect(at("csv/client.csv")).toContain("'=HYPERLINK(1)");
    expect(at("csv/audit_event.csv")).toBeTruthy();

    // Every stored document, tied back to its record.
    const docs = await db.select({ id: document.id }).from(document).where(eq(document.workspaceId, wsId));
    const docFiles = [...files.keys()].filter((k) => k.startsWith(`${folder}/documents/`) && !k.endsWith("/index.csv"));
    expect(docFiles).toHaveLength(r.files);
    expect(r.files + r.skipped).toBe(docs.length);
    expect(at("documents/index.csv")!.trim().split("\r\n")).toHaveLength(docs.length + 1);

    const [job] = await db.select().from(exportJob).where(eq(exportJob.id, r.jobId));
    expect(job).toMatchObject({ kind: "full_export", status: "done", requestedBy: by.id });
    const logged = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.workspaceId, wsId), eq(auditEvent.action, "workspace.exported")));
    expect(logged).toHaveLength(1);
    expect((await fullExports(db, wsId))[0]).toMatchObject({ id: r.jobId, status: "done" });
  }, 60_000);

  it("deleting the workspace removes its exports from storage too", async () => {
    const [ws] = await db.select().from(workspace).where(eq(workspace.id, wsId));
    const r = await buildFullExport(pool, db, storage, ws!, by);
    if (!r.ok) throw new Error(r.reason);
    await purgeWorkspace(db, storage, wsId);
    await expect(storage.get(exportKey(wsId, r.jobId))).rejects.toThrow();
    expect(await db.select().from(workspace).where(eq(workspace.id, wsId))).toHaveLength(0);
    wsId = "";
  }, 60_000);
});
