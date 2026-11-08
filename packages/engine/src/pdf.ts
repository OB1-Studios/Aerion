/**
 * A minimal PDF writer: lines of text in Helvetica, one or more A4 pages, with a real text
 * layer. Used for sample documents a visitor can upload, and for tests of the PDF reader.
 */
const PAGE_W = 595;
const PAGE_H = 842;
const LINES_PER_PAGE = 52;

/** WinAnsi text for a PDF string: escapes ( ) \ and replaces what Helvetica can't show. */
function pdfString(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (m) => `\\${m}`);
}

export function simplePdf(lines: string[], opts: { fontSize?: number; title?: string } = {}): Uint8Array {
  const size = opts.fontSize ?? 10;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  // Objects: 1 catalog, 2 pages, 3 font, 4 info, then a page and its content stream per page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = `<< /Producer (Aerion) /Title (${pdfString(opts.title ?? "Document")}) >>`;
  pages.forEach((pageLines, i) => {
    const body = pageLines.map((l) => `(${pdfString(l)}) Tj T*`).join("\n");
    const stream = `BT\n/F1 ${size} Tf\n${Math.round(size * 1.45)} TL\n50 ${PAGE_H - 60} Td\n${body}\nET`;
    objects[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // ASCII only, so string offsets are byte offsets
}
