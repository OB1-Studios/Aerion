import { formatAmount, formatMoney, type Grouping } from "@ebo/core";

/** Scales and short figures for charts and headline numbers, in the workspace's digit grouping. */

/** Whole rupees in the workspace's grouping: "PKR 816,060" or "PKR 8,16,060". */
export const rupees = (x: string | number, g: Grouping) => formatMoney(x, "PKR", { grouping: g, decimals: 0 });

const UNITS: Record<Grouping, Array<[number, string]>> = {
  western: [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ],
  lakh: [
    [1e7, " Cr"],
    [1e5, " L"],
  ],
};

/** Three significant figures: "41.7M", or "4.17 Cr" for lakh grouping. Small amounts in full. */
export function compact(x: number, g: Grouping): string {
  const units = UNITS[g];
  for (let i = 0; i < units.length; i++) {
    const [n, s] = units[i]!;
    if (Math.abs(x) < n) continue;
    const v = Number((x / n).toPrecision(3));
    const up = units[i - 1];
    if (up && Math.abs(v) * n >= up[0]) return `${Number((x / up[0]).toPrecision(3))}${up[1]}`;
    return `${v}${s}`;
  }
  return formatAmount(Math.round(x), { grouping: g, decimals: 0 });
}

/** A value axis with clean ticks, in one style: in full under 10,000, compact from there. */
export function valueAxis(max: number, g: Grouping) {
  const raw = Math.max(max, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const top = Math.ceil(max / step) * step || step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const unit = UNITS[g].find(([n]) => top >= (n === 1e3 ? 1e4 : n));
  const label = (t: number) => (t === 0 ? "0" : unit ? `${Number((t / unit[0]).toPrecision(4))}${unit[1]}` : formatAmount(t, { grouping: g, decimals: 0 }));
  return { top, ticks, label };
}
