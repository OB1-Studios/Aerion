import { addDays, daysBetween, dateInZone, dec, formatDateLong, formatMoney, normalizeName, normalizeRef } from "@ebo/core";
import { clientClaim, complianceItem, dispute, document, message, modelCall, promiseToPay, receivingAccount, transaction, type DocumentKind } from "@ebo/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { audit } from "../context";
import { loadBooks } from "../books";
import { MARKETPLACE_HEADER, offlineDocumentReader, PAYONEER_HEADER } from "../readers/offline";
import { csvRecords, documentText, parseAmount, parseDate, quoteFound } from "../readers/text";
import type { ConfirmedReading, DocumentReadResult, Extraction, Intent, IntentReadResult, ModelCallRecord, ReadContext, Readers } from "../readers/types";
import { offlineIntentReader } from "../readers/intent";
import { importStatement } from "../statements";
import { bump, type StepContext, type Step } from "./types";

type Account = typeof receivingAccount.$inferSelect;
type Doc = typeof document.$inferSelect;

const CONFIDENCE = { high: 0.95, medium: 0.7, low: 0.4 } as const;
const compact = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/**
 * Read: classify and extract every new document, validate what came back, and turn it into
 * rows (transactions, certificates on file). Then classify the intent of new emails, which
 * creates payment claims, promises and disputes. Anything that fails a check goes to review.
 */
export const readStep: Step = {
  name: "read",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const accounts = await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, wsId));
    const docs = await db
      .select()
      .from(document)
      .where(and(eq(document.workspaceId, wsId), eq(document.parseStatus, "pending")))
      .orderBy(asc(document.receivedAt));
    const readers = readersFor(c);
    // Reading (model calls) runs a few at a time; applying stays in arrival order, since a
    // correction or certificate can depend on a credit read just before it.
    const reads = await mapLimit(docs, READ_CONCURRENCY, (doc) => readOne(c, readers, doc, accounts));
    const results: Array<Record<string, unknown>> = [];
    for (const [i, doc] of docs.entries()) results.push(await readDocument(c, doc, accounts, reads[i]!));

    const msgs = await db
      .select()
      .from(message)
      .where(and(eq(message.workspaceId, wsId), eq(message.direction, "in"), isNull(message.intent)))
      .orderBy(asc(message.sentAt));
    const intentReads = await mapLimit(msgs, READ_CONCURRENCY, (m) => readIntent(c, readers, m));
    const intents: Array<Record<string, unknown>> = [];
    for (const [i, m] of msgs.entries()) intents.push(await readMessage(c, m, intentReads[i]!));

    const review = results.filter((r) => r.status === "needs_review").length;
    c.report.push(`Read ${docs.length} document${docs.length === 1 ? "" : "s"} and ${msgs.length} email${msgs.length === 1 ? "" : "s"}${review ? `; ${review} need${review === 1 ? "s" : ""} a person to check` : ""}.`);
    return { documents: results, emails: intents };
  },
};

async function recordCalls(c: StepContext, calls: ModelCallRecord[], documentId: string | null) {
  if (!calls.length) return;
  await c.deps.db.insert(modelCall).values(calls.map((x) => ({ ...x, workspaceId: c.w.ws.id, runId: c.runId, runStepId: c.stepId, documentId })));
  bump(c, "model_calls", calls.length);
}

function readContext(c: StepContext, accounts: Account[], receivedAt: Date): ReadContext {
  return { workspaceName: c.w.ws.name, legalName: c.w.ws.legalName, ibans: accounts.flatMap((a) => (a.iban ? [a.iban] : [])), receivedOn: dateInZone(receivedAt, c.w.ws.timezone) };
}

const READ_CONCURRENCY = 4;

/** Per workspace: the model reader only where AI reading is switched on. */
function readersFor(c: StepContext): Readers {
  return c.w.ws.aiReadingEnabled ? c.deps.readers : { document: offlineDocumentReader, intent: offlineIntentReader };
}

