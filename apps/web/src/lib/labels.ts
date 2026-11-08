/**
 * The words people see for the app's internal names: flag kinds, document kinds, readers and
 * audit actions. One place, so every page calls the same thing by the same name.
 */
import type { FlagKind } from "@ebo/core";
import type { DocumentKind } from "@ebo/db";

export const FLAG_KIND: Record<FlagKind, { label: string; next: string }> = {
  short_payment: { label: "Short payment", next: "Send the client the breakdown. It closes when the rest arrives or is credited." },
  wrong_purpose_code: { label: "Wrong purpose code", next: "Ask the bank to correct the code before it issues the ePRC." },
  eprc_wrong_code: { label: "ePRC with a non-IT code", next: "Ask the bank whether the ePRC can be reissued under the IT code." },
  unconfirmed_payment_claim: { label: "Payment claimed, not received", next: "Ask the client for the wire confirmation (MT103 or UETR)." },
  overdue: { label: "Overdue invoice", next: "Send the reminder. It closes when the payment is matched." },
  missing_eprc: { label: "Missing ePRC", next: "Request it from the bank. Waiting on the bank counts as handled." },
  missing_wht_certificate: { label: "Missing withholding certificate", next: "Request it from the bank. Waiting on the bank counts as handled." },
  bank_detail_change: { label: "Possible payment fraud", next: "Call the client on the number already on file. Change nothing because of the email." },
  duplicate_payment: { label: "Duplicate payment", next: "Agree a refund or a credit with the client." },
  banking_share_low: { label: "Banking-channel share low", next: "Bring more proceeds in through Pakistani banks before the tax year ends." },
  pseb_renewal: { label: "PSEB renewal due", next: "Start the PSEB renewal, then update the expiry date in Setup." },
  atl_status: { label: "Active taxpayer status", next: "Check FBR's Active Taxpayers List and record the result in Setup." },
  fx_spread_high: { label: "Poor conversion rate", next: "Compare the bank's rate with the reference rate and raise it with the bank." },
  promise_broken: { label: "Promise to pay broken", next: "Follow up with the client; the next reminder comes forward." },
  pseb_savings_estimate: { label: "PSEB savings estimate", next: "See what registering with PSEB could save. An estimate, from unverified rules." },
};
export const flagKindLabel = (k: string) => FLAG_KIND[k as FlagKind]?.label ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const SEVERITY_LABEL: Record<string, string> = { high: "High", medium: "Medium", info: "Info" };
export const FLAG_STATUS_LABEL: Record<string, string> = { open: "Open", actioned: "Being handled", resolved: "Resolved", dismissed: "Dismissed" };

export const DOCUMENT_KIND: Record<DocumentKind, string> = {
  credit_advice: "Credit advice",
  statement: "Bank statement",
  payoneer_export: "Payoneer export",
  eprc: "ePRC",
  wht_certificate: "Withholding certificate",
  invoice_pdf: "Invoice PDF",
  screenshot: "Screenshot",
  email: "Email",
  marketplace_export: "Marketplace export",
  pasted_text: "Pasted bank text",
  contract: "Contract",
  timesheet: "Timesheet",
  client_tax_form: "Client tax form",
  report: "Report",
  import: "Imported spreadsheet",
  other: "Other",
};
export const documentKindLabel = (k: string | null | undefined) => (k ? (DOCUMENT_KIND[k as DocumentKind] ?? k.replace(/_/g, " ")) : "Not classified yet");

export const SOURCE_LABEL: Record<string, string> = { email: "Email", upload: "Upload", generated: "Made by Aerion", seed: "Demo data", mailbox: "Mailbox", paste: "Pasted" };

/** Who read a document: the built-in rules, the language model, a person, or nobody (seeded). */
export function readerLabel(model: string | null | undefined): { label: string; kind: "rules" | "model" | "person" | "simulated" | null } {
  if (!model) return { label: "—", kind: null };
  if (model === "offline-rules" || model === "rules") return { label: "Layout rules", kind: "rules" };
  if (model === "seed") return { label: "Demo data", kind: "simulated" };
  // A document a person checked and confirmed is stored as "checked by <name>".
  if (model === "person" || model.startsWith("checked by ")) return { label: "A person", kind: "person" };
  return { label: model, kind: "model" };
}

/** A document's status in words, the same on the list and on the document's own page. */
export function documentStatusLabel(d: { kind: string | null; source: string; parseStatus: string; reviewReasons: string[] | null }): string | undefined {
  if (d.kind === "import") return "Imported spreadsheet";
  if (d.source === "generated") return d.kind === "report" ? "Made by Aerion" : "Sent, on file";
  if (d.parseStatus === "needs_review") return "Needs a person";
  if (d.reviewReasons?.[0]?.startsWith("Set aside by")) return "Set aside";
  if (d.parseStatus === "parsed") return "Read";
  return undefined;
}

export const RUN_KIND_LABEL: Record<string, string> = { weekly: "Weekly run", manual: "Started by a person", on_arrival: "New mail arrived" };

