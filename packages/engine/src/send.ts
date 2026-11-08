import { attachesInvoice, checkNumbers, dateInZone, TEMPLATE_ALLOW_LIST, type NumbersCheckResult, type SendDecision } from "@ebo/core";
import { complianceItem, document, documentKey, draftAction, flag, invoice, invoiceReminder, message, sha256, workspace, type Db, type Storage } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";
import { audit, workspaceClock, type Mailer, type OutgoingEmail } from "./context";
import { invoicePdf } from "./invoicing";

export interface Actor {
  type: "user" | "agent";
  id: string | null;
}

/**
 * Sends one draft. Shared by the run's send step and by a person approving a draft.
 * The numbers check runs again on the exact text being sent, whatever happened before.
 */
export async function sendDraft(deps: SendDeps, draftId: string, actor: Actor): Promise<{ ok: boolean; reason?: string }> {
  const { db, mailer } = deps;
  const [d] = await db.select().from(draftAction).where(eq(draftAction.id, draftId));
  if (!d) return { ok: false, reason: "Draft not found." };
  if (d.kind === "internal_task") return { ok: false, reason: "Tasks are not sent." };
  if (!["approved", "scheduled", "failed"].includes(d.status)) return { ok: false, reason: `Draft is ${d.status}.` };
  if (!d.toAddress || !d.subject || !d.bodyRendered) return { ok: false, reason: "Draft has no recipient, subject or body." };
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, d.workspaceId));
  if (!ws) return { ok: false, reason: "Workspace not found." };

  const check = checkNumbers(`${d.subject}\n${d.bodyRendered}`, d.evidence ?? {}, TEMPLATE_ALLOW_LIST);
  if (!check.ok) {
    await db.update(draftAction).set({ status: "blocked", numbersCheck: check }).where(eq(draftAction.id, d.id));
    await audit(db, { workspaceId: d.workspaceId, actorType: actor.type, actorId: actor.id, action: "draft.blocked", objectType: "draft_action", objectId: d.id, details: { failures: check.failures } });
    return { ok: false, reason: "A number in the draft doesn't match the records." };
  }

  const at = workspaceClock(ws);
  const from = ws.settings?.mailboxAddress ?? `no-reply@${ws.emailDomain ?? "example.invalid"}`;
  // An email that says the invoice is attached carries it, rendered from the records as they are now.
  const needsPdf = attachesInvoice(d.template);
  const pdf = needsPdf && d.invoiceId ? await invoicePdf(db, ws.id, d.invoiceId) : null;
  if (needsPdf && !pdf) return { ok: false, reason: "The invoice for this email no longer exists." };
  const attachments: OutgoingEmail["attachments"] = pdf ? [{ name: pdf.name, contentType: "application/pdf", content: pdf.bytes }] : [];
  await db.update(draftAction).set({ status: "sending" }).where(eq(draftAction.id, d.id));
  let providerId: string | null = null;
  let via: string = mailer.kind;
  try {
    const result = await mailer.send({ workspaceId: ws.id, from, fromName: ws.legalName ?? ws.name, to: d.toAddress, cc: d.ccAddress, subject: d.subject, body: d.bodyRendered, attachments });
    providerId = result.messageId;
    via = result.via ?? mailer.kind;
  } catch (err) {
    await db.update(draftAction).set({ status: "failed", rejectedReason: String(err) }).where(eq(draftAction.id, d.id));
    return { ok: false, reason: `Sending failed: ${String(err)}` };
  }

  const today = dateInZone(at, ws.timezone);
  // Keep the exact PDF that went out, next to the message that carried it.
  const kept = pdf && deps.storage ? await keepFile(db, deps.storage, ws.id, at, pdf.name, pdf.bytes) : null;
  await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(message)
      .values({ workspaceId: ws.id, direction: "out", fromAddress: from, toAddress: d.toAddress!, subject: d.subject, sentAt: at, bodyText: d.bodyRendered, threadKey: d.subject?.replace(/^(re|fwd?):\s*/gi, "") ?? null, mailboxUid: providerId, documentIds: kept ? [kept] : [] })
      .returning({ id: message.id });
    await tx.update(draftAction).set({ status: "sent", sentAt: at, messageId: m!.id }).where(eq(draftAction.id, d.id));

    const stage = /:stage(\d+)$/.exec(d.key)?.[1];
    if (d.invoiceId && stage && ["T1", "T2", "T3"].includes(d.template ?? "")) {
      await tx.insert(invoiceReminder).values({ workspaceId: ws.id, invoiceId: d.invoiceId, stage: Number(stage), sentOn: today, draftActionId: d.id });
    }
    if (d.invoiceId && d.template === "T11") {
      await tx
        .update(invoice)
        .set({ status: "sent", sentAt: at, ...(kept ? { pdfDocumentId: kept } : {}) })
        .where(and(eq(invoice.id, d.invoiceId), eq(invoice.status, "draft")));
    }
    if (d.flagIds.length) {
      const flags = await tx.select().from(flag).where(inArray(flag.id, d.flagIds));
      if (d.template === "T8") {
        const itemIds = flags.filter((f) => f.subjectType === "compliance_item").map((f) => f.subjectId);
        if (itemIds.length) await tx.update(complianceItem).set({ status: "requested", requestedAt: at }).where(and(inArray(complianceItem.id, itemIds), eq(complianceItem.status, "missing")));
      }
      await tx.update(flag).set({ status: "actioned", updatedAt: at }).where(and(inArray(flag.id, d.flagIds), eq(flag.status, "open")));
    }
  });
  await audit(db, { workspaceId: ws.id, actorType: actor.type, actorId: actor.id, action: "email.sent", objectType: "draft_action", objectId: d.id, details: { template: d.template, to: d.toAddress, subject: d.subject, mailer: via, attachments: attachments.map((a) => a.name) } });
  return { ok: true };
}

