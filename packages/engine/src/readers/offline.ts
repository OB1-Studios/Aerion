import type { DocumentKind } from "@ebo/db";
import { parseAmount, parseDate, parseMoney } from "./text";
import type { Classification, Confidence, DocumentInput, DocumentReader, Extraction, ReadContext } from "./types";

/**
 * The offline reader: layout rules for the simulated documents (data spec section 12).
 * It needs no model, so the demo and the tests run anywhere. Real-world layouts go to the
 * model reader, which returns the same fields.
 */

export const PAYONEER_HEADER = "date,description,amount,currency,status,payer,transaction_id";
export const MARKETPLACE_HEADER = "date,type,description,client,amount,currency,reference";
export const STATEMENT_HEADER = "txn_date,value_date,narration,reference,debit,credit,balance,currency";

export const SMS_RE =
  /PKR\s*([\d,]+(?:\.\d{1,2})?)\s+received in A\/C\s+(\*+\d{3,4})\s+from\s+(.+?)\s+via\s+([A-Z0-9 ]+?)\s+on\s+(\d{2}-\d{2}-\d{4})\.\s*Purpose:\s*(\d{4})\s*([^.]*)\./i;

const compact = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export function workspaceMatch(text: string, ctx: ReadContext): "yes" | "no" | "unsure" {
  const t = compact(text);
  if (ctx.ibans.some((iban) => t.includes(compact(iban)))) return "yes";
  const tail = /\*{2,}(\d{4})/.exec(text)?.[1];
  if (tail && ctx.ibans.some((iban) => iban.endsWith(tail))) return "yes";
  if (ctx.legalName && t.includes(compact(ctx.legalName))) return "yes";
  return "no";
}

export function classifyOffline(doc: DocumentInput, ctx: ReadContext): Classification {
  const text = doc.text ?? "";
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? "";
  const pick = (kind: DocumentKind, reason: string, confidence: Confidence = "high", needsMatch = true): Classification => ({
    kind,
    confidence,
    workspaceMatch: needsMatch ? workspaceMatch(text, ctx) : "unsure",
    reason,
  });
  if (!text) return { kind: doc.kindHint ?? "other", confidence: "low", workspaceMatch: "unsure", reason: "No text layer; needs the model or a person." };
  if (firstLine === PAYONEER_HEADER) return pick("payoneer_export", "CSV with the Payoneer activity columns.", "high", false);
  if (firstLine === MARKETPLACE_HEADER) return pick("marketplace_export", "CSV with the marketplace earnings columns.", "high", false);
  if (firstLine === STATEMENT_HEADER) return pick("statement", "CSV with the bank statement columns.", "high", false);
  if (/Inward Remittance Credit Advice/i.test(text)) return pick("credit_advice", "Titled as an inward remittance credit advice.");
  if (/Proceeds Realization Certificate/i.test(text)) return pick("eprc", "Titled as an ePRC.");
  if (/withholding/i.test(text) && /certificate/i.test(text)) return pick("wht_certificate", "Mentions a withholding tax certificate.");
  if (SMS_RE.test(text)) return pick("pasted_text", "Bank SMS about a credit to our account.");
  if (doc.mimeType === "image/svg+xml" && /transfer submitted|payment sent|completed/i.test(text)) return pick("screenshot", "Picture of a banking app's transfer screen.", "high", false);
  if (/MT103/.test(text)) return pick("other", "Copy of a SWIFT MT103 sent by a client.", "medium", false);
  return { kind: doc.kindHint ?? "other", confidence: "low", workspaceMatch: "unsure", reason: "No known layout." };
}

/** "Label    : value" lines -> label -> { value, line }. */
function labelLines(text: string): Map<string, { value: string; line: string }> {
  const out = new Map<string, { value: string; line: string }>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(": ");
    if (i <= 0) continue;
    out.set(line.slice(0, i).trim().toLowerCase(), { value: line.slice(i + 2).trim(), line: line.trim() });
  }
  return out;
}

