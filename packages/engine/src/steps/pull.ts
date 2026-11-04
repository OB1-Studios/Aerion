import { client, demoInboxItem, document, draftAction, mailboxConnection, message } from "@ebo/db";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { audit } from "../context";
import { bump, type Step } from "./types";

/**
 * Pull: bring in what arrived since the last run. Demo workspaces read the simulated
 * mailbox (items whose time has come on the workspace clock); a reply that depends on an
 * email we never sent stays waiting, so the follow-up week reflects what was approved.
 */
export const pullStep: Step = {
  name: "pull",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const mailboxes = await db.select({ id: mailboxConnection.id }).from(mailboxConnection).where(eq(mailboxConnection.workspaceId, wsId));
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

    const emails = delivered.filter((d) => d.channel === "email").length;
    const uploads = delivered.length - emails;
    c.report.push(
      delivered.length
        ? `Pulled ${emails} email${emails === 1 ? "" : "s"} and ${uploads} upload${uploads === 1 ? "" : "s"} (${c.counts.documents ?? 0} documents).`
        : "Nothing new in the mailbox.",
    );
    if (waiting.length) c.report.push(`${waiting.length} expected repl${waiting.length === 1 ? "y is" : "ies are"} waiting on emails that haven't been sent yet.`);
    return { source: mailboxes.length ? "mailbox (not polled in this build)" : "demo mailbox", delivered, waiting };
  },
};
