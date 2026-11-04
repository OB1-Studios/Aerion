"use client";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100">
      <h1 className="font-semibold">That didn&apos;t work</h1>
      <p className="mt-1 text-sm">{error.message || "Something went wrong."}</p>
      <button onClick={reset} className="btn btn-secondary mt-4">
        Try again
      </button>
    </div>
  );
}
