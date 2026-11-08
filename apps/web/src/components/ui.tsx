import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

/** The page's title, in the display serif, with what it's for underneath and its main actions on the right. */
export function PageHeader({ title, sub, actions, eyebrow }: { title: string; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
        <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {sub ? <p className="mt-1.5 text-sm leading-relaxed text-muted">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, className, pad = true, id, sub }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; id?: string; sub?: ReactNode }) {
  return (
    <section id={id} className={cx("scroll-mt-4 overflow-hidden rounded-[10px] border border-line bg-panel", className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

const TONES = {
  gray: "bg-stone-100 text-stone-700 ring-stone-200 dark:bg-stone-800/70 dark:text-stone-300 dark:ring-stone-700",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
  amber: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
  red: "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900",
  blue: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-900",
  violet: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-900",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "gray", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone])}>
      {children}
    </span>
  );
}

export const severityTone = (s: string): Tone => (s === "high" ? "red" : s === "medium" ? "amber" : "blue");
const STATUS_TONES: Record<string, Tone> = {
  succeeded: "green",
  sent: "green",
  paid: "green",
  matched: "green",
  on_file: "green",
  resolved: "green",
  parsed: "green",
  done: "green",
  closed: "green",
  transfer: "blue",
  actioned: "blue",
  approved: "blue",
  scheduled: "blue",
  running: "blue",
  queued: "blue",
  requested: "blue",
  part_paid: "amber",
  draft: "amber",
  open: "amber",
  missing: "amber",
  needs_review: "amber",
  unmatched: "amber",
  pending: "gray",
  ignored: "gray",
  cancelled: "gray",
  dismissed: "gray",
  skipped: "gray",
  void: "gray",
  failed: "red",
  blocked: "red",
  rejected: "red",
  wrong_code: "red",
  duplicate: "red",
};
export const statusTone = (s: string): Tone => STATUS_TONES[s] ?? "gray";
const sentence = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function Status({ value, label }: { value: string; label?: string }) {
  return <Badge tone={statusTone(value)}>{label ?? sentence(value)}</Badge>;
}

const STAT_TONE = {
  good: { text: "text-emerald-700 dark:text-emerald-400" },
  warn: { text: "text-amber-700 dark:text-amber-400" },
  bad: { text: "text-rose-700 dark:text-rose-400" },
} as const;

/** One figure with its label and what it means. With `href`, the whole tile opens where it's dealt with. */
export function Stat({ label, value, hint, tone, href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "warn" | "bad"; href?: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-[13px] font-medium text-muted">
        {label}
        {href ? (
          <span aria-hidden className="text-muted transition-transform group-hover:translate-x-0.5">
            →
          </span>
        ) : null}
      </div>
      <div className={cx("mt-1.5 text-[26px] font-semibold leading-none tracking-tight tabular-nums", tone ? STAT_TONE[tone].text : "text-ink")}>{value}</div>
      {hint ? <div className="mt-2 text-xs leading-snug text-muted">{hint}</div> : null}
    </>
  );
  const cls = "group relative block overflow-hidden rounded-[10px] border border-line bg-panel p-4";
  return href ? (
    <Link href={href} className={cx(cls, "transition-colors hover:border-line-strong hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong bg-sunken/60 px-4 py-8 text-center text-sm text-muted">
      {children}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * A table on a panel. `num` lists the columns (by index) that hold amounts or counts: their
 * headings are right-aligned, and so should their cells be (`text-right`).
 */
// Written out in full so Tailwind generates them: on a phone, hide column n (its header and cells).
const PHONE_HIDE: Record<number, string> = {
  1: "max-sm:[&_tr>*:nth-child(2)]:hidden",
  2: "max-sm:[&_tr>*:nth-child(3)]:hidden",
  3: "max-sm:[&_tr>*:nth-child(4)]:hidden",
  4: "max-sm:[&_tr>*:nth-child(5)]:hidden",
  5: "max-sm:[&_tr>*:nth-child(6)]:hidden",
  6: "max-sm:[&_tr>*:nth-child(7)]:hidden",
  7: "max-sm:[&_tr>*:nth-child(8)]:hidden",
};

/**
 * A data table. `num` right-aligns those columns' headers; `phoneHidden` drops those columns on a
 * phone, for tables whose first cell repeats what matters in a line of its own there.
 */
export function Table({ head, children, dense, num = [], phoneHidden = [] }: { head: ReactNode[]; children: ReactNode; dense?: boolean; num?: number[]; phoneHidden?: number[] }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full text-left text-sm", dense ? "[&_td]:py-1.5" : "[&_td]:py-2.5", ...phoneHidden.map((i) => PHONE_HIDE[i]))}>
        <thead>
          <tr className="border-b border-line bg-sunken text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} scope="col" className={cx("whitespace-nowrap px-3 py-2 font-medium first:pl-4 last:pr-4", num.includes(i) && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line [&_td]:px-3 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_tr]:transition-colors [&_tr:hover]:bg-sunken/70">{children}</tbody>
      </table>
    </div>
  );
}

/** The page number from the address: 1 when missing or nonsense. */
export const pageOf = (v: string | undefined) => Math.max(1, Math.min(10_000, Number.parseInt(v ?? "1", 10) || 1));

/** "51–100 of 230" with previous and next, under a list that can grow long. */
export function Pager({ page, pageSize, total, href, noun = "rows" }: { page: number; pageSize: number; total: number; href: (page: number) => string; noun?: string }) {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-sm">
      <span className="tabular-nums text-muted">{pages > 1 ? `${from.toLocaleString("en")}–${to.toLocaleString("en")} of ${total.toLocaleString("en")} ${noun}` : `${total.toLocaleString("en")} ${noun}`}</span>
      {pages > 1 ? (
        <span className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} className="btn btn-secondary h-8 px-3" rel="prev">
              ← Previous
            </Link>
          ) : null}
          <span className="text-xs tabular-nums text-muted">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={href(page + 1)} className="btn btn-secondary h-8 px-3" rel="next">
              Next →
            </Link>
          ) : null}
        </span>
      ) : null}
    </nav>
  );
}

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <Link href={href} className={cx("btn", variant === "primary" ? "btn-primary" : "btn-secondary")}>
      {children}
    </Link>
  );
}

