"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  count?: number;
}

/** Sidebar links (a scrolling row on phones) with the current section highlighted. */
export function WorkspaceNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Workspace" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
      {items.map((it) => {
        const active = path === it.href || path.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors ${active ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-panel hover:text-ink"}`}
          >
            {it.label}
            {it.count ? <span className={`rounded-full px-1.5 text-xs tabular-nums ${active ? "bg-accent text-accent-ink" : "bg-line text-ink"}`}>{it.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
