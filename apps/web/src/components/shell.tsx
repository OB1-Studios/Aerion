"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Search across the workspace: invoices, clients, payments, documents, flags and emails.
 * Press "/" anywhere outside a text field to jump here.
 */
export function SearchBox({ base }: { base: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const path = usePathname();
  const sp = useSearchParams();
  const onSearch = path === `${base}/search`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form action={`${base}/search`} method="get" role="search" className="relative">
      <label htmlFor="ws-search" className="sr-only">
        Search this workspace
      </label>
      <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m13 13 4 4" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        id="ws-search"
        name="q"
        type="search"
        key={onSearch ? sp.get("q") : "idle"}
        defaultValue={onSearch ? (sp.get("q") ?? "") : ""}
        placeholder="Search"
        maxLength={80}
        autoComplete="off"
        className="input h-9 pl-8 pr-8"
      />
      <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1.5 text-[11px] leading-4 text-muted lg:block">
        /
      </kbd>
    </form>
  );
}

/** Notifications, as a bell with the unread count beside the logo. */
export function Bell({ href, unread }: { href: string; unread: number }) {
  const path = usePathname();
  const active = path === href;
  return (
    <Link
      href={href}
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      aria-current={active ? "page" : undefined}
      className={`relative grid size-9 place-items-center rounded-md border transition-colors ${active ? "border-accent/40 bg-accent-soft text-ink" : "border-transparent text-muted hover:border-line hover:bg-panel hover:text-ink"}`}
    >
      <svg aria-hidden viewBox="0 0 20 20" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M5 8a5 5 0 0 1 10 0c0 4.5 1.5 6 1.5 6h-13S5 12.5 5 8Z" />
        <path d="M8.3 16.5a1.8 1.8 0 0 0 3.4 0" strokeLinecap="round" />
      </svg>
      {unread ? <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-[18px] text-accent-ink tabular-nums">{unread > 99 ? "99+" : unread}</span> : null}
    </Link>
  );
}
