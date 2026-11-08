"use client";

import { useActionState, useState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START, type FormState } from "@/lib/forms";

/** Invite by email; the link to send appears here once (only a hash of it is kept). */
export function InviteForm({ action, roles }: { action: (prev: FormState, form: FormData) => Promise<FormState>; roles: Array<{ value: string; label: string; text: string }> }) {
  const [state, formAction] = useActionState(action, FORM_START);
  const [copied, setCopied] = useState(false);
  const v = state.values ?? { role: "accountant" };
  return (
    <div className="space-y-3">
      {state.notice ? (
        <div role="status" className="rounded-lg border border-success-line bg-success-soft p-3 text-sm text-ink">
          <p className="mb-2">Invitation ready. Send them this link: it works once, for that email address, for 7 days. It won&apos;t be shown again.</p>
          <div className="flex gap-2">
            <input readOnly value={state.notice} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" className="input min-w-0 flex-1 font-mono text-xs" />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(state.notice ?? "")
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}
      <form action={formAction} key={`${state.saved ?? 0}:${JSON.stringify(state.values)}`} className="space-y-3">
        <FormProblems problems={state.problems} title="Not invited:" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="Their email">
            <input type="email" name="email" defaultValue={v.email} required maxLength={120} autoComplete="off" className="input w-full" />
          </Field>
          <Field label="Role">
            <select name="role" defaultValue={v.role} className="input w-full">
              {roles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <ul className="space-y-0.5 text-xs text-muted">
          {roles.map((r) => (
            <li key={r.value}>
              <b className="font-medium text-ink">{r.label}:</b> {r.text}
            </li>
          ))}
        </ul>
        <SubmitButton pendingText="Creating the link…">Create an invitation link</SubmitButton>
      </form>
    </div>
  );
}