/** Runs fn over items with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type DocRead = { text: string | null; res: DocumentReadResult } | { error: string };

/**
 * A document a person checked in the review queue is applied with their values instead of
 * being read again. The same checks still run on them (the account must be ours, and so on).
 */
function confirmedResult(doc: Doc): DocumentReadResult | null {
  const conf = (doc.extracted as { confirmed?: ConfirmedReading } | null)?.confirmed;
  if (!conf?.fields) return null;
  const present = Object.keys(conf.fields).filter((k) => conf.fields[k] != null);
  return {
    classification: { kind: conf.kind, confidence: "high", workspaceMatch: "yes", reason: `Checked by ${conf.byName}` },
    extraction: {
      kind: conf.kind,
      fields: conf.fields,
      evidence: Object.fromEntries(present.map((k) => [k, { quote: "", confidence: "high" as const }])),
      notes: `Checked and confirmed by ${conf.byName}.`,
    },
    model: `checked by ${conf.byName}`,
    promptVersion: "review",
    calls: [],
  };
}

async function readOne(c: StepContext, readers: Readers, doc: Doc, accounts: Account[]): Promise<DocRead> {
  try {
    const text = await documentText(await c.deps.storage.get(doc.storagePath), doc.mimeType);
    const res =
      confirmedResult(doc) ??
      (await readers.document.read({ id: doc.id, name: doc.originalName, mimeType: doc.mimeType, text, kindHint: doc.kind === "other" ? null : doc.kind }, readContext(c, accounts, doc.receivedAt)));
    return { text, res };
  } catch (err) {
    return { error: String(err) };
  }
}

async function readDocument(c: StepContext, doc: Doc, accounts: Account[], read: DocRead): Promise<Record<string, unknown>> {
  const { db } = c.deps;
  const rc = readContext(c, accounts, doc.receivedAt);
  if ("error" in read) {
    await db.update(document).set({ parseStatus: "failed", reviewReasons: [read.error] }).where(eq(document.id, doc.id));
    return { document: doc.originalName, status: "failed", error: read.error };
  }
  const { text, res } = read;
  await recordCalls(c, res.calls, doc.id);
  const kind: DocumentKind = res.classification.kind;
  const reasons: string[] = [];
  let status: Doc["parseStatus"] = "parsed";
  let outcome: Record<string, unknown> = {};

  const x = res.extraction;
  if (x && text) {
    for (const [field, e] of Object.entries(x.evidence)) {
      if (x.fields[field] != null && e.quote && !quoteFound(text, e.quote)) reasons.push(`The text quoted for "${field}" isn't in the document.`);
      if (x.fields[field] != null && e.confidence === "low") reasons.push(`Low confidence in "${field}".`);
    }
  }

  switch (kind) {
    case "payoneer_export":
      outcome = await importPayoneer(c, doc, text ?? "", accounts);
      break;
    case "marketplace_export":
      outcome = await importMarketplace(c, doc, text ?? "", accounts);
      break;
    case "statement": {
      const r = await importStatement(db, c.w.ws.id, doc, text ?? "", accounts);
      outcome = { ...r };
      if ("action" in r) {
        bump(c, "transactions", r.created);
        const missing = r.notOnStatement.length;
        c.report.push(
          `Statement for the ${r.account} (${formatDateLong(r.from)} to ${formatDateLong(r.to)}): ${r.linked} credit${r.linked === 1 ? "" : "s"} tied to the bank's advices${r.created ? `, ${r.created} added that came without an advice` : ""}${missing ? `; ${missing} on record but not on the statement` : ""}.`,
        );
      }
      break;
    }
    case "credit_advice":
    case "pasted_text":
      if (!x) reasons.push("The fields could not be read.");
      else reasons.push(...validateCredit(x, rc, res.classification.workspaceMatch));
      if (!reasons.length && x) outcome = await applyCredit(c, doc, x, accounts);
      break;
    case "eprc":
      if (!x) reasons.push("The fields could not be read.");
      else outcome = await applyEprc(c, doc, x, reasons);
      break;
    case "screenshot":
    case "other":
      if (!x) status = "skipped";
      break;
    default:
      status = "skipped";
      reasons.push(`Reading ${kind.replace(/_/g, " ")} documents isn't automated yet.`);
  }
  if (reasons.length && status === "parsed") status = "needs_review";
  if (typeof outcome.review === "string") {
    status = "needs_review";
    reasons.push(outcome.review);
  }
  if (status === "needs_review") bump(c, "needs_review");
  bump(c, "documents_read");

  await db
    .update(document)
    .set({
      kind,
      parseStatus: status,
      extracted: {
        classification: res.classification,
        fields: x?.fields ?? null,
        evidence: x?.evidence ?? null,
        notes: x?.notes ?? null,
        outcome,
        ...(doc.extracted?.confirmed ? { confirmed: doc.extracted.confirmed } : {}),
      },
      fieldConfidence: x ? Object.fromEntries(Object.entries(x.evidence).map(([k, e]) => [k, CONFIDENCE[e.confidence]])) : null,
      reviewReasons: reasons.length ? reasons : null,
      model: res.model,
      promptVersion: res.promptVersion,
    })
    .where(eq(document.id, doc.id));
  await audit(db, { workspaceId: c.w.ws.id, actorType: "agent", actorId: c.runId, action: `document.${status}`, objectType: "document", objectId: doc.id, details: { kind, reasons, model: res.model, ...outcome } });
  return { document: doc.originalName, kind, status, reasons, ...outcome };
}

