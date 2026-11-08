"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  count?: number;
  /** A count that needs someone soon is shown in gold, the rest quietly. */
  urgent?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** The sidebar's links, on dark green: the current page is the gold one. */
function Links({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <div className="space-y-5">
      {groups.map((g, gi) => (
        <div key={g.label ?? gi}>
          {g.label ? <div className="mb-1.5 px-3 text-[10.5px] font-bold uppercase tracking-[0.14em] text-sidebar-muted/80">{g.label}</div> : null}
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active = isActive(path, it.href);
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gold ${
                      active ? "bg-[linear-gradient(100deg,#dcbd80,#c69c58)] font-bold text-[#1c2823] shadow-[0_2px_10px_rgb(0_0_0/0.18)]" : "font-medium text-sidebar-ink/85 hover:bg-white/[0.07] hover:text-white"
                    }`}
                  >
                    <Icon name={it.icon} className={`size-[19px] shrink-0 ${active ? "text-[#1c2823]" : "text-sidebar-muted group-hover:text-white"}`} strokeWidth={active ? 2 : 1.7} />
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.count ? (
                      <span
                        className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-bold leading-5 tabular-nums ${
                          active ? "bg-[#1c2823]/15 text-[#1c2823]" : it.urgent ? "bg-gold text-[#1c2823]" : "bg-white/12 text-sidebar-ink"
                        }`}
                      >
                        {it.count}
                      </span>
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
    <nav aria-label="Workspace">
      <Links groups={groups} />
    </nav>
  );
}

/**
 * On phones and tablets: a menu button that slides the same sidebar in from the left, and closes
 * after a choice, on Escape, or on a tap outside it.
 */
export function MobileNav({ groups, header, footer }: { groups: NavGroup[]; header: ReactNode; footer?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);
  const pending = groups.flatMap((g) => g.items).reduce((n, it) => n + (it.urgent ? (it.count ?? 0) : 0), 0);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={pending ? `Menu, ${pending} need you` : "Menu"}
        className="relative grid size-10 place-items-center rounded-lg text-sidebar-ink hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-gold"
      >
        <Icon name="menu" className="size-6" />
        {pending ? <span className="absolute right-1 top-1 min-w-4 rounded-full bg-gold px-1 text-center text-[10px] font-bold leading-4 text-[#1c2823] tabular-nums">{pending}</span> : null}
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="Close the menu" onClick={() => setOpen(false)} className="absolute inset-0 bg-[#0c1a15]/55" />
          <div id="mobile-nav" role="dialog" aria-modal="true" aria-label="Menu" className="scroll-sidebar absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] flex-col overflow-y-auto bg-[linear-gradient(180deg,var(--sidebar),var(--sidebar-deep))] px-4 pb-4 pt-3 shadow-pop">
            <div className="mb-3 flex items-center justify-between">
              {header}
              <button type="button" onClick={() => setOpen(false)} aria-label="Close the menu" className="grid size-10 place-items-center rounded-lg text-sidebar-ink hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-gold">
                <Icon name="close" className="size-6" />
              </button>
            </div>
            <nav aria-label="Workspace" className="flex-1">
              <Links groups={groups} onNavigate={() => setOpen(false)} />
            </nav>
            {footer ? <div className="mt-5">{footer}</div> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
