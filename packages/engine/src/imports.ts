/**
 * Imports from spreadsheets (W4): clients, open invoices and this tax year's earlier proceeds
 * (opening balances), from CSV files laid out like the templates. Every row is checked before
 * anything is written, problems are listed by row and column, and an import is all or nothing.
 * The file is kept as a document, so every imported row can be traced back to it.
 */
import { dateInZone, dec, dueDate, periodLabel, ROUTE_LABELS, routeOptions, taxYearOf, type IsoDate, type RefRate, type Route } from "@ebo/core";
import { client, clientAlias, document, documentKey, importJob, invoice, invoiceLine, openingBalance, receivingAccount, sha256, user, type Db, type ImportSummary, type OpeningChannel, type Storage } from "@ebo/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { audit, loadRefRates, workspaceClock, type Workspace } from "./context";
import { routeAccount } from "./invoicing";
import { parseAmount, parseDate } from "./readers/text";
import { cleanName } from "./uploads";

export type ImportKind = "clients" | "invoices" | "opening_balances";
export const IMPORT_KINDS: ImportKind[] = ["clients", "invoices", "opening_balances"];
export const isImportKind = (k: unknown): k is ImportKind => IMPORT_KINDS.includes(k as ImportKind);

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 2000;

export interface ImportColumn {
  key: string;
  required: boolean;
  /** What to write, in plain words. */
  format: string;
  /** Other headings read as this column. */
  aliases: string[];
}

export interface ImportSpec {
  title: string;
  file: string;
  noun: [string, string];
  about: string;
  columns: ImportColumn[];
  /** Two fictional rows from the demo; the same rows in a file are refused, so they can't slip in. */
  examples: Array<Record<string, string>>;
}

const ROUTE_WORDS = "swift_esfca, swift_pkr, payoneer, wise_pkr or platform";

export const IMPORT_SPECS: Record<ImportKind, ImportSpec> = {
  clients: {
    title: "Clients",
    file: "clients.csv",
    noun: ["client", "clients"],
    about: "Who pays you: one row per client, with how banks spell their name.",
    columns: [
      { key: "name", required: true, format: "Text; unique in the workspace", aliases: ["client", "client name", "customer", "customer name", "company", "company name"] },
      { key: "country", required: true, format: "Two-letter code (US, GB) or the country's name", aliases: ["country code"] },
      { key: "kind", required: true, format: "business or individual", aliases: ["type", "client type"] },
      { key: "default_currency", required: true, format: "Three-letter code: USD, GBP, EUR", aliases: ["currency", "ccy", "billing currency"] },
      { key: "payment_terms_days", required: false, format: "Whole days; 30 if empty", aliases: ["terms", "payment terms", "terms days", "net days", "credit days"] },
      { key: "preferred_route", required: false, format: ROUTE_WORDS, aliases: ["route", "payment route", "usual route", "payment method"] },
      { key: "contact_name", required: false, format: "Text", aliases: ["contact", "contact person"] },
      { key: "contact_emails", required: false, format: "Emails, separated by ; (where reminders go)", aliases: ["email", "emails", "contact email", "contact emails", "e mail"] },
      { key: "phone", required: false, format: "Text; kept in the notes, for calling back about bank changes", aliases: ["telephone", "phone number", "tel", "mobile"] },
      { key: "aliases", required: false, format: "Names separated by ;, as banks spell the payer", aliases: ["payer names", "payer name", "also paid as", "bank names"] },
      { key: "notes", required: false, format: "Text", aliases: ["note", "comments", "remarks"] },
    ],
    examples: [
      { name: "Harbor & Pine LLC", country: "US", kind: "business", default_currency: "USD", payment_terms_days: "15", preferred_route: "payoneer", contact_name: "Dana Whitfield", contact_emails: "accounts@harborandpine.example", phone: "", aliases: "HARBOR AND PINE LLC; HARBOR & PINE", notes: "SIMULATED example row: replace with your own" },
      { name: "Thames Ledger Ltd", country: "GB", kind: "business", default_currency: "GBP", payment_terms_days: "30", preferred_route: "swift_esfca", contact_name: "Oliver Grant", contact_emails: "ap@thamesledger.example; oliver@thamesledger.example", phone: "+44 20 7946 0000", aliases: "THAMES LEDGER LIMITED", notes: "SIMULATED example row: replace with your own" },
    ],
  },
  invoices: {
    title: "Open invoices",
    file: "open-invoices.csv",
    noun: ["invoice", "invoices"],
    about: "Invoices sent but not yet fully paid, so the agent can match payments and chase what's owed. Import the clients first.",
    columns: [
      { key: "number", required: true, format: "Text; unique in the workspace", aliases: ["invoice", "invoice number", "invoice no", "inv no", "inv #", "invoice #", "inv", "no"] },
      { key: "client_name", required: true, format: "A client already in the workspace", aliases: ["client", "customer", "company", "customer name", "bill to"] },
      { key: "issued_on", required: true, format: "Date: 2026-10-01 or 01/10/2026 (day first)", aliases: ["date", "invoice date", "issue date", "issued", "issued date"] },
      { key: "due_on", required: false, format: "Date; the issue date plus the client's terms if empty", aliases: ["due", "due date", "payment due"] },
      { key: "currency", required: true, format: "Three-letter code: USD, GBP, EUR", aliases: ["ccy"] },
      { key: "amount", required: true, format: "The invoice total, like 3800.00 (commas are fine)", aliases: ["total", "invoice total", "invoice amount", "value"] },
      { key: "amount_paid", required: false, format: "Already received; what's owed is the rest", aliases: ["paid", "received", "amount received", "paid so far"] },
      { key: "route", required: false, format: `${ROUTE_WORDS}; the client's usual route if empty`, aliases: ["payment route", "payment method"] },
      { key: "description", required: false, format: "Text; becomes the invoice's one line", aliases: ["details", "item", "service", "line", "work"] },
    ],
    examples: [
      { number: "INV-2026-031", client_name: "Harbor & Pine LLC", issued_on: "2026-10-01", due_on: "2026-10-16", currency: "USD", amount: "3800.00", amount_paid: "", route: "payoneer", description: "SIMULATED example row: Flutter app development, September" },
      { number: "INV-2026-032", client_name: "Thames Ledger Ltd", issued_on: "05/10/2026", due_on: "", currency: "GBP", amount: "2,450.00", amount_paid: "1000.00", route: "", description: "SIMULATED example row: Bookkeeping integration, phase 2" },
    ],
  },
  opening_balances: {
    title: "Opening balances",
    file: "opening-balances.csv",
    noun: ["opening balance", "opening balances"],
    about: "Export proceeds from earlier in this tax year, before your records here begin, so the 80% banking-channel share and the PSEB estimate cover the whole year. One row per month, channel and currency. Importing again replaces them.",
    columns: [
      { key: "month", required: true, format: "2026-08: a month of this tax year, before your records here begin", aliases: ["period"] },
      { key: "channel", required: true, format: "bank, payoneer_withdrawn, payoneer_held, platform or other", aliases: ["received via", "via", "how received"] },
      { key: "currency", required: true, format: "Three-letter code: USD, GBP, PKR", aliases: ["ccy"] },
      { key: "amount", required: true, format: "Amount in that currency", aliases: ["total", "value"] },
      { key: "pkr_amount", required: false, format: "PKR as the bank credited it; worked out at the reference rate if empty", aliases: ["pkr", "amount pkr", "pkr credited", "amount in pkr"] },
      { key: "eprc_on_file", required: false, format: "yes or no (kept for the summary only)", aliases: ["eprc", "prc", "eprc received"] },
    ],
    examples: [
      { month: "2026-07", channel: "bank", currency: "USD", amount: "6400.00", pkr_amount: "1784320.00", eprc_on_file: "yes" },
      { month: "2026-08", channel: "payoneer_held", currency: "USD", amount: "1250.00", pkr_amount: "", eprc_on_file: "" },
    ],
  },
};

