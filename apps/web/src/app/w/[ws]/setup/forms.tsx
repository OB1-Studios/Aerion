"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** A form that stays on the page: shows what to fix, keeps what was typed, and says when it saved. */
function useSavingForm(action: Action, initial: Record<string, string>) {
  const [state, formAction] = useActionState(action, FORM_START);
  return { state, formAction, v: state.values ?? initial, key: `${state.saved ?? 0}:${JSON.stringify(state.values)}` };
}

function Footer({ canEdit, saved, label }: { canEdit: boolean; saved?: number; label: string }) {
  if (!canEdit) return <p className="text-sm text-muted">Only an owner can change these.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SubmitButton pendingText="Saving…">{label}</SubmitButton>
      {saved ? (
        <span role="status" className="text-sm text-success">
          Saved.
        </span>
      ) : null}
    </div>
  );
}

const grid = "grid grid-cols-1 gap-4 sm:grid-cols-2";

export function BusinessForm({ action, initial, canEdit, company }: { action: Action; initial: Record<string, string>; canEdit: boolean; company: boolean }) {
  const { state, formAction, v, key } = useSavingForm(action, initial);
  return (
    <form action={formAction} key={key} className="space-y-5">
      <FormProblems problems={state.problems} />
      <fieldset disabled={!canEdit} className="space-y-5">
        <div className={grid}>
          <Field label="Workspace name">
            <input name="name" defaultValue={v.name} required maxLength={80} className="input w-full" />
          </Field>
          <Field label={company ? "Legal name (as registered)" : "Your full name (as on your CNIC)"} hint="Printed on every invoice.">
            <input name="legalName" defaultValue={v.legalName} required maxLength={160} className="input w-full" />
          </Field>
          <Field label="City">
            <input name="city" defaultValue={v.city} maxLength={80} className="input w-full" />
          </Field>
          <Field label="NTN" hint="National Tax Number, e.g. 1234567-8.">
            <input name="ntn" defaultValue={v.ntn} maxLength={20} className="input w-full" />
          </Field>
          {company ? (
            <Field label="SECP registration number">
              <input name="secpRegNo" defaultValue={v.secpRegNo} maxLength={40} className="input w-full" />
            </Field>
          ) : null}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-ink">PSEB registration</h3>
          <div className={grid}>
            <Field label="Registration number">
              <input name="psebRegNo" defaultValue={v.psebRegNo} maxLength={40} className="input w-full" />
            </Field>
            <Field label="Valid until" hint="The agent reminds you 60 days before it lapses.">
              <input type="date" name="psebValidUntil" defaultValue={v.psebValidUntil} className="input w-full" />
            </Field>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" name="notRegistered" />
            Not registered with PSEB (clears the number)
          </label>
        </div>

        <div className={grid}>
          <Field label="Active taxpayer list (ATL)" hint="Being on it lowers the tax the bank deducts from export proceeds.">
            <select name="atlStatus" defaultValue={v.atlStatus || "unknown"} className="input w-full">
              <option value="active">On the list</option>
              <option value="inactive">Not on the list</option>
              <option value="unknown">Not sure</option>
            </select>
          </Field>
          <Field label="Checked on">
            <input type="date" name="atlCheckedOn" defaultValue={v.atlCheckedOn} className="input w-full" />
          </Field>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-ink">Emails to clients</h3>
          <div className={grid}>
            <Field label="Signed by">
              <input name="senderName" defaultValue={v.senderName} maxLength={80} className="input w-full" />
            </Field>
            <Field label="Title">
              <input name="senderTitle" defaultValue={v.senderTitle} maxLength={80} placeholder={company ? "Finance" : "Freelance developer"} className="input w-full" />
            </Field>
            <Field label="Phone in the signature">
              <input name="phone" defaultValue={v.phone} maxLength={40} className="input w-full" />
            </Field>
            <Field label="Send from" hint="The address client emails come from.">
              <input type="email" name="mailboxAddress" defaultValue={v.mailboxAddress} maxLength={120} className="input w-full" />
            </Field>
          </div>
        </div>
      </fieldset>
      <Footer canEdit={canEdit} saved={state.saved} label="Save details" />
    </form>
  );
}

