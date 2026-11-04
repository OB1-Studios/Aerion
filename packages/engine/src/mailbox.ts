import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mailboxConnection, run, workspace, type Db } from "@ebo/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import { audit, type Mailer, type OutgoingEmail, type Workspace } from "./context";
import { openSecret, sealSecret } from "./secrets";

/**
 * The workspace's own mailbox (main doc W5): new mail is read over IMAP at the start of each
 * run, and approved emails go out over SMTP, both with an app password. The password is
 * sealed before it's stored and never sent to the browser. The mailbox is opened read-only:
 * nothing is marked as read, moved or deleted.
 */

type Env = Record<string, string | undefined>;
export type MailboxRow = typeof mailboxConnection.$inferSelect;

export const MAILBOX_PROVIDERS = {
  gmail: {
    label: "Gmail or Google Workspace",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    help: "Turn on 2-Step Verification for the account, then create an app password at myaccount.google.com/apppasswords and paste it here.",
  },
  zoho: {
    label: "Zoho Mail",
    imapHost: "imap.zoho.com",
    imapPort: 993,
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    help: "Switch on IMAP access in Zoho Mail's settings, then create an application-specific password.",
  },
} as const;
export type MailboxProvider = keyof typeof MAILBOX_PROVIDERS | "other";

/** Ports that carry IMAP and SMTP. Anything else is refused, so the form can't be used to probe other services. */
const IMAP_PORTS = new Set([993, 143]);
const SMTP_PORTS = new Set([465, 587, 2525]);
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const MAX_MESSAGE_BYTES = 15 * 1024 * 1024;
const MAX_BODY_CHARS = 100_000;

export interface MailboxSettings {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
}

export interface MailboxInput {
  provider: string;
  address: string;
  password: string;
  imapHost?: string;
  imapPort?: string;
  smtpHost?: string;
  smtpPort?: string;
  username?: string;
}

/** The form, checked and resolved to connection settings. */
export function mailboxSettings(input: MailboxInput): { settings: MailboxSettings } | { problems: string[] } {
  const problems: string[] = [];
  const address = input.address.trim();
  const provider = (input.provider in MAILBOX_PROVIDERS ? input.provider : "other") as MailboxProvider;
  // Gmail shows app passwords in groups of four; the spaces aren't part of it.
  const password = provider === "gmail" ? input.password.replace(/\s+/g, "") : input.password;
  if (!EMAIL_RE.test(address)) problems.push("The email address doesn't look right.");
  if (!password) problems.push("Paste the app password.");
  if (password.length > 200) problems.push("That password is too long.");
  if (provider !== "other") {
    const p = MAILBOX_PROVIDERS[provider];
    if (problems.length) return { problems };
    return { settings: { imapHost: p.imapHost, imapPort: p.imapPort, smtpHost: p.smtpHost, smtpPort: p.smtpPort, username: address, password } };
  }
  const imapHost = (input.imapHost ?? "").trim().toLowerCase();
  const smtpHost = (input.smtpHost ?? "").trim().toLowerCase();
  const imapPort = Number((input.imapPort ?? "").trim() || 993);
  const smtpPort = Number((input.smtpPort ?? "").trim() || 465);
  if (!HOST_RE.test(imapHost)) problems.push("The IMAP server should be a host name, like mail.example.com.");
  if (!HOST_RE.test(smtpHost)) problems.push("The SMTP server should be a host name, like mail.example.com.");
  if (!IMAP_PORTS.has(imapPort)) problems.push("The IMAP port should be 993 (or 143 with STARTTLS).");
  if (!SMTP_PORTS.has(smtpPort)) problems.push("The SMTP port should be 465, 587 or 2525.");
  const username = (input.username ?? "").trim() || address;
  if (problems.length) return { problems };
  return { settings: { imapHost, imapPort, smtpHost, smtpPort, username, password } };
}

// ---------------------------------------------------------------------------
// Connecting safely: public hosts only, TLS always
// ---------------------------------------------------------------------------

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

/**
 * Resolves a mail host once and connects to that address (with the name kept for the TLS
 * check), so a host can't point at the app's private network, before or after the check.
 */
async function resolvePublic(host: string, env: Env): Promise<string> {
  const addresses = await lookup(host, { all: true });
  if (!addresses.length) throw Object.assign(new Error(`no address for ${host}`), { code: "ENOTFOUND", hostname: host });
  const allowPrivate = env.MAIL_ALLOW_PRIVATE_HOSTS === "1";
  const usable = addresses.filter((a) => allowPrivate || !privateAddress(a.address));
  if (!usable.length) throw Object.assign(new Error(`${host} is on a private network`), { code: "EPRIVATE", hostname: host });
  return usable[0]!.address;
}

