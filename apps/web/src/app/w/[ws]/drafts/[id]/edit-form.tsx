"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/**
 * The email's subject and text, editable. Saving runs the numbers check on the new text: an
 * amount, date or invoice number that isn't in the records holds the email until it's fixed.
 */
export function DraftEditor({ action, subject, body, cancelHref }: { action: Action; subject: string; body: string; cancelHref: string }) {
  const [state, formAction] = useActionState(action, FORM_START);
  const v = state.values;
  const text = v?.body ?? body;
  return (
    <form action={formAction} key={JSON.stringify(v)} className="space-y-4">
      <FormProblems problems={state.problems} />
      <Field label="Subject">
        <input name="subject" defaultValue={v?.subject ?? subject} maxLength={200} required className="input" autoComplete="off" />
      </Field>
      <Field label="Text" hint="Amounts, dates and invoice numbers must match the records. The numbers check runs when you save, and again just before the email is sent.">
        <textarea name="body" defaultValue={text} rows={Math.min(28, Math.max(12, text.split("\n").length + 2))} maxLength={20000} required spellCheck className="input font-mono text-[13px] leading-relaxed" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingText="Checking the numbers…">Save and check</SubmitButton>
        <Link href={cancelHref} className="btn btn-ghost">
          Cancel
        </Link>
        <span className="text-xs text-muted">An edited email always waits for a person to approve it.</span>
      </div>
    </form>
  );
}
