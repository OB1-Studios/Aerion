"use client";

import type { CreditKind } from "@ebo/core";
import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const KINDS: Record<CreditKind, { label: string; hint: string }> = {
  credit: { label: "Credit note", hint: "Agreed with the client: a discount, a disputed hour, a mistake on the invoice." },
  write_off: { label: "Write-off", hint: "Money you've stopped expecting, such as bank charges the client won't cover, or a client who won't pay." },
  void: { label: "Void", hint: "Cancels the invoice, before any money has come in. Its number stays used, and nothing more is sent about it." },
};

/** Takes money off what the client owes, with a reason. Works without JavaScript; what was typed survives a rejected save. */
export function CreditForm({ action, kinds, balance, owedText, currency }: { action: Action; kinds: CreditKind[]; balance: string; owedText: string; currency: string }) {
  const [state, formAction] = useActionState(action, FORM_START);
  const v = state.values ?? { kind: kinds[0]!, amount: balance, reason: "" };
  const onlyVoid = kinds.length === 1 && kinds[0] === "void";
  return (
    <form action={formAction} key={JSON.stringify(state.values)} className="space-y-3">
      <FormProblems problems={state.problems} title="Not recorded:" />
      <fieldset className="space-y-2">
        <legend className="sr-only">What to record</legend>
        {kinds.map((k) => (
          <label key={k} className="flex cursor-pointer gap-2.5 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/5">
            <input type="radio" name="kind" value={k} defaultChecked={v.kind === k} className="mt-0.5 accent-[var(--accent)]" />
            <span>
              <span className="font-medium text-ink">{KINDS[k].label}</span>
              <span className="block text-xs text-muted">{KINDS[k].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {onlyVoid ? (
        <input type="hidden" name="amount" value={balance} />
      ) : (
        <Field label={`Amount (${currency})`} hint={`Up to the ${owedText} still owed. A void always takes all of it.`}>
          <input name="amount" defaultValue={v.amount} inputMode="decimal" className="input w-full tabular-nums" />
        </Field>
      )}
      <Field label="Why" hint="Kept with the invoice and shown to your accountant.">
        <input name="reason" defaultValue={v.reason} maxLength={300} required className="input w-full" placeholder={onlyVoid ? "Raised by mistake" : "Two testing days were billed twice"} />
      </Field>
      <SubmitButton variant="danger" pendingText="Recording…">
        {onlyVoid ? "Void this invoice" : "Record it"}
      </SubmitButton>
    </form>
  );
}
