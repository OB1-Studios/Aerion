import { dateInZone, dec, eprcStatus, fixed2, formatDateLong, formatMoney, sumDec, type IsoDate } from "@ebo/core";
import { complianceItem, creditNote, document, exportJob, flag, invoice, workspacePrefix, type Db, type Storage } from "@ebo/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { taxYearCredits, taxYearOpenings } from "./books";
import { audit, loadContext, workspaceClock, type Workspace, type WorkspaceContext } from "./context";
import { creditsCsv, shareCsv, taxYearFile, toCsv, type TaxYearFile } from "./tax-file";
import { zip, type ZipEntry } from "./zip";

/**
 * The year-end tax pack (main doc W27): one zip for the accountant with the tax year's
 * export proceeds by month (in the currency received and in PKR), every credit with its
 * paperwork, the banking-channel share working, the invoices and credit notes, the open
 * exceptions, and the ePRCs and withholding certificates on file. It's built from the same
 * books as the tax-year file and kept in storage (Object Storage in production) under the
 * workspace, one file per build.
 */

export const taxPackKey = (workspaceId: string, jobId: string) => `${workspacePrefix(workspaceId)}/exports/${jobId}.zip`;

export interface TaxPackSummary {
  year: { start: IsoDate; end: IsoDate; label: string };
  asOf: IsoDate;
  credits: number;
  proceedsPkr: string | null;
  sharePct: string | null;
  minSharePct: string;
  eprc: { needed: number; onFile: number; missing: number; wrongCode: number };
  wht: { needed: number; onFile: number; missing: number };
  invoices: number;
  creditNotes: number;
  exceptions: number;
  files: number;
  pseb: { number: string | null; validUntil: IsoDate | null; lapsesInYear: boolean };
}

