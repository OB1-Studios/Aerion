import { ACCOUNT_KIND_LABELS, compactIban, formatIban, ibanProblem, isIsoDate, swiftProblem, type AccountKind, type Route } from "@ebo/core";
import { client, clientAlias, member, receivingAccount, workspace, type Db, type WorkspaceKind } from "@ebo/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { audit, type Workspace } from "./context";

/**
 * Setting up a workspace (main doc W1, W3): the business's details, its receiving accounts,
 * invoice settings and clients. Every check says what's wrong in plain words.
 */

export type Saved = { ok: true; id: string } | { ok: false; problems: string[] };

const ROUTES: Route[] = ["swift_esfca", "swift_pkr", "payoneer", "wise_pkr", "platform", "other"];
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$/i;
const CCY_RE = /^[A-Z]{3}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "workspace";

export interface NewWorkspaceInput {
  kind: string;
  name: string;
  legalName: string;
  city: string;
  /** Whether the owner agreed to documents being read by a model (off: layout rules only). */
  aiReading?: boolean;
}

/** A new, empty workspace owned by this person. Real data from here on: no demo clock. */
export async function createWorkspace(db: Db, input: NewWorkspaceInput, user: { id: string; name: string }): Promise<{ ok: true; id: string; slug: string } | { ok: false; problems: string[] }> {
  const problems: string[] = [];
  const kind = input.kind === "company" || input.kind === "freelancer" ? (input.kind as WorkspaceKind) : null;
  if (!kind) problems.push("Choose a software house or a freelancer.");
  const name = str(input.name);
  if (!name) problems.push("Give the workspace a name.");
  if (name.length > 80) problems.push("The name is too long (80 characters at most).");
  if (str(input.legalName).length > 160) problems.push("The legal name is too long.");
  if (problems.length || !kind) return { ok: false, problems };
  const base = slugify(name);
  const taken = new Set((await db.select({ slug: workspace.slug }).from(workspace)).map((w) => w.slug).filter((s) => s === base || s.startsWith(`${base}-`)));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
  const id = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(workspace)
      .values({
        slug,
        name,
        kind,
        legalName: str(input.legalName) || name,
        city: str(input.city) || null,
        invoicePrefix: kind === "freelancer" && initials.length >= 2 ? initials : "INV",
        aiReadingEnabled: input.aiReading ?? true,
        settings: { senderName: user.name, senderTitle: kind === "company" ? "Finance" : "Freelance developer" },
      })
      .returning({ id: workspace.id });
    await tx.insert(member).values({ workspaceId: w!.id, userId: user.id, role: "owner" });
    return w!.id;
  });
  await audit(db, { workspaceId: id, actorType: "user", actorId: user.id, action: "workspace.created", objectType: "workspace", objectId: id, details: { name, kind } });
  return { ok: true, id, slug };
}

export interface BusinessInput {
  name: string;
  legalName: string;
  city: string;
  ntn: string;
  secpRegNo: string;
  psebRegNo: string;
  psebValidUntil: string;
  atlStatus: string;
  atlCheckedOn: string;
  senderName: string;
  senderTitle: string;
  phone: string;
  mailboxAddress: string;
}

