import { formatDateLong, formatMoney } from "@ebo/core";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { CheckState, CloseView } from "./close";
import type { Workspace } from "./context";
import { pdfSafe, wrap } from "./pdf-text";

const STATE_LABEL: Record<CheckState, string> = { done: "Done", waiting: "Waiting", todo: "To do" };
const BAND_LABEL = { current: "Not yet due", "1-30": "1-30 days late", "31-60": "31-60", "61-90": "61-90", "90+": "Over 90" } as const;

/**
 * The month-end report for the director, as an A4 PDF: the month in numbers (money in,
 * proceeds banked, invoices issued, what was owed at month end by how late it was, statement
 * balances), the checklist as it stood at close, and what was still outstanding.
 */
export async function renderCloseReport(d: { ws: Workspace; view: CloseView; closedAt: Date; closedBy: string }): Promise<Uint8Array> {
  const { ws, view: v } = d;
  const g = { grouping: ws.numberGrouping };
  const money = (a: string, c: string) => formatMoney(a, c, g);
  const business = ws.legalName ?? ws.name;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Month-end report: ${v.label}`);
  pdf.setAuthor(business);
  pdf.setCreator("IT Export Back Office");
  pdf.setProducer("IT Export Back Office (pdf-lib)");
  pdf.setCreationDate(d.closedAt);
  pdf.setModificationDate(d.closedAt);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.11, 0.14, 0.2);
  const muted = rgb(0.42, 0.45, 0.5);
  const rule = rgb(0.86, 0.88, 0.9);
  const tone: Record<CheckState, ReturnType<typeof rgb>> = { done: rgb(0.13, 0.45, 0.3), waiting: rgb(0.62, 0.42, 0.04), todo: rgb(0.7, 0.14, 0.09) };
  const W = 595.28;
  const H = 841.89;
  const M = 50;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, size = 10, font: PDFFont = regular, color = ink) => page.drawText(pdfSafe(s), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 10, font: PDFFont = regular, color = ink) => page.drawText(pdfSafe(s), { x: xRight - font.widthOfTextAtSize(pdfSafe(s), size), y, size, font, color });
  const ensure = (needed: number) => {
    if (y - needed >= M + 30) return;
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const para = (s: string, x: number, width: number, size = 10, font: PDFFont = regular, color = ink, leading = 1.45) => {
    for (const line of wrap(s, font, size, width)) {
      ensure(size * leading);
      text(line, x, size, font, color);
      y -= size * leading;
    }
  };
  const heading = (s: string) => {
    ensure(40);
    y -= 10;
    text(s.toUpperCase(), M, 9, bold, muted);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
    y -= 16;
  };
  const row = (label: string, value: string) => {
    const lines = wrap(value, regular, 10, W - M - 210);
    ensure(lines.length * 14 + 2);
    text(label, M, 10, regular, muted);
    for (const l of lines) {
      text(l, M + 160, 10);
      y -= 14;
    }
    y -= 2;
  };

  // Header.
  text(business, M, 16, bold);
  right("MONTH-END REPORT", W - M, 14, bold);
  y -= 20;
  text(`${v.label}: ${formatDateLong(v.start)} to ${formatDateLong(v.end)}`, M, 11, regular, muted);
  y -= 15;
  const closed = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: ws.timezone }).format(d.closedAt);
  text(`Closed by ${d.closedBy} on ${closed}.`, M, 10, regular, muted);
  y -= 8;

  // The month in numbers.
  heading("The month in numbers");
  const n = v.numbers;
  row("Money received", n.received.length ? n.received.map((r) => `${money(r.amount, r.currency)} (${r.count} payment${r.count === 1 ? "" : "s"})`).join("; ") : "Nothing came in.");
  row("Banked in Pakistan", `${money(n.bankedPkr, "PKR")}, export proceeds as credited (reference rate where the bank didn't convert)`);
  row("Invoices issued", n.issued.length ? n.issued.map((r) => `${r.count} for ${money(r.amount, r.currency)}`).join("; ") : "None.");
  row("Owed at month end", n.owed.length ? n.owed.map((r) => `${money(r.amount, r.currency)} on ${r.invoices} invoice${r.invoices === 1 ? "" : "s"}`).join("; ") : "Nothing.");
  for (const s of n.statements) row(`Statement: ${s.account}`, `${money(s.balance, s.currency)} on ${formatDateLong(s.on)}`);

  // Ageing at month end, one row per currency.
  if (n.owed.length) {
    y -= 6;
    ensure(30 + n.owed.length * 16);
    const cols = Object.keys(BAND_LABEL) as Array<keyof typeof BAND_LABEL>;
    const x0 = M + 70;
    const colW = (W - M - x0) / cols.length;
    page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 20, color: rgb(0.95, 0.96, 0.97) });
    text("Owed by age", M + 6, 8, bold, muted);
    cols.forEach((c, i) => right(BAND_LABEL[c], x0 + colW * (i + 1) - 6, 8, bold, muted));
    y -= 22;
    for (const r of n.owed) {
      text(r.currency, M + 6, 9, bold);
      cols.forEach((c, i) => right(r.bands[c] === "0.00" ? "-" : money(r.bands[c], r.currency).replace(`${r.currency} `, ""), x0 + colW * (i + 1) - 6, 9));
      y -= 16;
    }
  }

  // The checklist at close.
  heading("Checklist at close");
  for (const item of v.items) {
    const lines = wrap(item.summary, regular, 9.5, W - M - 140);
    ensure(16 + lines.length * 13);
    text(STATE_LABEL[item.state], M, 9, bold, tone[item.state]);
    text(item.title, M + 60, 10, bold);
    y -= 14;
    for (const l of lines) {
      text(l, M + 60, 9.5, regular, muted);
      y -= 13;
    }
    y -= 4;
  }

  // Still outstanding.
  const waiting = v.items.flatMap((i) => i.lines.filter((l) => l.state === "waiting"));
  heading("Still outstanding at close");
  if (!waiting.length) para("Nothing: every check was done.", M, W - 2 * M, 10, regular, muted);
  for (const l of waiting) {
    const lines = wrap(l.text, regular, 9.5, W - 2 * M - 14);
    ensure(lines.length * 13 + 3);
    text("-", M, 9.5, regular, muted);
    for (const t of lines) {
      text(t, M + 12, 9.5);
      y -= 13;
    }
    y -= 3;
  }

  y -= 8;
  para("Amounts come from the workspace's records: bank advices, statements, wallet exports and invoices. PKR is as the bank credited it. Money kept in foreign currency is valued at the reference rate of its value date. This is a working report, not audited accounts.", M, W - 2 * M, 8.5, regular, muted, 1.4);

  // Footer on every page.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    y = M - 10;
    text(`${business} · Month-end report, ${v.label}`, M, 8, regular, muted);
    right(`Page ${i + 1} of ${pages.length}`, W - M, 8, regular, muted);
    if (ws.isDemo) {
      y = M + 6;
      text("SIMULATED - NOT A REAL DOCUMENT", M, 9, bold, rgb(0.7, 0.14, 0.09));
    }
  });
  return pdf.save({ useObjectStreams: false });
}
