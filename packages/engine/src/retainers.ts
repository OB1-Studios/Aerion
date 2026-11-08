import { checkRetainer, DEFAULT_PURPOSE_WORDING, nextRetainerDate, periodLabel, retainerDue, type IsoDate, type RetainerInput, type RetainerTerms } from "@ebo/core";
import { client, contract, task, type Db } from "@ebo/db";
import { and, eq, isNull } from "drizzle-orm";
import { audit, type Workspace, type WorkspaceContext } from "./context";
import { draftInvoiceEmail, invoiceRoutes, saveInvoice, workspaceToday } from "./invoicing";

/**
 * Retainers (main doc W7): a client pays the same amount every month. Each run drafts the
 * month's invoice once its billing day has come, with the email that sends it; both wait for a
 * person, like every invoice. Rules for which month is due live in core/retainers.ts.
 */

type ContractRow = typeof contract.$inferSelect;

export const retainerTerms = (r: ContractRow): RetainerTerms => ({ billingDay: r.billingDay ?? 1, startsOn: r.startsOn, endsOn: r.endsOn, lastPeriod: r.lastPeriod });

/** Adds a retainer; `firstOn` is the billing date of the first invoice the agent will draft. */
export async function addRetainer(db: Db, ws: Workspace, clientId: string, input: RetainerInput, userId: string): Promise<{ ok: true; id: string; firstOn: IsoDate | null } | { ok: false; problems: string[] }> {
  const [c] = await db.select().from(client).where(and(eq(client.workspaceId, ws.id), eq(client.id, clientId)));
  if (!c) return { ok: false, problems: ["That client doesn't exist."] };
  const { problems, value } = checkRetainer(input);
  if (!value) return { ok: false, problems };
  // The monthly draft would fail without somewhere to be paid, so say so now.
  if (!(await invoiceRoutes(db, ws.id, c.id, value.currency)).length) return { ok: false, problems: [`None of your receiving accounts can take ${value.currency}. Add one in Setup first.`] };
  const [row] = await db
    .insert(contract)
    .values({ workspaceId: ws.id, clientId: c.id, kind: "retainer", currency: value.currency, amountOrRate: value.amount, description: value.description, billingDay: value.billingDay, startsOn: value.startsOn })
    .returning({ id: contract.id });
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "retainer.added", objectType: "contract", objectId: row!.id, details: { client: c.name, ...value } });
  return { ok: true, id: row!.id, firstOn: nextRetainerDate({ billingDay: value.billingDay, startsOn: value.startsOn, endsOn: null, lastPeriod: null }, workspaceToday(ws)) };
}

/** No more invoices from this retainer, including this month's if it hasn't been drafted yet. */
export async function stopRetainer(db: Db, ws: Workspace, contractId: string, userId: string, today: IsoDate): Promise<boolean> {
  const [r] = await db.select().from(contract).where(and(eq(contract.workspaceId, ws.id), eq(contract.id, contractId), eq(contract.kind, "retainer")));
  if (!r || (r.endsOn && r.endsOn <= today)) return false;
  const due = retainerDue(retainerTerms(r), today);
  await db
    .update(contract)
    .set({ endsOn: today, ...(due ? { lastPeriod: due.period } : {}) })
    .where(eq(contract.id, r.id));
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "retainer.stopped", objectType: "contract", objectId: r.id, details: { endsOn: today, skipped: due?.period ?? null } });
  return true;
}

export interface RetainerDraft {
  contractId: string;
  client: string;
  period: string;
  amount: string;
  currency: string;
  invoiceId: string | null;
  number: string | null;
  /** The email that sends the invoice, waiting for approval. */
  draftId: string | null;
  /** What a person has to fix, in plain words. */
  problem: string | null;
}

/** Drafts this month's invoice for every retainer whose billing day has come. Each month once. */
export async function draftDueRetainers(db: Db, w: WorkspaceContext, runId: string): Promise<RetainerDraft[]> {
  const { ws, today } = w;
  const rows = await db
    .select({ r: contract, name: client.name, terms: client.paymentTermsDays })
    .from(contract)
    .innerJoin(client, eq(client.id, contract.clientId))
    .where(and(eq(contract.workspaceId, ws.id), eq(contract.kind, "retainer")));
  const agent = { actorType: "agent" as const, actorId: runId };
  const out: RetainerDraft[] = [];
  for (const { r, name, terms } of rows) {
    const due = retainerDue(retainerTerms(r), today);
    if (!due) continue;
    // Claim the month first, so two runs at once can't both draft it.
    const claimed = await db
      .update(contract)
      .set({ lastPeriod: due.period })
      .where(and(eq(contract.id, r.id), r.lastPeriod === null ? isNull(contract.lastPeriod) : eq(contract.lastPeriod, r.lastPeriod)))
      .returning({ id: contract.id });
    if (!claimed.length) continue;

    const label = periodLabel(due.period);
    const base = { contractId: r.id, client: name, period: due.period, amount: r.amountOrRate, currency: r.currency };
    const taskKey = `retainer:${r.id}:${due.period}`;
    const askPerson = (title: string, detail: string) =>
      db
        .insert(task)
        .values({ workspaceId: ws.id, key: taskKey, title, detail, dueOn: today, createdAt: w.clock })
        .onConflictDoUpdate({ target: [task.workspaceId, task.key], set: { title, detail, status: "open" } });

    // Gives the month back, so the next run tries again.
    const release = () => db.update(contract).set({ lastPeriod: r.lastPeriod }).where(eq(contract.id, r.id));
    let saved: Awaited<ReturnType<typeof saveInvoice>>;
    try {
      const routes = await invoiceRoutes(db, ws.id, r.clientId, r.currency);
      const route = routes.find((o) => o.suggested) ?? routes[0];
      saved = await saveInvoice(
        db,
        ws,
        {
          clientId: r.clientId,
          issuedOn: due.billingDate,
          termsDays: terms,
          currency: r.currency,
          routeChoice: route ? `${route.route}:${route.accountId}` : "",
          purposeWording: ws.settings?.purposeWording ?? DEFAULT_PURPOSE_WORDING,
          lines: [{ description: `${r.description ?? "Monthly retainer"}, ${label}`, quantity: "1", unitPrice: r.amountOrRate, contractId: r.id, milestoneLabel: due.period }],
        },
        agent,
      );
    } catch (err) {
      await release();
      throw err;
    }
    if (!saved.ok) {
      // Ask a person to fix what's wrong; the next run tries again.
      await release();
      const problem = saved.problems.join(" ");
      await askPerson(`Draft the ${label} retainer invoice for ${name}`, `The agent couldn't draft it: ${problem}`);
      out.push({ ...base, invoiceId: null, number: null, draftId: null, problem });
      continue;
    }
    const email = await draftInvoiceEmail(db, ws.id, saved.id, agent);
    if (email.ok) await db.update(task).set({ status: "done", doneNote: `Drafted ${saved.number}.` }).where(and(eq(task.workspaceId, ws.id), eq(task.key, taskKey), eq(task.status, "open")));
    else await askPerson(`Send ${saved.number} to ${name}`, `The agent drafted the ${label} retainer invoice but not its email: ${email.reason}`);
    out.push({ ...base, invoiceId: saved.id, number: saved.number, draftId: email.ok ? email.draftId : null, problem: email.ok ? null : email.reason });
  }
  return out;
}