/** The business's identity: what goes on invoices and decides which reminders it gets. */
export async function saveBusinessDetails(db: Db, ws: Workspace, input: BusinessInput, userId: string): Promise<Saved> {
  const problems: string[] = [];
  const v = Object.fromEntries(Object.entries(input).map(([k, x]) => [k, str(x)])) as unknown as BusinessInput;
  if (!v.name) problems.push("The workspace needs a name.");
  if (!v.legalName) problems.push("The legal name goes on every invoice, so it can't be empty.");
  if (v.psebValidUntil && !isIsoDate(v.psebValidUntil)) problems.push("The PSEB expiry isn't a date.");
  if (v.psebValidUntil && !v.psebRegNo) problems.push("Add the PSEB registration number, or clear its expiry date.");
  if (!["active", "inactive", "unknown"].includes(v.atlStatus)) problems.push("Choose the ATL status.");
  if (v.atlCheckedOn && !isIsoDate(v.atlCheckedOn)) problems.push("The ATL check date isn't a date.");
  if (v.mailboxAddress && !EMAIL_RE.test(v.mailboxAddress)) problems.push("The email address doesn't look right.");
  if (problems.length) return { ok: false, problems };
  await db
    .update(workspace)
    .set({
      name: v.name,
      legalName: v.legalName,
      city: v.city || null,
      ntn: v.ntn || null,
      secpRegNo: v.secpRegNo || null,
      psebRegNo: v.psebRegNo || null,
      psebValidUntil: v.psebValidUntil || null,
      atlStatus: v.atlStatus as "active" | "inactive" | "unknown",
      atlCheckedOn: v.atlCheckedOn || null,
      emailDomain: v.mailboxAddress ? v.mailboxAddress.split("@")[1]!.toLowerCase() : ws.emailDomain,
      settings: { ...ws.settings, senderName: v.senderName || undefined, senderTitle: v.senderTitle || undefined, phone: v.phone || undefined, mailboxAddress: v.mailboxAddress || undefined },
    })
    .where(eq(workspace.id, ws.id));
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "workspace.details_updated", objectType: "workspace", objectId: ws.id, details: { legalName: v.legalName, ntn: v.ntn || null, psebRegNo: v.psebRegNo || null, atlStatus: v.atlStatus } });
  return { ok: true, id: ws.id };
}

export interface InvoiceSettingsInput {
  prefix: string;
  nextNumber: string;
  purposeWording: string;
}

export async function saveInvoiceSettings(db: Db, ws: Workspace, input: InvoiceSettingsInput, userId: string): Promise<Saved> {
  const problems: string[] = [];
  const prefix = str(input.prefix).toUpperCase();
  const next = Number(str(input.nextNumber));
  if (!/^[A-Z0-9]{1,10}$/.test(prefix)) problems.push("The prefix should be 1 to 10 letters or digits, like INV.");
  if (!Number.isInteger(next) || next < 1 || next > 99999) problems.push("The next number should be a whole number from 1 to 99999.");
  if (str(input.purposeWording).length > 200) problems.push("The purpose wording is too long (200 characters at most).");
  if (problems.length) return { ok: false, problems };
  await db
    .update(workspace)
    .set({ invoicePrefix: prefix, nextInvoiceSeq: next, settings: { ...ws.settings, purposeWording: str(input.purposeWording) || undefined } })
    .where(eq(workspace.id, ws.id));
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "workspace.invoice_settings_updated", objectType: "workspace", objectId: ws.id, details: { prefix, next } });
  return { ok: true, id: ws.id };
}

// ---------------------------------------------------------------------------
// Receiving accounts
// ---------------------------------------------------------------------------

export interface AccountInput {
  kind: string;
  label: string;
  bankName: string;
  iban: string;
  swift: string;
  currency: string;
  /** Payoneer: the currencies it receives, comma-separated. */
  currencies: string;
  /** Receiving details printed on invoices (Payoneer, marketplaces). */
  instructions: string;
}

const BANK_KINDS = new Set<AccountKind>(["pkr_account", "esfca", "wise_pkr"]);