const MIME_EXT: Record<string, string> = { "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const safeName = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";

interface DocFields {
  fields?: Record<string, unknown> | null;
  confirmed?: Record<string, unknown> | null;
  certificate_number?: unknown;
}
/** What a person confirmed, else what was read; older records keep the fields flat. */
const certificateNumber = (extracted: unknown): string => {
  const x = (extracted ?? {}) as DocFields;
  const v = x.confirmed?.certificate_number ?? x.fields?.certificate_number ?? x.certificate_number;
  return typeof v === "string" ? v : "";
};

/**
 * Everything that goes in the pack, without zipping it. With no storage it's a preview for
 * the page: the same summary and file names, but the certificate copies aren't read.
 */
export async function gatherTaxPack(db: Db, storage: Storage | null, w0: WorkspaceContext, yearStart?: IsoDate) {
  const file: TaxYearFile = await taxYearFile(db, w0, yearStart);
  const { year, books, context: w } = file;
  const ws = w.ws;
  const inYear = (d: IsoDate) => d >= year.start && d <= year.end;
  const g = { grouping: ws.numberGrouping };

  // Export proceeds banked in Pakistan by month and currency: the same credits as the share and the PSEB estimate.
  // Opening balances imported for months before the records began are rows of their own.
  type IncomeRow = { month: string; currency: string; credits: number; amount: ReturnType<typeof dec>; pkr: ReturnType<typeof dec>; source: string };
  const byMonth = new Map<string, IncomeRow>();
  for (const { t, pkr } of taxYearCredits(books, w)) {
    const k = `${t.valueDate.slice(0, 7)} ${t.currency}`;
    const row = byMonth.get(k) ?? { month: t.valueDate.slice(0, 7), currency: t.currency, credits: 0, amount: dec(0), pkr: dec(0), source: "records" };
    row.credits++;
    row.amount = row.amount.plus(t.amount);
    row.pkr = row.pkr.plus(pkr);
    byMonth.set(k, row);
  }
  for (const o of taxYearOpenings(books, w)) {
    if (!o.banked || !o.pkr) continue;
    const k = `${o.month} ${o.currency} opening ${o.pkrEstimated}`;
    const row = byMonth.get(k) ?? { month: o.month, currency: o.currency, credits: 0, amount: dec(0), pkr: dec(0), source: o.pkrEstimated ? "opening balance (PKR estimated)" : "opening balance" };
    row.amount = row.amount.plus(o.amount);
    row.pkr = row.pkr.plus(o.pkr);
    byMonth.set(k, row);
  }
  const income = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency) || a.source.localeCompare(b.source));

  // Paperwork for each credit in the year, and the files on record.
  const lineById = new Map(file.lines.map((l) => [l.id, l]));
  const items = (await db.select().from(complianceItem).where(eq(complianceItem.workspaceId, ws.id))).filter((i) => lineById.has(i.transactionId));
  const docIds = items.map((i) => i.documentId).filter((x): x is string => !!x);
  const docs = docIds.length ? await db.select().from(document).where(and(eq(document.workspaceId, ws.id), inArray(document.id, docIds))) : [];
  const docById = new Map(docs.map((d) => [d.id, d]));
  const statusOf = (i: (typeof items)[number]) => (i.kind === "eprc" ? eprcStatus(i, w.rules) : i.status);
  const entries: ZipEntry[] = [];
  const taken = new Set<string>();
  const unreadable: string[] = [];
  const fileFor = new Map<string, string>();
  for (const i of items) {
    const d = i.documentId ? docById.get(i.documentId) : undefined;
    if (!d) continue;
    const l = lineById.get(i.transactionId)!;
    const base = safeName((d.originalName ?? d.id).replace(/\.[a-z0-9]+$/i, ""));
    let name = `documents/${i.kind === "eprc" ? "eprc" : "wht"}/${l.valueDate}-${base}.${MIME_EXT[d.mimeType ?? ""] ?? "bin"}`;
    if (taken.has(name)) name = name.replace(/(\.[a-z0-9]+)$/, `-${d.id.slice(0, 8)}$1`);
    taken.add(name);
    if (!storage) {
      fileFor.set(i.id, name); // a preview lists the copies without reading them
      continue;
    }
    try {
      entries.push({ name, data: await storage.get(d.storagePath) });
      fileFor.set(i.id, name);
    } catch {
      unreadable.push(d.originalName ?? d.id);
    }
  }
  const paperwork = (kind: "eprc" | "wht_certificate") =>
    toCsv([
      ["value_date", "payer", "currency", "amount", "pkr_amount", "purpose_code", "status", "certificate_number", "file"],
      ...items
        .filter((i) => i.kind === kind)
        .map((i) => ({ i, l: lineById.get(i.transactionId)! }))
        .sort((a, b) => a.l.valueDate.localeCompare(b.l.valueDate))
        .map(({ i, l }) => [l.valueDate, l.payer, l.currency, l.amount, l.pkrAmount, l.purposeCode, statusOf(i).replace(/_/g, " "), i.documentId ? certificateNumber(docById.get(i.documentId)?.extracted) : "", fileFor.get(i.id) ?? ""]),
    ]);
  const count = (kind: "eprc" | "wht_certificate", ...statuses: string[]) => items.filter((i) => i.kind === kind && (!statuses.length || statuses.includes(statusOf(i)))).length;

  // The year's invoices, with what came in and what was credited against each.
  const clientName = new Map(books.clients.map((c) => [c.id, c.name]));
  const invoices = books.invoices.filter((i) => i.status !== "draft" && inYear(i.issuedOn)).sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.number.localeCompare(b.number));
  const notes = (await db.select({ c: creditNote, number: invoice.number, currency: invoice.currency }).from(creditNote).innerJoin(invoice, eq(invoice.id, creditNote.invoiceId)).where(eq(creditNote.workspaceId, ws.id)))
    .map((n) => ({ ...n, on: dateInZone(n.c.createdAt, ws.timezone) }))
    .filter((n) => inYear(n.on))
    .sort((a, b) => a.on.localeCompare(b.on) || a.c.number.localeCompare(b.c.number));
  const open = await db.select().from(flag).where(and(eq(flag.workspaceId, ws.id), inArray(flag.status, ["open", "actioned"])));

  entries.unshift(
    {
      name: "income-by-month.csv",
      data: toCsv([["month", "currency", "credits", "amount", "pkr", "source"], ...income.map((r) => [r.month, r.currency, r.credits, fixed2(r.amount), fixed2(r.pkr), r.source]), ["total", "PKR", income.reduce((s, r) => s + r.credits, 0), "", fixed2(sumDec(income.map((r) => r.pkr))), ""]]),
    },
    { name: "export-credits.csv", data: creditsCsv(file) },
    { name: "banking-share.csv", data: shareCsv(file) },
    { name: "eprc-list.csv", data: paperwork("eprc") },
    { name: "wht-certificates.csv", data: paperwork("wht_certificate") },
    {
      name: "invoices.csv",
      data: toCsv([
        ["number", "client", "issued_on", "due_on", "currency", "amount", "received_before_import", "received", "credited", "balance", "status"],
        ...invoices.map((i) => [i.number, clientName.get(i.clientId), i.issuedOn, i.dueOn, i.currency, i.amount, i.paidBeforeImport, i.appliedTotal, fixed2(dec(i.amount).minus(i.paidBeforeImport).minus(i.appliedTotal).minus(i.balance)), i.balance, i.status.replace(/_/g, " ")]),
      ]),
    },
    { name: "credit-notes.csv", data: toCsv([["number", "kind", "invoice", "recorded_on", "currency", "amount", "reason"], ...notes.map((n) => [n.c.number, n.c.kind.replace(/_/g, " "), n.number, n.on, n.currency, n.c.amount, n.c.reason])]) },
    { name: "exceptions.csv", data: toCsv([["severity", "kind", "summary", "since"], ...open.map((f) => [f.severity, f.kind.replace(/_/g, " "), f.summary, dateInZone(f.createdAt, ws.timezone)])]) },
  );

  const summary: TaxPackSummary = {
    year: { start: year.start, end: year.end, label: year.label },
    asOf: w.today,
    credits: file.lines.length,
    proceedsPkr: file.proceedsPkr,
    sharePct: file.share?.sharePct ?? null,
    minSharePct: String(w.rules["banking_share.min_pct"]),
    eprc: { needed: count("eprc"), onFile: count("eprc", "on_file"), missing: count("eprc", "missing", "requested"), wrongCode: count("eprc", "wrong_code") },
    wht: { needed: count("wht_certificate"), onFile: count("wht_certificate", "on_file"), missing: count("wht_certificate", "missing", "requested") },
    invoices: invoices.length,
    creditNotes: notes.length,
    exceptions: open.length,
    files: fileFor.size,
    pseb: { number: ws.psebRegNo, validUntil: ws.psebValidUntil, lapsesInYear: !!ws.psebValidUntil && ws.psebValidUntil < year.end },
  };
  const money = (x: string | null) => (x == null ? "nothing" : formatMoney(x, "PKR", g));
  const readme = (builtAt: Date, by: string) =>
    [
      `Tax pack: ${ws.legalName ?? ws.name}, tax year ${year.label} (${formatDateLong(year.start)} to ${formatDateLong(year.end)})`,
      `Built ${new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: ws.timezone }).format(builtAt)} by ${by}, from the records as of ${formatDateLong(w.today)}.`,
      ...(ws.isDemo ? ["", "SIMULATED: this is demo data for a fictional business."] : []),
      "",
      `NTN: ${ws.ntn ?? "not set"}`,
      `PSEB registration: ${ws.psebRegNo ? `${ws.psebRegNo}${ws.psebValidUntil ? `, valid until ${formatDateLong(ws.psebValidUntil)}` : ""}` : "not registered"}${summary.pseb.lapsesInYear ? " (lapses before the tax year ends: renew it)" : ""}`,
      "",
      "The year in numbers",
      `- Export proceeds banked in Pakistan: ${money(summary.proceedsPkr)} from ${summary.credits} credit${summary.credits === 1 ? "" : "s"}`,
      `- Banking-channel share: ${summary.sharePct != null ? `${summary.sharePct}%` : "not worked out"} (the rule is at least ${summary.minSharePct}%)`,
      `- ePRCs: ${summary.eprc.onFile} of ${summary.eprc.needed} on file${summary.eprc.missing ? `; ${summary.eprc.missing} missing or requested` : ""}${summary.eprc.wrongCode ? `; ${summary.eprc.wrongCode} with the wrong purpose code` : ""}`,
      `- Withholding certificates: ${summary.wht.onFile} of ${summary.wht.needed} on file${summary.wht.missing ? `; ${summary.wht.missing} missing or requested` : ""}`,
      `- Certificate copies included: ${summary.files} (under documents/; a blank file column means no copy was uploaded)`,
      `- Invoices issued: ${summary.invoices}; credit notes, write-offs and voids: ${summary.creditNotes}`,
      `- Open flags when this was built: ${summary.exceptions} (exceptions.csv)`,
      ...(unreadable.length ? [`- Couldn't read from storage, so not included: ${unreadable.join(", ")}`] : []),
      "",
      "What's in it",
      "- income-by-month.csv: export proceeds banked in Pakistan, by month and currency, in the currency received and in PKR; opening balances imported for months before the records began are rows of their own",
      "- export-credits.csv: every credit into a Pakistani bank account, with its ePRC and withholding certificate status",
      "- banking-share.csv: the banking-channel share working, at reference rates",
      "- eprc-list.csv and wht-certificates.csv: each credit's certificate, its number, and its file under documents/",
      "- invoices.csv: invoices issued in the year, with money received, credit notes and what's still owed",
      "- credit-notes.csv: credit notes, write-offs and voids recorded in the year, with their reasons",
      "- exceptions.csv: what still needs a person",
      "",
      "PKR amounts are as the bank credited them. Money kept in foreign currency is valued at the reference rate of its value date.",
      "The tax rates and the banking-share rule are stored as rules marked unverified until checked against FBR sources.",
      "This is a working file for your accountant, not tax advice.",
      "",
    ].join("\r\n");
  return { file, summary, entries, readme };
}

