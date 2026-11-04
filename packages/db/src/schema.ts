/**
 * Database schema (data spec section 3). Conventions (section 2):
 * - UUID keys; human references (invoice numbers, advice numbers) are separate columns.
 * - Every tenant table has workspace_id; access is always scoped to the caller's workspaces.
 * - Money is numeric(18,2) next to a 3-letter currency; FX rates are numeric(18,6) PKR per unit.
 *   Drizzle returns numerics as strings, so amounts never become floats.
 * - Calendar dates are `date` (strings like 2026-11-02); instants are timestamptz.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ApprovalPolicy, Evidence, FlagKind, NumbersCheckResult, SendDecision, Severity, TemplateKey } from "@ebo/core";

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const rate = (name: string) => numeric(name, { precision: 18, scale: 6 });
const day = (name: string) => date(name, { mode: "string" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();
const wsId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" });

// ---------------------------------------------------------------------------
// Sign-in (tables required by better-auth; ids are text)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  /** Visitors who pressed "Try the demo" (better-auth anonymous plugin). */
  isAnonymous: boolean("is_anonymous").default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  verified: boolean("verified"),
  failedVerificationCount: integer("failed_verification_count"),
  lockedUntil: ts("locked_until"),
});

// ---------------------------------------------------------------------------
// Workspace and people
// ---------------------------------------------------------------------------

export type WorkspaceKind = "company" | "freelancer";

/** Who signs outgoing emails and owns tasks (build kit decision 7: always a person). */
export interface WorkspaceSettings {
  senderName?: string;
  senderTitle?: string;
  directorName?: string;
  directorTitle?: string;
  phone?: string;
  /** The address outgoing emails come from (the connected mailbox in production). */
  mailboxAddress?: string;
  /** Default "purpose of payment" wording on invoices. */
  purposeWording?: string;
}
export type Role = "owner" | "finance" | "accountant" | "viewer";

export const workspace = pgTable("workspace", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").$type<WorkspaceKind>().notNull(),
  legalName: text("legal_name"),
  city: text("city"),
  ntn: text("ntn"),
  /** Freelancers only; encrypted by the app before it is stored. */
  cnicEncrypted: text("cnic_encrypted"),
  secpRegNo: text("secp_reg_no"),
  psebRegNo: text("pseb_reg_no"),
  psebValidUntil: day("pseb_valid_until"),
  atlStatus: text("atl_status").$type<"active" | "inactive" | "unknown">().notNull().default("unknown"),
  atlCheckedOn: day("atl_checked_on"),
  fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(7),
  emailDomain: text("email_domain"),
  approvalPolicy: jsonb("approval_policy").$type<ApprovalPolicy>().notNull().default({ mode: "supervised", delayMinutes: 30 }),
  numberGrouping: text("number_grouping").$type<"western" | "lakh">().notNull().default("western"),
  logoPath: text("logo_path"),
  invoicePrefix: text("invoice_prefix").notNull().default("INV"),
  nextInvoiceSeq: integer("next_invoice_seq").notNull().default(1),
  aiReadingEnabled: boolean("ai_reading_enabled").notNull().default(true),
  timezone: text("timezone").notNull().default("Asia/Karachi"),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull().default({}),
  /** Demo workspaces run on a simulated clock so they look the same whenever they are opened. */
  isDemo: boolean("is_demo").notNull().default(false),
  demoClock: ts("demo_clock"),
  /** Demo copies made for visitors expire. */
  expiresAt: ts("expires_at"),
  createdAt: createdAt(),
});

export const member = pgTable(
  "member",
  {
    id: id(),
    workspaceId: wsId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
    invitedBy: text("invited_by"),
    createdAt: createdAt(),
  },
  (t) => [unique("member_ws_user").on(t.workspaceId, t.userId), index("member_user_idx").on(t.userId)],
);

