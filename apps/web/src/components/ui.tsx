import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

/** The page's title in the display serif, a terracotta rule beside it, what it's for underneath and its main actions on the right. */
export function PageHeader({ title, sub, actions, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 max-w-3xl border-l-2 border-terracotta/80 pl-4 sm:pl-5">
        {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
        <h1 className="font-display text-[30px] leading-[1.12] text-ink sm:text-[36px]">{title}</h1>
        {sub ? <p className="mt-2 text-[15px] leading-relaxed text-muted">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A panel of related things: a serif title (with an icon on the dashboard), what it covers, and actions on the right. */
export function Card({ title, actions, children, className, pad = true, id, sub, icon }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; id?: string; sub?: ReactNode; icon?: IconName }) {
  return (
    <section id={id} className={cx("scroll-mt-4 overflow-hidden rounded-xl border border-line bg-panel shadow-card", className)}>
      {title || actions ? (
        <header className={cx("flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-5 pt-4", pad ? "pb-1" : "border-b border-line pb-3.5")}>
          <div className="flex min-w-0 items-start gap-2.5">
            {icon ? <Icon name={icon} className="mt-0.5 size-[22px] shrink-0 text-gold" strokeWidth={1.8} /> : null}
            <div className="min-w-0">
              <h2 className="font-display text-[19px] leading-snug text-ink">{title}</h2>
              {sub ? <p className="mt-0.5 text-[13px] text-muted">{sub}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2 pt-0.5 text-sm">{actions}</div> : null}
        </header>
      ) : null}
      <div className={pad ? "px-5 pb-5 pt-3" : ""}>{children}</div>
    </section>
  );
}

/** "View all →" and the like, in a card's header. */
export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 whitespace-nowrap rounded font-semibold text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      {children}
      <Icon name="arrowRight" className="size-4" strokeWidth={2} />
    </Link>
  );
}

const TONES = {
  gray: "bg-sunken text-muted ring-line",
  green: "bg-success-soft text-success ring-success-line",
  amber: "bg-warning-soft text-warning ring-warning-line",
  red: "bg-danger-soft text-danger ring-danger-line",
  blue: "bg-info-soft text-info ring-info-line",
  violet: "bg-violet-soft text-violet ring-violet-line",
} as const;
export type Tone = keyof typeof TONES;

/** A status in words, on a soft pill of its colour; the words carry the meaning, never the colour alone. */
export function Badge({ tone = "gray", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset", TONES[tone])}>
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
  good: { text: "text-success", chip: "bg-success-soft text-success", line: "var(--success)" },
  warn: { text: "text-warning", chip: "bg-warning-soft text-warning", line: "var(--warning)" },
  bad: { text: "text-danger", chip: "bg-danger-soft text-danger", line: "var(--danger)" },
  brand: { text: "text-ink", chip: "bg-accent-soft text-accent", line: "var(--accent)" },
  gold: { text: "text-ink", chip: "bg-gold-soft text-gold", line: "var(--gold)" },
  violet: { text: "text-ink", chip: "bg-violet-soft text-violet", line: "var(--violet)" },
} as const;
export type StatTone = keyof typeof STAT_TONE;

/** A small line of real values, oldest first: the shape of a series, no axis. */
export function Sparkline({ values, color, label }: { values: number[]; color: string; label: string }) {
  if (values.length < 2) return null;
  const w = 84;
  const h = 34;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={label} className="shrink-0 overflow-visible">
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={color} opacity="0.08" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One figure with its label and what it means. With `icon`, it sits in a tinted circle and `tone`
 * colours that; without, `tone` colours the figure. With `href`, the whole tile opens where it's dealt with.
 */
export function Stat({ label, value, hint, tone, href, icon, spark }: { label: string; value: ReactNode; hint?: ReactNode; tone?: StatTone; href?: string; icon?: IconName; spark?: { values: number[]; label: string } }) {
  const t = tone ? STAT_TONE[tone] : null;
  const body = (
    <>
      {icon ? (
        <span className={cx("grid size-11 shrink-0 place-items-center rounded-full", t ? t.chip : "bg-accent-soft text-accent")}>
          <Icon name={icon} className="size-[22px]" strokeWidth={1.8} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2 text-[13px] font-semibold text-ink/80">
          {label}
          {href && !icon ? (
            <span aria-hidden className="text-muted transition-transform group-hover:translate-x-0.5">
              →
            </span>
          ) : null}
        </span>
        <span className={cx("mt-1.5 block font-display text-[28px] leading-none tabular-nums", icon || !t ? "text-ink" : t.text)}>{value}</span>
        {hint ? <span className="mt-2 block text-xs leading-snug text-muted">{hint}</span> : null}
      </span>
      {spark && spark.values.length > 1 ? (
        <span className="self-end">
          <Sparkline values={spark.values} color={t?.line ?? "var(--accent)"} label={spark.label} />
        </span>
      ) : null}
    </>
  );
  const cls = "group relative flex items-start gap-3.5 overflow-hidden rounded-xl border border-line bg-panel p-4 shadow-card sm:p-5";
  return href ? (
    <Link href={href} className={cx(cls, "transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-sunken/60 px-4 py-8 text-center text-sm text-muted">
      {children}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

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
 * A data table. `num` lists the columns (by index) that hold amounts or counts: their headings are
 * right-aligned, and so should their cells be (`text-right`). `phoneHidden` drops those columns on a
 * phone, for tables whose first cell repeats what matters in a line of its own there.
 */
export function Table({ head, children, dense, num = [], phoneHidden = [] }: { head: ReactNode[]; children: ReactNode; dense?: boolean; num?: number[]; phoneHidden?: number[] }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full text-left text-sm", dense ? "[&_td]:py-2" : "[&_td]:py-3", ...phoneHidden.map((i) => PHONE_HIDE[i]))}>
        <thead>
          <tr className="border-b border-line bg-sunken text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} scope="col" className={cx("whitespace-nowrap px-3 py-2.5 font-semibold first:pl-5 last:pr-5", num.includes(i) && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line [&_td]:px-3 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_tr]:transition-colors [&_tr:hover]:bg-sunken/60">{children}</tbody>
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
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm">
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
  green: "border-success-line bg-success-soft text-ink",
  violet: "border-violet-line bg-violet-soft text-ink",
  red: "border-danger-line bg-danger-soft text-ink",
  amber: "border-warning-line bg-warning-soft text-ink",
} as const;
const NOTICE_ICON = { green: ["checkCircle", "text-success"], violet: ["clock", "text-violet"], red: ["alert", "text-danger"], amber: ["warning", "text-warning"] } as const;

export function Notice({ tone = "green", children }: { tone?: keyof typeof NOTICE; children: ReactNode }) {
  const [icon, iconTone] = NOTICE_ICON[tone];
  return (
    <div role={tone === "red" ? "alert" : "status"} className={cx("mb-5 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm", NOTICE[tone])}>
      <Icon name={icon} className={cx("mt-px size-[18px] shrink-0", iconTone)} strokeWidth={1.9} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A segmented row of views of one list (Open, Overdue, All…), each with its count when known. */
export function Tabs({ items, label = "Views" }: { items: Array<{ href: string; label: string; active: boolean; count?: number }>; label?: string }) {
  return (
    <nav aria-label={label} className="mb-4 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-sunken p-1">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx("flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors", t.active ? "bg-panel font-semibold text-ink shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(23_33_29/0.06)]" : "text-muted hover:text-ink")}
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
