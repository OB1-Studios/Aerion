import { client, demoInboxItem, document, documentKey, draftAction, mailboxConnection, message, sha256 } from "@ebo/db";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { audit } from "../context";
import { mailboxProblem, type IncomingMail } from "../mailbox";
import { checkUpload } from "../uploads";
import { bump, type Step, type StepContext } from "./types";

/** How many new emails one run reads from a real mailbox; the rest wait for the next run. */
const MAIL_PER_RUN = 25;

/**
 * Pull: bring in what arrived since the last run. Demo workspaces read the simulated
 * mailbox (items whose time has come on the workspace clock); a reply that depends on an
 * email we never sent stays waiting, so the follow-up week reflects what was approved.
 * A workspace with its own mailbox connected reads the new mail from it over IMAP.
 */
export const pullStep: Step = {
  name: "pull",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const [conn] = await db.select().from(mailboxConnection).where(eq(mailboxConnection.workspaceId, wsId));
    const due = await db
      .select()
      .from(demoInboxItem)
      .where(and(eq(demoInboxItem.workspaceId, wsId), isNull(demoInboxItem.pulledAt), lte(demoInboxItem.deliverAt, c.w.clock)))
      .orderBy(asc(demoInboxItem.deliverAt));
    const sent = new Set(
      (await db.selectDistinct({ t: draftAction.template }).from(draftAction).where(and(eq(draftAction.workspaceId, wsId), eq(draftAction.status, "sent")))).map((r) => r.t),
    );
    const clients = await db.select({ id: client.id, emails: client.contactEmails }).from(client).where(eq(client.workspaceId, wsId));
    const clientFor = (from: string | null) => {
      const addr = (/<([^>]+)>/.exec(from ?? "")?.[1] ?? from ?? "").trim().toLowerCase();
      if (!addr) return null;
      const exact = clients.find((x) => x.emails.some((e) => e.toLowerCase() === addr));
      if (exact) return exact.id;
      const domain = addr.split("@")[1];
      return clients.find((x) => x.emails.some((e) => e.toLowerCase().split("@")[1] === domain))?.id ?? null;
    };

    const delivered: Array<{ channel: string; from: string | null; subject: string | null; files: string[] }> = [];
    const waiting: Array<{ subject: string | null; needs: string }> = [];
    for (const item of due) {
      if (item.requiresSentTemplate && !sent.has(item.requiresSentTemplate)) {
        waiting.push({ subject: item.subject, needs: item.requiresSentTemplate });
        continue;
      }
      const documentIds: string[] = [];
      for (const a of item.attachments) {
        const inserted = await db
          .insert(document)
          .values({
            workspaceId: wsId,
            kind: item.channel === "email" ? "other" : (item.kindHint ?? "other"),
            storagePath: a.storagePath,
            sha256: a.sha256,
            originalName: a.name,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            source: item.channel === "email" ? "email" : "upload",
            receivedAt: item.deliverAt,
            parseStatus: "pending",
          })
          .onConflictDoNothing({ target: [document.workspaceId, document.sha256] })
          .returning({ id: document.id });
        const id = inserted[0]?.id ?? (await db.select({ id: document.id }).from(document).where(and(eq(document.workspaceId, wsId), eq(document.sha256, a.sha256))))[0]?.id;
        if (id) documentIds.push(id);
      }
      let messageId: string | null = null;
      if (item.channel === "email") {
        const [m] = await db
          .insert(message)
          .values({
            workspaceId: wsId,
            direction: "in",
            fromAddress: item.fromAddress ?? "unknown",
            toAddress: item.toAddress ?? (c.w.ws.settings?.mailboxAddress ?? ""),
            subject: item.subject,
            sentAt: item.deliverAt,
            bodyText: item.bodyText,
            documentIds,
            clientId: clientFor(item.fromAddress),
            threadKey: item.subject?.replace(/^(re|fwd?):\s*/gi, "") ?? null,
          })
          .returning({ id: message.id });
        messageId = m?.id ?? null;
        bump(c, "emails");
      }
      await db.update(demoInboxItem).set({ pulledAt: new Date(), pulledByRunId: c.runId }).where(eq(demoInboxItem.id, item.id));
      await audit(db, { workspaceId: wsId, actorType: "agent", actorId: c.runId, action: item.channel === "email" ? "email.received" : "document.uploaded", objectType: messageId ? "message" : "document", objectId: messageId ?? documentIds[0] ?? null, details: { subject: item.subject, files: item.attachments.map((a) => a.name) } });
      delivered.push({ channel: item.channel, from: item.fromAddress, subject: item.subject, files: item.attachments.map((a) => a.name) });
      bump(c, "documents", documentIds.length);
    }

    // The workspace's own mailbox. The cursor only moves once everything up to it is saved.
    let mailbox: { address: string; read: number; more: boolean; skipped: string[]; error?: string } | null = null;
    if (conn && conn.status !== "paused" && c.deps.mailbox && !c.w.ws.isDemo) {
      mailbox = { address: conn.username, read: 0, more: false, skipped: [] };
      try {
        const { mail, cursor, more } = await c.deps.mailbox.fetchNew(conn, { limit: MAIL_PER_RUN });
        for (const m of mail) {
          const kept = await storeIncoming(c, m, clientFor(m.from));
          mailbox.skipped.push(...kept.skipped);
          if (kept.stored) delivered.push({ channel: "email", from: m.from, subject: m.subject, files: m.files.map((f) => f.name) });
        }
        mailbox.read = mail.length;
        mailbox.more = more;
        await db.update(mailboxConnection).set({ lastSeenUid: cursor, lastPolledAt: new Date(), status: "ok", lastError: null }).where(eq(mailboxConnection.id, conn.id));
      } catch (err) {
        mailbox.error = mailboxProblem(err, conn);
        await db.update(mailboxConnection).set({ lastPolledAt: new Date(), status: "error", lastError: mailbox.error }).where(eq(mailboxConnection.id, conn.id));
      }
    }

    const emails = delivered.filter((d) => d.channel === "email").length;
    const uploads = delivered.length - emails;
    c.report.push(
      delivered.length
        ? `Pulled ${emails} email${emails === 1 ? "" : "s"} and ${uploads} upload${uploads === 1 ? "" : "s"} (${c.counts.documents ?? 0} documents).`
        : "Nothing new in the mailbox.",
    );
    if (waiting.length) c.report.push(`${waiting.length} expected repl${waiting.length === 1 ? "y is" : "ies are"} waiting on emails that haven't been sent yet.`);
    if (mailbox?.error) c.report.push(`Couldn't read ${mailbox.address}: ${mailbox.error}`);
    if (mailbox?.more) c.report.push(`More new mail is waiting in ${mailbox.address}; the next run reads it.`);
    if (mailbox?.skipped.length) c.report.push(`Attachments not kept: ${mailbox.skipped.slice(0, 5).join("; ")}.`);
    return { source: mailbox ? `mailbox ${mailbox.address}` : c.w.ws.isDemo ? "demo mailbox" : "uploads only (no mailbox connected)", delivered, waiting, ...(mailbox ? { mailbox } : {}) };
  },
};