async function imapClient(conn: Pick<MailboxSettings, "imapHost" | "imapPort" | "username" | "password">, env: Env): Promise<ImapFlow> {
  const ip = await resolvePublic(conn.imapHost, env);
  return new ImapFlow({
    host: ip,
    servername: conn.imapHost,
    port: conn.imapPort,
    secure: conn.imapPort === 993,
    // Port 143 only with STARTTLS: an app password never crosses the network in the clear.
    doSTARTTLS: conn.imapPort === 993 ? undefined : true,
    auth: { user: conn.username, pass: conn.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

export type SmtpTransport = Pick<Transporter, "sendMail" | "verify">;

export async function smtpTransport(conn: Pick<MailboxSettings, "smtpHost" | "smtpPort" | "username" | "password">, env: Env): Promise<SmtpTransport> {
  const ip = await resolvePublic(conn.smtpHost, env);
  return nodemailer.createTransport({
    host: ip,
    port: conn.smtpPort,
    secure: conn.smtpPort === 465,
    requireTLS: conn.smtpPort !== 465,
    tls: { servername: conn.smtpHost },
    auth: { user: conn.username, pass: conn.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/** What went wrong talking to the mailbox, in words a person can act on. */
export function mailboxProblem(err: unknown, conn?: Partial<MailboxSettings>): string {
  const e = (err ?? {}) as { code?: string; authenticationFailed?: boolean; responseCode?: number; response?: string; hostname?: string; message?: string; responseText?: string };
  const text = `${e.message ?? ""} ${e.response ?? ""} ${e.responseText ?? ""}`;
  if (e.authenticationFailed || e.code === "EAUTH" || e.responseCode === 535 || /AUTHENTICATIONFAILED|invalid credentials|authentication failed|username and password not accepted/i.test(text))
    return "The mailbox didn't accept the address and password. Use an app password, not the account's normal password.";
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return `Couldn't find the server ${e.hostname ?? conn?.imapHost ?? ""}. Check its name.`.replace("  ", " ");
  if (e.code === "EPRIVATE") return "That server is on a private network, so the app won't connect to it.";
  if (e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ESOCKET" || e.code === "ECONNECTION" || /timed? ?out/i.test(text)) return "Couldn't reach the mail server. Check the server names and ports.";
  if (/certificate|self[- ]signed|CERT_|TLS|SSL/i.test(`${e.code ?? ""} ${text}`)) return "The mail server's security certificate didn't check out, so the app won't send the password to it.";
  if (/STARTTLS/i.test(text)) return "The mail server doesn't offer an encrypted connection on that port. Use port 993 for IMAP and 465 for SMTP.";
  return `The mail server said: ${(e.message ?? String(err)).slice(0, 200)}`;
}

export interface MailboxCheck {
  ok: boolean;
  problems: string[];
  /** Where reading starts: only mail that arrives after connecting is pulled. */
  cursor?: string;
}

/** Logs in over IMAP and SMTP with these settings, without reading or sending anything. */
export async function testMailbox(settings: MailboxSettings, env: Env = process.env): Promise<MailboxCheck> {
  let cursor: string;
  try {
    const client = await imapClient(settings, env);
    await client.connect();
    try {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      cursor = `${box.uidValidity}:${box.uidNext - 1}`;
    } finally {
      await client.logout().catch(() => client.close());
    }
  } catch (err) {
    return { ok: false, problems: [`Reading mail (IMAP): ${mailboxProblem(err, settings)}`] };
  }
  try {
    await (await smtpTransport(settings, env)).verify();
  } catch (err) {
    return { ok: false, problems: [`Sending mail (SMTP): ${mailboxProblem(err, { ...settings, imapHost: settings.smtpHost })}`] };
  }
  return { ok: true, problems: [], cursor };
}

export async function connectMailbox(
  db: Db,
  ws: Workspace,
  input: MailboxInput,
  userId: string,
  opts: { env?: Env; test?: typeof testMailbox } = {},
): Promise<{ ok: true; id: string } | { ok: false; problems: string[] }> {
  if (ws.isDemo) return { ok: false, problems: ["Demo workspaces use a simulated mailbox, so a real one can't be connected here."] };
  const env = opts.env ?? process.env;
  const resolved = mailboxSettings(input);
  if ("problems" in resolved) return { ok: false, problems: resolved.problems };
  const s = resolved.settings;
  const check = await (opts.test ?? testMailbox)(s, env);
  if (!check.ok) return { ok: false, problems: check.problems };
  const address = input.address.trim().toLowerCase();
  const id = await db.transaction(async (tx) => {
    await tx.delete(mailboxConnection).where(eq(mailboxConnection.workspaceId, ws.id));
    const [row] = await tx
      .insert(mailboxConnection)
      .values({ workspaceId: ws.id, imapHost: s.imapHost, imapPort: s.imapPort, smtpHost: s.smtpHost, smtpPort: s.smtpPort, username: s.username, secretEncrypted: sealSecret(s.password, env), lastSeenUid: check.cursor ?? null, status: "ok" })
      .returning({ id: mailboxConnection.id });
    await tx
      .update(workspace)
      .set({ emailDomain: address.split("@")[1]!, settings: { ...ws.settings, mailboxAddress: address } })
      .where(eq(workspace.id, ws.id));
    return row!.id;
  });
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "mailbox.connected", objectType: "mailbox_connection", objectId: id, details: { address, imap: `${s.imapHost}:${s.imapPort}`, smtp: `${s.smtpHost}:${s.smtpPort}` } });
  return { ok: true, id };
}

export async function disconnectMailbox(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const rows = await db.delete(mailboxConnection).where(eq(mailboxConnection.workspaceId, workspaceId)).returning({ id: mailboxConnection.id, username: mailboxConnection.username });
  if (!rows.length) return false;
  await audit(db, { workspaceId, actorType: "user", actorId: userId, action: "mailbox.disconnected", objectType: "mailbox_connection", objectId: rows[0]!.id, details: { address: rows[0]!.username } });
  return true;
}

// ---------------------------------------------------------------------------
// Reading new mail
// ---------------------------------------------------------------------------

export interface IncomingMail {
  /** "uidvalidity:uid", so the same email is never stored twice. */
  key: string;
  from: string;
  to: string;
  subject: string | null;
  date: Date;
  text: string;
  files: Array<{ name: string; mimeType: string; bytes: Uint8Array }>;
}

export interface MailboxReader {
  /** Mail that arrived after the connection's cursor, oldest first, and the cursor to store once it's saved. */
  fetchNew(conn: MailboxRow, opts: { limit: number }): Promise<{ mail: IncomingMail[]; cursor: string; more: boolean }>;
  /** How many emails are waiting past the cursor, from the mailbox's status alone (nothing is downloaded). */
  waiting?(conn: MailboxRow): Promise<number>;
}

const addresses = (a: ParsedMail["to"]) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : (a?.text ?? ""));

function toIncoming(key: string, parsed: ParsedMail, fallbackDate: Date): IncomingMail {
  const files = parsed.attachments
    // Logos and signature images embedded in the HTML aren't documents.
    .filter((a) => !a.related && !(a.contentDisposition === "inline" && a.contentType.startsWith("image/")))
    .map((a, i) => ({ name: a.filename || `attachment-${i + 1}`, mimeType: a.contentType, bytes: new Uint8Array(a.content) }));
  return {
    key,
    from: parsed.from?.text || "unknown",
    to: addresses(parsed.to),
    subject: parsed.subject ?? null,
    date: parsed.date ?? fallbackDate,
    text: (parsed.text ?? "").slice(0, MAX_BODY_CHARS),
    files,
  };
}

export function imapReader(env: Env = process.env): MailboxReader {
  return {
    async waiting(conn) {
      const client = await imapClient({ ...conn, password: openSecret(conn.secretEncrypted, env) }, env);
      await client.connect();
      try {
        const status = await client.status("INBOX", { uidNext: true, uidValidity: true });
        if (!status || status.uidNext == null) return 0;
        const [validity, lastText] = (conn.lastSeenUid ?? "").split(":");
        // A renumbered mailbox counts as new mail: the next run resets the cursor.
        if (validity !== String(status.uidValidity)) return 1;
        return Math.max(0, status.uidNext - 1 - Number(lastText || 0));
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
    async fetchNew(conn, { limit }) {
      const client = await imapClient({ ...conn, password: openSecret(conn.secretEncrypted, env) }, env);
      await client.connect();
      try {
        const box = await client.mailboxOpen("INBOX", { readOnly: true });
        const [validity, lastText] = (conn.lastSeenUid ?? "").split(":");
        const last = Number(lastText);
        const latest = `${box.uidValidity}:${box.uidNext - 1}`;
        // First read, or the server renumbered the mailbox: start from what's there now.
        if (validity !== String(box.uidValidity) || !Number.isInteger(last)) return { mail: [], cursor: latest, more: false };
        if (box.uidNext - 1 <= last) return { mail: [], cursor: `${validity}:${last}`, more: false };
        const heads = (await client.fetchAll(`${last + 1}:*`, { uid: true, size: true, internalDate: true }, { uid: true })).filter((m) => m.uid > last).sort((a, b) => a.uid - b.uid);
        const batch = heads.slice(0, limit);
        const mail: IncomingMail[] = [];
        for (const h of batch) {
          const key = `${box.uidValidity}:${h.uid}`;
          const when = h.internalDate ? new Date(h.internalDate) : new Date();
          if ((h.size ?? 0) > MAX_MESSAGE_BYTES) {
            mail.push({ key, from: "unknown", to: conn.username, subject: "(an email too large to download)", date: when, text: `This email is over ${MAX_MESSAGE_BYTES / 1024 / 1024} MB, so it wasn't downloaded. Open it in the mailbox.`, files: [] });
            continue;
          }
          const full = await client.fetchOne(String(h.uid), { uid: true, source: true }, { uid: true });
          if (!full || !full.source) continue;
          mail.push(toIncoming(key, await simpleParser(full.source), when));
        }
        const end = batch.length ? batch[batch.length - 1]!.uid : last;
        return { mail, cursor: `${box.uidValidity}:${end}`, more: heads.length > batch.length };
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends through the workspace's connected mailbox. A workspace without one (every demo
 * workspace) only records the email, as before.
 */
export function mailboxMailer(db: Db, env: Env = process.env, transportFor: (conn: MailboxSettings, env: Env) => Promise<SmtpTransport> = smtpTransport): Mailer {
  return {
    kind: "smtp",
    async send(email: OutgoingEmail) {
      const [conn] = await db.select().from(mailboxConnection).where(eq(mailboxConnection.workspaceId, email.workspaceId));
      if (!conn || conn.status === "paused") return { messageId: null, via: "recorded" as const };
      const transport = await transportFor({ ...conn, password: openSecret(conn.secretEncrypted, env) }, env);
      const info = await transport.sendMail({
        from: email.fromName ? { name: email.fromName, address: conn.username } : conn.username,
        to: email.to,
        cc: email.cc || undefined,
        subject: email.subject,
        text: email.body,
        attachments: (email.attachments ?? []).map((a) => ({ filename: a.name, contentType: a.contentType, content: Buffer.from(a.content) })),
      });
      return { messageId: (info as { messageId?: string }).messageId ?? null, via: "smtp" as const };
    },
  };
}

// ---------------------------------------------------------------------------
// Between Mondays: a run when mail arrives
// ---------------------------------------------------------------------------

/**
 * Checks every connected mailbox and queues an "on arrival" run for each workspace with new
 * mail and no run already waiting or going. The worker calls this every 15 minutes.
 */
export async function queueRunsForNewMail(deps: { db: Db; mailbox?: MailboxReader }): Promise<{ checked: number; queued: number; errors: number }> {
  const { db, mailbox } = deps;
  if (!mailbox?.waiting) return { checked: 0, queued: 0, errors: 0 };
  const rows = await db
    .select({ conn: mailboxConnection })
    .from(mailboxConnection)
    .innerJoin(workspace, eq(workspace.id, mailboxConnection.workspaceId))
    .where(and(eq(workspace.isDemo, false), ne(mailboxConnection.status, "paused")));
  let queued = 0;
  let errors = 0;
  for (const { conn } of rows) {
    try {
      if (!(await mailbox.waiting(conn))) continue;
      const [busy] = await db.select({ id: run.id }).from(run).where(and(eq(run.workspaceId, conn.workspaceId), inArray(run.status, ["queued", "running"])));
      if (busy) continue;
      await db.insert(run).values({ workspaceId: conn.workspaceId, kind: "on_arrival", clockAt: new Date(), status: "queued" });
      queued++;
    } catch (err) {
      errors++;
      await db.update(mailboxConnection).set({ status: "error", lastError: mailboxProblem(err, conn), lastPolledAt: new Date() }).where(eq(mailboxConnection.id, conn.id));
    }
  }
  return { checked: rows.length, queued, errors };
}
