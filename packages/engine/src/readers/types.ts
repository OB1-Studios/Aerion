import type { IsoDate } from "@ebo/core";
import type { DocumentKind } from "@ebo/db";

/**
 * Reading documents and emails (build kit sections 2 to 4). Two implementations share
 * these interfaces: the offline reader (layout rules for the simulated documents) and the
 * model reader (Vultr Serverless Inference). Code validates whatever either returns.
 */

export type Confidence = "high" | "medium" | "low";

export interface DocumentInput {
  id: string;
  name: string | null;
  mimeType: string | null;
  /** Text layer: file text, or text recovered from an image. Null when there is none. */
  text: string | null;
  /** The kind a person chose when uploading, if any. */
  kindHint: DocumentKind | null;
}

export interface ReadContext {
  workspaceName: string;
  legalName: string | null;
  /** The workspace's own IBANs (the beneficiary of a credit must be one of them). */
  ibans: string[];
  receivedOn: IsoDate;
}

export interface ModelCallRecord {
  purpose: "classify" | "extract" | "reread" | "draft" | "intent" | "assistant" | "benchmark";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number;
  ok: boolean;
  error?: string | null;
}

export interface Classification {
  kind: DocumentKind;
  confidence: Confidence;
  workspaceMatch: "yes" | "no" | "unsure";
  reason: string;
}

export interface Extraction {
  kind: DocumentKind;
  /** Field values as strings (amounts "6400.00", dates "2026-10-27"); null = not on the document. */
  fields: Record<string, string | null>;
  evidence: Record<string, { quote: string; confidence: Confidence }>;
  notes: string | null;
}

/** Fields a person checked and confirmed in the review queue; the next run applies them as read. */
export interface ConfirmedReading {
  kind: DocumentKind;
  fields: Record<string, string | null>;
  by: string;
  byName: string;
  at: string;
}

export interface DocumentReadResult {
  classification: Classification;
  extraction: Extraction | null;
  model: string;
  promptVersion: string;
  calls: ModelCallRecord[];
}

export interface MessageInput {
  id: string;
  from: string;
  subject: string | null;
  body: string | null;
  receivedOn: IsoDate;
}

export type IntentKind = "payment_claim" | "promise_to_pay" | "dispute" | "bank_detail_change" | "remittance_advice" | "question" | "other";

export interface Intent {
  kind: IntentKind;
  invoiceNumbers: string[];
  amount: string | null;
  currency: string | null;
  /** Claimed payment date (claim), promised date (promise), or null. */
  date: IsoDate | null;
  quote: string;
}

export interface IntentResult {
  intents: Intent[];
  mentionsNewBankDetails: boolean;
  /** Sender of a forwarded message inside the email (where impersonation shows up). */
  forwardedFrom: string | null;
  uetr: string | null;
  requestsActionFromUs: string | null;
}

export interface IntentReadResult {
  result: IntentResult;
  model: string;
  promptVersion: string;
  calls: ModelCallRecord[];
}

export interface DocumentReader {
  readonly name: string;
  read(doc: DocumentInput, ctx: ReadContext): Promise<DocumentReadResult>;
}

export interface IntentReader {
  readonly name: string;
  read(msg: MessageInput, ctx: ReadContext): Promise<IntentReadResult>;
}

export interface Readers {
  document: DocumentReader;
  intent: IntentReader;
}
