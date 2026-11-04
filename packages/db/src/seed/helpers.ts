import { createHash, randomUUID } from "node:crypto";
import { addDays, Decimal, dec, matchCredit, rulesFrom, type CreditForMatching, type IsoDate, type Route, type TemplateKey } from "@ebo/core";
import type { Db } from "../client";
import * as s from "../schema";
import { documentKey, sha256, type Storage } from "../storage";
import type { Truth } from "./documents";
import { simulatedRate } from "./rates";

export const uuid = () => randomUUID();
export const r2 = (x: Decimal.Value) => dec(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
/** 2026-10-27, "ESF" -> ADV-ESF-261027-4821 (the 4 digits are stable for the same seed text). */
export function adviceNo(prefix: string, date: IsoDate, seed: string): string {
  const n = (parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 9000) + 1000;
  return `ADV-${prefix}-${date.slice(2).replace(/-/g, "")}-${n}`;
}
export function payoneerId(date: IsoDate, seed: string): string {
  return `PO-${date.slice(2).replace(/-/g, "")}-${createHash("sha256").update(seed).digest("hex").slice(0, 4).toUpperCase()}`;
}
/** A local time in Pakistan as an instant. */
export const pkt = (date: IsoDate, time = "10:00") => new Date(`${date}T${time}:00+05:00`);
export const refRate = (ccy: string, date: IsoDate) => (ccy === "PKR" ? "1" : simulatedRate(ccy, date));

export interface StoredFile {
  name: string;
  mimeType: string;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  kind?: s.DocumentKind;
}

export async function storeFile(storage: Storage, workspaceId: string, name: string, mimeType: string, content: string, kind?: s.DocumentKind): Promise<StoredFile> {
  const hash = sha256(content);
  const storagePath = documentKey(workspaceId, hash, mimeType);
  await storage.put(storagePath, content, mimeType);
  return { name, mimeType, storagePath, sha256: hash, sizeBytes: Buffer.byteLength(content), kind };
}

/** Rows collected in memory, then written in dependency order in one transaction. */
export class Rows {
  workspace: (typeof s.workspace.$inferInsert)[] = [];
  receivingAccount: (typeof s.receivingAccount.$inferInsert)[] = [];
  client: (typeof s.client.$inferInsert)[] = [];
  clientAlias: (typeof s.clientAlias.$inferInsert)[] = [];
  contract: (typeof s.contract.$inferInsert)[] = [];
  invoice: (typeof s.invoice.$inferInsert)[] = [];
  invoiceLine: (typeof s.invoiceLine.$inferInsert)[] = [];
  document: (typeof s.document.$inferInsert)[] = [];
  transaction: (typeof s.transaction.$inferInsert)[] = [];
  transferLink: (typeof s.transferLink.$inferInsert)[] = [];
  match: (typeof s.match.$inferInsert)[] = [];
  complianceItem: (typeof s.complianceItem.$inferInsert)[] = [];
  message: (typeof s.message.$inferInsert)[] = [];
  invoiceReminder: (typeof s.invoiceReminder.$inferInsert)[] = [];
  demoInboxItem: (typeof s.demoInboxItem.$inferInsert)[] = [];
  member: (typeof s.member.$inferInsert)[] = [];
  auditEvent: (typeof s.auditEvent.$inferInsert)[] = [];

  async write(db: Db): Promise<void> {
    await db.transaction(async (tx) => {
      const order = [
        [s.workspace, this.workspace],
        [s.receivingAccount, this.receivingAccount],
        [s.client, this.client],
        [s.clientAlias, this.clientAlias],
        [s.contract, this.contract],
        [s.invoice, this.invoice],
        [s.invoiceLine, this.invoiceLine],
        [s.document, this.document],
        [s.transaction, this.transaction],
        [s.transferLink, this.transferLink],
        [s.match, this.match],
        [s.complianceItem, this.complianceItem],
        [s.message, this.message],
        [s.invoiceReminder, this.invoiceReminder],
        [s.demoInboxItem, this.demoInboxItem],
        [s.member, this.member],
        [s.auditEvent, this.auditEvent],
      ] as const;
      for (const [table, rows] of order) {
        for (let i = 0; i < rows.length; i += 500) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await tx.insert(table as any).values(rows.slice(i, i + 500) as any);
        }
      }
    });
  }
}