export function validateCredit(x: Extraction, rc: ReadContext, workspaceMatch: string): string[] {
  const f = x.fields;
  const out: string[] = [];
  const valueDate = parseDate(f.value_date);
  if (!valueDate) out.push("No valid value date.");
  else {
    if (valueDate > rc.receivedOn) out.push("The value date is after the document arrived.");
    if (daysBetween(valueDate, rc.receivedOn) > 120) out.push("The value date is more than 120 days before the document arrived.");
  }
  const hasForeign = !!(parseAmount(f.amount) && f.currency);
  if (!hasForeign && !parseAmount(f.pkr_amount)) out.push("No amount.");
  if (f.currency && !/^[A-Z]{3}$/.test(f.currency)) out.push(`"${f.currency}" isn't a currency code.`);
  if (f.charges_code && !["OUR", "SHA", "BEN"].includes(f.charges_code)) out.push(`Charges code "${f.charges_code}" isn't OUR, SHA or BEN.`);
  if (hasForeign && f.currency !== "PKR" && parseAmount(f.pkr_amount) && parseAmount(f.fx_rate_applied)) {
    const expected = dec(f.amount!).times(f.fx_rate_applied!);
    if (expected.minus(f.pkr_amount!).abs().gt(1)) out.push(`PKR amount ${f.pkr_amount} doesn't equal ${f.amount} x ${f.fx_rate_applied}.`);
  }
  const iban = f.beneficiary_iban ? compact(f.beneficiary_iban) : "";
  const tail = /(\d{4})$/.exec(iban)?.[1];
  const ours = rc.ibans.some((i) => compact(i) === iban || (iban.includes("*") && tail && i.endsWith(tail)));
  if (!ours) out.push("The beneficiary account isn't one of this workspace's accounts.");
  if (workspaceMatch === "no" && !ours) out.push("The document doesn't mention this workspace.");
  return out;
}

function accountFor(accounts: Account[], ibanOrMasked: string | null | undefined): Account | undefined {
  const iban = compact(ibanOrMasked ?? "");
  const tail = /(\d{4})$/.exec(iban)?.[1];
  return accounts.find((a) => a.iban && compact(a.iban) === iban) ?? (tail ? accounts.find((a) => a.iban?.endsWith(tail)) : undefined);
}