class FieldSet {
  fields: Record<string, string | null> = {};
  evidence: Record<string, { quote: string; confidence: Confidence }> = {};
  set(name: string, value: string | null | undefined, quote: string, confidence: Confidence = "high") {
    this.fields[name] = value ?? null;
    if (value != null) this.evidence[name] = { quote, confidence };
  }
  done(kind: DocumentKind, notes: string | null = null): Extraction {
    return { kind, fields: this.fields, evidence: this.evidence, notes };
  }
}

const na = (v: string | undefined) => (!v || /^N\/?A$/i.test(v) || v === "-" ? null : v);

function extractAdvice(text: string): Extraction {
  const L = labelLines(text);
  const f = new FieldSet();
  const get = (label: string) => L.get(label.toLowerCase());
  const plain = (name: string, label: string, transform: (v: string) => string | null = (v) => v) => {
    const e = get(label);
    const v = na(e?.value);
    f.set(name, v ? transform(v) : null, e?.line ?? "");
  };
  plain("advice_number", "Advice No.");
  plain("value_date", "Value Date", parseDate);
  plain("beneficiary_iban", "Beneficiary Account", (v) => v.replace(/\s+/g, ""));
  plain("beneficiary_name", "Beneficiary");
  const remitted = get("Amount Remitted");
  const money = parseMoney(na(remitted?.value) ?? "");
  f.set("amount", money?.amount, remitted?.line ?? "");
  f.set("currency", money?.currency, remitted?.line ?? "");
  const credited = get("Amount Credited (PKR)");
  f.set("pkr_amount", parseMoney(na(credited?.value) ?? "")?.amount, credited?.line ?? "");
  plain("fx_rate_applied", "Exchange Rate", parseAmount);
  plain("remitter_name", "Remitter");
  plain("remitter_bank", "Remitter Bank");
  plain("remitter_swift", "Remitter SWIFT");
  plain("ordering_reference", "Ordering Ref (F70)");
  plain("charges_code", "Charges (F71A)", (v) => (/^(OUR|SHA|BEN)$/.test(v) ? v : null));
  const ch = get("Sender's Charges (F71F)");
  const chMoney = parseMoney(na(ch?.value) ?? "");
  f.set("charges_amount", chMoney?.amount, ch?.line ?? "");
  f.set("charges_currency", chMoney?.currency, ch?.line ?? "");
  const purpose = get("Purpose of Payment");
  const pm = /^(\d{4})\s*-?\s*(.*)$/.exec(na(purpose?.value) ?? "");
  f.set("purpose_code", pm?.[1], purpose?.line ?? "");
  f.set("purpose_description", pm?.[2] || null, purpose?.line ?? "");
  plain("uetr", "UETR");
  const corr = /CORRECTED ADVICE.*?(\d{2}-\d{2}-\d{4})/i.exec(text);
  f.set("corrects_advice_of", corr ? parseDate(corr[1]) : null, corr?.[0] ?? "");
  f.set("via", null, "");
  return f.done("credit_advice");
}

function extractSms(text: string): Extraction {
  const m = SMS_RE.exec(text);
  const f = new FieldSet();
  const quote = m?.[0] ?? "";
  f.set("pkr_amount", parseAmount(m?.[1]), quote);
  f.set("amount", null, quote);
  f.set("currency", null, quote);
  f.set("beneficiary_iban", m?.[2] ?? null, quote);
  f.set("remitter_name", m?.[3]?.trim(), quote);
  f.set("via", m?.[4]?.trim(), quote);
  f.set("value_date", parseDate(m?.[5]), quote, "medium"); // day-month order assumed (Pakistani banks)
  f.set("purpose_code", m?.[6], quote);
  f.set("purpose_description", m?.[7]?.trim() || null, quote);
  for (const k of ["advice_number", "fx_rate_applied", "remitter_bank", "remitter_swift", "ordering_reference", "charges_code", "charges_amount", "charges_currency", "uetr", "corrects_advice_of"]) f.set(k, null, "");
  return f.done("pasted_text");
}

