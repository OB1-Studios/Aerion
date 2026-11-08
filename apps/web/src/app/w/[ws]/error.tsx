"use client";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-xl border border-danger-line bg-danger-soft p-6 text-ink">
      <h1 className="font-semibold">That didn&apos;t work</h1>
      <p className="mt-1 text-sm">{error.message || "Something went wrong."}</p>
      <button onClick={reset} className="btn btn-secondary mt-4">
        Try again
      </button>
    </div>
  );
}