async function applyCredit(c: StepContext, doc: Doc, x: Extraction, accounts: Account[]): Promise<Record<string, unknown>> {
  const { db } = c.deps;
  const wsId = c.w.ws.id;
  const f = x.fields;
  const acc = accountFor(accounts, f.beneficiary_iban)!;
  const foreign = !!(f.amount && f.currency && f.currency !== "PKR");
  const amount = foreign ? f.amount! : (f.pkr_amount ?? f.amount)!;
  const currency = foreign ? f.currency! : "PKR";
  const pkrAmount = f.pkr_amount ?? (currency === "PKR" ? amount : null);
  const valueDate = parseDate(f.value_date)!;
  const payerBank = f.remitter_bank ?? (f.via ? `via ${f.via}` : null);
  const tail = /(\d{4})$/.exec(compact(f.beneficiary_iban ?? ""))?.[1] ?? "";
  const dedupeKey = f.advice_number ? `advice:${f.advice_number}` : `sms:${tail}:${valueDate}:${pkrAmount ?? amount}:${normalizeName(f.remitter_name)}`;

  if (f.corrects_advice_of) {
    const credits = await db.select().from(transaction).where(and(eq(transaction.workspaceId, wsId), eq(transaction.kind, "credit")));
    const existing =
      (f.advice_number && credits.find((t) => t.adviceNumber === f.advice_number)) ||
      credits.find(
        (t) =>
          t.receivingAccountId === acc.id &&
          t.valueDate === valueDate &&
          normalizeName(t.payerName) === normalizeName(f.remitter_name) &&
          (pkrAmount ? !!t.pkrAmount && dec(t.pkrAmount).eq(pkrAmount) : dec(t.amount).eq(amount)),
      );
    if (existing) {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set: Partial<typeof transaction.$inferInsert> = {};
      const maybe = <K extends "purposeCode" | "chargesCode" | "reference" | "adviceNumber" | "uetr" | "payerBank">(key: K, value: string | null | undefined, onlyIfEmpty = false) => {
        if (value == null || value === existing[key] || (onlyIfEmpty && existing[key])) return;
        changes[key] = { from: existing[key], to: value };
        (set as Record<string, unknown>)[key] = value;
      };
      maybe("purposeCode", f.purpose_code);
      maybe("chargesCode", f.charges_code);
      maybe("reference", f.ordering_reference, true);
      maybe("adviceNumber", f.advice_number, true);
      maybe("uetr", f.uetr, true);
      maybe("payerBank", payerBank, true);
      if (Object.keys(set).length) await db.update(transaction).set(set).where(eq(transaction.id, existing.id));
      await audit(db, { workspaceId: wsId, actorType: "agent", actorId: c.runId, action: "transaction.corrected", objectType: "transaction", objectId: existing.id, details: { documentId: doc.id, changes } });
      bump(c, "corrections");
      if (changes.purposeCode) c.report.push(`The bank corrected the purpose code of the ${formatMoney(amount, currency)} credit of ${formatDateLong(valueDate)} from ${changes.purposeCode.from} to ${changes.purposeCode.to}.`);
      return { action: "corrected", transactionId: existing.id, changes };
    }
  }

  const inserted = await db
    .insert(transaction)
    .values({
      workspaceId: wsId,
      kind: "credit",
      receivingAccountId: acc.id,
      valueDate,
      amount,
      currency,
      pkrAmount,
      fxRateApplied: foreign ? f.fx_rate_applied : null,
      chargesAmount: f.charges_amount,
      chargesCurrency: f.charges_currency,
      chargesCode: (f.charges_code as "OUR" | "SHA" | "BEN" | null) ?? null,
      payerName: f.remitter_name,
      payerBank,
      adviceNumber: f.advice_number,
      reference: f.ordering_reference,
      purposeCode: f.purpose_code,
      uetr: f.uetr,
      sourceDocumentId: doc.id,
      sourceLocator: { document: doc.originalName },
      dedupeKey,
      matchStatus: "pending",
    })
    .onConflictDoNothing({ target: [transaction.workspaceId, transaction.dedupeKey] })
    .returning({ id: transaction.id });
  if (!inserted[0]) return { action: "already_imported", dedupeKey };
  bump(c, "transactions");
  return { action: "created", transactionId: inserted[0].id, account: acc.label, amount: `${currency} ${amount}` };
}

