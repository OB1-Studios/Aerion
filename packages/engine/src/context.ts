import { clockNow, dateInZone, Decimal, dec, rulesFrom, type IsoDate, type RefRate, type Rules } from "@ebo/core";
import { auditEvent, fxReferenceRate, rule, workspace, type Db, type Storage } from "@ebo/db";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Readers } from "./readers/types";

export type Workspace = typeof workspace.$inferSelect;

/** What a run needs from outside: the database, document storage, and how to read and send. */
export interface EngineDeps {
  db: Db;
  storage: Storage;
  readers: Readers;
  mailer: Mailer;
  env?: Record<string, string | undefined>;
}

export interface OutgoingEmail {
  workspaceId: string;
  from: string;
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  /** Files sent with the email (an invoice email carries the invoice PDF). */
  attachments?: Array<{ name: string; contentType: string; content: Uint8Array }>;
}

/** Sends email. The demo mailer only records the message; production uses the connected mailbox. */
export interface Mailer {
  readonly kind: "demo" | "smtp";
  send(email: OutgoingEmail): Promise<{ messageId: string | null }>;
}

export const demoMailer: Mailer = {
  kind: "demo",
  async send() {
    return { messageId: null };
  },
};

export interface WorkspaceContext {
  ws: Workspace;
  /** The time the run acts as of: the demo clock, APP_CLOCK, or now. */
  clock: Date;
  today: IsoDate;
  rules: Rules;
  refRate: RefRate;
  tolerance: Decimal;
}

export async function loadRules(db: Db, workspaceId: string): Promise<Rules> {
  const rows = await db
    .select({ key: rule.key, value: rule.value, workspaceId: rule.workspaceId })
    .from(rule)
    .where(or(isNull(rule.workspaceId), eq(rule.workspaceId, workspaceId)));
  const global = Object.fromEntries(rows.filter((r) => !r.workspaceId).map((r) => [r.key, r.value]));
  const own = Object.fromEntries(rows.filter((r) => r.workspaceId).map((r) => [r.key, r.value]));
  return rulesFrom({ ...global, ...own });
}

/** Reference rates from the table: the rate on the date, or the latest one before it. */
export async function loadRefRates(db: Db): Promise<RefRate> {
  const rows = await db.select().from(fxReferenceRate);
  const byCcy = new Map<string, Array<{ d: IsoDate; r: string }>>();
  for (const row of rows) byCcy.set(row.currency, [...(byCcy.get(row.currency) ?? []), { d: row.rateDate, r: row.midRate }]);
  for (const list of byCcy.values()) list.sort((a, b) => a.d.localeCompare(b.d));
  return (currency, date) => {
    if (currency === "PKR") return "1";
    const list = byCcy.get(currency);
    if (!list?.length) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.d <= date) {
        found = list[mid]!.r;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
}

export function workspaceClock(ws: Pick<Workspace, "demoClock">, env?: Record<string, string | undefined>): Date {
  return ws.demoClock ?? clockNow(env);
}

export async function loadContext(db: Db, workspaceId: string, env?: Record<string, string | undefined>): Promise<WorkspaceContext> {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId));
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);
  const rules = await loadRules(db, workspaceId);
  const clock = workspaceClock(ws, env);
  return { ws, clock, today: dateInZone(clock, ws.timezone), rules, refRate: await loadRefRates(db), tolerance: dec(rules["tolerance.abs"]) };
}

export interface AuditInput {
  workspaceId: string;
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  details?: Record<string, unknown>;
}

export async function audit(db: Pick<Db, "insert">, a: AuditInput | AuditInput[]): Promise<void> {
  const list = Array.isArray(a) ? a : [a];
  if (!list.length) return;
  await db.insert(auditEvent).values(list.map((x) => ({ ...x, details: x.details ?? {} })));
}

/** Rows of a workspace-scoped table: shorthand for `and(eq(t.workspaceId, id), ...more)`. */
export const inWs = <T extends { workspaceId: unknown }>(t: T, id: string, ...more: Parameters<typeof and>) =>
  and(eq(t.workspaceId as never, id), ...more);
