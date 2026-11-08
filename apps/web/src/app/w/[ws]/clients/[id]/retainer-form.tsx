"use client";

import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** Adds a monthly retainer to a client. Works without JavaScript; what was typed survives a rejected save. */
export function RetainerForm({ action, currency, currencies, today }: { action: Action; currency: string; currencies: string[]; today: string }) {
  const [state, formAction] = useActionState(action, FORM_START);
  const v = state.values ?? { description: "", amount: "", currency, billingDay: "1", startsOn: today };
  return (
    <form action={formAction} key={`${state.saved ?? 0}:${JSON.stringify(state.values)}`} className="space-y-3">
      <FormProblems problems={state.problems} />
      {state.saved ? (
        <p role="status" className="text-sm text-success">
          Added. {state.notice}
        </p>
      ) : null}
      <Field label="What it's for" hint="Each invoice line reads like this, followed by the month.">
        <input name="description" defaultValue={v.description} maxLength={200} placeholder="App development, monthly retainer" className="input w-full" />
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3">
        <Field label="Each month">
          <input name="amount" defaultValue={v.amount} inputMode="decimal" placeholder="2400.00" className="input w-full tabular-nums" />
        </Field>
        <Field label="Currency">
          <select name="currency" defaultValue={v.currency} className="input w-full">
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Billed on day" hint="1 to 28, so every month has it.">
          <input name="billingDay" type="number" min={1} max={28} defaultValue={v.billingDay} className="input w-full" />
        </Field>
        <Field label="Starts on" hint="No earlier months are billed.">
          <input name="startsOn" type="date" defaultValue={v.startsOn} className="input w-full" />
        </Field>
      </div>
      <SubmitButton variant="secondary" pendingText="Adding…">
        Add retainer
      </SubmitButton>
    </form>
  );
}
