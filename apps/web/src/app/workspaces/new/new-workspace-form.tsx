"use client";

import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START } from "@/lib/forms";
import { newWorkspace } from "../../actions";

export function NewWorkspaceForm({ defaultName }: { defaultName: string }) {
  const [state, action] = useActionState(newWorkspace, FORM_START);
  const v = state.values ?? { kind: "company" };
  return (
    <form action={action} key={JSON.stringify(state.values)} className="mt-4 space-y-4">
      <FormProblems problems={state.problems} />
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm text-muted">Who is it for?</legend>
        {(
          [
            ["company", "A software house", "A registered company or firm with staff, clients abroad and an ESFCA."],
            ["freelancer", "My freelance work", "One person paid through Payoneer, Upwork or a bank account."],
          ] as const
        ).map(([value, label, text]) => (
          <label key={value} className="flex cursor-pointer gap-3 rounded-xl border border-line p-4 has-[:checked]:border-accent has-[:checked]:bg-accent/5">
            <input type="radio" name="kind" value={value} defaultChecked={(v.kind ?? "company") === value} className="mt-1" />
            <span>
              <span className="font-medium text-ink">{label}</span>
              <span className="mt-1 block text-sm text-muted">{text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field label="Workspace name" hint="What you call the business. You can change it later.">
        <input name="name" defaultValue={v.name ?? ""} placeholder={defaultName} required maxLength={80} className="input w-full" />
      </Field>
      <Field label="Legal name" hint="As registered (or as on your CNIC). Printed on invoices; leave empty to use the name above.">
        <input name="legalName" defaultValue={v.legalName ?? ""} maxLength={160} className="input w-full" />
      </Field>
      <Field label="City">
        <input name="city" defaultValue={v.city ?? ""} maxLength={80} placeholder="Lahore" className="input w-full" />
      </Field>
      <SubmitButton pendingText="Creating…">Create the workspace</SubmitButton>
    </form>
  );
}
