import {
  dateInZone,
  dec,
  DEFAULT_PURPOSE_WORDING,
  dueDate,
  formatAmount,
  formatDateLong,
  formatMoney,
  highestSequence,
  invoiceNumber,
  invoiceTotal,
  isIsoDate,
  lineAmount,
  paymentInstructions,
  planInvoiceEmail,
  ROUTE_LABELS,
  routeOptions,
  type ApprovalPolicy,
  type Grouping,
  type InvoiceLineInput,
  type IsoDate,
  type Route,
  type RouteAccount,
  type RouteOption,
} from "@ebo/core";
import { client, draftAction, invoice, invoiceLine, match, receivingAccount, transaction, workspace, type Db } from "@ebo/db";
import { and, asc, desc, eq, gt, inArray, like } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts, type PDFPage } from "pdf-lib";
import { pdfSafe, wrap } from "./pdf-text";
import { actorOf, audit, workspaceClock, type AuditActor, type Workspace } from "./context";

/**
 * Invoices a person writes (main doc W6): numbering, the route picker, the A4 PDF with exact
 * payment instructions, and the email that sends it after approval (template T11).
 */

type AccountRow = typeof receivingAccount.$inferSelect;

export function routeAccount(a: AccountRow): RouteAccount {
  const d = (a.receivingDetails ?? {}) as { currencies?: unknown; paymentInstructions?: unknown };
  return {
    id: a.id,
    kind: a.kind,
    label: a.label,
    currency: a.currency,
    currencies: Array.isArray(d.currencies) ? d.currencies.map(String) : [],
    bankName: a.bankName,
    iban: a.iban,
    swift: a.swift,
    instructions: typeof d.paymentInstructions === "string" ? d.paymentInstructions : null,
    active: a.active,
  };
}

/** The workspace's "today" (the demo clock in a demo). */
export const workspaceToday = (ws: Pick<Workspace, "demoClock" | "timezone">) => dateInZone(workspaceClock(ws), ws.timezone);

/** The last bank wire from this client that arrived short by a fee, for the route reason. */
async function lastSwiftFee(db: Db, workspaceId: string, clientId: string) {
  const [row] = await db
    .select({ fee: match.feeAmount, currency: invoice.currency, on: transaction.valueDate })
    .from(match)
    .innerJoin(invoice, eq(invoice.id, match.invoiceId))
    .innerJoin(transaction, eq(transaction.id, match.transactionId))
    .innerJoin(receivingAccount, eq(receivingAccount.id, transaction.receivingAccountId))
    .where(and(eq(match.workspaceId, workspaceId), eq(invoice.clientId, clientId), gt(match.feeAmount, "0"), inArray(receivingAccount.kind, ["esfca", "pkr_account"])))
    .orderBy(desc(transaction.valueDate))
    .limit(1);
  return row ? { amount: row.fee, currency: row.currency, on: row.on } : null;
}

/** Ways this client can pay, in a given currency, with the suggestion marked. */
export async function invoiceRoutes(db: Db, workspaceId: string, clientId: string, currency?: string): Promise<RouteOption[]> {
  const [c] = await db.select().from(client).where(and(eq(client.workspaceId, workspaceId), eq(client.id, clientId)));
  if (!c) return [];
  const accounts = await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, workspaceId)).orderBy(asc(receivingAccount.createdAt));
  return routeOptions({ name: c.name, currency: currency ?? c.defaultCurrency, preferredRoute: c.preferredRoute, lastSwiftFee: await lastSwiftFee(db, workspaceId, c.id) }, accounts.map(routeAccount));
}

export interface InvoiceInput {
  clientId: string;
  issuedOn: string;
  termsDays: number;
  currency: string;
  /** "route:accountId", as the route picker sends it. */
  routeChoice: string;
  purposeWording: string;
  lines: InvoiceLine[];
}

