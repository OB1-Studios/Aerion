import { addDays, daysBetween, nextRetainerDate, type IsoDate, type RetainerTerms } from "@ebo/core";
import { contract, type Db } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { loadBooks, type Books } from "./books";
import { closeOverview, type MonthSummary } from "./close";
import type { WorkspaceContext } from "./context";

/**
 * What's coming up for the workspace: the dated obligations a finance person plans the week
 * around, beside the things the run already put in front of them. Only what the records say:
 * invoices falling due, retainer invoices the next run will draft, the PSEB registration
 * lapsing, and months that have ended without being closed. Nothing here is a prediction.
 */

export type AgendaKind = "invoice_due" | "retainer" | "pseb" | "close";

export interface AgendaItem {
  key: string;
  kind: AgendaKind;
  /** The day it falls on (for a month to close, the day after the month ended). */
  date: IsoDate;
  /** Negative when it's already past. */
  inDays: number;
  title: string;
  detail: string;
  /** What to open for it. */
  ref: { type: "invoice" | "client" | "setup" | "close"; id: string };
  amount?: { value: string; currency: string };
}

export interface AgendaInput {
  today: IsoDate;
  kind: "company" | "freelancer";
  invoices: Array<{ id: string; number: string; client: string; currency: string; balance: string; dueOn: IsoDate; status: string }>;
  retainers: Array<{ id: string; clientId: string; client: string; currency: string; amount: string; terms: RetainerTerms }>;
  pseb: { regNo: string | null; validUntil: IsoDate | null };
  months: Array<Pick<MonthSummary, "month" | "label" | "ended" | "status" | "todo" | "waiting">>;
}

/** Days ahead the agenda looks for invoices and retainers. */
export const AGENDA_DAYS = 14;
/** The PSEB registration is flagged this many days before it lapses: renewal takes weeks. */
export const PSEB_WARN_DAYS = 60;

const firstOfNext = (month: string): IsoDate => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function agenda(x: AgendaInput): AgendaItem[] {
  const { today } = x;
  const until = addDays(today, AGENDA_DAYS);
  const items: AgendaItem[] = [];

  for (const i of x.invoices) {
    if ((i.status !== "sent" && i.status !== "part_paid") || Number(i.balance) <= 0) continue;
    if (i.dueOn < today || i.dueOn > until) continue;
    const n = daysBetween(today, i.dueOn);
    items.push({
      key: `invoice:${i.id}`,
      kind: "invoice_due",
      date: i.dueOn,
      inDays: n,
      title: `${i.number} falls due`,
      detail: `${i.client}${i.status === "part_paid" ? ", part paid" : ""}`,
      ref: { type: "invoice", id: i.id },
      amount: { value: i.balance, currency: i.currency },
    });
  }

  for (const r of x.retainers) {
    const next = nextRetainerDate(r.terms, today);
    if (!next || next > until) continue;
    items.push({
      key: `retainer:${r.id}`,
      kind: "retainer",
      date: next,
      inDays: daysBetween(today, next),
      title: `Retainer invoice for ${r.client}`,
      detail: "Drafted by the first run on or after this day, then waits for your approval",
      ref: { type: "client", id: r.clientId },
      amount: { value: r.amount, currency: r.currency },
    });
  }

  if (x.pseb.regNo && x.pseb.validUntil && x.pseb.validUntil <= addDays(today, PSEB_WARN_DAYS)) {
    const n = daysBetween(today, x.pseb.validUntil);
    items.push({
      key: "pseb",
      kind: "pseb",
      date: x.pseb.validUntil,
      inDays: n,
      title: n < 0 ? "PSEB registration has lapsed" : "PSEB registration lapses",
      detail: n < 0 ? `${x.pseb.regNo}. Renew it.` :`${x.pseb.regNo}. Start the renewal.`,
      ref: { type: "setup", id: "pseb" },
    });
  }

  // Offices close their months; the oldest ones still open first, at most three.
  if (x.kind === "company") {
    const open = x.months.filter((m) => m.ended && m.status !== "closed").sort((a, b) => a.month.localeCompare(b.month));
    for (const m of open.slice(0, 3)) {
      const date = firstOfNext(m.month);
      items.push({
        key: `close:${m.month}`,
        kind: "close",
        date,
        inDays: daysBetween(today, date),
        title: `Close ${m.label}`,
        detail: m.status === "ready" ? "Everything is in: ready to close" : [m.todo ? `${plural(m.todo, "item")} to do` : null, m.waiting ? `${plural(m.waiting, "item")} waiting on others` : null].filter(Boolean).join(", ") || "Not closed yet",
        ref: { type: "close", id: m.month },
      });
    }
  }

  return items.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** The agenda for a workspace, from its books, retainers and month-end records. */
export async function loadAgenda(db: Db, w: WorkspaceContext, books?: Books): Promise<AgendaItem[]> {
  const [b, contracts, months] = await Promise.all([
    books ?? loadBooks(db, w),
    db.select().from(contract).where(and(eq(contract.workspaceId, w.ws.id), eq(contract.kind, "retainer"))),
    w.ws.kind === "company" ? closeOverview(db, w) : Promise.resolve([] as MonthSummary[]),
  ]);
  const clientName = new Map(b.clients.map((c) => [c.id, c.name]));
  return agenda({
    today: w.today,
    kind: w.ws.kind,
    invoices: b.invoices.map((i) => ({ id: i.id, number: i.number, client: clientName.get(i.clientId) ?? "", currency: i.currency, balance: i.balance, dueOn: i.dueOn, status: i.status })),
    retainers: contracts
      .filter((r) => !r.endsOn || r.endsOn > w.today)
      .map((r) => ({
        id: r.id,
        clientId: r.clientId,
        client: clientName.get(r.clientId) ?? "",
        currency: r.currency,
        amount: r.amountOrRate,
        terms: { billingDay: r.billingDay ?? 1, startsOn: r.startsOn, endsOn: r.endsOn, lastPeriod: r.lastPeriod },
      })),
    pseb: { regNo: w.ws.psebRegNo, validUntil: w.ws.psebValidUntil },
    months,
  });
}