/** The template: headings and the two example rows (UTF-8 with a byte-order mark, so Excel reads it right). */
export function importTemplate(kind: ImportKind): string {
  const spec = IMPORT_SPECS[kind];
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [spec.columns.map((c) => c.key), ...spec.examples.map((e) => spec.columns.map((c) => e[c.key] ?? ""))];
  return `﻿${lines.map((l) => l.map(cell).join(",")).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

export interface RowError {
  /** The spreadsheet row: 1 is the heading row. */
  row: number;
  column?: string;
  error: string;
}

/** RFC 4180 records, each with its spreadsheet row number; blank rows are skipped but still counted. */
export function numberedCsvRows(text: string): Array<{ row: number; cells: string[] }> {
  const out: Array<{ row: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let row = 1;
  const end = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) out.push({ row, cells });
    cells = [];
    cell = "";
    row++;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      end();
    } else cell += c;
  }
  if (cell !== "" || cells.length) end();
  return out;
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .trim();

export interface ParsedFile {
  rows: Array<{ row: number; get: (key: string) => string }>;
  /** Each heading in the file and the column it was read as. */
  columns: Array<[string, string]>;
  ignored: string[];
  problems: RowError[];
  /** The headings can't be read, or there are no rows or too many: the rows aren't checked. */
  fatal: boolean;
  /** From a heading like "Amount (USD)" when the file has no currency column. */
  currency: string | null;
}

/** Reads the headings (template names or the usual alternatives) and the rows under them. */
export function parseImportFile(kind: ImportKind, text: string): ParsedFile {
  const spec = IMPORT_SPECS[kind];
  const records = numberedCsvRows(text.replace(/^﻿/, ""));
  const problems: RowError[] = [];
  const empty: ParsedFile = { rows: [], columns: [], ignored: [], problems, fatal: true, currency: null };
  const head = records[0];
  if (!head) {
    problems.push({ row: 1, error: "The file is empty. Start from the template: the first row holds the column names." });
    return empty;
  }
  const byName = new Map<string, string>();
  for (const c of spec.columns) for (const n of [c.key, c.key.replace(/_/g, " "), ...c.aliases]) byName.set(norm(n), c.key);
  const at = new Map<string, number>();
  const columns: Array<[string, string]> = [];
  const ignored: string[] = [];
  let currency: string | null = null;
  head.cells.forEach((raw, i) => {
    const heading = raw.trim();
    if (!heading) return;
    let key = byName.get(norm(heading));
    const withCcy = /^(amount|total|invoice total|invoice amount)\s*[([]\s*([A-Za-z]{3})\s*[)\]]$/i.exec(heading);
    if (!key && withCcy && kind !== "clients") {
      key = "amount";
      currency = withCcy[2]!.toUpperCase();
    }
    if (!key) return void ignored.push(heading);
    if (at.has(key)) return void problems.push({ row: head.row, column: heading, error: `Two columns are both read as ${key}: "${columns.find(([, k]) => k === key)?.[0]}" and "${heading}". Keep one.` });
    at.set(key, i);
    columns.push([heading, key]);
  });
  for (const c of spec.columns) {
    if (!c.required || at.has(c.key) || (c.key === "currency" && currency)) continue;
    problems.push({ row: head.row, column: c.key, error: `There's no ${c.key} column. Name the column ${c.key}, as in the template.` });
  }
  const rows = records.slice(1).map((r) => ({ row: r.row, get: (key: string) => (at.has(key) ? (r.cells[at.get(key)!] ?? "").trim() : "") }));
  if (!rows.length && !problems.length) problems.push({ row: head.row + 1, error: "There are no rows under the headings." });
  if (rows.length > IMPORT_MAX_ROWS) problems.push({ row: rows[IMPORT_MAX_ROWS]!.row, error: `The file has ${rows.length} rows; ${IMPORT_MAX_ROWS} at most. Split it into smaller files.` });
  const fatal = problems.length > 0;
  // The template's example rows, left in by mistake.
  if (!fatal)
    for (const r of rows) {
      const isExample = spec.examples.some((e) => spec.columns.every((c) => !at.has(c.key) || norm(r.get(c.key)) === norm(e[c.key] ?? "")));
      if (isExample) problems.push({ row: r.row, error: "This is one of the template's example rows. Delete it." });
    }
  return { rows, columns, ignored, problems, fatal, currency };
}

