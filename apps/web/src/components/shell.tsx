"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/**
 * Search across the workspace: invoices, clients, payments, documents, flags and emails.
 * Press "/" or Ctrl+K (⌘K on a Mac) anywhere to jump here.
 */
export function SearchBox({ base }: { base: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const path = usePathname();
  const sp = useSearchParams();
  const onSearch = path === `${base}/search`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (!k) {
        if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      }
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form action={`${base}/search`} method="get" role="search" className="relative w-full">
      <label htmlFor="ws-search" className="sr-only">
        Search this workspace
      </label>
      <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-muted" strokeWidth={1.9} />
      <input
        ref={ref}
        id="ws-search"
        name="q"
        type="search"
        key={onSearch ? sp.get("q") : "idle"}
        defaultValue={onSearch ? (sp.get("q") ?? "") : ""}
        placeholder="Search invoices, payments or documents…"
        maxLength={80}
        autoComplete="off"
        className="h-11 w-full rounded-full border border-line bg-panel pl-11 pr-20 text-sm text-ink shadow-card placeholder:text-muted focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/25"
      />
      <kbd aria-hidden className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 font-sans text-xs font-medium text-muted sm:block">
        Ctrl + K
      </kbd>
    </form>
  );
}

const round = "relative grid size-10 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Notifications: a bell with a dot while something is unread. */
export function Bell({ href, unread, onDark }: { href: string; unread: number; onDark?: boolean }) {
  const path = usePathname();
  const active = path === href;
  return (
    <Link
      href={href}
      title={unread ? `${unread} unread` : "Notifications"}
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      aria-current={active ? "page" : undefined}
      className={`${round} ${onDark ? "text-sidebar-ink hover:bg-white/10" : active ? "bg-accent-soft text-accent" : "text-ink hover:bg-panel hover:shadow-card"}`}
    >
      <Icon name="bell" className="size-[21px]" strokeWidth={1.8} />
      {unread ? <span aria-hidden className={`absolute right-2 top-2 size-2.5 rounded-full bg-danger ring-2 ${onDark ? "ring-sidebar" : "ring-canvas"}`} /> : null}
    </Link>
  );
}

/** Light is the default; this switches to dark and back, and remembers the choice in this browser. */
export function ThemeToggle({ onDark }: { onDark?: boolean }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      if (next) localStorage.setItem("aerion-theme", "dark");
      else localStorage.removeItem("aerion-theme");
    } catch {
      // Storage can be off (private windows); the switch still works for this page.
    }
  };
  return (
    <button type="button" onClick={flip} aria-label={dark ? "Switch to the light theme" : "Switch to the dark theme"} title={dark ? "Light theme" : "Dark theme"} className={`${round} ${onDark ? "text-sidebar-ink hover:bg-white/10" : "bg-sunken text-ink hover:bg-panel hover:shadow-card"}`}>
      <Icon name={dark ? "moon" : "sun"} className="size-[20px]" strokeWidth={1.8} />
    </button>
  );
}