/** A line as typed, plus, for invoices drafted from a contract, which contract and month it bills. */
export type InvoiceLine = InvoiceLineInput & { contractId?: string | null; milestoneLabel?: string | null };

export type SaveResult = { ok: true; id: string; number: string } | { ok: false; problems: string[] };

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** Checks the form and returns clean lines, or what's wrong in plain words. */
function checkInvoice(input: InvoiceInput, options: RouteOption[]): { problems: string[]; lines: InvoiceLine[]; route: RouteOption | null } {
  const problems: string[] = [];
  if (!isIsoDate(input.issuedOn)) problems.push("The issue date isn't a date.");
  if (!Number.isInteger(input.termsDays) || input.termsDays < 0 || input.termsDays > 365) problems.push("Payment terms should be between 0 and 365 days.");
  if (!/^[A-Z]{3}$/.test(input.currency)) problems.push("The currency should be a three-letter code, like USD.");
  const lines = input.lines
    .map((l) => ({ description: l.description.trim(), quantity: l.quantity.trim().replace(/,/g, "") || "1", unitPrice: l.unitPrice.trim().replace(/,/g, ""), contractId: l.contractId ?? null, milestoneLabel: l.milestoneLabel ?? null }))
    .filter((l) => l.description || l.unitPrice);
  lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (!l.description) problems.push(`${n} needs a description.`);
    if (l.description.length > 300) problems.push(`${n}: the description is too long (300 characters at most).`);
    if (!MONEY_RE.test(l.quantity) || dec(l.quantity).lte(0)) problems.push(`${n}: the quantity should be a number above zero, like 1 or 2.5.`);
    if (!MONEY_RE.test(l.unitPrice)) problems.push(`${n}: the price should be an amount like 3800 or 3800.00.`);
  });
  if (!lines.length) problems.push("Add at least one line.");
  else if (!problems.length && dec(invoiceTotal(lines)).lte(0)) problems.push("The total should be more than zero.");
  if (input.purposeWording.length > 200) problems.push("The purpose wording is too long (200 characters at most).");
  const [route, accountId] = input.routeChoice.split(":");
  const chosen = options.find((o) => o.route === route && o.accountId === accountId) ?? null;
  if (!options.length) problems.push(`None of your receiving accounts can take ${input.currency}. Add one in Setup first.`);
  else if (!chosen) problems.push("Choose how the client should pay.");
  return { problems, lines, route: chosen };
}

/** The number the next invoice issued on this date would get (shown in the editor; given for real on save). */
export async function peekInvoiceNumber(db: Db, ws: Workspace, issuedOn: IsoDate): Promise<string> {
  const year = issuedOn.slice(0, 4);
  const used = await db.select({ number: invoice.number }).from(invoice).where(and(eq(invoice.workspaceId, ws.id), like(invoice.number, `${ws.invoicePrefix}-${year}-%`)));
  return invoiceNumber(ws.invoicePrefix, issuedOn, Math.max(ws.nextInvoiceSeq, highestSequence(used.map((u) => u.number), ws.invoicePrefix, year) + 1));
}

/**
 * Creates an invoice, or changes one that's still a draft. Numbers continue after the highest
 * used this year. Lines drafted from a retainer keep their contract and month through edits.
 */