/** Adds an account money can arrive in. Bank accounts need a valid Pakistani IBAN. */
export async function addReceivingAccount(db: Db, ws: Workspace, input: AccountInput, userId: string): Promise<Saved> {
  const problems: string[] = [];
  const kind = (Object.keys(ACCOUNT_KIND_LABELS) as AccountKind[]).find((k) => k === input.kind);
  if (!kind) return { ok: false, problems: ["Choose what kind of account this is."] };
  const label = str(input.label) || ACCOUNT_KIND_LABELS[kind];
  const currencies = [...new Set(str(input.currencies).toUpperCase().split(/[\s,;/]+/).filter(Boolean))];
  // A Payoneer account's own currency is the first one it receives, unless one is given.
  const currency = str(input.currency).toUpperCase() || (kind === "payoneer" ? (currencies[0] ?? "") : "");
  const iban = compactIban(str(input.iban));
  const swift = str(input.swift).toUpperCase();
  const instructions = str(input.instructions);
  if (!CCY_RE.test(currency)) problems.push("The account's currency should be a three-letter code, like PKR or USD.");
  if ((kind === "pkr_account" || kind === "wise_pkr") && currency !== "PKR") problems.push("A PKR account's currency is PKR.");
  if (kind === "esfca" && currency === "PKR") problems.push("An ESFCA holds foreign currency, such as USD.");
  if (BANK_KINDS.has(kind)) {
    if (!str(input.bankName)) problems.push("Add the bank's name.");
    const p = iban ? ibanProblem(iban) : null;
    if (!iban) problems.push("Add the account's IBAN.");
    else if (p) problems.push(`Check the IBAN: ${p}.`);
    else if (!iban.startsWith("PK")) problems.push("This should be your Pakistani account, so its IBAN starts with PK.");
    if (swift && swiftProblem(swift)) problems.push(`The SWIFT code: ${swiftProblem(swift)}.`);
  }
  if (kind === "payoneer") {
    const bad = currencies.filter((c) => !CCY_RE.test(c));
    if (currency && CCY_RE.test(currency) && currencies.length && !currencies.includes(currency)) currencies.unshift(currency);
    if (!currencies.length) problems.push("List the currencies your Payoneer account receives, like USD, EUR, GBP.");
    if (bad.length) problems.push(`Not a currency code: ${bad.join(", ")}.`);
    if (!instructions) problems.push("Add the receiving details clients need (they're printed on the invoice).");
  }
  if (instructions.length > 1000) problems.push("The receiving details are too long (1,000 characters at most).");
  if (iban && !problems.length) {
    const [dupe] = await db.select({ label: receivingAccount.label }).from(receivingAccount).where(and(eq(receivingAccount.workspaceId, ws.id), eq(receivingAccount.iban, iban)));
    if (dupe) problems.push(`That IBAN is already on file as "${dupe.label}".`);
  }
  if (problems.length) return { ok: false, problems };
  const legal = ws.legalName ?? ws.name;
  const [row] = await db
    .insert(receivingAccount)
    .values({
      workspaceId: ws.id,
      kind,
      label,
      bankName: str(input.bankName) || (kind === "payoneer" ? "Payoneer" : null),
      iban: BANK_KINDS.has(kind) ? iban : null,
      swift: swift || null,
      currency,
      platformName: kind === "payoneer" ? "Payoneer" : kind === "platform" ? label : null,
      receivingDetails: {
        ...(kind === "payoneer" ? { currencies } : {}),
        paymentInstructions: BANK_KINDS.has(kind) ? `${str(input.bankName)}${swift ? `, SWIFT ${swift}` : ""}, IBAN ${formatIban(iban)} (${label} of ${legal})` : instructions || label,
      },
    })
    .returning({ id: receivingAccount.id });
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "receiving_account.added", objectType: "receiving_account", objectId: row!.id, details: { kind, label, iban: iban ? `…${iban.slice(-4)}` : null, currency } });
  return { ok: true, id: row!.id };
}

