import { dec } from "@ebo/core";
import type { DocumentKind } from "@ebo/db";
import type { AnswerDoc } from "@ebo/db/seed";
import { documentText, parseAmount, parseDate, type DocumentReader, type DocumentReadResult } from "@ebo/engine";
import { FIELDS, MT103_FIELDS, type FieldSpec } from "./fields";

/**
 * The reading benchmark (data spec section 14): every reader reads every document in the
 * answer key, and each field is compared with the answer after normalising. It picks the
 * model by measurement, and shows how much the model adds over the built-in layout rules.
 */

type FieldType = FieldSpec[string]["type"];

export interface BenchReader {
  name: string;
  reader: DocumentReader;
  /** A model reader. When it falls back to the layout rules, that counts as a miss, not as the rules' reading. */
  model?: boolean;
}

export interface FieldScore {
  name: string;
  expected: string | null;
  got: string | null;
  ok: boolean;
}

export interface DocScore {
  id: string;
  set: AnswerDoc["set"];
  layout: string;
  kind: DocumentKind;
  gotKind: DocumentKind | null;
  kindOk: boolean;
  ours: boolean | null;
  gotMatch: "yes" | "no" | "unsure" | null;
  /** Ours read as ours; someone else's never read as ours. Null where the answer doesn't say. */
  oursOk: boolean | null;
  /** Fields where the answer or the reading has a value. */
  fields: FieldScore[];
  fellBack: boolean;
  error: string | null;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
}

export interface Ratio {
  ok: number;
  of: number;
}

export interface BenchSummary {
  reader: string;
  docs: number;
  kind: Ratio;
  ours: Ratio;
  fields: Ratio;
  fieldsDemo: Ratio;
  fieldsStress: Ratio;
  /** Kind right and every field right. */
  perfect: Ratio;
  byLayout: Array<{ layout: string; fields: Ratio; perfect: Ratio }>;
  missed: Array<{ field: string; missed: number }>;
  fellBack: number;
  errors: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  medianMs: number;
}

export interface BenchRun {
  reader: string;
  scores: DocScore[];
  summary: BenchSummary;
}

/** The fields the answer for this kind lists (an MT103 copy is "other" with its own few fields). */
export const specFor = (kind: DocumentKind): FieldSpec => (kind === "other" ? MT103_FIELDS : (FIELDS[kind] ?? {}));

/** Normal form for comparing: amounts as numbers, dates as ISO, IBANs without spaces, text upper-cased. */
export function scoreValue(type: FieldType, v: string | null | undefined): string | null {
  const s = v == null ? "" : String(v).trim();
  if (!s) return null;
  switch (type) {
    case "money": {
      const a = parseAmount(s.replace(/^[A-Z]{3}\s*/, ""));
      return a == null ? s.toUpperCase() : dec(a).toString();
    }
    case "date":
      return parseDate(s) ?? s;
    case "iban":
      return s.replace(/\s+/g, "").toUpperCase();
    default:
      return s.replace(/\s+/g, " ").toUpperCase();
  }
}