export async function saveInvoice(db: Db, ws: Workspace, input: InvoiceInput, by: AuditActor, invoiceId?: string): Promise<SaveResult> {
  const actor = actorOf(by);
  const [c] = await db.select().from(client).where(and(eq(client.workspaceId, ws.id), eq(client.id, input.clientId)));
  if (!c) return { ok: false, problems: ["Choose a client."] };
  const { problems, lines, route } = checkInvoice(input, await invoiceRoutes(db, ws.id, c.id, input.currency));
  if (problems.length || !route) return { ok: false, problems };
  const issuedOn = input.issuedOn as IsoDate;
  const values = {
    clientId: c.id,
    currency: input.currency,
    amount: invoiceTotal(lines),
    issuedOn,
    dueOn: dueDate(issuedOn, input.termsDays),
    route: route.route as Route,
    receivingAccountId: route.accountId,
    purposeWording: input.purposeWording.trim() || null,
  };
  type Tags = { contractId: string | null; milestoneLabel: string | null };
  const lineRows = (id: string, before: Tags[] = []) =>
    lines.map((l, i) => ({
      workspaceId: ws.id,
      invoiceId: id,
      position: i,
      description: l.description,
      quantity: l.quantity,
      unitPrice: dec(l.unitPrice).toFixed(2),
      amount: lineAmount(l.quantity, l.unitPrice).toFixed(2),
      contractId: l.contractId ?? before[i]?.contractId ?? null,
      milestoneLabel: l.milestoneLabel ?? before[i]?.milestoneLabel ?? null,
    }));

  if (invoiceId) {
    const [existing] = await db.select().from(invoice).where(and(eq(invoice.workspaceId, ws.id), eq(invoice.id, invoiceId)));
    if (!existing) return { ok: false, problems: ["That invoice doesn't exist."] };
    if (existing.status !== "draft") return { ok: false, problems: ["Only a draft invoice can be changed; this one has been sent."] };
    await db.transaction(async (tx) => {
      const before = await tx.select({ position: invoiceLine.position, contractId: invoiceLine.contractId, milestoneLabel: invoiceLine.milestoneLabel }).from(invoiceLine).where(eq(invoiceLine.invoiceId, existing.id));
      const tags: Tags[] = [];
      for (const b of before) tags[b.position] = b;
      await tx.update(invoice).set(values).where(eq(invoice.id, existing.id));
      await tx.delete(invoiceLine).where(eq(invoiceLine.invoiceId, existing.id));
      await tx.insert(invoiceLine).values(lineRows(existing.id, tags));
    });
    await audit(db, { workspaceId: ws.id, ...actor, action: "invoice.updated", objectType: "invoice", objectId: existing.id, details: { number: existing.number, amount: values.amount, currency: values.currency } });
    return { ok: true, id: existing.id, number: existing.number };
  }

  const year = issuedOn.slice(0, 4);
  for (let attempt = 0; attempt < 3; attempt++) {
    const used = await db.select({ number: invoice.number }).from(invoice).where(and(eq(invoice.workspaceId, ws.id), like(invoice.number, `${ws.invoicePrefix}-${year}-%`)));
    const [fresh] = await db.select({ next: workspace.nextInvoiceSeq }).from(workspace).where(eq(workspace.id, ws.id));
    const seq = Math.max(fresh?.next ?? 1, highestSequence(used.map((u) => u.number), ws.invoicePrefix, year) + 1);
    const number = invoiceNumber(ws.invoicePrefix, issuedOn, seq);
    try {
      const id = await db.transaction(async (tx) => {
        const [row] = await tx.insert(invoice).values({ workspaceId: ws.id, number, status: "draft", ...values }).returning({ id: invoice.id });
        await tx.insert(invoiceLine).values(lineRows(row!.id));
        await tx.update(workspace).set({ nextInvoiceSeq: seq + 1 }).where(eq(workspace.id, ws.id));
        return row!.id;
      });
      await audit(db, { workspaceId: ws.id, ...actor, action: "invoice.created", objectType: "invoice", objectId: id, details: { number, amount: values.amount, currency: values.currency, route: values.route } });
      return { ok: true, id, number };
    } catch (err) {
      // Someone took this number a moment ago: try the next one.
      if (!/invoice_ws_number|duplicate key/i.test(String((err as { cause?: unknown }).cause ?? err))) throw err;
    }
  }
  return { ok: false, problems: ["Couldn't give the invoice a number; please try again."] };
}

// ---------------------------------------------------------------------------
// Everything the PDF and the email need, from the records
// ---------------------------------------------------------------------------

