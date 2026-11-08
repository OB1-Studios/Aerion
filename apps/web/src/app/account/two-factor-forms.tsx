"use client";

import { useActionState } from "react";
import { Field, FormProblems } from "@/components/form-problems";
import { SubmitButton } from "@/components/submit-button";
import { setupTwoFactor, type CodesState, type SetupState } from "./actions";

const SETUP_START: SetupState = { step: "password", problems: [] };
const CODES_START: CodesState = { problems: [] };

function PasswordField() {
  return (
    <Field label="Your password" className="flex-1 basis-56">
      <input name="password" type="password" required autoComplete="current-password" className="input w-full" />
    </Field>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-ink sm:grid-cols-3" aria-label="Backup codes">
      {codes.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  );
}

/** Password first; then the QR code, the backup codes, and the first code from the app to finish. */
export function TwoFactorSetup({ required }: { required?: string }) {
  const [state, action] = useActionState(setupTwoFactor, SETUP_START);
  // The workspace that asked for it, if any: the page links back to it once it's on.
  const back = required ? <input type="hidden" name="required" value={required} /> : null;
  if (state.step === "password" || !state.uri) {
    return (
      <form action={action} className="space-y-3">
        <FormProblems problems={state.problems} title="Not turned on:" />
        <input type="hidden" name="step" value="start" />
        {back}
        <div className="flex flex-wrap items-end gap-3">
          <PasswordField />
          <SubmitButton pendingText="Checking…">Set up two-factor sign-in</SubmitButton>
        </div>
      </form>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="step" value="verify" />
      {back}
      <input type="hidden" name="uri" value={state.uri} />
      <input type="hidden" name="codes" value={(state.backupCodes ?? []).join(" ")} />
      <ol className="space-y-6">
        <li className="space-y-2">
          <h3 className="font-medium text-ink">1. Add this account to your authenticator app</h3>
          <div className="flex flex-wrap items-start gap-4">
            {/* Built on the server from the authenticator link; dark on white so phones can read it. */}
            <div className="size-44 shrink-0 overflow-hidden rounded-lg border border-line bg-white" dangerouslySetInnerHTML={{ __html: state.qr ?? "" }} />
            <div className="min-w-0 flex-1 basis-56 space-y-2 text-sm">
              <p>Scan the code with Google Authenticator, Microsoft Authenticator, 1Password or any app that shows six-digit sign-in codes.</p>
              <p className="text-muted">Can&apos;t scan it? Add an account by hand with this key (time-based):</p>
              <code className="block break-words rounded-md bg-canvas px-2 py-1.5 font-mono text-ink">{state.key}</code>
              <a href={state.uri} className="link inline-block">
                On this phone? Open it in the authenticator app
              </a>
            </div>
          </div>
        </li>
        {state.backupCodes?.length ? (
          <li className="space-y-2">
            <h3 className="font-medium text-ink">2. Keep the backup codes</h3>
            <p className="text-sm text-muted">If the phone is lost, each code signs you in once. Print them or keep them in a password manager: they aren&apos;t shown again.</p>
            <BackupCodes codes={state.backupCodes} />
          </li>
        ) : null}
        <li className="space-y-2">
          <h3 className="font-medium text-ink">{state.backupCodes?.length ? "3" : "2"}. Enter the code the app shows</h3>
          <FormProblems problems={state.problems} title="Not turned on yet:" />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Six-digit code" className="w-44">
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required className="input w-full font-mono tracking-widest" />
            </Field>
            <SubmitButton pendingText="Checking…">Turn on</SubmitButton>
          </div>
        </li>
      </ol>
    </form>
  );
}

/** A password and one button: new backup codes, or turning two-factor sign-in off. */
export function PasswordAction({
  action,
  label,
  pendingText,
  title,
  variant = "secondary",
}: {
  action: (prev: CodesState, form: FormData) => Promise<CodesState>;
  label: string;
  pendingText: string;
  title: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction] = useActionState(action, CODES_START);
  return (
    <form action={formAction} className="space-y-3">
      <FormProblems problems={state.problems} title={title} />
      {state.backupCodes?.length ? (
        <div role="status" className="space-y-2 rounded-lg border border-success-line bg-success-soft p-3">
          <p className="text-sm text-ink">New backup codes. The old ones no longer work. Keep these somewhere safe: they aren&apos;t shown again.</p>
          <BackupCodes codes={state.backupCodes} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <PasswordField />
        <SubmitButton variant={variant} pendingText={pendingText}>
          {label}
        </SubmitButton>
      </div>
    </form>
  );
}
