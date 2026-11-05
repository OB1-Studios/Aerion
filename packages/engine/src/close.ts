import { addDays, dateInZone, daysBetween, dec, eprcStatus, fixed2, formatDateLong, formatMoney, sumDec, type Decimal, type IsoDate } from "@ebo/core";
import { closePeriod, creditNote, document, documentKey, flag, sha256, user, type Db, type Storage } from "@ebo/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { BANK_ACCOUNT_KINDS, loadBooks, type Books } from "./books";
import { renderCloseReport } from "./close-report";
import { audit, loadContext, workspaceClock, type Workspace, type WorkspaceContext } from "./context";
import type { StatementOutcome } from "./statements";

/**
 * Month-end close (main doc W25, screen S61). For a month that's over, a checklist of what
 * an accountant checks before signing it off:
 *
 * - every credit matched to an invoice, or explained (a transfer between our own accounts)
 * - every certificate the bank owes for the month's credits on file, or on its way
 * - each bank account's statement agrees with the records
 * - every flag about the month looked at
 * - every document read
 *
 * Each line is done, waiting on someone outside (the bank, a client), or to do. A month with
 * nothing to do can be closed: that makes the report PDF for the director and records who
 * closed it. What's still waiting goes in the report.
 */

export type CheckState = "done" | "waiting" | "todo";
export type CloseItemKey = "credits" | "certificates" | "statements" | "flags" | "documents";
export interface CheckLine {
  text: string;
  state: CheckState;
  /** Inside the workspace, e.g. "payments/<id>". */
  path?: string;
}
export interface CloseItem {
  key: CloseItemKey;
  title: string;
  state: CheckState;
  summary: string;
  lines: CheckLine[];
}

export type AgeBand = "current" | "1-30" | "31-60" | "61-90" | "90+";
export const AGE_BANDS: AgeBand[] = ["current", "1-30", "31-60", "61-90", "90+"];
export interface MonthNumbers {
  /** Client money in, by currency, whichever route it came by. */
  received: Array<{ currency: string; count: number; amount: string }>;
  /** Export proceeds banked in Pakistan: PKR as credited, or at the reference rate. */
  bankedPkr: string;
  issued: Array<{ currency: string; count: number; amount: string }>;
  /** What clients owed at the end of the month, by how late it was then. */
  owed: Array<{ currency: string; amount: string; invoices: number; bands: Record<AgeBand, string> }>;
  statements: Array<{ account: string; currency: string; on: IsoDate; balance: string }>;
}

export interface CloseRecord {
  status: "open" | "closing" | "closed";
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
  reportDocumentId: string | null;
  fingerprint: string | null;
}

export interface CloseView {
  month: string;
  label: string;
  start: IsoDate;
  end: IsoDate;
  ended: boolean;
  items: CloseItem[];
  numbers: MonthNumbers;
  fingerprint: string;
  record: CloseRecord | null;
  canClose: boolean;
  /** Why it can't be closed, in a sentence; null when it can. */
  blocked: string | null;
  /** Closed, but the records for the month have changed since. */
  changedSinceClose: boolean;
}

export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const monthLabel = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
export function nextMonth(m: string): string {
  const [y, mm] = m.split("-").map(Number) as [number, number];
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
}
export function monthRange(m: string): { start: IsoDate; end: IsoDate } {
  return { start: `${m}-01`, end: addDays(`${nextMonth(m)}-01`, -1) };
}

