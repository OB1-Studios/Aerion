"use client";

import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** Records a conversion the bank has made. Works without JavaScript; what was typed survives a rejected save. */
export function ConversionForm({ action, accountId, currency, today }: { action: Action; accountId: string; currency: string; today: string }) {
  const [state, formAction] = useActionState(action, FORM_START);
  const v = state.values ?? { on: today, amount: "", pkr: "", reference: "" };
  return (
    <form action={formAction} key={JSON.stringify(state.values)} className="space-y-3">
      <FormProblems problems={state.problems} title="Not recorded:" />
      <input type="hidden" name="accountId" value={accountId} />
      <Field label="Date the bank converted it">
        <input type="date" name="on" defaultValue={v.on} max={today} required className="input w-full tabular-nums" />
      </Field>
      <Field label={`Amount converted (${currency})`}>
        <input name="amount" defaultValue={v.amount} inputMode="decimal" required className="input w-full tabular-nums" />
      </Field>
      <Field label="PKR credited" hint="From the bank's advice. The rate is worked out from these two amounts.">
        <input name="pkr" defaultValue={v.pkr} inputMode="decimal" required className="input w-full tabular-nums" />
      </Field>
      <Field label="Bank reference (optional)">
        <input name="reference" defaultValue={v.reference} maxLength={120} className="input w-full" />
      </Field>
      <SubmitButton pendingText="Recording…">Record conversion</SubmitButton>
    </form>
  );
}
