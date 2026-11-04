"use client";

import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

export interface ClientFormProps {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  initial: Record<string, string>;
  countries: Array<{ code: string; name: string }>;
  currencies: string[];
  routes: Array<{ value: string; label: string }>;
  submitLabel: string;
}

export function ClientForm({ action, initial, countries, currencies, routes, submitLabel }: ClientFormProps) {
  const [state, formAction] = useActionState(action, FORM_START);
  const v = state.values ?? initial;
  const known = countries.some((c) => c.code === v.country);
  const countryChoice = v.country === "other" || (v.country && !known) ? "other" : (v.country ?? "");
  const countryOther = v.country === "other" ? (v.countryOther ?? "") : known ? "" : (v.country ?? "");
  return (
    // Keyed by what was sent, so a rejected attempt shows the values the person typed.
    <form action={formAction} key={JSON.stringify(state.values)} className="space-y-4">
      <FormProblems problems={state.problems} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input name="name" defaultValue={v.name ?? ""} required maxLength={120} className="input w-full" />
        </Field>
        <Field label="Kind">
          <select name="kind" defaultValue={v.kind ?? "business"} className="input w-full">
            <option value="business">A business</option>
            <option value="individual">A person</option>
            <option value="marketplace">A marketplace (Upwork, Fiverr…)</option>
          </select>
        </Field>
        <Field label="Country">
          <select name="country" defaultValue={countryChoice} className="input w-full">
            <option value="">Not set</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
            <option value="other">Another country…</option>
          </select>
          <input name="countryOther" defaultValue={countryOther} placeholder="Another country: its two-letter code, like ZA" maxLength={2} className="input mt-2 w-full" />
        </Field>
        <Field label="Currency they pay in">
          <select name="currency" defaultValue={v.currency ?? "USD"} className="input w-full">
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Payment terms (days)">
          <input name="termsDays" type="number" min={0} max={365} defaultValue={v.termsDays ?? "30"} className="input w-full" />
        </Field>
        <Field label="Usual way they pay" hint="Left to the agent, each invoice suggests the cheapest route that works.">
          <select name="preferredRoute" defaultValue={v.preferredRoute ?? ""} className="input w-full">
            <option value="">Let the agent suggest</option>
            {routes.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact name">
          <input name="contactName" defaultValue={v.contactName ?? ""} className="input w-full" />
        </Field>
        <Field label="Email for invoices and reminders" hint="Several? Separate them with commas; the first gets the emails.">
          <input name="contactEmails" defaultValue={v.contactEmails ?? ""} className="input w-full" />
        </Field>
      </div>
      <Field label="Names their payments arrive under" hint="As printed on bank advices, one per line, like NORTHWIND ANALYTICS INC. The agent also learns these as it matches payments.">
        <textarea name="aliases" rows={3} defaultValue={v.aliases ?? ""} className="input w-full font-mono text-xs" />
      </Field>
      <Field label="Notes">
        <textarea name="notes" rows={2} defaultValue={v.notes ?? ""} className="input w-full" />
      </Field>
      <SubmitButton pendingText="Saving…">{submitLabel}</SubmitButton>
    </form>
  );
}
