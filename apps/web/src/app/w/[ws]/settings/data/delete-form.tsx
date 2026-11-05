"use client";

import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

/** The workspace's name, typed out, and the owner's password: deleting can't be undone. */
export function DeleteWorkspaceForm({ action, name }: { action: (prev: FormState, form: FormData) => Promise<FormState>; name: string }) {
  const [state, formAction] = useActionState(action, FORM_START);
  return (
    <form action={formAction} className="space-y-3">
      <FormProblems problems={state.problems} title="Not deleted:" />
      <Field label={`Type the workspace's name: ${name}`}>
        <input name="confirm" defaultValue={state.values?.confirm ?? ""} required autoComplete="off" spellCheck={false} className="input w-full" />
      </Field>
      <Field label="Your password">
        <input name="password" type="password" required autoComplete="current-password" className="input w-full" />
      </Field>
      <SubmitButton variant="danger" pendingText="Deleting…">
        Delete {name} for good
      </SubmitButton>
    </form>
  );
}