export interface SendDeps {
  db: Db;
  mailer: Mailer;
  /** Where sent attachments are kept (Object Storage when deployed). Without it they're sent but not kept. */
  storage?: Storage;
}

/** Stores a file the workspace sent, as a document that's on file but not for the agent to read. */
async function keepFile(db: Db, storage: Storage, workspaceId: string, at: Date, name: string, bytes: Uint8Array): Promise<string> {
  const hash = sha256(bytes);
  const key = documentKey(workspaceId, hash, "application/pdf");
  await storage.put(key, bytes, "application/pdf");
  const [row] = await db
    .insert(document)
    .values({ workspaceId, kind: "invoice_pdf", storagePath: key, sha256: hash, originalName: name, mimeType: "application/pdf", sizeBytes: bytes.length, source: "generated", receivedAt: at, parseStatus: "skipped", reviewReasons: [`The copy of ${name} sent by email, kept on file. The agent doesn't read what the workspace sends.`] })
    .onConflictDoUpdate({ target: [document.workspaceId, document.sha256], set: { originalName: name } })
    .returning({ id: document.id });
  return row!.id;
}

/** A person approves a draft; in this build approval sends it straight away. */
export async function approveAndSend(deps: SendDeps, draftId: string, userId: string): Promise<{ ok: boolean; reason?: string }> {
  const { db } = deps;
  const [d] = await db.select().from(draftAction).where(eq(draftAction.id, draftId));
  if (!d) return { ok: false, reason: "Draft not found." };
  if (d.status !== "draft" && d.status !== "scheduled") return { ok: false, reason: `Draft is ${d.status}.` };
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, d.workspaceId));
  await db.update(draftAction).set({ status: "approved", approvedBy: userId, approvedAt: ws ? workspaceClock(ws) : new Date() }).where(eq(draftAction.id, d.id));
  await audit(db, { workspaceId: d.workspaceId, actorType: "user", actorId: userId, action: "draft.approved", objectType: "draft_action", objectId: d.id, details: { template: d.template, subject: d.subject } });
  return sendDraft(deps, draftId, { type: "user", id: userId });
}