async function importPayoneer(c: StepContext, doc: Doc, text: string, accounts: Account[]): Promise<Record<string, unknown>> {
  const acc = accounts.find((a) => a.kind === "payoneer");
  if (!acc) return { review: "This workspace has no Payoneer account to import into." };
  const { header, records } = csvRecords(text);
  if (header.join(",") !== PAYONEER_HEADER) return { review: "The columns aren't the Payoneer activity layout." };
  let created = 0;
  let skipped = 0;
  for (const [i, r] of records.entries()) {
    const amount = parseAmount(r.amount);
    const date = parseDate(r.date);
    if (!amount || !date || !r.transaction_id || r.status?.toLowerCase() !== "completed") {
      skipped++;
      continue;
    }
    const out = dec(amount).isNegative();
    const abs = dec(amount).abs().toFixed(2);
    const pkr = /PKR\s*([\d,]+(?:\.\d+)?)/i.exec(r.description ?? "")?.[1];
    const kind = !out ? "payoneer_receipt" : /withdraw/i.test(r.description ?? "") ? "payoneer_withdrawal" : /card/i.test(r.description ?? "") ? "payoneer_card_spend" : "bank_charge";
    const pkrAmount = kind === "payoneer_withdrawal" && pkr ? parseAmount(pkr) : null;
    const inserted = await c.deps.db
      .insert(transaction)
      .values({
        workspaceId: c.w.ws.id,
        kind,
        receivingAccountId: acc.id,
        valueDate: date,
        amount: abs,
        currency: r.currency ?? acc.currency,
        pkrAmount,
        fxRateApplied: pkrAmount ? dec(pkrAmount).div(abs).toDecimalPlaces(6).toString() : null,
        payerName: r.payer || null,
        payerBank: !out ? "Payoneer" : null,
        adviceNumber: r.transaction_id,
        reference: r.description ?? null,
        sourceDocumentId: doc.id,
        sourceLocator: { document: doc.originalName, row: i + 2 },
        dedupeKey: `payoneer:${r.transaction_id}`,
        matchStatus: "pending",
      })
      .onConflictDoNothing({ target: [transaction.workspaceId, transaction.dedupeKey] })
      .returning({ id: transaction.id });
    if (inserted[0]) created++;
    else skipped++;
  }
  bump(c, "transactions", created);
  return { action: "imported", rows: records.length, created, skipped };
}

async function importMarketplace(c: StepContext, doc: Doc, text: string, accounts: Account[]): Promise<Record<string, unknown>> {
  const acc = accounts.find((a) => a.kind === "platform");
  if (!acc) return { review: "This workspace has no marketplace account to import into." };
  const { header, records } = csvRecords(text);
  if (header.join(",") !== MARKETPLACE_HEADER) return { review: "The columns aren't the marketplace earnings layout." };
  let created = 0;
  let skipped = 0;
  for (const [i, r] of records.entries()) {
    const amount = parseAmount(r.amount);
    const date = parseDate(r.date);
    const kind = r.type === "earning" ? "platform_earning" : r.type === "fee" ? "platform_fee" : r.type === "payout" ? "platform_withdrawal" : null;
    if (!amount || !date || !kind || !r.reference) {
      skipped++;
      continue;
    }
    const inserted = await c.deps.db
      .insert(transaction)
      .values({
        workspaceId: c.w.ws.id,
        kind,
        receivingAccountId: acc.id,
        valueDate: date,
        amount: dec(amount).abs().toFixed(2),
        currency: r.currency ?? acc.currency,
        payerName: r.client || null,
        adviceNumber: r.reference,
        reference: r.description ?? null,
        sourceDocumentId: doc.id,
        sourceLocator: { document: doc.originalName, row: i + 2 },
        dedupeKey: `marketplace:${r.reference}`,
        matchStatus: "pending",
      })
      .onConflictDoNothing({ target: [transaction.workspaceId, transaction.dedupeKey] })
      .returning({ id: transaction.id });
    if (inserted[0]) created++;
    else skipped++;
  }
  bump(c, "transactions", created);
  return { action: "imported", rows: records.length, created, skipped };
}