export const invitation = pgTable("invitation", {
  id: id(),
  workspaceId: wsId(),
  email: text("email").notNull(),
  role: text("role").$type<Role>().notNull(),
  token: text("token").notNull().unique(),
  invitedBy: text("invited_by").notNull(),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Money in
// ---------------------------------------------------------------------------

export type AccountKind = "pkr_account" | "esfca" | "payoneer" | "wise_pkr" | "platform";
export type Route = "swift_esfca" | "swift_pkr" | "payoneer" | "wise_pkr" | "platform" | "other";

export const receivingAccount = pgTable("receiving_account", {
  id: id(),
  workspaceId: wsId(),
  kind: text("kind").$type<AccountKind>().notNull(),
  label: text("label").notNull(),
  bankName: text("bank_name"),
  iban: text("iban"),
  swift: text("swift"),
  currency: char("currency", { length: 3 }).notNull(),
  /** Payoneer's receiving details per currency, Wise details, etc. */
  receivingDetails: jsonb("receiving_details").$type<Record<string, unknown>>(),
  platformName: text("platform_name"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const client = pgTable(
  "client",
  {
    id: id(),
    workspaceId: wsId(),
    name: text("name").notNull(),
    country: char("country", { length: 2 }),
    kind: text("kind").$type<"business" | "individual" | "marketplace">().notNull().default("business"),
    defaultCurrency: char("default_currency", { length: 3 }).notNull(),
    preferredRoute: text("preferred_route").$type<Route>(),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    contactName: text("contact_name"),
    contactEmails: text("contact_emails").array().notNull().default(sql`'{}'::text[]`),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("client_ws_idx").on(t.workspaceId)],
);

export const clientAlias = pgTable(
  "client_alias",
  {
    id: id(),
    workspaceId: wsId(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => client.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    source: text("source").$type<"manual" | "learned">().notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [unique("client_alias_unique").on(t.workspaceId, t.clientId, t.alias)],
);

export const contract = pgTable("contract", {
  id: id(),
  workspaceId: wsId(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => client.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"retainer" | "milestone" | "hourly" | "fixed">().notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  amountOrRate: money("amount_or_rate").notNull(),
  /** What the work is, as it appears on each invoice line ("Flutter app development, monthly retainer"). */
  description: text("description"),
  billingDay: integer("billing_day"),
  startsOn: day("starts_on"),
  endsOn: day("ends_on"),
  /** The last month ("2026-11") a retainer invoice was drafted for, so each month is drafted once. */
  lastPeriod: text("last_period"),
  documentId: uuid("document_id"),
  createdAt: createdAt(),
});

export type InvoiceStatus = "draft" | "sent" | "part_paid" | "paid" | "void";

export const invoice = pgTable(
  "invoice",
  {
    id: id(),
    workspaceId: wsId(),
    number: text("number").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => client.id),
    currency: char("currency", { length: 3 }).notNull(),
    amount: money("amount").notNull(),
    issuedOn: day("issued_on").notNull(),
    dueOn: day("due_on").notNull(),
    route: text("route").$type<Route>().notNull(),
    receivingAccountId: uuid("receiving_account_id").references(() => receivingAccount.id),
    purposeWording: text("purpose_wording"),
    status: text("status").$type<InvoiceStatus>().notNull().default("draft"),
    pdfDocumentId: uuid("pdf_document_id"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [unique("invoice_ws_number").on(t.workspaceId, t.number), index("invoice_ws_status_idx").on(t.workspaceId, t.status)],
);

export const invoiceLine = pgTable("invoice_line", {
  id: id(),
  workspaceId: wsId(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoice.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull().default("1"),
  unitPrice: money("unit_price").notNull(),
  amount: money("amount").notNull(),
  contractId: uuid("contract_id"),
  milestoneLabel: text("milestone_label"),
});

export const creditNote = pgTable("credit_note", {
  id: id(),
  workspaceId: wsId(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoice.id),
  number: text("number").notNull(),
  kind: text("kind").$type<"credit" | "write_off" | "void">().notNull(),
  amount: money("amount").notNull(),
  reason: text("reason").notNull(),
  approvedBy: text("approved_by"),
  createdAt: createdAt(),
});

export type TransactionKind =
  | "credit"
  | "payoneer_receipt"
  | "payoneer_withdrawal"
  | "payoneer_card_spend"
  | "platform_earning"
  | "platform_fee"
  | "platform_withdrawal"
  | "fx_conversion"
  | "bank_charge"
  | "refund_out";

export const transaction = pgTable(
  "transaction",
  {
    id: id(),
    workspaceId: wsId(),
    kind: text("kind").$type<TransactionKind>().notNull(),
    receivingAccountId: uuid("receiving_account_id").references(() => receivingAccount.id),
    valueDate: day("value_date").notNull(),
    amount: money("amount").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    pkrAmount: money("pkr_amount"),
    fxRateApplied: rate("fx_rate_applied"),
    chargesAmount: money("charges_amount"),
    chargesCurrency: char("charges_currency", { length: 3 }),
    chargesCode: text("charges_code").$type<"OUR" | "SHA" | "BEN">(),
    payerName: text("payer_name"),
    payerBank: text("payer_bank"),
    /** The bank's own number for the credit (advice number), or the wallet's transaction id. */
    adviceNumber: text("advice_number"),
    /** The payer's reference (field 70 style): where invoice numbers show up. */
    reference: text("reference"),
    purposeCode: text("purpose_code"),
    uetr: text("uetr"),
    sourceDocumentId: uuid("source_document_id"),
    /** Page and line, or CSV row, that produced this row. */
    sourceLocator: jsonb("source_locator").$type<Record<string, unknown>>(),
    /** Stops the same document line being imported twice. */
    dedupeKey: text("dedupe_key"),
    matchStatus: text("match_status").$type<"pending" | "matched" | "unmatched" | "transfer" | "duplicate" | "ignored">().notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [
    index("transaction_ws_date_idx").on(t.workspaceId, t.valueDate),
    uniqueIndex("transaction_ws_dedupe").on(t.workspaceId, t.dedupeKey),
  ],
);

export const transferLink = pgTable("transfer_link", {
  id: id(),
  workspaceId: wsId(),
  fromTransactionId: uuid("from_transaction_id")
    .notNull()
    .references(() => transaction.id, { onDelete: "cascade" }),
  toTransactionId: uuid("to_transaction_id")
    .notNull()
    .references(() => transaction.id, { onDelete: "cascade" }),
  probable: boolean("probable").notNull().default(false),
  createdAt: createdAt(),
});

export const clientClaim = pgTable("client_claim", {
  id: id(),
  workspaceId: wsId(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => client.id),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoice.id),
  claimedOn: day("claimed_on").notNull(),
  claimedAmount: money("claimed_amount"),
  currency: char("currency", { length: 3 }),
  evidenceDocumentId: uuid("evidence_document_id"),
  messageId: uuid("message_id"),
  status: text("status").$type<"open" | "resolved">().notNull().default("open"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Matching and checks
// ---------------------------------------------------------------------------

export const match = pgTable(
  "match",
  {
    id: id(),
    workspaceId: wsId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transaction.id, { onDelete: "cascade" }),
    /** What this settles on the invoice (cash + explained fee), in the invoice currency. */
    appliedAmount: money("applied_amount").notNull(),
    cashAmount: money("cash_amount").notNull(),
    feeAmount: money("fee_amount").notNull().default("0"),
    feeProbable: boolean("fee_probable").notNull().default(false),
    /** PKR received minus PKR expected at the reference rate. */
    fxDifference: money("fx_difference"),
    bankRate: rate("bank_rate"),
    referenceRate: rate("reference_rate"),
    unexplainedAmount: money("unexplained_amount").notNull().default("0"),
    tier: text("tier").$type<"A" | "B" | "manual">().notNull(),
    explanation: text("explanation").array().notNull().default(sql`'{}'::text[]`),
    confirmedBy: text("confirmed_by"),
    confirmedAt: ts("confirmed_at"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("match_invoice_idx").on(t.invoiceId), index("match_tx_idx").on(t.transactionId)],
);

/** Global (not per workspace). Simulated in the demo; SBP's published rate in production (verify source). */
export const fxReferenceRate = pgTable(
  "fx_reference_rate",
  {
    currency: char("currency", { length: 3 }).notNull(),
    rateDate: day("rate_date").notNull(),
    midRate: rate("mid_rate").notNull(),
    source: text("source").notNull(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.rateDate] })],
);

export const complianceItem = pgTable(
  "compliance_item",
  {
    id: id(),
    workspaceId: wsId(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transaction.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"eprc" | "wht_certificate">().notNull(),
    status: text("status").$type<"missing" | "requested" | "on_file" | "wrong_code">().notNull().default("missing"),
    documentId: uuid("document_id"),
    purposeCodeOnDocument: text("purpose_code_on_document"),
    dueOn: day("due_on"),
    requestedAt: ts("requested_at"),
    createdAt: createdAt(),
  },
  (t) => [unique("compliance_tx_kind").on(t.transactionId, t.kind)],
);

export const flag = pgTable(
  "flag",
  {
    id: id(),
    workspaceId: wsId(),
    /** Stable identity across runs (see core/flags.ts). */
    key: text("key").notNull(),
    kind: text("kind").$type<FlagKind>().notNull(),
    severity: text("severity").$type<Severity>().notNull(),
    status: text("status").$type<"open" | "actioned" | "resolved" | "dismissed">().notNull().default("open"),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    summary: text("summary").notNull(),
    evidence: jsonb("evidence").$type<Evidence>().notNull(),
    ruleKeys: text("rule_keys").array().notNull().default(sql`'{}'::text[]`),
    runId: uuid("run_id"),
    resolvedByRunId: uuid("resolved_by_run_id"),
    resolvedAt: ts("resolved_at"),
    dismissedBy: text("dismissed_by"),
    dismissedReason: text("dismissed_reason"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("flag_ws_key").on(t.workspaceId, t.key), index("flag_ws_status_idx").on(t.workspaceId, t.status)],
);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type DraftStatus = "draft" | "blocked" | "approved" | "scheduled" | "sending" | "sent" | "rejected" | "cancelled" | "failed";

export const draftAction = pgTable(
  "draft_action",
  {
    id: id(),
    workspaceId: wsId(),
    /** Stable identity (see core/drafting.ts) so a re-run updates the draft instead of adding another. */
    key: text("key").notNull(),
    kind: text("kind").$type<"client_email" | "bank_email" | "internal_task">().notNull(),
    template: text("template").$type<TemplateKey>(),
    flagIds: uuid("flag_ids").array().notNull().default(sql`'{}'::uuid[]`),
    invoiceId: uuid("invoice_id"),
    toAddress: text("to_address"),
    ccAddress: text("cc_address"),
    subject: text("subject"),
    bodyTemplate: text("body_template"),
    bodyRendered: text("body_rendered"),
    evidence: jsonb("evidence").$type<Evidence>(),
    numbersCheck: jsonb("numbers_check").$type<NumbersCheckResult>(),
    sendDecision: jsonb("send_decision").$type<SendDecision>(),
    status: text("status").$type<DraftStatus>().notNull().default("draft"),
    scheduledFor: ts("scheduled_for"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    rejectedReason: text("rejected_reason"),
    sentAt: ts("sent_at"),
    messageId: uuid("message_id"),
    model: text("model"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("draft_ws_status_idx").on(t.workspaceId, t.status), uniqueIndex("draft_ws_key").on(t.workspaceId, t.key)],
);

export const invoiceReminder = pgTable("invoice_reminder", {
  id: id(),
  workspaceId: wsId(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoice.id, { onDelete: "cascade" }),
  stage: integer("stage").notNull(),
  sentOn: day("sent_on").notNull(),
  draftActionId: uuid("draft_action_id"),
});

export const task = pgTable(
  "task",
  {
    id: id(),
    workspaceId: wsId(),
    title: text("title").notNull(),
    detail: text("detail"),
    ownerId: text("owner_id"),
    dueOn: day("due_on"),
    status: text("status").$type<"open" | "done">().notNull().default("open"),
    flagId: uuid("flag_id"),
    documentId: uuid("document_id"),
    /** Stable identity so a re-run doesn't create the same task twice. */
    key: text("key"),
    doneNote: text("done_note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("task_ws_key").on(t.workspaceId, t.key)],
);

export const message = pgTable(
  "message",
  {
    id: id(),
    workspaceId: wsId(),
    threadKey: text("thread_key"),
    direction: text("direction").$type<"in" | "out">().notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject"),
    sentAt: ts("sent_at").notNull(),
    bodyText: text("body_text"),
    documentIds: uuid("document_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Inbound only: what the classifier says the email is (never followed as instructions). */
    intent: text("intent"),
    /** Inbound only: the intent reader's full output (intents, quotes, forwarded senders). */
    extracted: jsonb("extracted").$type<Record<string, unknown>>(),
    clientId: uuid("client_id"),
    mailboxUid: text("mailbox_uid"),
    createdAt: createdAt(),
  },
  (t) => [index("message_ws_idx").on(t.workspaceId, t.sentAt)],
);

// ---------------------------------------------------------------------------
// Documents, rules, runs, audit
// ---------------------------------------------------------------------------

export type DocumentKind =
  | "credit_advice"
  | "statement"
  | "payoneer_export"
  | "eprc"
  | "wht_certificate"
  | "invoice_pdf"
  | "screenshot"
  | "email"
  | "marketplace_export"
  | "pasted_text"
  | "contract"
  | "timesheet"
  | "client_tax_form"
  | "other";

export const document = pgTable(
  "document",
  {
    id: id(),
    workspaceId: wsId(),
    kind: text("kind").$type<DocumentKind>().notNull().default("other"),
    storagePath: text("storage_path").notNull(),
    sha256: text("sha256").notNull(),
    originalName: text("original_name"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    source: text("source").$type<"email" | "upload" | "generated" | "seed">().notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    parseStatus: text("parse_status").$type<"pending" | "parsed" | "needs_review" | "failed" | "skipped">().notNull().default("pending"),
    /** Raw model output; transaction rows are what code uses. */
    extracted: jsonb("extracted").$type<Record<string, unknown>>(),
    fieldConfidence: jsonb("field_confidence").$type<Record<string, number>>(),
    reviewReasons: text("review_reasons").array(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [unique("document_ws_sha").on(t.workspaceId, t.sha256), index("document_ws_status_idx").on(t.workspaceId, t.parseStatus)],
);

export const rule = pgTable(
  "rule",
  {
    id: id(),
    /** Null for rules that apply to every workspace. */
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    description: text("description").notNull(),
    sourceUrl: text("source_url"),
    sourceTitle: text("source_title"),
    effectiveFrom: day("effective_from"),
    effectiveTo: day("effective_to"),
    verifiedBy: text("verified_by"),
    verifiedAt: ts("verified_at"),
    status: text("status").$type<"unverified" | "verified">().notNull().default("unverified"),
    createdAt: createdAt(),
  },
  (t) => [unique("rule_ws_key").on(t.workspaceId, t.key).nullsNotDistinct()],
);

export type RunStepName = "plan" | "pull" | "read" | "reconcile" | "flag" | "draft" | "send" | "follow_up";

export const run = pgTable(
  "run",
  {
    id: id(),
    workspaceId: wsId(),
    kind: text("kind").$type<"weekly" | "on_arrival" | "manual">().notNull(),
    /** The (possibly simulated) time the run acted as of. */
    clockAt: ts("clock_at").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    status: text("status").$type<"queued" | "running" | "succeeded" | "failed">().notNull().default("running"),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    summary: text("summary"),
    triggeredBy: text("triggered_by"),
    error: text("error"),
  },
  (t) => [index("run_ws_started_idx").on(t.workspaceId, t.startedAt)],
);

export const runStep = pgTable(
  "run_step",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    workspaceId: wsId(),
    position: integer("position").notNull(),
    step: text("step").$type<RunStepName>().notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed" | "skipped">().notNull().default("running"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    output: jsonb("output").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
  },
  (t) => [index("run_step_run_idx").on(t.runId)],
);

/** Every Serverless Inference call: what for, which model, tokens, cost, time. Feeds the run timeline and the benchmark. */
export const modelCall = pgTable(
  "model_call",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    runStepId: uuid("run_step_id"),
    documentId: uuid("document_id"),
    purpose: text("purpose").$type<"classify" | "extract" | "reread" | "draft" | "intent" | "assistant" | "benchmark">().notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    ok: boolean("ok").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("model_call_run_idx").on(t.runId)],
);

/** Append-only: the app never updates or deletes these rows. */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: wsId(),
    actorType: text("actor_type").$type<"user" | "agent" | "system">().notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id"),
    at: ts("at").notNull().defaultNow(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("audit_ws_at_idx").on(t.workspaceId, t.at)],
);

// ---------------------------------------------------------------------------
// Collections, disputes, controls (added 2026-10-29)
// ---------------------------------------------------------------------------

export const promiseToPay = pgTable("promise_to_pay", {
  id: id(),
  workspaceId: wsId(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoice.id, { onDelete: "cascade" }),
  promisedOn: day("promised_on").notNull(),
  amount: money("amount"),
  messageId: uuid("message_id"),
  status: text("status").$type<"open" | "kept" | "broken">().notNull().default("open"),
  createdAt: createdAt(),
});

export const dispute = pgTable("dispute", {
  id: id(),
  workspaceId: wsId(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoice.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  status: text("status").$type<"open" | "settled" | "credited">().notNull().default("open"),
  creditNoteId: uuid("credit_note_id"),
  createdAt: createdAt(),
});

/** Two-person rule for bank details in offices (W18). */
export const changeRequest = pgTable("change_request", {
  id: id(),
  workspaceId: wsId(),
  objectType: text("object_type").$type<"receiving_account" | "workspace_identity">().notNull(),
  objectId: text("object_id"),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
  requestedBy: text("requested_by").notNull(),
  approvals: jsonb("approvals").$type<Array<{ userId: string; at: string }>>().notNull().default([]),
  status: text("status").$type<"pending" | "applied" | "rejected">().notNull().default("pending"),
  createdAt: createdAt(),
});

/**
 * The demo's simulated mailbox and upload folder. Items become visible to the pull step
 * once the workspace clock passes `deliver_at`, so "next week" in the demo is just the
 * clock moving on. Production workspaces read a real mailbox instead (mailbox_connection).
 */
export const demoInboxItem = pgTable(
  "demo_inbox_item",
  {
    id: id(),
    workspaceId: wsId(),
    deliverAt: ts("deliver_at").notNull(),
    channel: text("channel").$type<"email" | "upload" | "paste">().notNull(),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    subject: text("subject"),
    bodyText: text("body_text"),
    /** Files already in storage: { name, mimeType, storagePath, sha256, sizeBytes, kind? }. */
    attachments: jsonb("attachments")
      .$type<Array<{ name: string; mimeType: string; storagePath: string; sha256: string; sizeBytes: number; kind?: DocumentKind }>>()
      .notNull()
      .default([]),
    /** Kind hint for an upload or paste (what the person chose in the upload dialog). */
    kindHint: text("kind_hint").$type<DocumentKind>(),
    /** A reply that only comes if we sent a draft from this template first (e.g. the bank's correction after T6). */
    requiresSentTemplate: text("requires_sent_template").$type<TemplateKey>(),
    pulledAt: ts("pulled_at"),
    pulledByRunId: uuid("pulled_by_run_id"),
  },
  (t) => [index("demo_inbox_ws_deliver_idx").on(t.workspaceId, t.deliverAt)],
);

export const mailboxConnection = pgTable("mailbox_connection", {
  id: id(),
  workspaceId: wsId(),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull().default(993),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull().default(587),
  username: text("username").notNull(),
  /** Encrypted at rest by the app; never sent to the browser. */
  secretEncrypted: text("secret_encrypted").notNull(),
  lastSeenUid: text("last_seen_uid"),
  status: text("status").$type<"ok" | "error" | "paused">().notNull().default("ok"),
  lastError: text("last_error"),
  lastPolledAt: ts("last_polled_at"),
  createdAt: createdAt(),
});

export const notification = pgTable("notification", {
  id: id(),
  workspaceId: wsId(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  readAt: ts("read_at"),
  createdAt: createdAt(),
});

export const consent = pgTable("consent", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"terms" | "ai_processing" | "pilot">().notNull(),
  version: text("version").notNull(),
  acceptedAt: ts("accepted_at").notNull().defaultNow(),
});

export const importJob = pgTable("import_job", {
  id: id(),
  workspaceId: wsId(),
  kind: text("kind").$type<"clients" | "invoices" | "opening_balances" | "timesheet" | "marketplace">().notNull(),
  documentId: uuid("document_id"),
  status: text("status").$type<"pending" | "validated" | "applied" | "failed">().notNull().default("pending"),
  rowErrors: jsonb("row_errors").$type<Array<{ row: number; error: string }>>().notNull().default([]),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

export const exportJob = pgTable("export_job", {
  id: id(),
  workspaceId: wsId(),
  kind: text("kind").$type<"tax_pack" | "journal_csv" | "full_export">().notNull(),
  period: text("period"),
  status: text("status").$type<"pending" | "running" | "done" | "failed">().notNull().default("pending"),
  documentId: uuid("document_id"),
  requestedBy: text("requested_by"),
  createdAt: createdAt(),
});

export const closePeriod = pgTable(
  "close_period",
  {
    id: id(),
    workspaceId: wsId(),
    month: text("month").notNull(),
    status: text("status").$type<"open" | "closing" | "closed">().notNull().default("open"),
    checklist: jsonb("checklist").$type<Record<string, unknown>>().notNull().default({}),
    closedBy: text("closed_by"),
    reportDocumentId: uuid("report_document_id"),
    createdAt: createdAt(),
  },
  (t) => [unique("close_period_ws_month").on(t.workspaceId, t.month)],
);