function extractEprc(text: string): Extraction {
  const L = labelLines(text);
  const f = new FieldSet();
  const get = (label: string) => L.get(label.toLowerCase());
  const plain = (name: string, label: string, transform: (v: string) => string | null = (v) => v) => {
    const e = get(label);
    const v = na(e?.value);
    f.set(name, v ? transform(v) : null, e?.line ?? "");
  };
  plain("certificate_number", "Certificate No.");
  plain("issue_date", "Issue Date", parseDate);
  plain("exporter_name", "Exporter");
  plain("pseb_number", "PSEB Registration");
  plain("advice_number", "Advice No.");
  plain("value_date", "Value Date", parseDate);
  const amt = get("Amount");
  const money = parseMoney(na(amt?.value) ?? "");
  f.set("amount", money?.amount, amt?.line ?? "");
  f.set("currency", money?.currency, amt?.line ?? "");
  const pkr = get("Amount (PKR)");
  f.set("pkr_amount", parseMoney(na(pkr?.value) ?? "")?.amount, pkr?.line ?? "");
  const purpose = get("Purpose Code");
  f.set("purpose_code", /^(\d{4})/.exec(na(purpose?.value) ?? "")?.[1], purpose?.line ?? "");
  return f.done("eprc");
}

function extractScreenshot(text: string): Extraction {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const after = (label: string) => {
    const i = lines.findIndex((l) => l.toLowerCase() === label);
    return i >= 0 ? (lines[i + 1] ?? null) : null;
  };
  const f = new FieldSet();
  const status = lines.find((l) => /submitted|completed|sent/i.test(l)) ?? null;
  f.set("status_text", status, status ?? "");
  const amountLine = lines.find((l) => /^[A-Z]{3}\s[\d,]+\.\d{2}$/.test(l)) ?? null;
  const money = parseMoney(amountLine ?? "");
  f.set("amount", money?.amount, amountLine ?? "");
  f.set("currency", money?.currency, amountLine ?? "");
  const to = after("to");
  f.set("beneficiary_name", to, to ?? "");
  const account = after("account");
  f.set("beneficiary_account_tail", /(\d{4})\s*$/.exec(account ?? "")?.[1], account ?? "");
  const date = after("date");
  f.set("sent_date", parseDate(date), date ?? "", "medium");
  const ref = after("reference");
  f.set("reference", ref, ref ?? "");
  f.set("uetr_or_tracking", null, "");
  return f.done("screenshot", "A screenshot is not proof of payment; it only supports the client's claim.");
}

function extractMt103(text: string): Extraction {
  const f = new FieldSet();
  const a = /:32A:(\d{6})([A-Z]{3})([\d,]+)/.exec(text);
  f.set("value_date", a ? parseDate(`20${a[1]!.slice(0, 2)}-${a[1]!.slice(2, 4)}-${a[1]!.slice(4, 6)}`) : null, a?.[0] ?? "");
  f.set("currency", a?.[2], a?.[0] ?? "");
  f.set("amount", a ? parseAmount(a[3]!.replace(",", ".")) : null, a?.[0] ?? "");
  const ref = /:70:(.+)/.exec(text);
  f.set("reference", ref?.[1]?.trim(), ref?.[0] ?? "");
  const uetr = /UETR:\s*([0-9a-f-]{36})/i.exec(text);
  f.set("uetr", uetr?.[1], uetr?.[0] ?? "");
  return f.done("other", "SWIFT MT103 copy from the payer.");
}

export function extractOffline(kind: DocumentKind, text: string): Extraction | null {
  switch (kind) {
    case "credit_advice":
      return extractAdvice(text);
    case "pasted_text":
      return extractSms(text);
    case "eprc":
      return extractEprc(text);
    case "screenshot":
      return extractScreenshot(text);
    case "other":
      return /MT103/.test(text) ? extractMt103(text) : null;
    default:
      return null; // CSVs are parsed by code in the read step; other kinds need the model
  }
}

export const offlineDocumentReader: DocumentReader = {
  name: "offline",
  async read(doc, ctx) {
    const classification = classifyOffline(doc, ctx);
    const extraction = doc.text ? extractOffline(classification.kind, doc.text) : null;
    return { classification, extraction, model: "offline-rules", promptVersion: "offline.v1", calls: [] };
  },
};