/** Stops (or restarts) quoting an account on new invoices; past records keep pointing at it. */
export async function setAccountActive(db: Db, workspaceId: string, accountId: string, active: boolean, userId: string): Promise<boolean> {
  const rows = await db.update(receivingAccount).set({ active }).where(and(eq(receivingAccount.workspaceId, workspaceId), eq(receivingAccount.id, accountId))).returning({ label: receivingAccount.label });
  if (!rows.length) return false;
  await audit(db, { workspaceId, actorType: "user", actorId: userId, action: active ? "receiving_account.reactivated" : "receiving_account.deactivated", objectType: "receiving_account", objectId: accountId, details: { label: rows[0]!.label } });
  return true;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface ClientInput {
  name: string;
  kind: string;
  country: string;
  currency: string;
  termsDays: string;
  preferredRoute: string;
  contactName: string;
  contactEmails: string;
  /** Names the client's payments arrive under on bank advices, one per line. */
  aliases: string;
  notes: string;
}

export async function saveClient(db: Db, workspaceId: string, input: ClientInput, userId: string, clientId?: string): Promise<Saved> {
  const problems: string[] = [];
  const name = str(input.name);
  if (!name) problems.push("The client needs a name.");
  if (name.length > 120) problems.push("The name is too long (120 characters at most).");
  const kind = (["business", "individual", "marketplace"] as const).find((k) => k === input.kind);
  if (!kind) problems.push("Choose what kind of client this is.");
  const country = str(input.country).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) problems.push("The country should be a two-letter code, like US or GB.");
  const currency = str(input.currency).toUpperCase();
  if (!CCY_RE.test(currency)) problems.push("The currency should be a three-letter code, like USD.");
  const terms = Number(str(input.termsDays) || "30");
  if (!Number.isInteger(terms) || terms < 0 || terms > 365) problems.push("Payment terms should be a whole number of days from 0 to 365.");
  const route = str(input.preferredRoute) ? ROUTES.find((r) => r === str(input.preferredRoute)) : null;
  if (str(input.preferredRoute) && !route) problems.push("Choose the usual route from the list.");
  const emails = [...new Set(str(input.contactEmails).split(/[\s,;]+/).filter(Boolean).map((e) => e.toLowerCase()))];
  const badEmails = emails.filter((e) => !EMAIL_RE.test(e));
  if (badEmails.length) problems.push(`Not an email address: ${badEmails.join(", ")}.`);
  const aliases = [...new Set(str(input.aliases).split(/\r?\n/).map((a) => a.trim()).filter(Boolean))];
  if (aliases.length > 20) problems.push("Up to 20 payer names, please.");
  if (aliases.some((a) => a.length > 120)) problems.push("A payer name is too long (120 characters at most).");
  if (str(input.notes).length > 2000) problems.push("The notes are too long (2,000 characters at most).");
  if (!problems.length && (await clientNameTaken(db, workspaceId, name, clientId))) problems.push(`There's already a client called "${name}".`);
  if (problems.length || !kind) return { ok: false, problems };

  const values = { name, kind, country: country || null, defaultCurrency: currency, paymentTermsDays: terms, preferredRoute: route ?? null, contactName: str(input.contactName) || null, contactEmails: emails, notes: str(input.notes) || null };
  if (clientId) {
    const [existing] = await db.select({ id: client.id }).from(client).where(and(eq(client.workspaceId, workspaceId), eq(client.id, clientId)));
    if (!existing) return { ok: false, problems: ["That client doesn't exist."] };
  }
  const id = await db.transaction(async (tx) => {
    const cid = clientId
      ? (await tx.update(client).set(values).where(eq(client.id, clientId)).returning({ id: client.id }))[0]!.id
      : (await tx.insert(client).values({ workspaceId, ...values }).returning({ id: client.id }))[0]!.id;
    // Names a person typed replace the old typed ones; names the agent learned stay.
    const typed = await tx.select().from(clientAlias).where(and(eq(clientAlias.clientId, cid), eq(clientAlias.source, "manual")));
    const drop = typed.filter((a) => !aliases.includes(a.alias)).map((a) => a.id);
    if (drop.length) await tx.delete(clientAlias).where(inArray(clientAlias.id, drop));
    const have = new Set((await tx.select({ alias: clientAlias.alias }).from(clientAlias).where(eq(clientAlias.clientId, cid))).map((a) => a.alias));
    const add = aliases.filter((a) => !have.has(a));
    if (add.length) await tx.insert(clientAlias).values(add.map((alias) => ({ workspaceId, clientId: cid, alias, source: "manual" as const })));
    return cid;
  });
  await audit(db, { workspaceId, actorType: "user", actorId: userId, action: clientId ? "client.updated" : "client.created", objectType: "client", objectId: id, details: { name, currency, country: country || null } });
  return { ok: true, id };
}

/** Whether a client name is already used here (so a typo doesn't create a twin). */
export async function clientNameTaken(db: Db, workspaceId: string, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: client.id })
    .from(client)
    .where(and(eq(client.workspaceId, workspaceId), eq(client.name, name.trim()), ...(exceptId ? [ne(client.id, exceptId)] : [])));
  return rows.length > 0;
}