export interface InvoiceDocument {
  ws: Workspace;
  inv: typeof invoice.$inferSelect;
  client: typeof client.$inferSelect;
  lines: Array<typeof invoiceLine.$inferSelect>;
  account: AccountRow | null;
  routeLabel: string;
  instructions: string[];
}

export async function loadInvoiceDocument(db: Db, workspaceId: string, invoiceId: string): Promise<InvoiceDocument | null> {
  const [row] = await db
    .select({ inv: invoice, client, ws: workspace })
    .from(invoice)
    .innerJoin(client, eq(client.id, invoice.clientId))
    .innerJoin(workspace, eq(workspace.id, invoice.workspaceId))
    .where(and(eq(invoice.workspaceId, workspaceId), eq(invoice.id, invoiceId)));
  if (!row) return null;
  const [lines, [account]] = await Promise.all([
    db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, row.inv.id)).orderBy(asc(invoiceLine.position)),
    row.inv.receivingAccountId ? db.select().from(receivingAccount).where(eq(receivingAccount.id, row.inv.receivingAccountId)) : Promise.resolve([]),
  ]);
  const payee = row.ws.legalName ?? row.ws.name;
  const routeLabel = `${ROUTE_LABELS[row.inv.route]}${row.inv.route === "payoneer" ? ` (${row.inv.currency})` : ""}`;
  const instructions = account ? paymentInstructions(routeAccount(account), row.inv.route, payee, row.inv.number) : [`Payment reference: ${row.inv.number}`];
  return { ...row, lines: lines.length ? lines : [{ id: "total", workspaceId, invoiceId, position: 0, description: "As agreed", quantity: "1", unitPrice: row.inv.amount, amount: row.inv.amount, contractId: null, milestoneLabel: null }], account: account ?? null, routeLabel, instructions };
}

// ---------------------------------------------------------------------------
// The A4 PDF
// ---------------------------------------------------------------------------