// ---------------------------------------------------------------------------
// Checking the rows
// ---------------------------------------------------------------------------

const ROUTES: Route[] = ["swift_esfca", "swift_pkr", "payoneer", "wise_pkr", "platform", "other"];
const routeOf = (s: string): Route | null | undefined => {
  if (!s) return null;
  const n = norm(s).replace(/ /g, "_");
  if (n === "wise") return "wise_pkr";
  return ROUTES.find((r) => r === n) ?? (Object.entries(ROUTE_LABELS).find(([, label]) => norm(label) === norm(s))?.[0] as Route | undefined);
};

const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i;
let currencies: Set<string> | null = null;
const knownCurrency = (c: string) => (currencies ??= new Set(Intl.supportedValuesOf("currency"))).has(c);

let countries: Map<string, string> | null = null;
/** "US", "United States", "USA", "Türkiye", "UK" -> the two-letter code. */
export function countryCode(s: string): string | null {
  if (!countries) {
    countries = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    const notCountries = new Set(["EU", "EZ", "UN", "QO", "ZZ", "XA", "XB"]);
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const name = names.of(code);
        if (!name || name === code || notCountries.has(code)) continue;
        countries.set(norm(code), code);
        countries.set(norm(name), code);
      }
    const extra: Record<string, string> = { usa: "US", "united states of america": "US", america: "US", uk: "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB", uae: "AE", emirates: "AE", holland: "NL", "the netherlands": "NL", korea: "KR", turkey: "TR", "czech republic": "CZ", ksa: "SA", russia: "RU" };
    for (const [k, v] of Object.entries(extra)) countries.set(norm(k), v);
  }
  return countries.get(norm(s)) ?? null;
}

/** "2026-08", "08/2026", "Aug 2026", "August 2026" -> "2026-08". */
function monthOf(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(t);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]!.padStart(2, "0")}` : null;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${m[1]!.padStart(2, "0")}` : null;
  m = /^([A-Za-z]{3})[a-z]*\.?[\s-]+(\d{4})$/.exec(t);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  if (m && months.includes(m[1]!.toLowerCase())) return `${m[2]}-${String(months.indexOf(m[1]!.toLowerCase()) + 1).padStart(2, "0")}`;
  return null;
}

/** A positive amount with at most two decimals, as fixed text; commas and spaces allowed. */
function money(s: string): string | null {
  const a = parseAmount(s);
  if (!a || !/^\d+(\.\d{1,2})?$/.test(a)) return null;
  return dec(a).toFixed(2);
}

