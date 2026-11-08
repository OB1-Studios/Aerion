import type { CSSProperties, ReactNode } from "react";
import { cx, Table } from "./ui";

/**
 * Small charts in plain HTML and CSS: they render on the server and need no JavaScript.
 * They follow the dataviz rules the app uses everywhere:
 * - bars at most 24px thick, with a 4px rounded end and a square baseline, and a 2px gap between stacked parts
 * - hairline grids, and text in text colours (never the series colour)
 * - a legend whenever there are two or more series
 * - a tooltip on hover and on keyboard focus
 * - the same numbers in a table under every chart, so no value is only in a tooltip
 */

export interface Tip {
  /** The value: the strong first line. */
  value: ReactNode;
  /** What it is, and any breakdown. */
  lines?: ReactNode[];
}

function Tooltip({ tip, className }: { tip: Tip; className?: string }) {
  return (
    <div
      aria-hidden
      className={cx(
        "pointer-events-none invisible absolute z-20 w-max max-w-64 rounded-lg border border-line bg-panel px-3 py-2 text-xs opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100",
        className,
      )}
    >
      <div className="font-semibold tabular-nums text-ink">{tip.value}</div>
      {tip.lines?.map((l, i) => (
        <div key={i} className="mt-0.5 text-muted">
          {l}
        </div>
      ))}
    </div>
  );
}

/** A short stroke of the series colour, keying a tooltip row. */
export function LineKey({ color }: { color: string }) {
  return <span aria-hidden className="mr-1.5 inline-block h-0.5 w-3 rounded-full align-middle" style={{ background: color }} />;
}

/** Swatches mirror the marks: small squares for bars. */
export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: it.color }} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  sub?: ReactNode;
  /** Stacked parts, from the baseline out. Parts at zero or below draw nothing. */
  parts: Array<{ value: number; color: string }>;
  /** The value printed at the tip. */
  tipLabel: ReactNode;
  /** Everything the tooltip says, for screen readers. */
  aria: string;
  tip: Tip;
}

/** Horizontal bars, one per row, all from one baseline. Room is kept for the value at the tip. */
export function BarList({ rows, labelWidth = "9rem" }: { rows: BarRow[]; labelWidth?: string }) {
  const total = (r: BarRow) => r.parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const scale = Math.max(0, ...rows.map(total));
  return (
    <div className="space-y-2.5" style={{ "--label-w": labelWidth } as CSSProperties}>
      {rows.map((r) => {
        const parts = r.parts.filter((p) => p.value > 0);
        return (
          <div key={r.key} role="group" tabIndex={0} aria-label={r.aria} className="group relative grid items-center gap-x-3 gap-y-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent sm:grid-cols-[var(--label-w)_1fr]">
            <div className="min-w-0 text-sm leading-tight text-ink">
              {r.label}
              {r.sub ? <div className="text-xs text-muted">{r.sub}</div> : null}
            </div>
            <div className="flex h-7 items-center border-l border-line">
              {parts.length ? (
                <div className="flex h-5 gap-[2px] transition-[filter] group-hover:brightness-110 group-focus-visible:brightness-110" style={{ width: `calc((100% - 7.5rem) * ${scale > 0 ? total(r) / scale : 0})` }}>
                  {parts.map((p, i) => (
                    <div key={i} className={cx("h-full min-w-px", i === parts.length - 1 && "rounded-r-[4px]")} style={{ flex: `${p.value} 1 0`, background: p.color }} />
                  ))}
                </div>
              ) : null}
              <div className="ml-2 whitespace-nowrap text-xs tabular-nums text-ink">{r.tipLabel}</div>
            </div>
            <Tooltip tip={r.tip} className="left-0 top-full mt-1 sm:left-[calc(var(--label-w)+0.75rem)]" />
          </div>
        );
      })}
    </div>
  );
}

export interface Column {
  key: string;
  label: string;
  /** For narrow screens: one letter. */
  short: string;
  value: number;
  /** Not happened yet: no bar, no tooltip, a faint label. */
  future?: boolean;
  /** Printed on the cap, for the one or two columns the story is about. */
  capLabel?: ReactNode;
  aria: string;
  tip: Tip;
}