const AUDIT: Record<string, string> = {
  "workspace.seeded": "Demo workspace created",
  "workspace.created": "Workspace created",
  "workspace.details_updated": "Business details changed",
  "workspace.invoice_settings_updated": "Invoice settings changed",
  "workspace.exported": "Full data export built",
  "run.started": "Run started",
  "run.succeeded": "Run finished",
  "run.failed": "Run failed",
  "document.uploaded": "Document added",
  "document.parsed": "Document read",
  "document.needs_review": "Document needs a person",
  "document.failed": "Document couldn't be read",
  "document.skipped": "Document skipped",
  "document.duplicate": "Duplicate document",
  "document.confirmed": "Document checked by a person",
  "document.set_aside": "Document set aside",
  "email.received": "Email received",
  "email.classified": "Email read",
  "email.sent": "Email sent",
  "payment.matched": "Payment matched",
  "transaction.corrected": "Payment corrected",
  "flag.opened": "Flag raised",
  "flag.resolved": "Flag resolved",
  "flag.dismissed": "Flag dismissed",
  "draft.created": "Email drafted",
  "draft.edited": "Email edited",
  "draft.approved": "Email approved",
  "draft.rejected": "Email rejected",
  "draft.blocked": "Email held by the numbers check",
  "task.created": "Task created",
  "task.done": "Task done",
  "compliance.received": "Certificate received",
  "invoice.created": "Invoice created",
  "invoice.updated": "Invoice changed",
  "invoice.marked_sent": "Invoice marked as sent",
  "invoice.credited": "Credit note recorded",
  "invoice.written_off": "Invoice written off",
  "invoice.voided": "Invoice voided",
  "retainer.added": "Retainer added",
  "retainer.stopped": "Retainer stopped",
  "receiving_account.added": "Receiving account added",
  "policy.changed": "Approval policy changed",
  "ai_reading.changed": "AI reading switched",
  "mailbox.connected": "Mailbox connected",
  "mailbox.disconnected": "Mailbox disconnected",
  "member.invited": "Person invited",
  "member.joined": "Person joined",
  "member.invitation_revoked": "Invitation withdrawn",
  "member.role_changed": "Role changed",
  "member.removed": "Person removed",
  "two_factor.turned_on": "Two-factor sign-in turned on",
  "two_factor.turned_off": "Two-factor sign-in turned off",
  "two_factor.backup_codes_renewed": "Backup codes renewed",
  "two_factor.requirement_changed": "Two-factor requirement changed",
  "import.checked": "Spreadsheet checked",
  "import.applied": "Spreadsheet imported",
  "month.closed": "Month closed",
  "month.reopened": "Month reopened",
  "tax_pack.built": "Tax pack built",
  "esfca.conversion_recorded": "ESFCA conversion recorded",
  "esfca.conversion_removed": "ESFCA conversion removed",
  "digest.sent": "Email digest sent",
  "demo.clock_advanced": "Demo clock moved on",
};
export const auditLabel = (action: string) => AUDIT[action] ?? action.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The areas of the audit log, for its filter: the part before the dot. */
export const AUDIT_AREAS: Array<[string, string]> = [
  ["run", "Runs"],
  ["document", "Documents"],
  ["email", "Emails in and out"],
  ["draft", "Drafts and approvals"],
  ["payment", "Matching"],
  ["flag", "Flags"],
  ["task", "Tasks"],
  ["invoice", "Invoices"],
  ["member", "People"],
  ["two_factor", "Sign-in"],
  ["workspace", "Workspace"],
  ["month", "Month-end"],
];

export const TRANSACTION_KIND: Record<string, string> = {
  credit: "Bank credit",
  payoneer_receipt: "Payoneer receipt",
  payoneer_withdrawal: "Payoneer withdrawal",
  payoneer_card_spend: "Payoneer card spend",
  platform_earning: "Marketplace earning",
  platform_fee: "Marketplace fee",
  platform_withdrawal: "Marketplace withdrawal",
  fx_conversion: "Currency conversion",
  bank_charge: "Bank charge",
  refund_out: "Refund",
};

export const MATCH_STATUS: Record<string, string> = { matched: "Matched", transfer: "Own transfer", unmatched: "To place", duplicate: "Duplicate", pending: "Not read yet", ignored: "Ignored" };

/** A run's counters in words. The keys come from the engine's steps. */
const RUN_COUNT: Record<string, string> = {
  emails: "Emails collected",
  documents: "Documents collected",
  documents_read: "Documents read",
  needs_review: "Documents sent to a person to check",
  duplicates: "Duplicates skipped",
  transactions: "Payments recorded",
  corrections: "Payments corrected from a later document",
  matched: "Payments matched to invoices",
  unmatched: "Payments left to place",
  transfers: "Transfers between own accounts",
  compliance_items: "ePRCs and certificates now expected",
  certificates: "ePRCs and certificates filed",
  claims: "Client says they've paid",
  promises: "Promises to pay",
  flags_opened: "Flags raised",
  flags_resolved: "Flags resolved",
  flags_open: "Flags open",
  tasks_created: "Tasks for a person",
  retainer_invoices: "Retainer invoices drafted",
  drafts_draft: "Emails waiting for approval",
  drafts_blocked: "Emails held back",
  drafts_scheduled: "Emails scheduled to send",
  drafts_approved: "Emails approved",
  drafts_sent: "Emails sent",
  sent: "Emails sent",
  awaiting_approval: "Waiting for approval",
  needs_person: "Need a person",
  model_calls: "Model calls",
};

/** What a client email was read as. */
export const INTENT_LABEL: Record<string, string> = {
  payment_claim: "Says they've paid",
  promise_to_pay: "Promises to pay",
  bank_detail_change: "Asks to change bank details",
  dispute: "Disputes an amount",
  remittance_advice: "Remittance advice",
  question: "Asks a question",
  other: "Nothing to act on",
};

const words = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
export const intentLabel = (k: string) => INTENT_LABEL[k] ?? words(k);
export const runCountLabel = (k: string) => RUN_COUNT[k] ?? (k.startsWith("intent_") ? `Emails read as: ${intentLabel(k.slice(7)).toLowerCase()}` : words(k));