export interface ClientPlan {
  row: number;
  values: { name: string; kind: "business" | "individual" | "marketplace"; country: string; defaultCurrency: string; paymentTermsDays: number; preferredRoute: Route | null; contactName: string | null; contactEmails: string[]; notes: string | null };
  aliases: string[];
}
export interface InvoicePlan {
  row: number;
  number: string;
  clientId: string;
  clientName: string;
  issuedOn: IsoDate;
  dueOn: IsoDate;
  currency: string;
  amount: string;
  paid: string;
  route: Route;
  receivingAccountId: string | null;
  description: string | null;
}
export interface OpeningPlan {
  row: number;
  month: string;
  channel: OpeningChannel;
  currency: string;
  amount: string;
  pkrAmount: string | null;
  eprcOnFile: boolean | null;
}
export type ImportPlan = { kind: "clients"; rows: ClientPlan[] } | { kind: "invoices"; rows: InvoicePlan[] } | { kind: "opening_balances"; rows: OpeningPlan[]; replaces: number };

type Reader = Pick<Db, "select">;
interface CheckContext {
  db: Reader;
  ws: Workspace;
  today: IsoDate;
  refRate: RefRate;
}

/** Every problem in the rows, or what importing them would write. */
export async function checkImport(c: CheckContext, kind: ImportKind, file: ParsedFile): Promise<{ errors: RowError[]; plan: ImportPlan | null }> {
  const errors = [...file.problems];
  if (file.fatal) return { errors, plan: null };
  const result = kind === "clients" ? await checkClients(c, file, errors) : kind === "invoices" ? await checkInvoices(c, file, errors) : await checkOpenings(c, file, errors);
  return errors.length ? { errors: errors.sort((a, b) => a.row - b.row), plan: null } : { errors, plan: result };
}

async function checkClients({ db, ws }: CheckContext, file: ParsedFile, errors: RowError[]): Promise<ImportPlan> {
  const existing = new Set((await db.select({ name: client.name }).from(client).where(eq(client.workspaceId, ws.id))).map((r) => norm(r.name)));
  const seen = new Map<string, number>();
  const rows: ClientPlan[] = [];
  for (const r of file.rows) {
    const bad = (column: string, error: string) => errors.push({ row: r.row, column, error });
    const name = r.get("name").replace(/\s+/g, " ");
    if (!name) bad("name", "The client needs a name.");
    else if (name.length > 120) bad("name", "The name is too long (120 characters at most).");
    else if (existing.has(norm(name))) bad("name", `There's already a client called "${name}".`);
    else if (seen.has(norm(name))) bad("name", `Row ${seen.get(norm(name))} has the same name.`);
    else seen.set(norm(name), r.row);
    const country = countryCode(r.get("country"));
    if (!r.get("country")) bad("country", "Add the client's country, like US or GB.");
    else if (!country) bad("country", `"${r.get("country")}" isn't a country we know. Use the two-letter code, like US or GB.`);
    const kindWord = norm(r.get("kind"));
    const kind = ({ business: "business", company: "business", individual: "individual", person: "individual", marketplace: "marketplace" } as const)[kindWord as "business"];
    if (!kind) bad("kind", r.get("kind") ? `"${r.get("kind")}" should be business or individual.` : "Say whether the client is a business or an individual.");
    const currency = r.get("default_currency").toUpperCase();
    if (!currency) bad("default_currency", "Add the currency you bill in, like USD.");
    else if (!/^[A-Z]{3}$/.test(currency) || !knownCurrency(currency)) bad("default_currency", `"${r.get("default_currency")}" isn't a currency code. Use three letters, like USD.`);
    const termsText = r.get("payment_terms_days").replace(/\s*days?$/i, "");
    const terms = termsText ? Number(termsText) : 30;
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) bad("payment_terms_days", `"${r.get("payment_terms_days")}" should be a whole number of days from 0 to 365.`);
    const route = routeOf(r.get("preferred_route"));
    if (route === undefined) bad("preferred_route", `"${r.get("preferred_route")}" isn't a route. Use ${ROUTE_WORDS}.`);
    const emails = [
      ...new Set(
        r
          .get("contact_emails")
          .split(/[\s,;]+/)
          .filter(Boolean)
          .map((e) => e.toLowerCase()),
      ),
    ];
    const badEmails = emails.filter((e) => !EMAIL_RE.test(e));
    if (badEmails.length) bad("contact_emails", `Not an email address: ${badEmails.join(", ")}.`);
    const aliases = [
      ...new Set(
        r
          .get("aliases")
          .split(";")
          .map((a) => a.trim().replace(/\s+/g, " "))
          .filter(Boolean),
      ),
    ];
    if (aliases.length > 20) bad("aliases", "Up to 20 payer names per client.");
    if (aliases.some((a) => a.length > 120)) bad("aliases", "A payer name is too long (120 characters at most).");
    const contactName = r.get("contact_name");
    if (contactName.length > 120) bad("contact_name", "The contact name is too long (120 characters at most).");
    const notes = [r.get("notes"), r.get("phone") ? `Phone: ${r.get("phone")}` : ""].filter(Boolean).join("\n");
    if (notes.length > 2000) bad("notes", "The notes are too long (2,000 characters at most).");
    if (name && country && kind && currency && route !== undefined)
      rows.push({ row: r.row, values: { name, kind, country, defaultCurrency: currency, paymentTermsDays: terms, preferredRoute: route ?? null, contactName: contactName || null, contactEmails: emails, notes: notes || null }, aliases });
  }
  return { kind: "clients", rows };
}

