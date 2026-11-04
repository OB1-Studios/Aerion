"use server";

import { getDb } from "@ebo/db";
import { addReceivingAccount, draftInvoiceEmail, markInvoiceSent, saveBusinessDetails, saveClient, saveInvoice, saveInvoiceSettings, setAccountActive, type AccountInput, type BusinessInput, type ClientInput } from "@ebo/engine";
import { revalidatePath } from "next/cache";
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