const CLIENT_MONEY = new Set(["credit", "payoneer_receipt"]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ORDER: Record<CheckState, number> = { todo: 0, waiting: 1, done: 2 };
const worst = (lines: CheckLine[], fallback: CheckState = "done"): CheckState => lines.reduce<CheckState>((w, l) => (ORDER[l.state] < ORDER[w] ? l.state : w), fallback);

interface Extras {
  flags: Array<typeof flag.$inferSelect>;
  statements: Array<{ id: string; name: string | null; outcome: StatementOutcome }>;
  documents: Array<Pick<typeof document.$inferSelect, "id" | "originalName" | "parseStatus" | "reviewReasons" | "receivedAt">>;
  credits: Array<{ invoiceId: string; amount: string; on: IsoDate }>;
  record: CloseRecord | null;
}

async function loadExtras(db: Db, w: WorkspaceContext, month: string | null): Promise<Omit<Extras, "record"> & { records: Map<string, CloseRecord> }> {
  const id = w.ws.id;
  const [flags, docs, notes, records] = await Promise.all([
    db
      .select()
      .from(flag)
      .where(and(eq(flag.workspaceId, id), inArray(flag.status, ["open", "actioned"]))),
    db
      .select({ id: document.id, originalName: document.originalName, parseStatus: document.parseStatus, reviewReasons: document.reviewReasons, receivedAt: document.receivedAt, kind: document.kind, source: document.source, extracted: document.extracted })
      .from(document)
      .where(and(eq(document.workspaceId, id), sql`(${document.kind} = 'statement' or ${document.parseStatus} in ('pending', 'needs_review', 'failed'))`)),
    db.select({ invoiceId: creditNote.invoiceId, amount: creditNote.amount, createdAt: creditNote.createdAt }).from(creditNote).where(eq(creditNote.workspaceId, id)),
    db
      .select({ c: closePeriod, by: user.name, anon: user.isAnonymous })
      .from(closePeriod)
      .leftJoin(user, eq(user.id, closePeriod.closedBy))
      .where(month ? and(eq(closePeriod.workspaceId, id), eq(closePeriod.month, month)) : eq(closePeriod.workspaceId, id)),
  ]);
  const statements = docs.flatMap((d) => {
    const o = (d.extracted as { outcome?: StatementOutcome } | null)?.outcome;
    return d.kind === "statement" && d.parseStatus === "parsed" && o?.action === "statement" ? [{ id: d.id, name: d.originalName, outcome: o }] : [];
  });
  return {
    flags,
    statements,
    documents: docs.filter((d) => d.source !== "generated" && ["pending", "needs_review", "failed"].includes(d.parseStatus)),
    credits: notes.map((n) => ({ invoiceId: n.invoiceId, amount: n.amount, on: dateInZone(n.createdAt, w.ws.timezone) })),
    records: new Map(
      records.map(({ c, by, anon }) => {
        const k = (c.checklist ?? {}) as { closedAt?: string; fingerprint?: string };
        return [c.month, { status: c.status, closedBy: c.closedBy, closedByName: anon ? "Visitor" : by, closedAt: k.closedAt ?? null, reportDocumentId: c.reportDocumentId, fingerprint: k.fingerprint ?? null }];
      }),
    ),
  };
}

/** The checklist and the month's numbers, from books already loaded. */
export function buildCloseView(b: Books, w: WorkspaceContext, month: string, x: Extras): CloseView {
  const { start, end } = monthRange(month);
  const label = monthLabel(month);
  const today = w.today;
  const tz = w.ws.timezone;
  const inMonth = (d: IsoDate) => d >= start && d <= end;
  const money = (a: string | Decimal, c: string) => formatMoney(typeof a === "string" ? a : a.toFixed(2), c, { grouping: w.ws.numberGrouping });
  const accountKind = new Map(b.accounts.map((a) => [a.id, a.kind]));
  const txById = new Map(b.transactions.map((t) => [t.id, t]));
  const payer = (t: { payerName: string | null }) => t.payerName ?? "an unknown payer";
  const items: CloseItem[] = [];

  // 1. Every credit matched or explained.
  const money_in = b.transactions.filter((t) => CLIENT_MONEY.has(t.kind) && inMonth(t.valueDate) && t.matchStatus !== "duplicate" && t.matchStatus !== "ignored");
  const unmatched = money_in.filter((t) => t.matchStatus !== "matched" && t.matchStatus !== "transfer");
  items.push({
    key: "credits",
    title: "Every credit matched",
    state: unmatched.length ? "todo" : "done",
    summary: !money_in.length ? "No money came in this month." : unmatched.length ? `${unmatched.length} of ${money_in.length} still to match to an invoice.` : `All ${money_in.length} matched to invoices or explained as transfers.`,
    lines: unmatched.map((t) => ({ text: `${money(t.amount, t.currency)} from ${payer(t)} on ${formatDateLong(t.valueDate)}: not matched to an invoice yet.`, state: "todo" as const, path: `payments/${t.id}` })),
  });

  // 2. Certificates the bank owes for the month's bank credits.
  const bankCredits = b.transactions.filter((t) => t.kind === "credit" && inMonth(t.valueDate) && BANK_ACCOUNT_KINDS.has(accountKind.get(t.receivingAccountId ?? "") ?? "") && t.matchStatus !== "duplicate");
  const bankIds = new Set(bankCredits.map((t) => t.id));
  const actioned = new Set(x.flags.filter((f) => f.status === "actioned" && f.subjectType === "compliance_item").map((f) => f.subjectId));
  const certLines: CheckLine[] = [];
  let onFile = 0;
  const certs = b.compliance.filter((c) => bankIds.has(c.transactionId));
  for (const c of certs) {
    const t = txById.get(c.transactionId)!;
    const what = `${c.kind === "eprc" ? "ePRC" : "Withholding certificate"} for ${money(t.amount, t.currency)} from ${payer(t)} (${formatDateLong(t.valueDate)})`;
    const st = c.kind === "eprc" ? eprcStatus(c, w.rules) : c.status;
    const path = `payments/${t.id}`;
    if (st === "on_file") onFile++;
    else if (st === "wrong_code")
      certLines.push(
        actioned.has(c.id)
          ? { text: `${what}: issued with code ${c.purposeCodeOnDocument ?? "?"}; the bank has been asked to reissue it.`, state: "waiting", path }
          : { text: `${what}: issued with code ${c.purposeCodeOnDocument ?? "?"}. Ask the bank to reissue it.`, state: "todo", path },
      );
    else if (st === "requested") certLines.push({ text: `${what}: asked for${c.requestedAt ? ` on ${formatDateLong(dateInZone(c.requestedAt, tz))}` : ""}, not received yet.`, state: "waiting", path });
    else if (c.dueOn && c.dueOn > today) certLines.push({ text: `${what}: due from the bank by ${formatDateLong(c.dueOn)}.`, state: "waiting", path });
    else {
      const late = `${what}: overdue${c.dueOn ? ` since ${formatDateLong(c.dueOn)}` : ""}`;
      certLines.push(actioned.has(c.id) ? { text: `${late}; the bank has been asked for it.`, state: "waiting", path } : { text: `${late}. Ask the bank for it.`, state: "todo", path });
    }
  }
  const certWaiting = certLines.filter((l) => l.state === "waiting").length;
  const certTodo = certLines.filter((l) => l.state === "todo").length;
  items.push({
    key: "certificates",
    title: "Every certificate on file",
    state: worst(certLines),
    summary: !certs.length ? "No bank credits this month, so no certificates are owed." : [`${onFile} of ${certs.length} on file`, certWaiting ? `${certWaiting} on the way` : "", certTodo ? `${certTodo} to chase` : ""].filter(Boolean).join(", ") + ".",
    lines: certLines.sort((p, q) => ORDER[p.state] - ORDER[q.state]),
  });

  // 3. Each bank account's statement agrees with the records.
  const stLines: CheckLine[] = [];
  const balances: MonthNumbers["statements"] = [];
  for (const a of b.accounts.filter((a) => BANK_ACCOUNT_KINDS.has(a.kind))) {
    const credits = bankCredits.filter((t) => t.receivingAccountId === a.id);
    const stmts = x.statements.filter((s) => s.outcome.accountId === a.id && s.outcome.from <= end && s.outcome.to >= start);
    if (!credits.length && !stmts.length) continue;
    if (!stmts.length) {
      stLines.push({ text: `No ${label} statement for the ${a.label} yet. Upload it on Documents.`, state: "todo", path: "documents" });
      continue;
    }
    const shown = new Set(stmts.flatMap((s) => s.outcome.onStatement));
    const missing = credits.filter((t) => !shown.has(t.id));
    for (const t of missing) stLines.push({ text: `${money(t.amount, t.currency)} from ${payer(t)} on ${formatDateLong(t.valueDate)} is on record for the ${a.label} but not on its statement.`, state: "todo", path: `payments/${t.id}` });
    const latest = [...stmts].sort((p, q) => p.outcome.to.localeCompare(q.outcome.to)).at(-1)!.outcome;
    const ends = Object.entries(latest.monthEnds)
      .filter(([m]) => m <= month)
      .sort(([p], [q]) => p.localeCompare(q))
      .at(-1)?.[1];
    if (ends) balances.push({ account: a.label, currency: latest.currency, on: ends.on, balance: ends.balance });
    if (!missing.length)
      stLines.push({
        text: `${a.label}: every credit on record is on the statement${ends ? `; balance ${money(ends.balance, latest.currency)} on ${formatDateLong(ends.on)}` : ""}${daysBetween(latest.to, end) > 3 ? ` (it stops on ${formatDateLong(latest.to)})` : ""}.`,
        state: "done",
        path: `documents/${stmts.at(-1)!.id}`,
      });
  }
  items.push({
    key: "statements",
    title: "Bank statements agree",
    state: worst(stLines),
    summary: !stLines.length
      ? "No bank account had money in this month."
      : stLines.some((l) => l.state === "todo")
        ? `${plural(stLines.filter((l) => l.state === "todo").length, "thing")} to sort out.`
        : `${plural(stLines.length, "account")} checked against the bank's statement.`,
    lines: stLines.sort((p, q) => ORDER[p.state] - ORDER[q.state]),
  });

  // 4. Flags about the month (or earlier) looked at.
  const invById = new Map(b.invoices.map((i) => [i.id, i]));
  const compById = new Map(b.compliance.map((c) => [c.id, c]));
  const claimById = new Map(b.claims.map((c) => [c.id, c]));
  const msgById = new Map(b.inbound.map((m) => [m.id, m]));
  const subjectDate = (f: (typeof x.flags)[number]): IsoDate => {
    const id = f.subjectId;
    if (f.subjectType === "invoice") return invById.get(id)?.issuedOn ?? dateInZone(f.createdAt, tz);
    if (f.subjectType === "transaction") return txById.get(id)?.valueDate ?? dateInZone(f.createdAt, tz);
    if (f.subjectType === "compliance_item") return txById.get(compById.get(id)?.transactionId ?? "")?.valueDate ?? dateInZone(f.createdAt, tz);
    if (f.subjectType === "claim") return dateInZone(claimById.get(id)?.createdAt ?? f.createdAt, tz);
    if (f.subjectType === "message") return dateInZone(msgById.get(id)?.sentAt ?? f.createdAt, tz);
    return dateInZone(f.createdAt, tz);
  };
  const flagLines: CheckLine[] = x.flags
    .filter((f) => subjectDate(f) <= end)
    .map((f) => ({ text: f.status === "open" ? f.summary : `${f.summary} (being handled)`, state: f.status === "open" ? ("todo" as const) : ("waiting" as const), path: "flags" }))
    .sort((p, q) => ORDER[p.state] - ORDER[q.state]);
  const flagTodo = flagLines.filter((l) => l.state === "todo").length;
  items.push({
    key: "flags",
    title: "Every flag looked at",
    state: worst(flagLines),
    summary: !flagLines.length ? "No open flags about this month." : [flagTodo ? `${plural(flagTodo, "flag")} not looked at yet` : "", flagLines.length - flagTodo ? `${flagLines.length - flagTodo} being handled` : ""].filter(Boolean).join(", ") + ".",
    lines: flagLines,
  });

  // 5. Every document read (one waiting could hold this month's money or paperwork).
  const docLines: CheckLine[] = x.documents.map((d) => ({
    text: `${d.originalName ?? "A document"}: ${d.parseStatus === "pending" ? "not read yet; the next run reads it (Run now)" : d.parseStatus === "failed" ? "couldn't be read" : (d.reviewReasons?.[0] ?? "needs a person")}`,
    state: "todo" as const,
    path: `documents/${d.id}`,
  }));
  items.push({
    key: "documents",
    title: "Every document read",
    state: docLines.length ? "todo" : "done",
    summary: docLines.length ? `${plural(docLines.length, "document")} still to read or check.` : "Every document that came in has been read.",
    lines: docLines,
  });

  // The month in numbers.
  const transfersIn = new Set(b.transfers.map((l) => l.toTransactionId));
  const byCurrency = (rows: Array<{ currency: string; amount: string }>) => {
    const m = new Map<string, { currency: string; count: number; amount: Decimal }>();
    for (const r of rows) {
      const e = m.get(r.currency) ?? { currency: r.currency, count: 0, amount: dec(0) };
      e.count++;
      e.amount = e.amount.plus(r.amount);
      m.set(r.currency, e);
    }
    return [...m.values()].sort((p, q) => q.amount.comparedTo(p.amount)).map((e) => ({ currency: e.currency, count: e.count, amount: fixed2(e.amount) }));
  };
  const received = byCurrency(money_in.filter((t) => !transfersIn.has(t.id)));
  const bankedPkr = fixed2(sumDec(bankCredits.map((t) => dec(t.pkrAmount ?? (t.currency === "PKR" ? t.amount : dec(t.amount).times(w.refRate(t.currency, t.valueDate) ?? 0))))));
  const issuedInvoices = b.invoices.filter((i) => i.status !== "draft" && i.status !== "void" && inMonth(i.issuedOn));
  const issued = byCurrency(issuedInvoices.map((i) => ({ currency: i.currency, amount: i.amount })));

  // Owed at month end: what each invoice issued by then still had open on that day.
  const applied = new Map<string, Decimal>();
  for (const m of b.matches) {
    const t = txById.get(m.transactionId);
    if (!t || t.valueDate > end) continue;
    applied.set(m.invoiceId, (applied.get(m.invoiceId) ?? dec(0)).plus(m.appliedAmount));
  }
  for (const c of x.credits) if (c.on <= end) applied.set(c.invoiceId, (applied.get(c.invoiceId) ?? dec(0)).plus(c.amount));
  const tol = dec(w.rules["tolerance.abs"]);
  const owedMap = new Map<string, { currency: string; amount: Decimal; invoices: number; bands: Record<AgeBand, Decimal> }>();
  for (const i of b.invoices) {
    if (i.status === "draft" || i.issuedOn > end) continue;
    const open = dec(i.amount).minus(applied.get(i.id) ?? 0);
    if (open.lte(tol)) continue;
    const late = daysBetween(i.dueOn, end);
    const band: AgeBand = late <= 0 ? "current" : late <= 30 ? "1-30" : late <= 60 ? "31-60" : late <= 90 ? "61-90" : "90+";
    const e = owedMap.get(i.currency) ?? { currency: i.currency, amount: dec(0), invoices: 0, bands: Object.fromEntries(AGE_BANDS.map((k) => [k, dec(0)])) as Record<AgeBand, Decimal> };
    e.amount = e.amount.plus(open);
    e.invoices++;
    e.bands[band] = e.bands[band].plus(open);
    owedMap.set(i.currency, e);
  }
  const owed = [...owedMap.values()]
    .sort((p, q) => q.amount.comparedTo(p.amount))
    .map((e) => ({ currency: e.currency, amount: fixed2(e.amount), invoices: e.invoices, bands: Object.fromEntries(AGE_BANDS.map((k) => [k, fixed2(e.bands[k])])) as Record<AgeBand, string> }));
  const numbers: MonthNumbers = { received, bankedPkr, issued, owed, statements: balances };

  // What the report was made from: if any of it changes after closing, the page says so.
  const fingerprint = sha256(
    new TextEncoder().encode(
      JSON.stringify({
        credits: money_in.map((t) => [t.id, t.amount, t.matchStatus]).sort(),
        certificates: certs.map((c) => [c.id, c.status]).sort(),
        invoices: issuedInvoices.map((i) => [i.id, i.amount, i.status]).sort(),
        numbers,
      }),
    ),
  );

  const ended = end < today;
  const record = x.record;
  const todo = items.filter((i) => i.state === "todo").length;
  const closed = record?.status === "closed";
  const blocked = closed ? `${label} is closed.` : !ended ? `${label} isn't over until the end of ${formatDateLong(end)}.` : todo ? `${plural(todo, "check")} still to do.` : null;
  return { month, label, start, end, ended, items, numbers, fingerprint, record, canClose: !blocked, blocked, changedSinceClose: closed && !!record?.fingerprint && record.fingerprint !== fingerprint };
}

/** One month's checklist, numbers and close record. */
export async function closeView(db: Db, w: WorkspaceContext, month: string): Promise<CloseView> {
  const [b, x] = await Promise.all([loadBooks(db, w), loadExtras(db, w, month)]);
  return buildCloseView(b, w, month, { ...x, record: x.records.get(month) ?? null });
}

export interface MonthSummary {
  month: string;
  label: string;
  ended: boolean;
  status: "closed" | "ready" | "todo" | "in_progress";
  todo: number;
  waiting: number;
  record: CloseRecord | null;
  changedSinceClose: boolean;
}

/** Every month from the first with any activity to the current one, newest first. */
export async function closeOverview(db: Db, w: WorkspaceContext): Promise<MonthSummary[]> {
  const [b, x] = await Promise.all([loadBooks(db, w), loadExtras(db, w, null)]);
  const first = [...b.invoices.filter((i) => i.status !== "draft").map((i) => i.issuedOn), ...b.transactions.map((t) => t.valueDate)].sort()[0];
  const current = w.today.slice(0, 7);
  if (!first) return [];
  const months: string[] = [];
  for (let m = first.slice(0, 7); m <= current && months.length < 36; m = nextMonth(m)) months.push(m);
  return months.reverse().map((m) => {
    const v = buildCloseView(b, w, m, { ...x, record: x.records.get(m) ?? null });
    const todo = v.items.reduce((n, i) => n + i.lines.filter((l) => l.state === "todo").length, 0);
    const waiting = v.items.reduce((n, i) => n + i.lines.filter((l) => l.state === "waiting").length, 0);
    const status = v.record?.status === "closed" ? "closed" : !v.ended ? "in_progress" : v.canClose ? "ready" : "todo";
    return { month: m, label: v.label, ended: v.ended, status, todo, waiting, record: v.record, changedSinceClose: v.changedSinceClose };
  });
}

export type CloseResult = { ok: true; documentId: string; name: string } | { ok: false; reason: string };

/**
 * Closes a month: checks it again under a lock, makes the report PDF, keeps it as a document
 * and records the close. Refused while anything is still to do.
 */
export async function closeMonth(db: Db, storage: Storage, ws: Workspace, month: string, by: { id: string; name: string }): Promise<CloseResult> {
  if (!isMonth(month)) return { ok: false, reason: "That isn't a month." };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`close:${ws.id}`}))`);
    const t = tx as unknown as Db;
    const w = await loadContext(t, ws.id);
    const v = await closeView(t, w, month);
    if (!v.canClose) return { ok: false as const, reason: v.blocked ?? `${v.label} can't be closed yet.` };
    const at = workspaceClock(ws);
    const name = `${ws.slug}-month-end-${month}.pdf`;
    const bytes = await renderCloseReport({ ws, view: v, closedAt: at, closedBy: by.name });
    const hash = sha256(bytes);
    const key = documentKey(ws.id, hash, "application/pdf");
    await storage.put(key, bytes, "application/pdf");
    const [doc] = await t
      .insert(document)
      .values({
        workspaceId: ws.id,
        kind: "report",
        storagePath: key,
        sha256: hash,
        originalName: name,
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
        source: "generated",
        receivedAt: at,
        parseStatus: "skipped",
        reviewReasons: [`The month-end report for ${v.label}, made when it was closed. The agent doesn't read what the app makes.`],
      })
      .onConflictDoUpdate({ target: [document.workspaceId, document.sha256], set: { originalName: name } })
      .returning({ id: document.id });
    const checklist = { closedAt: at.toISOString(), fingerprint: v.fingerprint, items: v.items.map((i) => ({ key: i.key, state: i.state, summary: i.summary })), numbers: v.numbers };
    await t
      .insert(closePeriod)
      .values({ workspaceId: ws.id, month, status: "closed", checklist, closedBy: by.id, reportDocumentId: doc!.id, createdAt: at })
      .onConflictDoUpdate({ target: [closePeriod.workspaceId, closePeriod.month], set: { status: "closed", checklist, closedBy: by.id, reportDocumentId: doc!.id } });
    const waiting = v.items.flatMap((i) => i.lines.filter((l) => l.state === "waiting")).length;
    await audit(t, { workspaceId: ws.id, actorType: "user", actorId: by.id, action: "month.closed", objectType: "close_period", objectId: month, details: { month, reportDocumentId: doc!.id, waiting, fingerprint: v.fingerprint } });
    return { ok: true as const, documentId: doc!.id, name };
  });
}