export interface HistoryClient {
  id: string;
  name: string;
  aliases: string[];
}

export interface HistoryInvoice {
  id: string;
  number: string;
  clientId: string;
  currency: string;
  amount: string;
  route: Route;
  issuedOn: IsoDate;
  dueOn: IsoDate;
}

/**
 * Settles a history invoice with a payment exactly as the engine would (core matching),
 * so seeded matches carry the same amounts and explanations as ones made by a run.
 */
export function historyMatch(workspaceId: string, inv: HistoryInvoice, client: HistoryClient, credit: CreditForMatching): typeof s.match.$inferInsert {
  const outcome = matchCredit(credit, {
    invoices: [{ ...inv, balance: inv.amount, status: "sent" }],
    clients: [{ clientId: client.id, name: client.name, aliases: client.aliases }],
    rules: rulesFrom(),
    refRate,
  });
  if (outcome.status !== "matched" || outcome.allocations.length !== 1) {
    throw new Error(`seed: history payment for ${inv.number} did not match: ${outcome.explanation.join(" ")}`);
  }
  const a = outcome.allocations[0]!;
  if (dec(a.unexplainedAmount).gt(0)) throw new Error(`seed: history payment for ${inv.number} left ${a.unexplainedAmount} unexplained`);
  return {
    id: uuid(),
    workspaceId,
    invoiceId: inv.id,
    transactionId: credit.id,
    appliedAmount: a.appliedAmount,
    cashAmount: a.cashAmount,
    feeAmount: a.feeAmount,
    feeProbable: a.feeProbable,
    fxDifference: a.fxDifferencePkr,
    bankRate: a.bankRate,
    referenceRate: a.referenceRate,
    unexplainedAmount: a.unexplainedAmount,
    tier: outcome.tier,
    explanation: outcome.explanation,
    confirmedBy: "seed",
    confirmedAt: new Date(`${credit.valueDate}T12:00:00+05:00`),
  };
}

/** Both documents a bank credit needs (data spec section 3, compliance_item). */
export function complianceRows(
  workspaceId: string,
  transactionId: string,
  valueDate: IsoDate,
  eprc: { status: "missing" | "on_file"; purposeCode?: string | null; documentId?: string | null },
  wht: { status: "missing" | "on_file" },
): Array<typeof s.complianceItem.$inferInsert> {
  return [
    {
      workspaceId,
      transactionId,
      kind: "eprc",
      status: eprc.status,
      purposeCodeOnDocument: eprc.status === "on_file" ? (eprc.purposeCode ?? null) : null,
      documentId: eprc.documentId ?? null,
      dueOn: addDays(valueDate, 14),
    },
    { workspaceId, transactionId, kind: "wht_certificate", status: wht.status, dueOn: addDays(valueDate, 14) },
  ];
}

export function ibanIsValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  const moved = s.slice(4) + s.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

// ---------------------------------------------------------------------------
// The simulated mailbox
// ---------------------------------------------------------------------------

export type Attachment = { name: string; mimeType: string; content: string; kind?: s.DocumentKind; truth?: Truth };

/** One message or upload that "arrives" when the demo clock passes `at`. */
export interface InboxSpec {
  at: Date;
  channel: "email" | "upload" | "paste";
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  attachments: Attachment[];
  kindHint?: s.DocumentKind;
  requires?: TemplateKey;
}

export async function storeInbox(rows: Rows, storage: Storage, ws: string, items: InboxSpec[]): Promise<void> {
  for (const it of items) {
    const attachments: StoredFile[] = [];
    for (const a of it.attachments) attachments.push(await storeFile(storage, ws, a.name, a.mimeType, a.content, a.kind));
    rows.demoInboxItem.push({
      workspaceId: ws,
      deliverAt: it.at,
      channel: it.channel,
      fromAddress: it.from ?? null,
      toAddress: it.to ?? null,
      subject: it.subject ?? null,
      bodyText: it.body ?? null,
      attachments,
      kindHint: it.kindHint ?? null,
      requiresSentTemplate: it.requires ?? null,
    });
  }
}
