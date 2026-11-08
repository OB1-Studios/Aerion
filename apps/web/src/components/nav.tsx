"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  count?: number;
  /** A count that needs someone soon is shown in the accent, the rest quietly. */
  urgent?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

function Links({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <div className="space-y-4">
      {groups.map((g, gi) => (
        <div key={g.label ?? gi}>
          {g.label ? <div className="eyebrow mb-1.5 px-3">{g.label}</div> : null}
          <ul className="space-y-px">
            {g.items.map((it) => {
              const active = path === it.href || path.startsWith(`${it.href}/`);
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex items-center justify-between gap-3 rounded-md px-3 py-[5px] text-sm transition-colors ${active ? "bg-accent-soft font-medium text-ink" : "text-muted hover:bg-panel hover:text-ink"}`}
                  >
                    {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-accent" /> : null}
                    {it.label}
                    {it.count ? (
                      <span className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums ${it.urgent ? "bg-accent text-accent-ink" : "bg-line text-ink"}`}>{it.count}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Grouped links in the sidebar on wide screens. */
export function WorkspaceNav({ groups }: { groups: NavGroup[] }) {
  return (
    <nav aria-label="Workspace" className="hidden lg:block">
      <Links groups={groups} />
    </nav>
  );
}

/** On phones and tablets: a menu button that opens the same groups, and closes after a choice. */
export function MobileNav({ groups, header, current }: { groups: NavGroup[]; header: ReactNode; current: string }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const pending = groups.flatMap((g) => g.items).reduce((n, it) => n + (it.urgent ? (it.count ?? 0) : 0), 0);
  return (
    <div className="lg:hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="mobile-nav" className="btn btn-secondary w-full justify-between">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="text-muted">☰</span>
          <span className="truncate">{current}</span>
        </span>
        {pending ? <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-accent-ink tabular-nums">{pending}</span> : null}
      </button>
      {open ? (
        <div id="mobile-nav" className="mt-2 rounded-[10px] border border-line bg-panel p-3">
          {header}
          <nav aria-label="Workspace" className="mt-3">
            <Links groups={groups} onNavigate={() => setOpen(false)} />
          </nav>
        </div>
      ) : null}
    </div>
  );
}

/** The label of the section the page belongs to, for the closed mobile menu. */
export function useCurrentLabel(groups: NavGroup[]) {
  const path = usePathname();
  return groups.flatMap((g) => g.items).find((it) => path === it.href || path.startsWith(`${it.href}/`))?.label;
}

export function MobileNavWithLabel({ groups, header, fallback }: { groups: NavGroup[]; header: ReactNode; fallback: string }) {
  const label = useCurrentLabel(groups);
  return <MobileNav groups={groups} header={header} current={label ?? fallback} />;
}
