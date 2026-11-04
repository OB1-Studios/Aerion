"use client";

import { useActionState } from "react";
import { signInWithPassword } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(signInWithPassword, undefined);
  return (
    <form action={action} className="mt-4 space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-muted">Email</span>
        <input name="email" type="email" required autoComplete="username" className="input" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">Password</span>
        <input name="password" type="password" required autoComplete="current-password" className="input" />
      </label>
      {state?.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
