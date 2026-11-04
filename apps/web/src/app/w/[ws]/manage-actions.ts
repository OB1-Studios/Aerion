"use server";

import { formatDateLong } from "@ebo/core";
import { getDb, member } from "@ebo/db";
import {
  addReceivingAccount,
  addRetainer,
  connectMailbox,
  disconnectMailbox,
  inviteMember,
  revokeInvitation,
  setMemberRole,
  draftInvoiceEmail,
  markInvoiceSent,
  saveBusinessDetails,
  saveClient,
  saveInvoice,
  saveInvoiceSettings,
  setAccountActive,
  stopRetainer,
  workspaceToday,
  type AccountInput,
  type BusinessInput,
  type ClientInput,
} from "@ebo/engine";
import type { Role } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { actor } from "@/lib/actor";
import { formValues, type FormState } from "@/lib/forms";

/**
 * Setting up and invoicing: clients, invoices, the business's details, receiving accounts.
 * The checks live in the engine; these only collect the form and say where to go next.
 */

const refresh = (slug: string) => revalidatePath(`/w/${slug}`, "layout");
const field = (v: Record<string, string>, k: string) => v[k] ?? "";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function saveClientAction(slug: string, clientId: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug);
  const v = formValues(form);
  const input: ClientInput = {
    name: field(v, "name"),
    kind: field(v, "kind"),
    country: field(v, "country") === "other" ? field(v, "countryOther") : field(v, "country"),
    currency: field(v, "currency"),
    termsDays: field(v, "termsDays"),
    preferredRoute: field(v, "preferredRoute"),
    contactName: field(v, "contactName"),
    contactEmails: field(v, "contactEmails"),
    aliases: field(v, "aliases"),
    notes: field(v, "notes"),
  };
  const r = await saveClient(getDb(), ws.id, input, user.id, clientId ?? undefined);
  if (!r.ok) return { problems: r.problems, values: v };
  refresh(slug);
  redirect(`/w/${slug}/clients/${r.id}?saved=1`);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export async function saveInvoiceAction(slug: string, invoiceId: string | null, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug);
  const v = formValues(form);
  const lines = form.getAll("description").map((d, i) => ({ description: String(d), quantity: String(form.getAll("quantity")[i] ?? ""), unitPrice: String(form.getAll("unitPrice")[i] ?? "") }));
  const r = await saveInvoice(
    getDb(),
    ws,
    {
      clientId: field(v, "clientId"),
      issuedOn: field(v, "issuedOn"),
      termsDays: Number(field(v, "termsDays") || "30"),
      currency: field(v, "currency").toUpperCase(),
      routeChoice: field(v, "route"),
      purposeWording: field(v, "purposeWording"),
      lines,
    },
    user.id,
    invoiceId ?? undefined,
  );
  if (!r.ok) return { problems: r.problems, values: v };
  refresh(slug);
  redirect(`/w/${slug}/invoices/${r.id}?saved=1`);
}

/** Prepares the invoice email for approval and opens it, so the person sees exactly what goes out. */
// ---------------------------------------------------------------------------
// Retainers: the run drafts each month's invoice from these
// ---------------------------------------------------------------------------

export async function addRetainerAction(slug: string, clientId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug);
  const v = formValues(form);
  const r = await addRetainer(getDb(), ws, clientId, { description: field(v, "description"), amount: field(v, "amount"), currency: field(v, "currency"), billingDay: field(v, "billingDay"), startsOn: field(v, "startsOn") }, user.id);
  if (!r.ok) return { problems: r.problems, values: v };
  refresh(slug);
  const notice = !r.firstOn ? "" : r.firstOn <= workspaceToday(ws) ? "This month's invoice is drafted at the next run; press Run now to draft it straight away." : `The first invoice is drafted on ${formatDateLong(r.firstOn)}.`;
  return { problems: [], values: null, saved: Date.now(), notice };
}

export async function stopRetainerAction(slug: string, clientId: string, contractId: string) {
  const { user, ws } = await actor(slug);
  await stopRetainer(getDb(), ws, contractId, user.id, workspaceToday(ws));
  refresh(slug);
  redirect(`/w/${slug}/clients/${clientId}?stopped=1#retainers`);
}

export async function sendInvoiceAction(slug: string, invoiceId: string) {
  const { user, ws } = await actor(slug);
  const r = await draftInvoiceEmail(getDb(), ws.id, invoiceId, user.id);
  refresh(slug);
  if (!r.ok) redirect(`/w/${slug}/invoices/${invoiceId}?error=${encodeURIComponent(r.reason)}`);
  redirect(`/w/${slug}/drafts/${r.draftId}`);
}

export async function markInvoiceSentAction(slug: string, invoiceId: string) {
  const { user, ws } = await actor(slug);
  const ok = await markInvoiceSent(getDb(), ws, invoiceId, user.id);
  refresh(slug);
  redirect(`/w/${slug}/invoices/${invoiceId}?${ok ? "marked=1" : `error=${encodeURIComponent("Only a draft invoice can be marked as sent.")}`}`);
}

// ---------------------------------------------------------------------------
// Setup: owners only
// ---------------------------------------------------------------------------