const countryName = (code: string | null) => {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Renders the invoice as an A4 PDF: who it's from and to, the lines, the total, and exactly how to pay. */
export async function renderInvoicePdf(d: InvoiceDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const grouping: Grouping = d.ws.numberGrouping;
  const seller = d.ws.legalName ?? d.ws.name;
  pdf.setTitle(`Invoice ${d.inv.number}`);
  pdf.setAuthor(seller);
  pdf.setCreator("Aerion");
  pdf.setProducer("Aerion (pdf-lib)");
  pdf.setCreationDate(new Date(`${d.inv.issuedOn}T00:00:00Z`));
  pdf.setModificationDate(new Date(`${d.inv.issuedOn}T00:00:00Z`));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.11, 0.14, 0.2);
  const muted = rgb(0.42, 0.45, 0.5);
  const line = rgb(0.86, 0.88, 0.9);
  const W = 595.28;
  const H = 841.89;
  const M = 50;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, size = 10, font = regular, color = ink) => page.drawText(pdfSafe(s), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 10, font = regular, color = ink) => page.drawText(pdfSafe(s), { x: xRight - font.widthOfTextAtSize(pdfSafe(s), size), y, size, font, color });
  const ensure = (needed: number) => {
    if (y - needed >= M + 30) return;
    page = pdf.addPage([W, H]);
    y = H - M;
  };

  // Header: the seller on the left, the invoice on the right.
  text(seller, M, 16, bold);
  // A voided invoice says so, so a copy that's downloaded later can't be paid by mistake.
  const voided = d.inv.status === "void";
  right(voided ? "VOID INVOICE" : "INVOICE", W - M, 22, bold, voided ? rgb(0.72, 0.11, 0.11) : ink);
  y -= 18;
  const sellerLines = [d.ws.city, d.ws.ntn ? `NTN ${d.ws.ntn}` : null, d.ws.psebRegNo ? `PSEB registration ${d.ws.psebRegNo}` : null, d.ws.settings?.mailboxAddress ?? null].filter((x): x is string => !!x);
  const meta: Array<[string, string]> = [
    ["Number", d.inv.number],
    ["Issued", formatDateLong(d.inv.issuedOn)],
    ["Due", formatDateLong(d.inv.dueOn)],
    ...(voided ? ([["Status", "Void, not payable"]] as Array<[string, string]>) : []),
  ];
  const headerRows = Math.max(sellerLines.length, meta.length);
  for (let i = 0; i < headerRows; i++) {
    if (sellerLines[i]) text(sellerLines[i]!, M, 9, regular, muted);
    if (meta[i]) {
      right(meta[i]![1], W - M, 10, bold);
      right(meta[i]![0], W - M - 110, 9, regular, muted);
    }
    y -= 14;
  }

  // Bill to.
  y -= 14;
  text("BILL TO", M, 8, bold, muted);
  y -= 15;
  text(d.client.name, M, 12, bold);
  y -= 15;
  for (const l of [d.client.contactName, countryName(d.client.country), d.client.contactEmails[0]].filter((x): x is string => !!x)) {
    text(l, M, 9, regular, muted);
    y -= 13;
  }

  // Lines.
  y -= 16;
  const cols = { desc: M + 8, qty: W - M - 190, price: W - M - 95, amount: W - M - 8 };
  page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 22, color: rgb(0.95, 0.96, 0.97) });
  text("Description", cols.desc, 9, bold, muted);
  right("Qty", cols.qty, 9, bold, muted);
  right("Unit price", cols.price, 9, bold, muted);
  right(`Amount (${d.inv.currency})`, cols.amount, 9, bold, muted);
  y -= 26;
  for (const l of d.lines) {
    const desc = wrap(l.description, regular, 10, cols.qty - cols.desc - 50);
    ensure(desc.length * 13 + 10);
    right(dec(l.quantity).toString(), cols.qty, 10);
    right(formatAmount(l.unitPrice, { grouping }), cols.price, 10);
    right(formatAmount(l.amount, { grouping }), cols.amount, 10);
    for (const dl of desc) {
      text(dl, cols.desc, 10);
      y -= 13;
    }
    y -= 5;
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: line });
  }
  y -= 12;
  right("Total due", cols.price, 11, bold);
  right(formatMoney(d.inv.amount, d.inv.currency, { grouping }), cols.amount, 12, bold);

  // How to pay.
  y -= 34;
  const purpose = d.inv.purposeWording ? wrap(`Purpose of payment: "${d.inv.purposeWording}"`, regular, 10, W - 2 * M - 28) : [];
  const instructionLines = d.instructions.flatMap((s) => wrap(s, regular, 10, W - 2 * M - 28));
  const boxHeight = 30 + instructionLines.length * 14 + (purpose.length ? 8 + purpose.length * 14 : 0) + 8;
  ensure(boxHeight + 10);
  page.drawRectangle({ x: M, y: y - boxHeight + 16, width: W - 2 * M, height: boxHeight, borderColor: rgb(0.18, 0.42, 0.33), borderWidth: 1 });
  text(`HOW TO PAY: ${d.routeLabel.toUpperCase()}`, M + 14, 9, bold, rgb(0.18, 0.42, 0.33));
  y -= 20;
  for (const l of instructionLines) {
    text(l, M + 14, 10);
    y -= 14;
  }
  if (purpose.length) {
    y -= 8;
    for (const l of purpose) {
      text(l, M + 14, 10, bold);
      y -= 14;
    }
  }

  // Footer on every page.
  for (const p of pdf.getPages()) {
    page = p;
    y = M - 10;
    text(`${seller} · Invoice ${d.inv.number}`, M, 8, regular, muted);
    if (d.ws.isDemo) {
      y = M + 6;
      text("SIMULATED - NOT A REAL DOCUMENT", M, 9, bold, rgb(0.7, 0.14, 0.09));
    }
  }
  return pdf.save({ useObjectStreams: false });
}

