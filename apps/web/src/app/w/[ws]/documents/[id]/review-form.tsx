"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { REVIEW_START, type ReviewState } from "@/lib/review";

export interface ReviewField {
  name: string;
  label: string;
  note?: string | undefined;
  value: string;
  /** Low confidence, or not found in the text: worth a second look. */
  doubtful: boolean;
}

/** Check-and-confirm form for one document; the server applies the same checks as the run. */
export function ReviewForm({ action, fields }: { action: (prev: ReviewState, form: FormData) => Promise<ReviewState>; fields: ReviewField[] }) {
  const [state, formAction] = useActionState(action, REVIEW_START);
  return (
    // Keyed by what was sent, so a rejected attempt shows the values the person typed.
    <form action={formAction} key={JSON.stringify(state.values)} className="space-y-3">
      {state.problems.length ? (
        <div className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-ink">
          <b>Not applied yet:</b>
          <ul className="mt-1 list-disc pl-5">
            {state.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3">
        {fields.map((f) => (
          <label key={f.name} className="min-w-0 text-sm">
            <span className="mb-1 flex items-baseline justify-between gap-2 text-muted">
              <span>{f.label}</span>
              {f.doubtful ? <span className="text-xs text-warning">check this</span> : null}
            </span>
            <input name={`f_${f.name}`} defaultValue={state.values?.[f.name] ?? f.value} title={f.note} className={`input w-full ${f.doubtful ? "ring-1 ring-warning" : ""}`} />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="Checking…">Confirm and apply</SubmitButton>
        <span className="text-xs text-muted">Leave a field empty if it isn&apos;t on the document. Amounts like 6400.00, dates like 2026-10-27.</span>
      </div>
    </form>
  );
}