export async function saveBusinessAction(slug: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug, "own");
  const v = formValues(form);
  const keys: Array<keyof BusinessInput> = ["name", "legalName", "city", "ntn", "secpRegNo", "psebRegNo", "psebValidUntil", "atlStatus", "atlCheckedOn", "senderName", "senderTitle", "phone", "mailboxAddress"];
  const input = Object.fromEntries(keys.map((k) => [k, field(v, k)])) as unknown as BusinessInput;
  if (v.notRegistered === "on") {
    input.psebRegNo = "";
    input.psebValidUntil = "";
  }
  const r = await saveBusinessDetails(getDb(), ws, input, user.id);
  if (!r.ok) return { problems: r.problems, values: v };
  refresh(slug);
  return { problems: [], values: null, saved: Date.now() };
}

export async function addAccountAction(slug: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug, "own");
  const v = formValues(form);
  const keys: Array<keyof AccountInput> = ["kind", "label", "bankName", "iban", "swift", "currency", "currencies", "instructions"];
  const r = await addReceivingAccount(getDb(), ws, Object.fromEntries(keys.map((k) => [k, field(v, k)])) as unknown as AccountInput, user.id);
  if (!r.ok) return { problems: r.problems, values: v };
  refresh(slug);
  return { problems: [], values: null, saved: Date.now() };
}

export async function toggleAccountAction(slug: string, accountId: string, active: boolean) {
  const { user, ws } = await actor(slug, "own");
  await setAccountActive(getDb(), ws.id, accountId, active, user.id);
  refresh(slug);
  redirect(`/w/${slug}/setup#accounts`);
}

export async function saveInvoiceSettingsAction(slug: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug, "own");
  const v = formValues(form);
  const r = await saveInvoiceSettings(getDb(), ws, { prefix: field(v, "prefix"), nextNumber: field(v, "nextNumber"), purposeWording: field(v, "purposeWording") }, user.id);
  if (!r.ok) return { problems: r.problems, values: v };
  refresh(slug);
  return { problems: [], values: null, saved: Date.now() };
}

/** Connects the workspace's own mailbox: both logins are tried before anything is saved. */
export async function connectMailboxAction(slug: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug, "own");
  const v = formValues(form);
  const r = await connectMailbox(getDb(), ws, { provider: field(v, "provider"), address: field(v, "address"), password: String(form.get("password") ?? ""), imapHost: field(v, "imapHost"), imapPort: field(v, "imapPort"), smtpHost: field(v, "smtpHost"), smtpPort: field(v, "smtpPort"), username: field(v, "username") }, user.id);
  // Never send the password back to the page.
  const { password: _password, ...typed } = v;
  if (!r.ok) return { problems: r.problems, values: typed };
  refresh(slug);
  return { problems: [], values: null, saved: Date.now() };
}

export async function disconnectMailboxAction(slug: string) {
  const { user, ws } = await actor(slug, "own");
  await disconnectMailbox(getDb(), ws.id, user.id);
  refresh(slug);
  redirect(`/w/${slug}/setup#mailbox`);
}

// ---------------------------------------------------------------------------
// People: owners only
// ---------------------------------------------------------------------------

/** The address people open the app at, for links they're sent. */
async function appOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin && /^https?:\/\/[^/\s]+$/.test(origin)) return origin;
  return (process.env.BETTER_AUTH_URL ?? `http://${h.get("host") ?? "localhost:3000"}`).replace(/\/$/, "");
}

/** Invites someone by email; the page shows the link to send them (it works once, for that address). */
export async function inviteAction(slug: string, _prev: FormState, form: FormData): Promise<FormState> {
  const { user, ws } = await actor(slug, "own");
  const v = formValues(form);
  if (ws.isDemo) return { problems: ["People can't be changed in a demo workspace."], values: v };
  const r = await inviteMember(getDb(), ws, { email: field(v, "email"), role: field(v, "role") }, user.id);
  if (!r.ok) return { problems: r.problems, values: v };
  refresh(slug);
  return { problems: [], values: null, saved: Date.now(), notice: `${await appOrigin()}/invite/${r.token}` };
}

export async function revokeInviteAction(slug: string, invitationId: string) {
  const { user, ws } = await actor(slug, "own");
  if (ws.isDemo) redirect(`/w/${slug}/settings#people`);
  await revokeInvitation(getDb(), ws.id, invitationId, user.id);
  refresh(slug);
  redirect(`/w/${slug}/settings#people`);
}

export async function setRoleAction(slug: string, memberId: string, remove: boolean, form: FormData) {
  const { user, ws } = await actor(slug, "own");
  if (ws.isDemo) redirect(`/w/${slug}/settings?people=${encodeURIComponent("People can't be changed in a demo workspace.")}#people`);
  const role = remove ? null : (String(form.get("role") ?? "") as Role);
  const r = await setMemberRole(getDb(), ws.id, memberId, role, user.id);
  refresh(slug);
  if (!r.ok) redirect(`/w/${slug}/settings?people=${encodeURIComponent(r.reason)}#people`);
  // Someone who removed themselves can't see this workspace any more.
  const [still] = await getDb().select({ id: member.id }).from(member).where(and(eq(member.workspaceId, ws.id), eq(member.userId, user.id)));
  redirect(still ? `/w/${slug}/settings#people` : "/workspaces");
}