const KIND_HELP: Record<string, string> = {
  esfca: "A foreign-currency account at a Pakistani bank: clients wire USD (or EUR, GBP) and it stays in that currency.",
  pkr_account: "Your ordinary rupee account. Foreign wires are converted to PKR when they land.",
  wise_pkr: "Clients pay Wise in their currency and Wise pays rupees into this account.",
  payoneer: "A Payoneer balance with receiving accounts in several currencies.",
  platform: "Money that comes through a marketplace such as Upwork or Fiverr.",
};

const BANK = new Set(["esfca", "pkr_account", "wise_pkr"]);

export function AccountForm({ action, kinds }: { action: Action; kinds: Array<[string, string]> }) {
  const { state, formAction, v, key } = useSavingForm(action, { kind: "esfca" });
  // Until JavaScript runs every field shows; after that only the ones this kind needs.
  const [kind, setKind] = useState<string | null>(null);
  useEffect(() => setKind(v.kind || "esfca"), [v.kind]);
  const show = (group: "bank" | "other") => kind == null || (group === "bank") === BANK.has(kind);
  const section = (group: "bank" | "other", children: ReactNode) => (show(group) ? children : null);

  return (
    <form action={formAction} key={key} className="space-y-4">
      <FormProblems problems={state.problems} />
      {state.saved ? (
        <p role="status" className="text-sm text-success">
          Added. It&apos;s offered on new invoices straight away.
        </p>
      ) : null}
      <div className={grid}>
        <Field label="Kind of account" hint={kind ? KIND_HELP[kind] : undefined}>
          <select name="kind" defaultValue={v.kind || "esfca"} onChange={(e) => setKind(e.target.value)} className="input w-full">
            {kinds.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name it" hint='How it appears here, e.g. "Meezan USD ESFCA".'>
          <input name="label" defaultValue={v.label} maxLength={80} className="input w-full" />
        </Field>
      </div>
      {section(
        "bank",
        <div className={grid}>
          <Field label="Bank">
            <input name="bankName" defaultValue={v.bankName} maxLength={80} placeholder="Meezan Bank" className="input w-full" />
          </Field>
          <Field label="IBAN" hint="24 characters, starting PK.">
            <input name="iban" defaultValue={v.iban} maxLength={40} placeholder="PK36 SCBL 0000 0011 2345 6702" className="input w-full font-mono" />
          </Field>
          <Field label="SWIFT / BIC" hint="Needed for wires from abroad.">
            <input name="swift" defaultValue={v.swift} maxLength={11} placeholder="MEZNPKKA" className="input w-full font-mono" />
          </Field>
          <Field label="Currency" hint="USD for a dollar ESFCA; PKR for a rupee account.">
            <input name="currency" defaultValue={v.currency} maxLength={3} placeholder={kind === "esfca" ? "USD" : "PKR"} className="input w-full uppercase" />
          </Field>
        </div>,
      )}
      {section(
        "other",
        <div className={grid}>
          <Field label="Currencies it receives" hint="Payoneer: e.g. USD, EUR, GBP.">
            <input name="currencies" defaultValue={v.currencies} maxLength={80} placeholder="USD, EUR, GBP" className="input w-full uppercase" />
          </Field>
          {kind == null ? null : (
            <Field label="Main currency" hint="Leave empty to use the first one listed.">
              <input name="currency" defaultValue={v.currency} maxLength={3} className="input w-full uppercase" />
            </Field>
          )}
          <Field label="Receiving details for clients" hint="Printed on the invoice as they are, e.g. the bank details Payoneer gives you for USD." className="sm:col-span-2">
            <textarea name="instructions" defaultValue={v.instructions} rows={4} maxLength={1000} className="input w-full" />
          </Field>
        </div>,
      )}
      <SubmitButton pendingText="Adding…">Add the account</SubmitButton>
    </form>
  );
}

export function InvoiceSettingsForm({ action, initial, canEdit, preview }: { action: Action; initial: Record<string, string>; canEdit: boolean; preview: string }) {
  const { state, formAction, v, key } = useSavingForm(action, initial);
  return (
    <form action={formAction} key={key} className="space-y-4">
      <FormProblems problems={state.problems} />
      <fieldset disabled={!canEdit} className="space-y-4">
        <div className={grid}>
          <Field label="Number prefix" hint={`The next invoice will be ${preview}.`}>
            <input name="prefix" defaultValue={v.prefix} required maxLength={10} className="input w-full uppercase" />
          </Field>
          <Field label="Next number" hint="Moving from another tool? Continue its numbering here. Numbers already used are never reused.">
            <input type="number" name="nextNumber" defaultValue={v.nextNumber} min={1} max={99999} required className="input w-full" />
          </Field>
        </div>
        <Field label="Default purpose of payment" hint="Pre-filled on each new invoice. Banks report the inward remittance under this purpose, which matters for the export tax rate.">
          <input name="purposeWording" defaultValue={v.purposeWording} maxLength={200} className="input w-full" />
        </Field>
      </fieldset>
      <Footer canEdit={canEdit} saved={state.saved} label="Save invoice settings" />
    </form>
  );
}

export function MailboxForm({ action, providers }: { action: Action; providers: Array<{ key: string; label: string; help: string }> }) {
  const { state, formAction, v, key } = useSavingForm(action, { provider: providers[0]?.key ?? "other" });
  // Until JavaScript runs every field shows; after that the server fields only for "Other".
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => setProvider(v.provider || providers[0]?.key || "other"), [v.provider, providers]);
  const help = providers.find((p) => p.key === provider)?.help;
  return (
    <form action={formAction} key={key} className="space-y-4">
      <FormProblems problems={state.problems} title="Not connected:" />
      <div className={grid}>
        <Field label="Mail provider" hint={help}>
          <select name="provider" defaultValue={v.provider} onChange={(e) => setProvider(e.target.value)} className="input w-full">
            {providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="other">Other (your host&apos;s IMAP and SMTP settings)</option>
          </select>
        </Field>
        <Field label="Mailbox address" hint="Best a finance address, like accounts@yourcompany.com.">
          <input type="email" name="address" defaultValue={v.address} required maxLength={120} autoComplete="off" className="input w-full" />
        </Field>
        <Field label="App password" hint="Stored encrypted; never shown again.">
          <input type="password" name="password" required maxLength={200} autoComplete="new-password" className="input w-full" />
        </Field>
      </div>
      {provider == null || provider === "other" ? (
        <div className={grid}>
          <Field label="IMAP server (reading)">
            <input name="imapHost" defaultValue={v.imapHost} maxLength={253} placeholder="mail.yourcompany.com" className="input w-full" />
          </Field>
          <Field label="IMAP port" hint="993 (SSL). 143 only with STARTTLS.">
            <input name="imapPort" defaultValue={v.imapPort} inputMode="numeric" placeholder="993" className="input w-full" />
          </Field>
          <Field label="SMTP server (sending)">
            <input name="smtpHost" defaultValue={v.smtpHost} maxLength={253} placeholder="mail.yourcompany.com" className="input w-full" />
          </Field>
          <Field label="SMTP port" hint="465 (SSL), or 587 with STARTTLS.">
            <input name="smtpPort" defaultValue={v.smtpPort} inputMode="numeric" placeholder="465" className="input w-full" />
          </Field>
          <Field label="Login name" hint="Leave empty if it's the mailbox address.">
            <input name="username" defaultValue={v.username} maxLength={120} autoComplete="off" className="input w-full" />
          </Field>
        </div>
      ) : null}
      <SubmitButton pendingText="Checking the connection…">Connect the mailbox</SubmitButton>
    </form>
  );
}
