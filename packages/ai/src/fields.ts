import { isIsoDate } from "@ebo/core";
import type { DocumentKind } from "@ebo/db";
import { parseAmount, parseDate, type Confidence, type Extraction } from "@ebo/engine";

/**
 * Fields per document kind (build kit section 3). The names are the ones the offline layout
 * rules produce, so the read step treats both readers' output the same way.
 */
type FieldType = "string" | "money" | "date" | "ccy" | "charges" | "purpose" | "iban";
export type FieldSpec = Record<string, { type: FieldType; note?: string }>;

const CREDIT: FieldSpec = {
  advice_number: { type: "string", note: "the bank's advice or reference number" },
  value_date: { type: "date" },
  beneficiary_iban: { type: "iban", note: "our account; spaces removed; for a masked SMS account copy it as written, e.g. ****9876" },
  beneficiary_name: { type: "string" },
  amount: { type: "money", note: "foreign currency amount as remitted" },
  currency: { type: "ccy" },
  pkr_amount: { type: "money", note: "PKR credited; null for a foreign currency (ESFCA) credit" },
  fx_rate_applied: { type: "money", note: "PKR per unit" },
  remitter_name: { type: "string", note: "the payer abroad, as written" },
  remitter_bank: { type: "string" },
  remitter_swift: { type: "string" },
  ordering_reference: { type: "string", note: "field 70 style; copy the whole reference (invoice numbers show up here)" },
  charges_code: { type: "charges", note: "OUR, SHA or BEN (field 71A)" },
  charges_amount: { type: "money" },
  charges_currency: { type: "ccy" },
  purpose_code: { type: "purpose", note: "4 digits, such as 9186" },
  purpose_description: { type: "string" },
  uetr: { type: "string", note: "36-character UUID if printed" },
  corrects_advice_of: { type: "date", note: "if this is a corrected advice, the value date of the credit it corrects" },
  via: { type: "string", note: "for a bank SMS: the channel, e.g. WISE or SWIFT" },
};

export const FIELDS: Partial<Record<DocumentKind, FieldSpec>> = {
  credit_advice: CREDIT,
  pasted_text: CREDIT,
  eprc: {
    certificate_number: { type: "string" },
    issue_date: { type: "date" },
    exporter_name: { type: "string" },
    pseb_number: { type: "string" },
    advice_number: { type: "string", note: "the advice or reference number of the remittance it certifies" },
    value_date: { type: "date" },
    amount: { type: "money" },
    currency: { type: "ccy" },
    pkr_amount: { type: "money" },
    purpose_code: { type: "purpose" },
  },
  screenshot: {
    status_text: { type: "string", note: "e.g. Transfer submitted, Completed" },
    amount: { type: "money" },
    currency: { type: "ccy" },
    beneficiary_name: { type: "string" },
    beneficiary_account_tail: { type: "string", note: "last 4 characters if visible" },
    sent_date: { type: "date" },
    reference: { type: "string" },
    uetr_or_tracking: { type: "string" },
  },
};

/** A SWIFT MT103 copy sent by a client (classified "other"). */
export const MT103_FIELDS: FieldSpec = {
  value_date: { type: "date", note: "from field 32A" },
  currency: { type: "ccy", note: "from field 32A" },
  amount: { type: "money", note: "from field 32A" },
  reference: { type: "string", note: "field 70" },
  uetr: { type: "string" },
};

const TYPE_SCHEMA: Record<FieldType, Record<string, unknown>> = {
  string: { type: ["string", "null"] },
  money: { type: ["string", "null"], description: "digits, dot for decimals, no thousands separators" },
  date: { type: ["string", "null"], description: "YYYY-MM-DD" },
  ccy: { type: ["string", "null"], description: "ISO 4217 code" },
  charges: { type: ["string", "null"], enum: ["OUR", "SHA", "BEN", null] },
  purpose: { type: ["string", "null"], description: "4 digits" },
  iban: { type: ["string", "null"] },
};

/** JSON schema for one extraction: { fields, evidence, notes }. */
export function extractionSchema(spec: FieldSpec): Record<string, unknown> {
  const names = Object.keys(spec);
  return {
    type: "object",
    additionalProperties: false,
    required: ["fields", "evidence", "notes"],
    properties: {
      fields: {
        type: "object",
        additionalProperties: false,
        required: names,
        properties: Object.fromEntries(names.map((n) => [n, { ...TYPE_SCHEMA[spec[n]!.type], ...(spec[n]!.note ? { description: spec[n]!.note } : {}) }])),
      },
      evidence: {
        type: "object",
        description: "for every non-null field: the exact text it was read from, and a confidence",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["quote", "confidence"],
          properties: { quote: { type: "string" }, confidence: { enum: ["high", "medium", "low"] } },
        },
      },
      notes: { type: ["string", "null"] },
    },
  };
}

const CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * Turns a model's reply into an Extraction, or explains why it can't. Values are normalised
 * and checked by type; anything that doesn't fit becomes null with a note, never a guess.
 * A value without a quote gets low confidence, which sends the document to a person.
 */
export function normalizeExtraction(kind: DocumentKind, spec: FieldSpec, raw: Record<string, unknown>): { extraction: Extraction; problems: string[] } {
  const problems: string[] = [];
  const rawFields = raw.fields && typeof raw.fields === "object" ? (raw.fields as Record<string, unknown>) : null;
  if (!rawFields) throw new Error('the reply has no "fields" object');
  const rawEvidence = raw.evidence && typeof raw.evidence === "object" ? (raw.evidence as Record<string, unknown>) : {};
  const fields: Record<string, string | null> = {};
  const evidence: Extraction["evidence"] = {};

  for (const [name, { type }] of Object.entries(spec)) {
    const v = rawFields[name];
    let value: string | null = null;
    if (v != null && v !== "") {
      const s = String(v).trim();
      value = normalizeValue(type, s);
      if (value == null) problems.push(`${name}: "${s}" is not a valid ${type}`);
    }
    fields[name] = value;
    if (value == null) continue;
    const e = rawEvidence[name] as { quote?: unknown; confidence?: unknown } | undefined;
    const quote = typeof e?.quote === "string" ? e.quote : "";
    const confidence = (typeof e?.confidence === "string" && CONFIDENCE.has(e.confidence) ? e.confidence : "low") as Confidence;
    evidence[name] = { quote, confidence: quote ? confidence : "low" };
  }
  const notes = typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null;
  return { extraction: { kind, fields, evidence, notes: [notes, ...problems].filter(Boolean).join(" ") || null }, problems };
}

function normalizeValue(type: FieldType, s: string): string | null {
  switch (type) {
    case "money":
      return /^-?\d+(\.\d{1,6})?$/.test(s) ? s : parseAmount(s);
    case "date":
      return isIsoDate(s) ? s : parseDate(s);
    case "ccy":
      return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
    case "charges":
      return /^(OUR|SHA|BEN)$/i.test(s) ? s.toUpperCase() : null;
    case "purpose":
      return /^\d{4}$/.test(s) ? s : (/^(\d{4})\b/.exec(s)?.[1] ?? null);
    case "iban":
      return s.replace(/\s+/g, "").toUpperCase();
    case "string":
      return s;
  }
}
