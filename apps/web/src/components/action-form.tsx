"use client";

import { useActionState } from "react";
import { FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** One button that runs a server action. Works without JavaScript; a refusal shows above it. */
export function ActionForm({ action, label, pendingText, hint, title = "Not done:", variant = "primary" }: { action: Action; label: string; pendingText: string; hint?: string; title?: string; variant?: "primary" | "secondary" | "danger" }) {
  const [state, formAction] = useActionState(action, FORM_START);
  return (
    <form action={formAction} className="space-y-3">
      <FormProblems problems={state.problems} title={title} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SubmitButton variant={variant} pendingText={pendingText}>
          {label}
        </SubmitButton>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </div>
    </form>
  );
}

/** Asks for a short reason, then runs the action (for example, reopening a closed month). */
export function ReasonForm({ action, label, pendingText, placeholder }: { action: Action; label: string; pendingText: string; placeholder: string }) {
  const [state, formAction] = useActionState(action, FORM_START);
  return (
    <form action={formAction} key={JSON.stringify(state.values)} className="space-y-3">
      <FormProblems problems={state.problems} title="Not reopened:" />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-64 text-sm">
          <span className="mb-1 block text-muted">Why</span>
          <input name="reason" defaultValue={state.values?.reason ?? ""} maxLength={300} required className="input w-full" placeholder={placeholder} />
        </label>
        <SubmitButton variant="secondary" pendingText={pendingText}>
          {label}
        </SubmitButton>
      </div>
    </form>
  );
}