async function checkInvoices({ db, ws, today }: CheckContext, file: ParsedFile, errors: RowError[]): Promise<ImportPlan> {
  const clients = await db.select().from(client).where(eq(client.workspaceId, ws.id));
  const byName = new Map(clients.map((c) => [norm(c.name), c]));
  const taken = new Set((await db.select({ number: invoice.number }).from(invoice).where(eq(invoice.workspaceId, ws.id))).map((r) => r.number.toLowerCase()));
  const accounts = (await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, ws.id))).map(routeAccount);
  const seen = new Map<string, number>();
  const rows: InvoicePlan[] = [];
  for (const r of file.rows) {
    const bad = (column: string, error: string) => errors.push({ row: r.row, column, error });
    const number = r.get("number");
    if (!number) bad("number", "The invoice needs its number.");
    else if (number.length > 40) bad("number", "The number is too long (40 characters at most).");
    else if (taken.has(number.toLowerCase())) bad("number", `Invoice ${number} is already in the workspace.`);
    else if (seen.has(number.toLowerCase())) bad("number", `Row ${seen.get(number.toLowerCase())} has the same number.`);
    else seen.set(number.toLowerCase(), r.row);
    const c = byName.get(norm(r.get("client_name")));
    if (!r.get("client_name")) bad("client_name", "Say which client the invoice is for.");
    else if (!c) bad("client_name", `There's no client called "${r.get("client_name")}". Import the clients first, or add them on Clients.`);
    const issuedOn = parseDate(r.get("issued_on"));
    if (!issuedOn) bad("issued_on", r.get("issued_on") ? `"${r.get("issued_on")}" isn't a date. Write 2026-10-01 or 01/10/2026 (day first).` : "Add the date the invoice was issued.");
    else if (issuedOn > today) bad("issued_on", "The issue date is after today.");
    const dueText = r.get("due_on");
    const due = dueText ? parseDate(dueText) : null;
    if (dueText && !due) bad("due_on", `"${dueText}" isn't a date. Write 2026-10-31 or 31/10/2026 (day first).`);
    else if (due && issuedOn && due < issuedOn) bad("due_on", "The due date is before the issue date.");
    const currency = (r.get("currency") || file.currency || "").toUpperCase();
    if (!currency) bad("currency", "Add the invoice's currency, like USD.");
    else if (!/^[A-Z]{3}$/.test(currency) || !knownCurrency(currency)) bad("currency", `"${r.get("currency")}" isn't a currency code. Use three letters, like USD.`);
    const amount = money(r.get("amount"));
    if (!amount || dec(amount).lte(0)) bad("amount", r.get("amount") ? `"${r.get("amount")}" should be an amount above zero, like 3800.00.` : "Add the invoice total.");
    const paidText = r.get("amount_paid");
    const paid = paidText ? money(paidText) : "0.00";
    if (!paid) bad("amount_paid", `"${paidText}" should be an amount, like 1000.00, or left empty.`);
    else if (amount && dec(paid).gte(amount)) bad("amount_paid", "That's the whole amount: only invoices with money still owed are imported.");
    const named = routeOf(r.get("route"));
    if (named === undefined) bad("route", `"${r.get("route")}" isn't a route. Use ${ROUTE_WORDS}, or leave it empty.`);
    const description = r.get("description");
    if (description.length > 300) bad("description", "The description is too long (300 characters at most).");
    if (!c || !number || !issuedOn || !amount || !paid || named === undefined || !currency) continue;
    // How the client pays: the column, then the client's usual route, then the suggestion for the currency.
    const options = routeOptions({ name: c.name, currency, preferredRoute: c.preferredRoute, lastSwiftFee: null }, accounts);
    const route = named ?? c.preferredRoute ?? options.find((o) => o.suggested)?.route ?? null;
    if (!route) {
      bad("route", `Say how ${c.name} pays (${ROUTE_WORDS}), or add a receiving account that takes ${currency} in Setup first.`);
      continue;
    }
    rows.push({ row: r.row, number, clientId: c.id, clientName: c.name, issuedOn, dueOn: due ?? dueDate(issuedOn, c.paymentTermsDays), currency, amount, paid, route, receivingAccountId: options.find((o) => o.route === route)?.accountId ?? null, description: description || null });
  }
  return { kind: "invoices", rows };
}