/** Saves one email from the mailbox, with its attachments as documents for the read step. */
async function storeIncoming(c: StepContext, m: IncomingMail, clientId: string | null): Promise<{ stored: boolean; skipped: string[] }> {
  const { db, storage } = c.deps;
  const wsId = c.w.ws.id;
  const [seen] = await db.select({ id: message.id }).from(message).where(and(eq(message.workspaceId, wsId), eq(message.mailboxUid, m.key)));
  if (seen) return { stored: false, skipped: [] };
  const documentIds: string[] = [];
  const skipped: string[] = [];
  for (const f of m.files) {
    const check = checkUpload(f.name, f.bytes);
    if (!check.ok) {
      skipped.push(`${f.name} ${check.reason}`);
      continue;
    }
    const hash = sha256(f.bytes);
    const key = documentKey(wsId, hash, check.mimeType);
    // The file first: a document row must never point at a file that isn't there.
    await storage.put(key, f.bytes, check.mimeType);
    const inserted = await db
      .insert(document)
      .values({ workspaceId: wsId, kind: "other", storagePath: key, sha256: hash, originalName: check.name, mimeType: check.mimeType, sizeBytes: f.bytes.length, source: "email", receivedAt: m.date, parseStatus: "pending" })
      .onConflictDoNothing({ target: [document.workspaceId, document.sha256] })
      .returning({ id: document.id });
    const id = inserted[0]?.id ?? (await db.select({ id: document.id }).from(document).where(and(eq(document.workspaceId, wsId), eq(document.sha256, hash))))[0]?.id;
    if (id) documentIds.push(id);
  }
  const [row] = await db
    .insert(message)
    .values({
      workspaceId: wsId,
      direction: "in",
      fromAddress: m.from,
      toAddress: m.to || (c.w.ws.settings?.mailboxAddress ?? ""),
      subject: m.subject,
      sentAt: m.date,
      bodyText: m.text,
      documentIds,
      clientId,
      threadKey: m.subject?.replace(/^(re|fwd?):\s*/gi, "") ?? null,
      mailboxUid: m.key,
    })
    .returning({ id: message.id });
  bump(c, "emails");
  bump(c, "documents", documentIds.length);
  await audit(db, { workspaceId: wsId, actorType: "agent", actorId: c.runId, action: "email.received", objectType: "message", objectId: row?.id ?? null, details: { subject: m.subject, from: m.from, files: m.files.map((f) => f.name), via: "imap" } });
  return { stored: true, skipped };
}
