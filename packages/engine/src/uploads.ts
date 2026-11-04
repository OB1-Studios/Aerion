import { addDays, dec, weekday, type IsoDate } from "@ebo/core";
import { document, documentKey, receivingAccount, sha256, type Db, type DocumentKind, type Storage } from "@ebo/db";
import { adviceNo, creditAdviceText, fakeUetr } from "@ebo/db/seed";
import { and, eq } from "drizzle-orm";
import { forMatching, loadBooks } from "./books";
import { audit, loadContext, workspaceClock, type Workspace } from "./context";
import { simplePdf } from "./pdf";

/**
 * Documents a person uploads. Each file is identified by its bytes (never by its name or the
 * browser's word for it), stored once by content hash, and waits as "pending" for the next
 * run, which reads it like anything that arrived by email.
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 10;

/** What a person may say a file is; anything else is left for the reader to classify. */
export const UPLOAD_KINDS: Array<{ kind: DocumentKind; label: string }> = [
  { kind: "credit_advice", label: "Bank credit advice" },
  { kind: "eprc", label: "ePRC" },
  { kind: "payoneer_export", label: "Payoneer export (CSV)" },
  { kind: "marketplace_export", label: "Upwork or Fiverr export (CSV)" },
  { kind: "pasted_text", label: "Bank SMS or pasted text" },
  { kind: "screenshot", label: "Payment screenshot" },
  { kind: "wht_certificate", label: "Withholding certificate" },
  { kind: "statement", label: "Bank statement" },
];

export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- strip control characters from a file name
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean.length > 120 ? clean.slice(-120) : clean) || "upload";
}

export type UploadCheck = { ok: true; mimeType: string; name: string } | { ok: false; reason: string };

/** Decides what an uploaded file is from its first bytes; only formats the readers handle get in. */
export function checkUpload(name: string, bytes: Uint8Array): UploadCheck {
  if (!bytes.length) return { ok: false, reason: "is empty" };
  if (bytes.length > UPLOAD_MAX_BYTES) return { ok: false, reason: `is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MB` };
  const clean = cleanName(name);
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { ok: true, mimeType: "application/pdf", name: clean };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, mimeType: "image/png", name: clean };
  if (starts([0xff, 0xd8, 0xff])) return { ok: true, mimeType: "image/jpeg", name: clean };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { ok: true, mimeType: "image/webp", name: clean };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "isn't a PDF, an image or a text file" };
  }
  if (text.includes("\u0000")) return { ok: false, reason: "isn't a PDF, an image or a text file" };
  const head = text.slice(0, 2000).replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return { ok: true, mimeType: "image/svg+xml", name: clean };
  if (/<html[\s>]|<!DOCTYPE html/i.test(head)) return { ok: false, reason: "is a web page: save it as PDF, or paste its text into a .txt file" };
  if (/\.csv$/i.test(clean)) return { ok: true, mimeType: "text/csv", name: clean };
  return { ok: true, mimeType: "text/plain", name: clean };
}

export type UploadResult =
  | { status: "added"; documentId: string; name: string }
  | { status: "duplicate"; documentId: string | null; name: string }
  | { status: "rejected"; name: string; reason: string };

