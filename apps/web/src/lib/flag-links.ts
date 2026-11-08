import "server-only";
import { clientClaim, complianceItem, getDb, invoice, promiseToPay, transaction } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";

export interface FlagTarget {
  href: string;
  label: string;
}

type FlagRef = { id: string; subjectType: string; subjectId: string };

/**
 * Where each flag's problem lives in the app: the invoice, the payment, or Setup. Certificates
 * point at the payment they belong to; claims and promises at their invoice.
 */
export async function flagTargets(workspaceId: string, base: string, flags: FlagRef[]): Promise<Map<string, FlagTarget>> {
  const db = getDb();
  const ids = (type: string) => [...new Set(flags.filter((f) => f.subjectType === type).map((f) => f.subjectId))];
  const [items, claims, promises] = await Promise.all([
    ids("compliance_item").length ? db.select({ id: complianceItem.id, tx: complianceItem.transactionId }).from(complianceItem).where(and(eq(complianceItem.workspaceId, workspaceId), inArray(complianceItem.id, ids("compliance_item")))) : [],
    ids("claim").length ? db.select({ id: clientClaim.id, inv: clientClaim.invoiceId }).from(clientClaim).where(and(eq(clientClaim.workspaceId, workspaceId), inArray(clientClaim.id, ids("claim")))) : [],
    ids("promise").length ? db.select({ id: promiseToPay.id, inv: promiseToPay.invoiceId }).from(promiseToPay).where(and(eq(promiseToPay.workspaceId, workspaceId), inArray(promiseToPay.id, ids("promise")))) : [],
  ]);
  const itemTx = new Map(items.map((i) => [i.id, i.tx]));
  const claimInv = new Map(claims.flatMap((c) => (c.inv ? [[c.id, c.inv] as const] : [])));
  const promiseInv = new Map(promises.map((p) => [p.id, p.inv]));

  const invoiceIds = [...new Set([...ids("invoice"), ...claimInv.values(), ...promiseInv.values()])];
  const txIds = [...new Set([...ids("transaction"), ...itemTx.values()])];
  const [invs, txs] = await Promise.all([
    invoiceIds.length ? db.select({ id: invoice.id, number: invoice.number }).from(invoice).where(and(eq(invoice.workspaceId, workspaceId), inArray(invoice.id, invoiceIds))) : [],
    txIds.length ? db.select({ id: transaction.id, payer: transaction.payerName, currency: transaction.currency, amount: transaction.amount }).from(transaction).where(and(eq(transaction.workspaceId, workspaceId), inArray(transaction.id, txIds))) : [],
  ]);
  const invNumber = new Map(invs.map((i) => [i.id, i.number]));
  const txLabel = new Map(txs.map((t) => [t.id, `${t.currency} ${Number(t.amount).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} payment`]));

  const out = new Map<string, FlagTarget>();
  const toInvoice = (flagId: string, invId: string | undefined) => {
    if (invId && invNumber.has(invId)) out.set(flagId, { href: `${base}/invoices/${invId}`, label: invNumber.get(invId)! });
  };
  const toPayment = (flagId: string, txId: string | undefined) => {
    if (txId && txLabel.has(txId)) out.set(flagId, { href: `${base}/payments/${txId}`, label: txLabel.get(txId)! });
  };
  for (const f of flags) {
    if (f.subjectType === "invoice") toInvoice(f.id, f.subjectId);
    else if (f.subjectType === "claim") toInvoice(f.id, claimInv.get(f.subjectId));
    else if (f.subjectType === "promise") toInvoice(f.id, promiseInv.get(f.subjectId));
    else if (f.subjectType === "transaction") toPayment(f.id, f.subjectId);
    else if (f.subjectType === "compliance_item") toPayment(f.id, itemTx.get(f.subjectId));
    else if (f.subjectType === "workspace") out.set(f.id, { href: `${base}/setup`, label: "Business details" });
  }
  return out;
}