export async function invoicePdf(db: Db, workspaceId: string, invoiceId: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const d = await loadInvoiceDocument(db, workspaceId, invoiceId);
  return d ? { name: `${d.inv.number}.pdf`, bytes: await renderInvoicePdf(d) } : null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Prepares the email that sends a draft invoice (T11). It waits in the inbox for approval, like every client email. */
export async function draftInvoiceEmail(db: Db, workspaceId: string, invoiceId: string, by: AuditActor): Promise<{ ok: true; draftId: string } | { ok: false; reason: string }> {
  const actor = actorOf(by);
  const d = await loadInvoiceDocument(db, workspaceId, invoiceId);
  if (!d) return { ok: false, reason: "That invoice doesn't exist." };
  if (d.inv.status !== "draft") return { ok: false, reason: "This invoice has already been sent." };
  if (!d.client.contactEmails.length) return { ok: false, reason: `${d.client.name} has no email address on file. Add one to the client first.` };
  const s = d.ws.settings ?? {};
  const plan = planInvoiceEmail(
    { invoiceId: d.inv.id, number: d.inv.number, amount: d.inv.amount, currency: d.inv.currency, dueOn: d.inv.dueOn, client: d.client, routeName: d.routeLabel, instructions: d.instructions, purposeWording: d.inv.purposeWording },
    { policy: d.ws.approvalPolicy as ApprovalPolicy, grouping: d.ws.numberGrouping, workspace: { legalName: d.ws.legalName ?? d.ws.name, phone: s.phone ?? null, domain: d.ws.emailDomain }, sender: { name: s.senderName ?? d.ws.name, title: s.senderTitle ?? "Finance" } },
  );
  const content = {
    kind: plan.kind,
    template: plan.template ?? null,
    invoiceId: d.inv.id,
    toAddress: plan.to ?? null,
    subject: plan.subject,
    bodyTemplate: plan.bodyTemplate ?? null,
    bodyRendered: plan.body,
    evidence: plan.evidence,
    numbersCheck: plan.numbersCheck ?? null,
    sendDecision: plan.decision ?? null,
    status: plan.decision?.mode === "blocked" ? ("blocked" as const) : ("draft" as const),
    rejectedReason: null,
    model: "template",
    ...(actor.actorType === "agent" ? { runId: actor.actorId } : {}),
  };
  const [existing] = await db.select().from(draftAction).where(and(eq(draftAction.workspaceId, workspaceId), eq(draftAction.key, plan.key)));
  if (existing && ["sending", "sent", "approved", "scheduled"].includes(existing.status)) return { ok: false, reason: "This invoice's email is already on its way." };
  const draftId = existing
    ? (await db.update(draftAction).set(content).where(eq(draftAction.id, existing.id)).returning({ id: draftAction.id }))[0]!.id
    : (await db.insert(draftAction).values({ workspaceId, key: plan.key, flagIds: [], ...content, createdAt: workspaceClock(d.ws) }).returning({ id: draftAction.id }))[0]!.id;
  await audit(db, { workspaceId, ...actor, action: "draft.created", objectType: "draft_action", objectId: draftId, details: { template: "T11", invoice: d.inv.number, to: plan.to, status: content.status } });
  return { ok: true, draftId };
}

/** The person sent the invoice themselves (from their own email, a portal…). */
export async function markInvoiceSent(db: Db, ws: Workspace, invoiceId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(invoice)
    .set({ status: "sent", sentAt: workspaceClock(ws) })
    .where(and(eq(invoice.workspaceId, ws.id), eq(invoice.id, invoiceId), eq(invoice.status, "draft")))
    .returning({ number: invoice.number });
  if (!rows.length) return false;
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "invoice.marked_sent", objectType: "invoice", objectId: invoiceId, details: { number: rows[0]!.number } });
  return true;
}

export { DEFAULT_PURPOSE_WORDING };
