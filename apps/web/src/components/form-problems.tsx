/** "Not saved yet" box listing what to fix, in the words the server used. */
export function FormProblems({ problems, title = "Not saved yet:" }: { problems: string[]; title?: string }) {
  if (!problems.length) return null;
  return (
    <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
      <b>{title}</b>
      <ul className="mt-1 list-disc pl-5">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

/** A labelled field; the input goes inside. */
export function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 text-sm ${className}`}>
      <span className="mb-1 block text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