async function applyEprc(c: StepContext, doc: Doc, x: Extraction, reasons: string[]): Promise<Record<string, unknown>> {
  const { db } = c.deps;
  const wsId = c.w.ws.id;
  const f = x.fields;
  if (f.pseb_number && c.w.ws.psebRegNo && compact(f.pseb_number) !== compact(c.w.ws.psebRegNo)) {
    reasons.push(`The PSEB number on the ePRC (${f.pseb_number}) isn't this workspace's.`);
    return {};
  }
  const credits = await db.select().from(transaction).where(and(eq(transaction.workspaceId, wsId), eq(transaction.kind, "credit")));
  const tx =
    (f.advice_number && credits.find((t) => t.adviceNumber === f.advice_number)) ||
    credits.find((t) => t.valueDate === parseDate(f.value_date) && !!f.amount && dec(t.amount).eq(f.amount) && (!f.currency || t.currency === f.currency));
  if (!tx) return { review: `No credit matches advice ${f.advice_number ?? "(none)"}.` };
  const wrong = !!f.purpose_code && c.w.rules["purpose_code.non_it"].includes(f.purpose_code);
  const status = wrong ? ("wrong_code" as const) : ("on_file" as const);
  const existing = await db.select().from(complianceItem).where(and(eq(complianceItem.transactionId, tx.id), eq(complianceItem.kind, "eprc")));
  if (existing[0]) {
    await db.update(complianceItem).set({ status, purposeCodeOnDocument: f.purpose_code, documentId: doc.id }).where(eq(complianceItem.id, existing[0].id));
  } else {
    await db.insert(complianceItem).values({ workspaceId: wsId, transactionId: tx.id, kind: "eprc", status, purposeCodeOnDocument: f.purpose_code, documentId: doc.id, dueOn: addDays(tx.valueDate, c.w.rules["eprc.wait_days"]) });
  }
  await audit(db, { workspaceId: wsId, actorType: "agent", actorId: c.runId, action: "compliance.received", objectType: "transaction", objectId: tx.id, details: { kind: "eprc", status, documentId: doc.id, purposeCode: f.purpose_code } });
  bump(c, "certificates");
  c.report.push(`ePRC ${f.certificate_number ?? ""} received for the ${formatMoney(tx.amount, tx.currency)} credit of ${formatDateLong(tx.valueDate)}${wrong ? `, but with code ${f.purpose_code}` : ""}.`);
  return { action: "certificate_on_file", transactionId: tx.id, status };
}

// ---------------------------------------------------------------------------
// Emails: intent -> claims, promises, disputes
// ---------------------------------------------------------------------------

const PRIORITY: Intent["kind"][] = ["bank_detail_change", "payment_claim", "promise_to_pay", "dispute", "remittance_advice", "question", "other"];

type Msg = typeof message.$inferSelect;

function readIntent(c: StepContext, readers: Readers, m: Msg): Promise<IntentReadResult> {
  const receivedOn = dateInZone(m.sentAt, c.w.ws.timezone);
  return readers.intent.read({ id: m.id, from: m.fromAddress, subject: m.subject, body: m.bodyText, receivedOn }, { workspaceName: c.w.ws.name, legalName: c.w.ws.legalName, ibans: [], receivedOn });
}

