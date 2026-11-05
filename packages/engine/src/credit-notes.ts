import { checkCredit, CREDIT_KIND_LABELS, dec, evaluateFlags, fixed2, formatMoney, nextCreditNumber, statusAfterCredit, sumDec, type CreditInput, type CreditKind, type InvoiceStatus } from "@ebo/core";
import { creditNote, dispute, draftAction, flag, invoice, match, type Db } from "@ebo/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { flagSnapshot, loadBooks } from "./books";
import { audit, loadContext, workspaceClock, type Workspace } from "./context";
import { workspaceToday } from "./invoicing";

/**
 * Credit notes, write-offs and voids (main doc W9; the rules are in core/credit-notes.ts).
 * Recording one changes what the client owes straight away, so everything that depended on
 * the old balance is brought up to date before the next run:
 * - flags about the invoice that no longer hold are resolved
 * - open disputes on it are closed by it
 * - emails waiting to go out about it are held for the next run to redraft with the new
 *   numbers, or cancelled when they're no longer needed (a voided invoice gets no emails)
 */

const ACTION: Record<CreditKind, string> = { credit: "invoice.credited", write_off: "invoice.written_off", void: "invoice.voided" };

export type CreditResult =
  | { ok: true; id: string; number: string; kind: CreditKind; amount: string; currency: string; balance: string; status: InvoiceStatus; flagsResolved: number; draftsHeld: number; draftsCancelled: number }
  | { ok: false; problems: string[] };

export async function issueCredit(db: Db, ws: Workspace, invoiceId: string, input: CreditInput, userId: string): Promise<CreditResult> {
  const at = workspaceClock(ws);
  const done = await db.transaction(async (tx) => {
    // The invoice row lock makes credits on one invoice wait for each other; the advisory lock
    // does the same for the workspace's numbering.
    const [inv] = await tx
      .select()
      .from(invoice)
      .where(and(eq(invoice.workspaceId, ws.id), eq(invoice.id, invoiceId)))
      .for("update");
    if (!inv) return { ok: false as const, problems: ["That invoice doesn't exist."] };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit_note:${ws.id}`}))`);
    const [received] = await tx.select({ total: sql<string>`coalesce(sum(${match.appliedAmount}), 0)::text` }).from(match).where(eq(match.invoiceId, inv.id));
    const earlier = await tx.select({ amount: creditNote.amount }).from(creditNote).where(eq(creditNote.invoiceId, inv.id));
    const applied = fixed2(dec(received?.total ?? "0").plus(inv.paidBeforeImport));
    const target = { number: inv.number, status: inv.status, currency: inv.currency, applied, balance: fixed2(dec(inv.amount).minus(applied).minus(sumDec(earlier.map((c) => c.amount)))) };
    const { problems, value } = checkCredit(input, target);
    if (!value) return { ok: false as const, problems };

    const used = (await tx.select({ number: creditNote.number }).from(creditNote).where(eq(creditNote.workspaceId, ws.id))).map((r) => r.number);
    const number = nextCreditNumber(value.kind, Number(workspaceToday(ws).slice(0, 4)), used);
    const [row] = await tx
      .insert(creditNote)
      .values({ workspaceId: ws.id, invoiceId: inv.id, number, kind: value.kind, amount: value.amount, reason: value.reason, approvedBy: userId, createdAt: at })
      .returning({ id: creditNote.id });
    const status = statusAfterCredit(value.kind, target, value.amount);
    if (status !== inv.status) await tx.update(invoice).set({ status }).where(eq(invoice.id, inv.id));
    return { ok: true as const, id: row!.id, number, value, inv, before: target.balance, balance: fixed2(dec(target.balance).minus(value.amount)), status };
  });
  if (!done.ok) return done;

  const { inv, value, number } = done;
  const what = `${CREDIT_KIND_LABELS[value.kind]} ${number}, ${formatMoney(value.amount, inv.currency)}`;

  const disputes = await db
    .update(dispute)
    .set({ status: value.kind === "write_off" ? "settled" : "credited", creditNoteId: done.id })
    .where(and(eq(dispute.workspaceId, ws.id), eq(dispute.invoiceId, inv.id), eq(dispute.status, "open")))
    .returning({ id: dispute.id });

  // The flag rules on the books as they are now: flags about this invoice that no longer hold close.
  const w = await loadContext(db, ws.id);
  const live = new Set(evaluateFlags(flagSnapshot(await loadBooks(db, w), w)).map((f) => f.key));
  const mine = await db
    .select()
    .from(flag)
    .where(and(eq(flag.workspaceId, ws.id), eq(flag.subjectType, "invoice"), eq(flag.subjectId, inv.id), inArray(flag.status, ["open", "actioned"])));
  const closing = mine.filter((f) => !live.has(f.key));
  if (closing.length) await db.update(flag).set({ status: "resolved", resolvedAt: at, updatedAt: at }).where(inArray(flag.id, closing.map((f) => f.id)));
  const stillOpen = new Set(mine.filter((f) => live.has(f.key)).map((f) => f.id));

  // Emails about this invoice that haven't gone out were written with the old balance.
  const pending = await db
    .select()
    .from(draftAction)
    .where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.invoiceId, inv.id), inArray(draftAction.status, ["draft", "blocked", "approved", "scheduled", "failed"])));
  const cancel = pending.filter((d) => value.kind === "void" || (d.template !== "T11" && d.flagIds.length > 0 && !d.flagIds.some((id) => stillOpen.has(id))));
  const hold = pending.filter((d) => !cancel.includes(d));
  if (cancel.length) {
    const reason = value.kind === "void" ? `${inv.number} was voided (${number}): ${value.reason}` : `No longer needed: ${what} settled ${inv.number}.`;
    await db.update(draftAction).set({ status: "cancelled", rejectedReason: reason }).where(inArray(draftAction.id, cancel.map((d) => d.id)));
  }
  if (hold.length) {
    const reason = `${inv.number} changed after this was drafted (${what}). The next run redrafts it with the new balance.`;
    await db.update(draftAction).set({ status: "blocked", rejectedReason: reason }).where(inArray(draftAction.id, hold.map((d) => d.id)));
  }

  await audit(db, [
    {
      workspaceId: ws.id,
      actorType: "user",
      actorId: userId,
      action: ACTION[value.kind],
      objectType: "invoice",
      objectId: inv.id,
      details: {
        invoice: inv.number,
        number,
        kind: value.kind,
        amount: value.amount,
        currency: inv.currency,
        reason: value.reason,
        balanceBefore: done.before,
        balanceAfter: done.balance,
        status: done.status,
        disputes: disputes.length,
        draftsHeld: hold.map((d) => d.key),
        draftsCancelled: cancel.map((d) => d.key),
      },
    },
    ...closing.map((f) => ({ workspaceId: ws.id, actorType: "user" as const, actorId: userId, action: "flag.resolved", objectType: "flag", objectId: f.key, details: { kind: f.kind, summary: f.summary, by: number } })),
  ]);
  return { ok: true, id: done.id, number, kind: value.kind, amount: value.amount, currency: inv.currency, balance: done.balance, status: done.status, flagsResolved: closing.length, draftsHeld: hold.length, draftsCancelled: cancel.length };
}

/** An invoice's credit notes, write-offs and voids, oldest first. */
export async function creditsFor(db: Db, workspaceId: string, invoiceId: string) {
  return db
    .select()
    .from(creditNote)
    .where(and(eq(creditNote.workspaceId, workspaceId), eq(creditNote.invoiceId, invoiceId)))
    .orderBy(creditNote.createdAt, creditNote.number);
}
