"use client";

import Link from "next/link";
import { useActionState } from "react";
import { verifySignInCode } from "../../actions";

export function CodeForm({ next, backup }: { next?: string; backup: boolean }) {
  const [state, action, pending] = useActionState(verifySignInCode, undefined);
  return (
    <form action={action} className="mt-4 space-y-3">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <input type="hidden" name="mode" value={backup ? "backup" : "totp"} />
      <label className="block text-sm">
        <span className="mb-1 block text-muted">{backup ? "Backup code" : "Six-digit code"}</span>
        {backup ? (
          <input name="code" required autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={12} className="input font-mono" />
        ) : (
          <input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} className="input font-mono tracking-widest" />
        )}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="trust" className="accent-[var(--accent)]" />
        Don&apos;t ask again on this device for 30 days
      </label>
      {state?.error ? (
        <p role="alert" className="text-sm text-rose-600">
          {state.error}{" "}
          {state.restart ? (
            <Link href={next ? `/login?${new URLSearchParams({ next })}` : "/login"} className="font-medium underline">
              Sign in again
            </Link>
          ) : null}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}
