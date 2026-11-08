"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";

/**
 * A list's filters, as a GET form: the address keeps the view, so it can be bookmarked or shared.
 * Choosing from a menu applies it at once; the search box applies on Enter or with the button.
 */
export function FilterForm({ children, keep = {}, clearHref, active, label = "Filters" }: { children: ReactNode; keep?: Record<string, string | undefined>; clearHref?: string; active?: boolean; label?: string }) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      method="get"
      role="search"
      aria-label={label}
      onChange={(e) => {
        if ((e.target as HTMLElement).tagName === "SELECT") ref.current?.requestSubmit();
      }}
      className="mb-4 flex flex-wrap items-end gap-2"
    >
      {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      {children}
      <button type="submit" className="btn btn-secondary">
        Apply
      </button>
      {active && clearHref ? (
        <Link href={clearHref} className="btn btn-ghost">
          Clear
        </Link>
      ) : null}
    </form>
  );
}

/** A labelled menu inside a FilterForm. */
export function FilterSelect({ name, label, value, options, className = "" }: { name: string; label: string; value: string; options: Array<[string, string]>; className?: string }) {
  return (
    <label className={`block text-xs text-muted ${className}`}>
      <span className="mb-1 block">{label}</span>
      <select name={name} defaultValue={value} className="input h-9 py-1.5 pr-8">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The search box inside a FilterForm. */
export function FilterSearch({ name = "q", label = "Search", value, placeholder, className = "" }: { name?: string; label?: string; value: string; placeholder: string; className?: string }) {
  return (
    <label className={`block min-w-0 flex-1 basis-56 text-xs text-muted ${className}`}>
      <span className="mb-1 block">{label}</span>
      <input type="search" name={name} defaultValue={value} placeholder={placeholder} maxLength={80} className="input h-9" />
    </label>
  );
}