const CHANNELS: OpeningChannel[] = ["bank", "payoneer_withdrawn", "payoneer_held", "platform", "other"];

async function checkOpenings({ db, ws, today, refRate }: CheckContext, file: ParsedFile, errors: RowError[]): Promise<ImportPlan> {
  const year = taxYearOf(today, ws.fiscalYearStartMonth);
  const first = year.start.slice(0, 7);
  const last = today.slice(0, 7);
  const seen = new Map<string, number>();
  const rows: OpeningPlan[] = [];
  for (const r of file.rows) {
    const bad = (column: string, error: string) => errors.push({ row: r.row, column, error });
    const parsedMonth = monthOf(r.get("month"));
    const month = parsedMonth && parsedMonth >= first && parsedMonth <= last ? parsedMonth : null;
    if (!parsedMonth) bad("month", r.get("month") ? `"${r.get("month")}" isn't a month. Write it like 2026-08.` : "Add the month, like 2026-08.");
    else if (!month) bad("month", `Only months of this tax year so far: ${periodLabel(first)} to ${periodLabel(last)}.`);
    const channel = CHANNELS.find((ch) => ch === norm(r.get("channel")).replace(/ /g, "_"));
    if (!channel) bad("channel", r.get("channel") ? `"${r.get("channel")}" should be bank, payoneer_withdrawn, payoneer_held, platform or other.` : "Say how the money came in: bank, payoneer_withdrawn, payoneer_held, platform or other.");
    const currency = (r.get("currency") || file.currency || "").toUpperCase();
    if (!currency) bad("currency", "Add the currency, like USD.");
    else if (!/^[A-Z]{3}$/.test(currency) || !knownCurrency(currency)) bad("currency", `"${r.get("currency")}" isn't a currency code. Use three letters, like USD.`);
    const amount = money(r.get("amount"));
    if (!amount || dec(amount).lte(0)) bad("amount", r.get("amount") ? `"${r.get("amount")}" should be an amount above zero.` : "Add the amount.");
    const pkrText = r.get("pkr_amount");
    const pkr = pkrText ? money(pkrText) : null;
    if (pkrText && (!pkr || dec(pkr).lte(0))) bad("pkr_amount", `"${pkrText}" should be an amount in rupees, or left empty.`);
    const eprcWord = norm(r.get("eprc_on_file"));
    const eprc = !eprcWord ? null : ["yes", "y", "true", "1"].includes(eprcWord) ? true : ["no", "n", "false", "0"].includes(eprcWord) ? false : undefined;
    if (eprc === undefined) bad("eprc_on_file", `"${r.get("eprc_on_file")}" should be yes or no, or left empty.`);
    if (month && channel && currency) {
      const key = `${month} ${channel} ${currency}`;
      if (seen.has(key)) bad("month", `Row ${seen.get(key)} has the same month, channel and currency: put them in one row.`);
      else seen.set(key, r.row);
    }
    // The share is worked out in USD at reference rates, so the currency needs one, and so does USD.
    if (month && currency) {
      const mid = `${month}-15` as IsoDate;
      const on = mid < today ? mid : today;
      if (!refRate(currency, on) || !refRate("USD", on)) bad("currency", `There's no reference rate for ${currency} in ${periodLabel(month)}, so it can't be counted.`);
    }
    if (month && channel && currency && amount && eprc !== undefined && (!pkrText || pkr)) rows.push({ row: r.row, month, channel, currency, amount, pkrAmount: currency === "PKR" ? null : pkr, eprcOnFile: eprc });
  }
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(openingBalance)
    .where(eq(openingBalance.workspaceId, ws.id));
  return { kind: "opening_balances", rows, replaces: count?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// Uploading, then applying
// ---------------------------------------------------------------------------

export type StartResult = { ok: true; jobId: string; valid: boolean } | { ok: false; problems: string[] };

async function checkContext(db: Db, ws: Workspace): Promise<CheckContext> {
  return { db, ws, today: dateInZone(workspaceClock(ws), ws.timezone), refRate: await loadRefRates(db) };
}

/** Keeps the file as a document, checks every row and records the result as an import job. */
export async function startImport(db: Db, storage: Storage, ws: Workspace, kind: ImportKind, file: { name: string; bytes: Uint8Array }, userId: string): Promise<StartResult> {
  if (!file.bytes.length) return { ok: false, problems: ["Choose a CSV file to upload."] };
  if (file.bytes.length > IMPORT_MAX_BYTES) return { ok: false, problems: [`The file is over ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it into smaller files.`] };
  const name = cleanName(file.name);
  const starts = (sig: number[]) => sig.every((b, i) => file.bytes[i] === b);
  if (starts([0x50, 0x4b, 0x03, 0x04]) || starts([0xd0, 0xcf, 0x11, 0xe0])) return { ok: false, problems: ["That's an Excel file. In Excel or Google Sheets, save or download it as CSV (comma-separated), then upload that."] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return { ok: false, problems: ["The file isn't UTF-8 text. Save it from the spreadsheet as CSV UTF-8, then upload that."] };
  }
  if (text.includes("\u0000") || /^\s*(%PDF|<!DOCTYPE|<html)/i.test(text)) return { ok: false, problems: ["That isn't a CSV file. Save the spreadsheet as CSV, then upload that."] };

  const parsed = parseImportFile(kind, text);
  const { errors, plan } = await checkImport(await checkContext(db, ws), kind, parsed);

  const hash = sha256(file.bytes);
  const [have] = await db
    .select({ id: document.id })
    .from(document)
    .where(and(eq(document.workspaceId, ws.id), eq(document.sha256, hash)));
  let documentId = have?.id;
  if (!documentId) {
    const key = documentKey(ws.id, hash, "text/csv");
    await storage.put(key, file.bytes, "text/csv");
    const [doc] = await db
      .insert(document)
      .values({ workspaceId: ws.id, kind: "import", storagePath: key, sha256: hash, originalName: name, mimeType: "text/csv", sizeBytes: file.bytes.length, source: "upload", parseStatus: "skipped", receivedAt: workspaceClock(ws) })
      .onConflictDoNothing()
      .returning({ id: document.id });
    documentId = doc?.id ?? (await db.select({ id: document.id }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.sha256, hash))))[0]?.id;
  }
  const summary: ImportSummary = { rows: parsed.rows.length, columns: parsed.columns, ignored: parsed.ignored };
  const [job] = await db
    .insert(importJob)
    .values({ workspaceId: ws.id, kind, documentId, status: plan ? "validated" : "failed", rowErrors: errors.slice(0, 500), summary, createdBy: userId, createdAt: workspaceClock(ws) })
    .returning({ id: importJob.id });
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "import.checked", objectType: "import_job", objectId: job!.id, details: { kind, file: name, rows: parsed.rows.length, problems: errors.length } });
  return { ok: true, jobId: job!.id, valid: !!plan };
}