export type TaxPackResult = { ok: true; jobId: string; name: string; bytes: number; summary: TaxPackSummary } | { ok: false; reason: string };

/** Builds the zip, keeps it in storage, and records it as an export job. */
export async function buildTaxPack(db: Db, storage: Storage, ws: Workspace, opts: { yearStart?: IsoDate; by: { id: string; name: string } }): Promise<TaxPackResult> {
  const pack = await gatherTaxPack(db, storage, await loadContext(db, ws.id), opts.yearStart);
  const { summary } = pack;
  if (!summary.credits && !summary.invoices) return { ok: false, reason: `There's nothing to pack for ${summary.year.label}: no export credits or invoices in that tax year.` };
  const at = workspaceClock(ws);
  const [job] = await db.insert(exportJob).values({ workspaceId: ws.id, kind: "tax_pack", period: summary.year.label, status: "running", requestedBy: opts.by.id, createdAt: at }).returning({ id: exportJob.id });
  const folder = `${ws.slug}-tax-pack-${summary.year.label}`;
  try {
    const bytes = zip([{ name: `${folder}/README.txt`, data: pack.readme(at, opts.by.name) }, ...pack.entries.map((e) => ({ ...e, name: `${folder}/${e.name}` }))], at, ws.timezone);
    await storage.put(taxPackKey(ws.id, job!.id), bytes, "application/zip");
    await db.update(exportJob).set({ status: "done" }).where(eq(exportJob.id, job!.id));
    await audit(db, { workspaceId: ws.id, actorType: "user", actorId: opts.by.id, action: "tax_pack.built", objectType: "export_job", objectId: job!.id, details: { year: summary.year.label, bytes: bytes.length, files: summary.files, credits: summary.credits, exceptions: summary.exceptions } });
    return { ok: true, jobId: job!.id, name: `${folder}.zip`, bytes: bytes.length, summary };
  } catch (err) {
    await db.update(exportJob).set({ status: "failed" }).where(eq(exportJob.id, job!.id));
    throw err;
  }
}

/** Tax packs built for a workspace, newest first. */
export function taxPacks(db: Db, workspaceId: string) {
  return db
    .select()
    .from(exportJob)
    .where(and(eq(exportJob.workspaceId, workspaceId), eq(exportJob.kind, "tax_pack")))
    .orderBy(desc(exportJob.createdAt));
}