/** Columns on one axis with hairline gridlines. The plot keeps room above for a cap label. */
export function ColumnChart({ columns, ticks, top, tickLabel, height = 160 }: { columns: Column[]; ticks: number[]; top: number; tickLabel: (t: number) => string; height?: number }) {
  const at = (v: number) => `${top > 0 ? (v / top) * 100 : 0}%`;
  const n = columns.length;
  return (
    <div className="flex gap-2 pt-5">
      <div aria-hidden className="relative w-11 shrink-0 text-right text-[11px] tabular-nums text-muted" style={{ height }}>
        {ticks.map((t) => (
          <div key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: at(t) }}>
            {tickLabel(t)}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height }}>
          {ticks.map((t) => (
            <div key={t} aria-hidden className={cx("absolute inset-x-0 border-t", t === 0 ? "border-muted/50" : "border-line")} style={{ bottom: at(t) }} />
          ))}
          <div className="absolute inset-0 flex">
            {columns.map((c, i) =>
              c.future ? (
                <div key={c.key} className="flex-1" aria-label={c.aria} role="group" />
              ) : (
                <div key={c.key} role="group" tabIndex={0} aria-label={c.aria} className="group relative flex h-full flex-1 items-end justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {c.value > 0 ? (
                    <div className="relative w-3/5 max-w-6 rounded-t-[4px] transition-[filter] group-hover:brightness-110 group-focus-visible:brightness-110" style={{ height: at(c.value), background: "var(--series-1)" }}>
                      {c.capLabel ? <div className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium tabular-nums text-ink">{c.capLabel}</div> : null}
                    </div>
                  ) : null}
                  <Tooltip tip={c.tip} className={cx("bottom-full mb-2", i < 3 ? "left-0" : i >= n - 3 ? "right-0" : "left-1/2 -translate-x-1/2")} />
                </div>
              ),
            )}
          </div>
        </div>
        <div aria-hidden className="mt-1.5 flex text-[11px] text-muted">
          {columns.map((c) => (
            <div key={c.key} className={cx("flex-1 text-center", c.future && "opacity-50")}>
              <span className="sm:hidden">{c.short}</span>
              <span className="hidden sm:inline">{c.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface GroupedColumn {
  key: string;
  label: string;
  /** For narrow screens: one letter. */
  short: string;
  /** One value per series, in the series' order. */
  values: number[];
  aria: string;
  tip: Tip;
  /** Still going (this month so far): the label says so. */
  partial?: boolean;
}

/**
 * Two or more series side by side in each column, on one axis with hairline gridlines: invoiced
 * against received, month by month. The legend sits above; a tooltip per column on hover and focus.
 */
export function GroupedColumns({ columns, series, ticks, top, tickLabel, height = 200 }: { columns: GroupedColumn[]; series: Array<{ label: string; color: string }>; ticks: number[]; top: number; tickLabel: (t: number) => string; height?: number }) {
  const at = (v: number) => `${top > 0 ? (v / top) * 100 : 0}%`;
  const n = columns.length;
  return (
    <div>
      <Legend items={series} />
      <div className="flex gap-2 pt-2">
        <div aria-hidden className="relative w-12 shrink-0 text-right text-[11px] tabular-nums text-muted" style={{ height }}>
          {ticks.map((t) => (
            <div key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: at(t) }}>
              {tickLabel(t)}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height }}>
            {ticks.map((t) => (
              <div key={t} aria-hidden className={cx("absolute inset-x-0 border-t", t === 0 ? "border-muted/50" : "border-line")} style={{ bottom: at(t) }} />
            ))}
            <div className="absolute inset-0 flex">
              {columns.map((c, i) => (
                <div key={c.key} role="group" tabIndex={0} aria-label={c.aria} className="group relative flex h-full flex-1 items-end justify-center gap-[3px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {c.values.map((v, k) => (
                    <div key={k} className="w-[30%] max-w-6 rounded-t-[4px] transition-[filter] group-hover:brightness-110 group-focus-visible:brightness-110" style={{ height: v > 0 ? at(v) : 0, background: series[k]?.color }} />
                  ))}
                  <Tooltip tip={c.tip} className={cx("bottom-full mb-2", i < 2 ? "left-0" : i >= n - 2 ? "right-0" : "left-1/2 -translate-x-1/2")} />
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden className="mt-2 flex text-xs text-muted">
            {columns.map((c) => (
              <div key={c.key} className="flex-1 text-center">
                <span className="sm:hidden">{c.short}</span>
                <span className="hidden sm:inline">{c.label}</span>
                {c.partial ? <span className="hidden text-[10px] sm:block">so far</span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The chart's numbers as a table, folded away under the chart. */
export function ChartTable({ head, children, num }: { head: ReactNode[]; children: ReactNode; num?: number[] }) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer select-none text-xs text-muted hover:text-ink">Show the numbers</summary>
      <div className="-mx-5 mt-2">
        <Table dense head={head} num={num}>
          {children}
        </Table>
      </div>
    </details>
  );
}