async function readJobFile(db: Reader, storage: Storage, ws: Workspace, documentId: string | null): Promise<string | null> {
  if (!documentId) return null;
  const [doc] = await db
    .select({ path: document.storagePath })
    .from(document)
    .where(and(eq(document.workspaceId, ws.id), eq(document.id, documentId)));
  if (!doc) return null;
  try {
    return new TextDecoder("utf-8").decode(await storage.get(doc.path));
  } catch {
    return null;
  }
}

export type ApplyResult = { ok: true; kind: ImportKind; created: number; replaced: number } | { ok: false; problems: string[]; errors?: RowError[] };

/**
 * Checks the file again (the workspace may have changed since) and writes every row in one
 * transaction, or nothing. The job row is locked, so the same import can't be applied twice.
 */
export async function applyImport(db: Db, storage: Storage, ws: Workspace, jobId: string, by: { id: string; name: string }): Promise<ApplyResult> {
  const refRate = await loadRefRates(db);
  const today = dateInZone(workspaceClock(ws), ws.timezone);
  const at = workspaceClock(ws);
  try {
    return await db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(importJob)
        .where(and(eq(importJob.workspaceId, ws.id), eq(importJob.id, jobId)))
        .for("update");
      if (!job || !isImportKind(job.kind)) return { ok: false as const, problems: ["That import doesn't exist."] };
      if (job.status === "applied") return { ok: false as const, problems: ["This file has already been imported."] };
      if (job.status !== "validated") return { ok: false as const, problems: ["This file has problems to fix first. Upload it again once they're fixed."] };
      const text = await readJobFile(tx, storage, ws, job.documentId);
      if (text == null) return { ok: false as const, problems: ["The uploaded file is no longer in storage. Upload it again."] };
      const kind = job.kind;
      const { errors, plan } = await checkImport({ db: tx, ws, today, refRate }, kind, parseImportFile(kind, text));
      if (!plan) {
        await tx.update(importJob).set({ status: "failed", rowErrors: errors.slice(0, 500) }).where(eq(importJob.id, job.id));
        return { ok: false as const, problems: ["Something in the workspace changed since the file was checked, and some rows no longer fit. Nothing was imported."], errors };
      }
      let created = 0;
      let replaced = 0;
      if (plan.kind === "clients") {
        for (const p of plan.rows) {
          const [row] = await tx
            .insert(client)
            .values({ workspaceId: ws.id, ...p.values })
            .returning({ id: client.id });
          if (p.aliases.length) await tx.insert(clientAlias).values(p.aliases.map((alias) => ({ workspaceId: ws.id, clientId: row!.id, alias, source: "manual" as const })));
          created++;
        }
      } else if (plan.kind === "invoices") {
        for (const p of plan.rows) {
          const [row] = await tx
            .insert(invoice)
            .values({ workspaceId: ws.id, number: p.number, clientId: p.clientId, currency: p.currency, amount: p.amount, paidBeforeImport: p.paid, issuedOn: p.issuedOn, dueOn: p.dueOn, route: p.route, receivingAccountId: p.receivingAccountId, status: dec(p.paid).gt(0) ? "part_paid" : "sent", importJobId: job.id })
            .returning({ id: invoice.id });
          if (p.description) await tx.insert(invoiceLine).values({ workspaceId: ws.id, invoiceId: row!.id, position: 0, description: p.description, quantity: "1", unitPrice: p.amount, amount: p.amount });
          created++;
        }
      } else {
        replaced = (await tx.delete(openingBalance).where(eq(openingBalance.workspaceId, ws.id)).returning({ id: openingBalance.id })).length;
        await tx.insert(openingBalance).values(plan.rows.map((p) => ({ workspaceId: ws.id, month: p.month, channel: p.channel, currency: p.currency, amount: p.amount, pkrAmount: p.pkrAmount, eprcOnFile: p.eprcOnFile, importJobId: job.id })));
        created = plan.rows.length;
      }
      const result = { created, ...(plan.kind === "opening_balances" ? { replaced } : {}) };
      await tx
        .update(importJob)
        .set({ status: "applied", rowErrors: [], summary: { ...job.summary, appliedAt: at.toISOString(), appliedBy: by.id, result } })
        .where(eq(importJob.id, job.id));
      await audit(tx, { workspaceId: ws.id, actorType: "user", actorId: by.id, action: "import.applied", objectType: "import_job", objectId: job.id, details: { kind, ...result } });
      return { ok: true as const, kind, created, replaced };
    });
  } catch (err) {
    if (/duplicate key|unique/i.test(String((err as { cause?: unknown }).cause ?? err))) return { ok: false, problems: ["Someone added one of these records a moment ago. Nothing was imported; check the file again."] };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// What the pages show
// ---------------------------------------------------------------------------

export interface ImportListItem {
  id: string;
  kind: ImportKind;
  status: string;
  file: string | null;
  rows: number;
  problems: number;
  createdAt: Date;
  by: string | null;
}

export async function recentImports(db: Db, workspaceId: string, limit = 10): Promise<ImportListItem[]> {
  const rows = await db
    .select({ job: importJob, file: document.originalName, by: user.name, anon: user.isAnonymous })
    .from(importJob)
    .leftJoin(document, eq(document.id, importJob.documentId))
    .leftJoin(user, eq(user.id, importJob.createdBy))
    .where(eq(importJob.workspaceId, workspaceId))
    .orderBy(desc(importJob.createdAt))
    .limit(limit);
  return rows.filter((r) => isImportKind(r.job.kind)).map((r) => ({ id: r.job.id, kind: r.job.kind as ImportKind, status: r.job.status, file: r.file, rows: r.job.summary.rows ?? 0, problems: r.job.rowErrors.length, createdAt: r.job.createdAt, by: r.anon ? "Visitor" : r.by }));
}

export interface ImportView {
  id: string;
  kind: ImportKind;
  status: "validated" | "applied" | "failed" | "pending";
  file: string | null;
  createdAt: Date;
  by: string | null;
  summary: ImportSummary;
  appliedBy: string | null;
  /** Problems: as stored for a failed job, or found again now for one waiting to be applied. */
  errors: RowError[];
  plan: ImportPlan | null;
}

/** One import for its page. A file waiting to be applied is checked again, against the workspace as it is now. */
export async function importView(db: Db, storage: Storage, ws: Workspace, jobId: string): Promise<ImportView | null> {
  const [row] = await db
    .select({ job: importJob, file: document.originalName, by: user.name, anon: user.isAnonymous })
    .from(importJob)
    .leftJoin(document, eq(document.id, importJob.documentId))
    .leftJoin(user, eq(user.id, importJob.createdBy))
    .where(and(eq(importJob.workspaceId, ws.id), eq(importJob.id, jobId)));
  const kind = row?.job.kind;
  if (!row || !isImportKind(kind)) return null;
  const { job } = row;
  let errors: RowError[] = job.rowErrors;
  let plan: ImportPlan | null = null;
  if (job.status === "validated") {
    const text = await readJobFile(db, storage, ws, job.documentId);
    if (text == null) errors = [{ row: 1, error: "The uploaded file is no longer in storage. Upload it again." }];
    else ({ errors, plan } = await checkImport(await checkContext(db, ws), kind, parseImportFile(kind, text)));
  }
  const appliedBy = job.summary.appliedBy ? ((await db.select({ name: user.name, anon: user.isAnonymous }).from(user).where(eq(user.id, job.summary.appliedBy)))[0] ?? null) : null;
  return {
    id: job.id,
    kind,
    status: job.status,
    file: row.file,
    createdAt: job.createdAt,
    by: row.anon ? "Visitor" : row.by,
    summary: job.summary,
    appliedBy: appliedBy ? (appliedBy.anon ? "Visitor" : appliedBy.name) : null,
    errors,
    plan,
  };
}