/** Stores one uploaded file and queues it for the next run's read step. */
export async function addUpload(
  deps: { db: Db; storage: Storage },
  ws: Workspace,
  file: { name: string; bytes: Uint8Array },
  opts: { kindHint?: DocumentKind | null; userId: string },
): Promise<UploadResult> {
  const check = checkUpload(file.name, file.bytes);
  if (!check.ok) return { status: "rejected", name: cleanName(file.name), reason: check.reason };
  const hash = sha256(file.bytes);
  const key = documentKey(ws.id, hash, check.mimeType);
  const kind = opts.kindHint && UPLOAD_KINDS.some((k) => k.kind === opts.kindHint) ? opts.kindHint : "other";
  // The file first: a document row must never point at a file that isn't there.
  await deps.storage.put(key, file.bytes, check.mimeType);
  const [row] = await deps.db
    .insert(document)
    .values({ workspaceId: ws.id, kind, storagePath: key, sha256: hash, originalName: check.name, mimeType: check.mimeType, sizeBytes: file.bytes.length, source: "upload", receivedAt: workspaceClock(ws), parseStatus: "pending" })
    .onConflictDoNothing({ target: [document.workspaceId, document.sha256] })
    .returning({ id: document.id });
  if (!row) {
    const [existing] = await deps.db.select({ id: document.id }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.sha256, hash)));
    return { status: "duplicate", documentId: existing?.id ?? null, name: check.name };
  }
  await audit(deps.db, {
    workspaceId: ws.id,
    actorType: "user",
    actorId: opts.userId,
    action: "document.uploaded",
    objectType: "document",
    objectId: row.id,
    details: { name: check.name, mimeType: check.mimeType, sizeBytes: file.bytes.length, kindHint: kind === "other" ? null : kind },
  });
  return { status: "added", documentId: row.id, name: check.name };
}

/** The last business day before a date (bank value dates don't fall on weekends). */
function businessDayBefore(d: IsoDate): IsoDate {
  let x = addDays(d, -1);
  while (weekday(x) >= 6) x = addDays(x, -1);
  return x;
}

/**
 * A sample credit advice as a PDF, for trying the upload: the full payment of the workspace's
 * oldest open invoice that is paid by bank wire, into the account on the invoice, value-dated
 * the business day before the workspace's clock. All of it SIMULATED. Null when nothing is open.
 */
export async function sampleCreditAdvice(db: Db, workspaceId: string): Promise<{ name: string; bytes: Uint8Array; invoiceNumber: string } | null> {
  const w = await loadContext(db, workspaceId);
  const books = await loadBooks(db, w);
  const accounts = await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, workspaceId));
  const bankAccount = (id: string | null) => accounts.find((a) => a.id === id && a.iban && (a.kind === "pkr_account" || a.kind === "esfca"));
  const open = forMatching(books)
    .filter((i) => dec(i.balance).gt(0) && i.currency !== "PKR")
    .map((i) => ({ i, full: books.invoices.find((x) => x.id === i.id)! }))
    .filter(({ full }) => bankAccount(full.receivingAccountId ?? null))
    .sort((a, b) => a.i.dueOn.localeCompare(b.i.dueOn) || a.i.number.localeCompare(b.i.number));
  const pick = open[0];
  if (!pick) return null;

  const acc = bankAccount(pick.full.receivingAccountId ?? null)!;
  const client = books.clients.find((c) => c.id === pick.i.clientId);
  const valueDate = businessDayBefore(w.today);
  const converted = acc.currency === "PKR";
  const rate = converted ? w.refRate(pick.i.currency, valueDate) : null;
  if (converted && !rate) return null;
  const amount = dec(pick.i.balance).toFixed(2);
  const number = adviceNo(converted ? "PKR" : "ESF", valueDate, `sample:${pick.i.id}:${amount}`);
  const text = creditAdviceText({
    bankName: acc.bankName ?? "Your bank",
    adviceNumber: number,
    adviceDate: w.today,
    valueDate,
    beneficiary: w.ws.legalName ?? w.ws.name,
    iban: acc.iban!,
    amount,
    currency: pick.i.currency,
    pkrAmount: converted ? dec(amount).times(rate!).toDecimalPlaces(2).toFixed(2) : null,
    fxRate: converted ? dec(rate!).toFixed(4) : null,
    remitter: (client?.name ?? "CLIENT").toUpperCase(),
    remitterBank: "SAMPLE REMITTING BANK (SIMULATED)",
    remitterSwift: "DEMOUS33",
    reference: pick.i.number,
    chargesCode: "OUR",
    purposeCode: "9186",
    uetr: fakeUetr(number),
  });
  return { name: `sample-advice-${number}.pdf`, bytes: simplePdf(text.split("\n"), { title: `Credit advice ${number} (SIMULATED)` }), invoiceNumber: pick.i.number };
}