/** The longest subject and text a person can give an email. */
export const DRAFT_LIMITS = { subject: 200, body: 20_000 } as const;

/** Marks a draft whose words a person wrote, so later runs keep them (see steps/draft.ts). */
export const EDITED_BY_PERSON = "person";

export type EditDraftResult = { ok: true; changed: boolean; check: NumbersCheckResult } | { ok: false; problems: string[] };

/**
 * A person rewrites an email before it goes. Their text gets the same numbers check as the
 * agent's: every amount, date and invoice number must still trace to the records, or the email
 * is held until it does. An edited email always waits for a person to approve it, whatever the
 * approval policy says, and the audit log keeps the text it replaced.
 */
export async function editDraft(db: Db, draftId: string, userId: string, input: { subject: string; body: string }): Promise<EditDraftResult> {
  const subject = input.subject.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const body = input.body
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+|\n+$/g, "");
  const problems: string[] = [];
  if (!subject) problems.push("The email needs a subject.");
  if (subject.length > DRAFT_LIMITS.subject) problems.push(`The subject is too long (${DRAFT_LIMITS.subject} characters at most).`);
  if (!body.trim()) problems.push("The email needs some text.");
  if (body.length > DRAFT_LIMITS.body) problems.push(`The text is too long (${DRAFT_LIMITS.body.toLocaleString("en")} characters at most).`);
  const [d] = await db.select().from(draftAction).where(eq(draftAction.id, draftId));
  if (!d) return { ok: false, problems: ["This email no longer exists."] };
  if (d.kind === "internal_task") return { ok: false, problems: ["Tasks aren't emails."] };
  if (!["draft", "blocked", "scheduled"].includes(d.status)) return { ok: false, problems: [`This email has been ${d.status === "sent" ? "sent" : d.status}, so it can't be changed.`] };
  if (problems.length) return { ok: false, problems };
  const evidence = d.evidence ?? {};
  if (subject === d.subject && body === d.bodyRendered) return { ok: true, changed: false, check: d.numbersCheck ?? checkNumbers(`${subject}\n${body}`, evidence, TEMPLATE_ALLOW_LIST) };

  const check = checkNumbers(`${subject}\n${body}`, evidence, TEMPLATE_ALLOW_LIST);
  const decision: SendDecision = check.ok
    ? { mode: "approve", reasons: ["A person edited this email, so a person approves it before it goes."] }
    : { mode: "blocked", reasons: ["A number in the edited text doesn't match the records. Fix it before it can be sent."] };
  await db
    .update(draftAction)
    .set({ subject, bodyRendered: body, numbersCheck: check, sendDecision: decision, status: check.ok ? "draft" : "blocked", scheduledFor: null, rejectedReason: null, model: EDITED_BY_PERSON })
    .where(eq(draftAction.id, d.id));
  await audit(db, {
    workspaceId: d.workspaceId,
    actorType: "user",
    actorId: userId,
    action: "draft.edited",
    objectType: "draft_action",
    objectId: d.id,
    details: {
      template: d.template,
      ...(subject !== d.subject ? { subject: { from: d.subject, to: subject } } : {}),
      ...(body !== d.bodyRendered ? { previousText: d.bodyRendered } : {}),
      numbersOk: check.ok,
      ...(check.ok ? {} : { unmatched: check.failures.map((f) => f.text) }),
      wasScheduled: d.status === "scheduled",
    },
  });
  return { ok: true, changed: true, check };
}

export async function rejectDraft(db: Db, draftId: string, userId: string, reason: string): Promise<void> {
  const [d] = await db.select().from(draftAction).where(eq(draftAction.id, draftId));
  if (!d || !["draft", "blocked", "scheduled"].includes(d.status)) return;
  await db.update(draftAction).set({ status: "rejected", rejectedReason: reason || "Rejected" }).where(eq(draftAction.id, d.id));
  await audit(db, { workspaceId: d.workspaceId, actorType: "user", actorId: userId, action: "draft.rejected", objectType: "draft_action", objectId: d.id, details: { reason } });
}
