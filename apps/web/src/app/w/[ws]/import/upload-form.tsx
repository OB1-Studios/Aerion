"use client";

import { useActionState } from "react";
import { FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

/** A CSV file to check. Works without JavaScript; a refused file says why above the button. */
export function ImportUploadForm({ action }: { action: (prev: FormState, form: FormData) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, FORM_START);
  return (
    <form action={formAction} className="space-y-3">
      <FormProblems problems={state.problems} title="Not checked:" />
      <label className="block text-sm">
        <span className="mb-1 block text-muted">CSV file</span>
        <input
          type="file"
          name="file"
          required
          accept=".csv,text/csv"
          className="input w-full file:mr-3 file:rounded-md file:border-0 file:bg-canvas file:px-3 file:py-1 file:text-sm file:text-ink"
        />
      </label>
      <SubmitButton variant="secondary" pendingText="Checking every row…">
        Check the file
      </SubmitButton>
    </form>
  );
}