/** Scores one reading against its answer. A null reading (an error or a model fallback) gets nothing right. */
export function scoreReading(doc: AnswerDoc, res: DocumentReadResult | null): Pick<DocScore, "gotKind" | "kindOk" | "gotMatch" | "oursOk" | "fields"> {
  const got = res?.extraction?.fields ?? {};
  const fields: FieldScore[] = [];
  for (const [name, { type }] of Object.entries(specFor(doc.kind))) {
    const expected = doc.fields[name] ?? null;
    const value = got[name] ?? null;
    const e = scoreValue(type, expected);
    const g = scoreValue(type, value);
    if (e == null && g == null) continue;
    const alternatives = (doc.alternatives?.[name] ?? []).map((a) => scoreValue(type, a));
    fields.push({ name, expected, got: value, ok: g === e || (g != null && alternatives.includes(g)) });
  }
  const gotMatch = res?.classification.workspaceMatch ?? null;
  return {
    gotKind: res?.classification.kind ?? null,
    kindOk: res?.classification.kind === doc.kind,
    gotMatch,
    oursOk: doc.ours == null ? null : res != null && (doc.ours ? gotMatch === "yes" : gotMatch !== "yes"),
    fields,
  };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export interface BenchOptions {
  /** Documents read at the same time per reader (default 3). */
  concurrency?: number;
  onDoc?: (reader: string, score: DocScore, done: number, total: number) => void;
}

export async function benchmark(readers: BenchReader[], docs: AnswerDoc[], o: BenchOptions = {}): Promise<BenchRun[]> {
  // Text layers once: the same extraction the read step uses (PDF, SVG and plain text).
  const texts = new Map<string, string | null>();
  for (const d of docs) texts.set(d.id, await documentText(new TextEncoder().encode(d.content), d.mimeType));
  const runs: BenchRun[] = [];
  for (const r of readers) {
    let done = 0;
    const scores = await pool(docs, o.concurrency ?? 3, async (doc): Promise<DocScore> => {
      const started = Date.now();
      let res: DocumentReadResult | null = null;
      let error: string | null = null;
      try {
        res = await r.reader.read({ id: doc.id, name: doc.name, mimeType: doc.mimeType, text: texts.get(doc.id) ?? null, kindHint: doc.kindHint }, doc.context);
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
      }
      const fellBack = !!r.model && !!res && res.model.endsWith("(model unavailable)");
      const calls = res?.calls ?? [];
      const score: DocScore = {
        id: doc.id,
        set: doc.set,
        layout: doc.layout,
        kind: doc.kind,
        ours: doc.ours,
        ...scoreReading(doc, fellBack ? null : res),
        fellBack,
        error,
        calls: calls.length,
        failedCalls: calls.filter((c) => !c.ok).length,
        inputTokens: calls.reduce((t, c) => t + c.inputTokens, 0),
        outputTokens: calls.reduce((t, c) => t + c.outputTokens, 0),
        costUsd: calls.reduce((t, c) => t + Number(c.costUsd || 0), 0),
        ms: Date.now() - started,
      };
      o.onDoc?.(r.name, score, ++done, docs.length);
      return score;
    });
    runs.push({ reader: r.name, scores, summary: summarize(r.name, scores) });
  }
  return runs;
}

const ratio = (xs: boolean[]): Ratio => ({ ok: xs.filter(Boolean).length, of: xs.length });
const fieldRatio = (scores: DocScore[]): Ratio => ratio(scores.flatMap((s) => s.fields.map((f) => f.ok)));
const perfect = (s: DocScore) => s.kindOk && s.fields.every((f) => f.ok);

export function summarize(reader: string, scores: DocScore[]): BenchSummary {
  const layouts = [...new Set(scores.map((s) => s.layout))];
  const missed = new Map<string, number>();
  for (const s of scores) for (const f of s.fields) if (!f.ok) missed.set(f.name, (missed.get(f.name) ?? 0) + 1);
  const ms = scores.map((s) => s.ms).sort((a, b) => a - b);
  return {
    reader,
    docs: scores.length,
    kind: ratio(scores.map((s) => s.kindOk)),
    ours: ratio(scores.flatMap((s) => (s.oursOk == null ? [] : [s.oursOk]))),
    fields: fieldRatio(scores),
    fieldsDemo: fieldRatio(scores.filter((s) => s.set === "demo")),
    fieldsStress: fieldRatio(scores.filter((s) => s.set === "stress")),
    perfect: ratio(scores.map(perfect)),
    byLayout: layouts.map((layout) => {
      const xs = scores.filter((s) => s.layout === layout);
      return { layout, fields: fieldRatio(xs), perfect: ratio(xs.map(perfect)) };
    }),
    missed: [...missed].map(([field, n]) => ({ field, missed: n })).sort((a, b) => b.missed - a.missed),
    fellBack: scores.filter((s) => s.fellBack).length,
    errors: scores.filter((s) => s.error).length,
    calls: scores.reduce((t, s) => t + s.calls, 0),
    failedCalls: scores.reduce((t, s) => t + s.failedCalls, 0),
    inputTokens: scores.reduce((t, s) => t + s.inputTokens, 0),
    outputTokens: scores.reduce((t, s) => t + s.outputTokens, 0),
    costUsd: scores.reduce((t, s) => t + s.costUsd, 0),
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)]! : 0,
  };
}

export const pct = (r: Ratio) => (r.of ? `${((100 * r.ok) / r.of).toFixed(1)}%` : "—");
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The report: one table across readers, accuracy by layout, and what each reader missed most. */
export function benchMarkdown(runs: BenchRun[], docs: AnswerDoc[], when = new Date()): string {
  const demo = docs.filter((d) => d.set === "demo").length;
  const stress = docs.length - demo;
  const layouts = [...new Set(docs.filter((d) => d.set === "stress" && d.ours !== false).map((d) => d.layout))];
  const notOurs = docs.filter((d) => d.ours === false).length;
  const out = [
    `# Reading benchmark, ${when.toISOString().slice(0, 10)}`,
    "",
    `${docs.length} SIMULATED documents from the answer key: ${demo} in the demo bank's layout${stress ? `, ${stress} in layouts the built-in rules were never written for (${layouts.join(", ")})` : ""}${notOurs ? `, of which ${notOurs} are advices addressed to someone else` : ""}. Fields are compared after normalising (amounts as numbers, dates as ISO, text upper-cased). A field counts when the answer or the reading has a value, so inventing a value is a miss too. A model reading that fell back to the rules counts as a miss.`,
    "",
    "| Reader | Kind right | Fields right, demo layout | Fields right, other layouts | Documents fully right | Ours vs not ours | Fell back | Tokens in / out | Cost | Median per document |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...runs.map(({ summary: s }) => `| ${s.reader} | ${pct(s.kind)} | ${pct(s.fieldsDemo)} | ${pct(s.fieldsStress)} | ${s.perfect.ok} of ${s.perfect.of} | ${pct(s.ours)} | ${s.fellBack} | ${s.inputTokens.toLocaleString("en-US")} / ${s.outputTokens.toLocaleString("en-US")} | ${usd(s.costUsd)} | ${secs(s.medianMs)} |`),
    "",
    "## Fields right, by layout",
    "",
    `| Layout | Documents | ${runs.map((r) => r.reader).join(" | ")} |`,
    `| --- | --- | ${runs.map(() => "---").join(" | ")} |`,
    ...[...new Set(docs.map((d) => d.layout))].map((layout) => `| ${layout} | ${docs.filter((d) => d.layout === layout).length} | ${runs.map((r) => pct(r.summary.byLayout.find((b) => b.layout === layout)?.fields ?? { ok: 0, of: 0 })).join(" | ")} |`),
    "",
    "## Most missed fields",
    "",
    ...runs.map(({ summary: s }) => `- **${s.reader}:** ${s.missed.length ? s.missed.slice(0, 6).map((m) => `${m.field} (${m.missed})`).join(", ") : "none"}`),
    "",
  ];
  return out.join("\n");
}
