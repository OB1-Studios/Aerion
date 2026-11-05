"use client";

import { useActionState } from "react";
import { FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** The Build button for a tax pack. Works without JavaScript; a refusal shows above it. */
export function PackForm({ action, label, hint }: { action: Action; label: string; hint: string }) {
  const [state, formAction] = useActionState(action, FORM_START);
  return (
    <form action={formAction} className="space-y-3">
      <FormProblems problems={state.problems} title="Not built:" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SubmitButton pendingText="Building the pack…">{label}</SubmitButton>
        <span className="text-xs text-muted">{hint}</span>
      </div>
    </form>
  );
}
