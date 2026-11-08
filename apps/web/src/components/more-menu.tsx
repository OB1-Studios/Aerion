"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

/**
 * The "⋯" beside a row's one main action: the other things you can do with it, in a small panel.
 * Closes on Escape or a click outside.
 */
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={`grid size-9 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-accent ${open ? "bg-sunken text-ink" : "text-muted hover:bg-sunken hover:text-ink"}`}
      >
        <Icon name="more" className="size-5" />
      </button>
      {open ? <div className="absolute right-0 top-full z-30 mt-1 w-[min(19rem,80vw)] rounded-lg border border-line bg-panel p-2 text-sm shadow-pop">{children}</div> : null}
    </div>
  );
}
