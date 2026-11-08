"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/**
 * The form's submit button: disabled with a spinner while the action runs. With `confirm`, it
 * asks first, for actions that are hard to take back (sending several emails, resetting).
 */
export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  className = "",
  confirm,
}: {
  children: ReactNode;
  pendingText?: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={confirm ? (e) => void (!window.confirm(confirm) && e.preventDefault()) : undefined}
      className={`btn btn-${variant} ${className}`}
    >
      {pending ? (
        <>
          <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
          {pendingText ?? "Working…"}
        </>
      ) : (
        children
      )}
    </button>
  );
}
