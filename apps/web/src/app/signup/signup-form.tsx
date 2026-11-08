"use client";

import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { FORM_START } from "@/lib/forms";
import { signUp } from "../actions";

export function SignUpForm({ next, email }: { next?: string; email?: string }) {
  const [state, action] = useActionState(signUp, FORM_START);
  const v = state.values ?? (email ? { email } : {});
  return (
    <form action={action} key={JSON.stringify(state.values)} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <FormProblems problems={state.problems} title="Not yet:" />
      <Field label="Your name">
        <input name="name" defaultValue={v.name} required maxLength={80} autoComplete="name" className="input w-full" />
      </Field>
      <Field label="Email">
        <input name="email" type="email" defaultValue={v.email} required autoComplete="email" className="input w-full" />
      </Field>
      <Field label="Password" hint="At least 10 characters.">
        <input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" className="input w-full" />
      </Field>
      <label className="flex gap-2 text-sm">
        <input type="checkbox" name="terms" defaultChecked={v.terms === "on"} className="mt-1 accent-[var(--accent)]" />
        <span>
          I understand Aerion is in an early pilot. I&apos;ll only upload documents I&apos;m allowed to share, and I can export or delete my workspace and its documents at any time. Aerion is not tax advice.
        </span>
      </label>
      <label className="flex gap-2 text-sm">
        <input type="checkbox" name="ai" defaultChecked={state.values ? v.ai === "on" : true} className="mt-1 accent-[var(--accent)]" />
        <span>
          Read my documents with AI on Vultr Serverless Inference (in Vultr&apos;s US data centres). <span className="text-muted">Without this only the built-in layout rules read them, and more documents will need typing in by hand. Either way, numbers are always checked against the document.</span>
        </span>
      </label>
      <SubmitButton pendingText="Creating your account…" className="w-full">
        Create the account
      </SubmitButton>
    </form>
  );
}