async function readMessage(c: StepContext, m: Msg, res: IntentReadResult): Promise<Record<string, unknown>> {
  const { db } = c.deps;
  const wsId = c.w.ws.id;
  const receivedOn = dateInZone(m.sentAt, c.w.ws.timezone);
  await recordCalls(c, res.calls, null);
  const r = res.result;
  const primary = PRIORITY.find((k) => r.intents.some((i) => i.kind === k)) ?? "other";
  const effects: string[] = [];

  if (m.clientId) {
    const books = await loadBooks(db, c.w);
    const tol = c.w.tolerance;
    const clientInvoices = books.invoices.filter((i) => i.clientId === m.clientId);
    const open = clientInvoices.filter((i) => (i.status === "sent" || i.status === "part_paid") && dec(i.balance).gt(tol));
    const named = (nums: string[]) => clientInvoices.filter((i) => nums.some((n) => normalizeRef(n) === normalizeRef(i.number)));
    const target = (it: Intent) => {
      const byNumber = named(it.invoiceNumbers).filter((i) => open.includes(i));
      if (byNumber.length) return byNumber;
      if (it.amount) {
        const byAmount = open.filter((i) => dec(i.balance).eq(it.amount!));
        if (byAmount.length === 1) return byAmount;
      }
      return open.length === 1 ? open : [];
    };
    const docs = m.documentIds.length ? await db.select().from(document).where(inArray(document.id, m.documentIds)) : [];
    const shot = docs.find((d) => m.documentIds.includes(d.id) && d.kind === "screenshot");
    const shotFields = (shot?.extracted?.fields ?? null) as Record<string, string | null> | null;

    for (const it of r.intents) {
      if (it.kind === "payment_claim") {
        for (const inv of target({ ...it, amount: it.amount ?? shotFields?.amount ?? null })) {
          if (books.claims.some((x) => x.invoiceId === inv.id && x.status === "open")) continue;
          await db.insert(clientClaim).values({
            workspaceId: wsId,
            clientId: m.clientId,
            invoiceId: inv.id,
            claimedOn: it.date ?? receivedOn,
            claimedAmount: it.amount ?? shotFields?.amount ?? inv.balance,
            currency: it.currency ?? shotFields?.currency ?? inv.currency,
            evidenceDocumentId: shot?.id ?? null,
            messageId: m.id,
          });
          effects.push(`claim:${inv.number}`);
          bump(c, "claims");
        }
      } else if (it.kind === "promise_to_pay") {
        for (const inv of target(it)) {
          await db.insert(promiseToPay).values({ workspaceId: wsId, invoiceId: inv.id, promisedOn: it.date ?? addDays(receivedOn, 7), amount: it.amount, messageId: m.id });
          effects.push(`promise:${inv.number}:${it.date ?? "in a week"}`);
          bump(c, "promises");
        }
      } else if (it.kind === "dispute") {
        for (const inv of named(it.invoiceNumbers)) {
          await db.insert(dispute).values({ workspaceId: wsId, invoiceId: inv.id, reason: it.quote.slice(0, 500) });
          effects.push(`dispute:${inv.number}`);
        }
      }
    }
  }

  await db.update(message).set({ intent: primary, extracted: { ...r, model: res.model, promptVersion: res.promptVersion } }).where(eq(message.id, m.id));
  await audit(db, { workspaceId: wsId, actorType: "agent", actorId: c.runId, action: "email.classified", objectType: "message", objectId: m.id, details: { intent: primary, effects, model: res.model } });
  if (primary !== "other") bump(c, `intent_${primary}`);
  return { from: m.fromAddress, subject: m.subject, intent: primary, effects, forwardedFrom: r.forwardedFrom };
}

