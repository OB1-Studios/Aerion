/**
 * The workspace's own mailbox, without a real mail server: secrets are sealed, settings are
 * checked, private hosts are refused, new mail is pulled into the run once (with its
 * attachments as documents), and approved emails go out through the workspace's SMTP login.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, document, localStorage, mailboxConnection, message, purgeWorkspace, run, user, workspace, type Db } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import {
  connectMailbox,
  createWorkspace,
  defaultDeps,
  mailboxMailer,
  mailboxProblem,
  mailboxSettings,
  openSecret,
  queueRunsForNewMail,
  runWorkspace,
  saveClient,
  sealSecret,
  simplePdf,
  testMailbox,
  type IncomingMail,
  type MailboxReader,
  type MailboxSettings,
  type SmtpTransport,
} from "../src/index";

const env = { APP_ENCRYPTION_KEY: "test-key-for-sealing-0123456789abcdef" };

describe("sealed secrets", () => {
  it("open with the same key, and fail with another key or after tampering", () => {
    const sealed = sealSecret("abcd efgh ijkl mnop", env);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("abcd");
    expect(openSecret(sealed, env)).toBe("abcd efgh ijkl mnop");
    expect(sealSecret("same", env)).not.toBe(sealSecret("same", env));
    expect(() => openSecret(sealed, { APP_ENCRYPTION_KEY: "another-key-entirely-0123456789" })).toThrow();
    const [v, iv, tag, body] = sealed.split(".");
    expect(() => openSecret([v, iv, tag, `${body!.slice(0, -2)}AA`].join("."), env)).toThrow();
    expect(() => sealSecret("x", {})).toThrow(/APP_ENCRYPTION_KEY/);
  });
});

describe("mailbox settings", () => {
  it("fill in the provider's servers, and check a custom host's names and ports", () => {
    expect(mailboxSettings({ provider: "gmail", address: "accounts@lahoreapps.example", password: "abcd efgh ijkl mnop" })).toEqual({
      settings: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465, username: "accounts@lahoreapps.example", password: "abcdefghijklmnop" },
    });
    expect(mailboxSettings({ provider: "other", address: "accounts@lahoreapps.example", password: "pass word", imapHost: "Mail.LahoreApps.example", smtpHost: "mail.lahoreapps.example", smtpPort: "587" })).toEqual({
      settings: { imapHost: "mail.lahoreapps.example", imapPort: 993, smtpHost: "mail.lahoreapps.example", smtpPort: 587, username: "accounts@lahoreapps.example", password: "pass word" },
    });
    expect(mailboxSettings({ provider: "other", address: "nope", password: "", imapHost: "10.0.0.5", imapPort: "5432", smtpHost: "localhost", smtpPort: "25" })).toEqual({
      problems: [
        "The email address doesn't look right.",
        "Paste the app password.",
        "The IMAP server should be a host name, like mail.example.com.",
        "The SMTP server should be a host name, like mail.example.com.",
        "The IMAP port should be 993 (or 143 with STARTTLS).",
        "The SMTP port should be 465, 587 or 2525.",
      ],
    });
  });

  it("refuse hosts on a private network, and explain login failures plainly", async () => {
    const local: MailboxSettings = { imapHost: "localhost", imapPort: 993, smtpHost: "localhost", smtpPort: 465, username: "a@b.example", password: "x" };
    expect(await testMailbox(local, env)).toEqual({ ok: false, problems: ["Reading mail (IMAP): That server is on a private network, so the app won't connect to it."] });
    expect(mailboxProblem(Object.assign(new Error("Command failed"), { authenticationFailed: true }))).toMatch(/app password/);
    expect(mailboxProblem(Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH" }))).toMatch(/app password/);
    expect(mailboxProblem(Object.assign(new Error("getaddrinfo ENOTFOUND imap.nowhere.example"), { code: "ENOTFOUND", hostname: "imap.nowhere.example" }))).toBe("Couldn't find the server imap.nowhere.example. Check its name.");
  });
});

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const userId = `test-user-mail-${tag}`;
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-mail-")));
let db: Db;
let wsId = "";

/** A mailbox that hands out the given mail once, then nothing; or fails like a real server would. */
function fakeMailbox(batches: IncomingMail[][], fail?: Error): MailboxReader & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async fetchNew(conn) {
      seen.push(conn.lastSeenUid ?? "");
      if (fail) throw fail;
      const mail = batches.shift() ?? [];
      return { mail, cursor: mail.length ? mail[mail.length - 1]!.key : (conn.lastSeenUid ?? ""), more: false };
    },
  };
}