export function KeyValues({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(7rem,38%)_minmax(0,1fr)]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const NOTICE = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100",
  violet: "border-violet-200 bg-violet-50 text-violet-950 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-100",
  red: "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-100",
  amber: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100",
} as const;

export function Notice({ tone = "green", children }: { tone?: keyof typeof NOTICE; children: ReactNode }) {
  return (
    <div role={tone === "red" ? "alert" : "status"} className={cx("mb-4 rounded-md border px-4 py-2.5 text-sm", NOTICE[tone])}>
      {children}
    </div>
  );
}

/** A segmented row of views of one list (Open, Overdue, All…), each with its count when known. */
export function Tabs({ items, label = "Views" }: { items: Array<{ href: string; label: string; active: boolean; count?: number }>; label?: string }) {
  return (
    <nav aria-label={label} className="mb-4 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-sunken p-0.5">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx("flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors", t.active ? "bg-panel font-medium text-ink shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink")}
        >
          {t.label}
          {t.count != null ? <span className="text-xs tabular-nums text-muted">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** Marks where a value came from, so nobody mistakes a suggestion or a sample for a record. */
export function Provenance({ kind }: { kind: "simulated" | "model" | "rules" | "template" | "person" | "edited" }) {
  const t = {
    simulated: { tone: "violet" as const, label: "Simulated", title: "Fictional demo data" },
    model: { tone: "blue" as const, label: "Read by model", title: "Fields extracted by the language model, each quoting its source text, then checked by code" },
    rules: { tone: "gray" as const, label: "Read by rules", title: "Fields extracted by the built-in layout rules, no model involved" },
    template: { tone: "gray" as const, label: "From a template", title: "Written from a fixed template; every number filled and checked by code" },
    person: { tone: "green" as const, label: "Confirmed by a person", title: "A person checked or corrected these values" },
    edited: { tone: "green" as const, label: "Edited by a person", title: "A person rewrote this text; the numbers check ran on their words" },
  }[kind];
  return (
    <Badge tone={t.tone} title={t.title}>
      {t.label}
    </Badge>
  );
}