/** Opens a closed month again (owners only, with a reason). Its report stays on file. */
export async function reopenMonth(db: Db, ws: Workspace, month: string, by: { id: string }, reason: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isMonth(month)) return { ok: false, reason: "That isn't a month." };
  const why = reason.trim();
  if (why.length < 3) return { ok: false, reason: "Say why it's being reopened, in a few words. It's kept in the audit log." };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`close:${ws.id}`}))`);
    const [row] = await tx
      .select()
      .from(closePeriod)
      .where(and(eq(closePeriod.workspaceId, ws.id), eq(closePeriod.month, month)));
    if (!row || row.status !== "closed") return { ok: false as const, reason: `${monthLabel(month)} isn't closed.` };
    const old = (row.checklist ?? {}) as Record<string, unknown> & { history?: unknown[] };
    const history = [...(old.history ?? []), { closedAt: old.closedAt ?? null, closedBy: row.closedBy, reportDocumentId: row.reportDocumentId, reopenedAt: workspaceClock(ws).toISOString(), reopenedBy: by.id, reason: why.slice(0, 300) }];
    await tx.update(closePeriod).set({ status: "open", checklist: { history }, closedBy: null, reportDocumentId: null }).where(eq(closePeriod.id, row.id));
    await audit(tx as unknown as Db, { workspaceId: ws.id, actorType: "user", actorId: by.id, action: "month.reopened", objectType: "close_period", objectId: month, details: { month, reason: why.slice(0, 300), reportDocumentId: row.reportDocumentId } });
    return { ok: true as const };
  });
}
