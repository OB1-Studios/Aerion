import type { IsoDate } from "@ebo/core";

/** The text layer of a stored file, when it has one we can read without a model. */
export function textLayer(bytes: Uint8Array, mimeType: string | null): string | null {
  const mt = (mimeType ?? "").toLowerCase();
  const text = () => new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (mt.startsWith("text/") || mt === "message/rfc822" || mt === "application/json") return text();
  if (mt === "image/svg+xml") return svgText(text());
  return null; // PDF and raster images need the model (OCR) in this build
}

/** Credit advices and ePRCs are a page or two; a long PDF is read for its first pages only. */
export const PDF_MAX_PAGES = 10;

/**
 * Text of a stored document for the readers: text formats as they are, SVG drawings by their
 * text elements, PDFs by their text layer. Null for scans and photos, which have no text layer.
 */
export async function documentText(bytes: Uint8Array, mimeType: string | null): Promise<string | null> {
  if ((mimeType ?? "").toLowerCase() !== "application/pdf") return textLayer(bytes, mimeType);
  // Loaded on first use, so processes that never see a PDF don't carry pdf.js.
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes)); // pdf.js takes over the buffer it's given
  try {
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(pdf.numPages, PDF_MAX_PAGES); n++) {
      const { items } = await (await pdf.getPage(n)).getTextContent();
      pages.push(items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join(""));
    }
    const text = pages.join("\n\n").replace(/[ \t]+\n/g, "\n").trim();
    return text || null;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Text drawn in an SVG, one line per <text> element, top to bottom. */
export function svgText(svg: string): string {
  const out: Array<{ y: number; t: string }> = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    const y = Number(/\by="([\d.]+)"/.exec(m[1] ?? "")?.[1] ?? 0);
    const t = (m[2] ?? "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
    if (t) out.push({ y, t });
  }
  return out
    .sort((a, b) => a.y - b.y)
    .map((x) => x.t)
    .join("\n");
}

/** "27-10-2026" -> "2026-10-27"; also accepts ISO. Null if it is not a real date. */
export function parseDate(s: string | null | undefined): IsoDate | null {
  if (!s) return null;
  const t = s.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(t))) [y, m, d] = [Number(r[3]), Number(r[2]), Number(r[1])];
  else {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    r = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t) ?? null;
    if (r) [y, m, d] = [Number(r[3]), months.indexOf(r[1]!.toLowerCase()) + 1, Number(r[2])];
    else if ((r = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(t))) [y, m, d] = [Number(r[3]), months.indexOf(r[2]!.toLowerCase()) + 1, Number(r[1])];
    else return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1,817,100.00" or "18,17,100.00" -> "1817100.00". Null if not a number. */
export function parseAmount(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/[,\s]/g, "");
  return /^-?\d+(\.\d{1,6})?$/.test(t) ? t : null;
}

/** "USD 6,400.00" -> { currency: "USD", amount: "6400.00" } */
export function parseMoney(s: string | null | undefined): { currency: string; amount: string } | null {
  const m = /^([A-Z]{3})\s*(-?[\d,]+(?:\.\d{1,6})?)$/.exec((s ?? "").trim());
  if (!m) return null;
  const amount = parseAmount(m[2]);
  return amount ? { currency: m[1]!, amount } : null;
}

/** Whitespace- and case-insensitive containment (build kit: every quote must appear in the text layer). */
export function quoteFound(text: string, quote: string): boolean {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(text).includes(norm(quote));
}

/** RFC 4180 CSV: quoted cells, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** CSV rows as objects keyed by the (lower-cased, trimmed) header. */
export function csvRecords(text: string): { header: string[]; records: Array<Record<string, string>> } {
  const [head, ...rest] = parseCsv(text.replace(/^﻿/, ""));
  const header = (head ?? []).map((h) => h.trim().toLowerCase());
  return { header, records: rest.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}