const mail = (uid: number, over: Partial<IncomingMail> = {}): IncomingMail => ({
  key: `7:${uid}`,
  from: "Ingrid Berg <ap@fjord.example>",
  to: "accounts@lahoreapps.example",
  subject: `Remittance ${uid}`,
  date: new Date("2026-11-03T09:00:00Z"),
  text: "Hi, we sent the payment for INV-2026-001 today. Ingrid (SIMULATED)",
  files: [],
  ...over,
});

describe.skipIf(!dbUp)("a real workspace's mailbox", () => {
  beforeAll(async () => {
    db = createDb(pool);
    await db.insert(user).values({ id: userId, name: "Bilal Ahmed", email: `bilal-mail-${tag}@example.invalid`, emailVerified: false });
    const w = await createWorkspace(db, { kind: "company", name: `Mail Test ${tag}`, legalName: `Mail Test ${tag} (Pvt) Ltd`, city: "Lahore" }, { id: userId, name: "Bilal Ahmed" });
    if (!w.ok) throw new Error("no workspace");
    wsId = w.id;
    expect((await saveClient(db, wsId, { name: "Fjord Systems AS", kind: "business", country: "NO", currency: "EUR", termsDays: "14", preferredRoute: "", contactName: "Ingrid Berg", contactEmails: "ap@fjord.example", aliases: "", notes: "" }, userId)).ok).toBe(true);
  });

  afterAll(async () => {
    if (dbUp) {
      if (wsId) await purgeWorkspace(db, null, wsId);
      await db.delete(user).where(eq(user.id, userId));
    }
    await pool.end();
  });

  const ws = async () => (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;

  it("connects only after both logins work, and keeps the password sealed", async () => {
    const w = await ws();
    const refused = await connectMailbox(db, w, { provider: "gmail", address: "accounts@lahoreapps.example", password: "wrong" }, userId, { env, test: async () => ({ ok: false, problems: ["Reading mail (IMAP): The mailbox didn't accept the address and password."] }) });
    expect(refused.ok).toBe(false);
    expect(await db.select().from(mailboxConnection).where(eq(mailboxConnection.workspaceId, wsId))).toEqual([]);

    const ok = await connectMailbox(db, w, { provider: "gmail", address: "Accounts@LahoreApps.example", password: "abcd efgh ijkl mnop" }, userId, { env, test: async () => ({ ok: true, problems: [], cursor: "7:41" }) });
    expect(ok.ok).toBe(true);
    const [conn] = await db.select().from(mailboxConnection).where(eq(mailboxConnection.workspaceId, wsId));
    expect(conn).toMatchObject({ imapHost: "imap.gmail.com", smtpPort: 465, username: "Accounts@LahoreApps.example", lastSeenUid: "7:41", status: "ok" });
    expect(conn!.secretEncrypted).not.toContain("abcd");
    expect(openSecret(conn!.secretEncrypted, env)).toBe("abcdefghijklmnop");
    expect(await ws()).toMatchObject({ emailDomain: "lahoreapps.example", settings: { mailboxAddress: "accounts@lahoreapps.example" } });

    const demo = { ...w, isDemo: true };
    expect(await connectMailbox(db, demo, { provider: "gmail", address: "a@b.example", password: "x" }, userId, { env, test: async () => ({ ok: true, problems: [] }) })).toEqual({
      ok: false,
      problems: ["Demo workspaces use a simulated mailbox, so a real one can't be connected here."],
    });
  });

  it("pulls new mail into the run once, keeps readable attachments, and moves the cursor", async () => {
    const pdf = await simplePdf(["BANK CREDIT ADVICE (SIMULATED)", "Amount: EUR 2,400.00"]);
    const reader = fakeMailbox([[mail(42, { files: [{ name: "advice.pdf", mimeType: "application/pdf", bytes: pdf }, { name: "setup.exe", mimeType: "application/octet-stream", bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]) }] }), mail(43, { subject: "Re: invoice", files: [] })]]);
    const deps = { ...defaultDeps({ db, storage }), env, mailbox: reader };
    const r = await runWorkspace(deps, wsId, { kind: "manual" });
    expect(r.status).toBe("succeeded");
    expect(reader.seen).toEqual(["7:41"]);
    const inbound = await db.select().from(message).where(and(eq(message.workspaceId, wsId), eq(message.direction, "in")));
    expect(inbound.map((m) => [m.mailboxUid, m.subject]).sort()).toEqual([
      ["7:42", "Remittance 42"],
      ["7:43", "Re: invoice"],
    ]);
    expect(inbound.every((m) => m.clientId)).toBe(true);
    const docs = await db.select().from(document).where(eq(document.workspaceId, wsId));
    expect(docs.map((d) => [d.originalName, d.source])).toEqual([["advice.pdf", "email"]]);
    expect(inbound.find((m) => m.mailboxUid === "7:42")!.documentIds).toEqual([docs[0]!.id]);
    expect((await db.select().from(mailboxConnection).where(eq(mailboxConnection.workspaceId, wsId)))[0]).toMatchObject({ lastSeenUid: "7:43", status: "ok", lastError: null });

    // The same email handed out again (a server that lost its place) isn't stored twice.
    const again = { ...deps, mailbox: fakeMailbox([[mail(43)]]) };
    expect((await runWorkspace(again, wsId, { kind: "manual" })).status).toBe("succeeded");
    expect((await db.select().from(message).where(and(eq(message.workspaceId, wsId), eq(message.direction, "in")))).length).toBe(2);
  });

  it("a mailbox that can't be read doesn't stop the run; the reason is kept for Setup", async () => {
    const broken = { ...defaultDeps({ db, storage }), env, mailbox: fakeMailbox([], Object.assign(new Error("Invalid credentials (Failure)"), { authenticationFailed: true })) };
    const r = await runWorkspace(broken, wsId, { kind: "manual" });
    expect(r.status).toBe("succeeded");
    expect((await db.select().from(mailboxConnection).where(eq(mailboxConnection.workspaceId, wsId)))[0]).toMatchObject({
      status: "error",
      lastSeenUid: "7:43",
      lastError: "The mailbox didn't accept the address and password. Use an app password, not the account's normal password.",
    });
  });

  it("new mail between Mondays queues one run, not one per check", async () => {
    const onArrival = async () => (await db.select().from(run).where(and(eq(run.workspaceId, wsId), eq(run.kind, "on_arrival")))).map((r) => r.status);
    const quiet: MailboxReader = { fetchNew: async () => ({ mail: [], cursor: "", more: false }), waiting: async () => 0 };
    await queueRunsForNewMail({ db, mailbox: quiet });
    expect(await onArrival()).toEqual([]);
    const busy: MailboxReader = { ...quiet, waiting: async (conn) => (conn.workspaceId === wsId ? 2 : 0) };
    await queueRunsForNewMail({ db, mailbox: busy });
    await queueRunsForNewMail({ db, mailbox: busy });
    expect(await onArrival()).toEqual(["queued"]);
    await db.delete(run).where(and(eq(run.workspaceId, wsId), eq(run.kind, "on_arrival")));
    // A reader without the cheap check never polls.
    expect(await queueRunsForNewMail({ db, mailbox: { fetchNew: quiet.fetchNew } })).toEqual({ checked: 0, queued: 0, errors: 0 });
  });

  it("sends through the workspace's SMTP login with its attachments; other workspaces only record", async () => {
    const sent: unknown[] = [];
    const logins: MailboxSettings[] = [];
    const transport = async (conn: MailboxSettings): Promise<SmtpTransport> => {
      logins.push(conn);
      return { sendMail: async (m: unknown) => (sent.push(m), { messageId: "<abc@smtp.example>" }), verify: async () => true } as unknown as SmtpTransport;
    };
    const mailer = mailboxMailer(db, env, transport);
    const r = await mailer.send({ workspaceId: wsId, from: "accounts@lahoreapps.example", fromName: "Mail Test (Pvt) Ltd", to: "ap@fjord.example", subject: "INV-2026-001", body: "Hi Ingrid", attachments: [{ name: "INV-2026-001.pdf", contentType: "application/pdf", content: new Uint8Array([37, 80, 68, 70]) }] });
    expect(r).toEqual({ messageId: "<abc@smtp.example>", via: "smtp" });
    expect(logins[0]).toMatchObject({ smtpHost: "smtp.gmail.com", smtpPort: 465, username: "Accounts@LahoreApps.example", password: "abcdefghijklmnop" });
    expect(sent[0]).toMatchObject({ from: { name: "Mail Test (Pvt) Ltd", address: "Accounts@LahoreApps.example" }, to: "ap@fjord.example", subject: "INV-2026-001", text: "Hi Ingrid", attachments: [{ filename: "INV-2026-001.pdf", contentType: "application/pdf" }] });
    expect(await mailer.send({ workspaceId: "00000000-0000-0000-0000-000000000000", from: "x@y.example", to: "z@y.example", subject: "s", body: "b" })).toEqual({ messageId: null, via: "recorded" });
  });
});
