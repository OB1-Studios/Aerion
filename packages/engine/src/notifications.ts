/**
 * Notifications (W31). One list of what needs a person, worked out from the records as they are
 * now and filtered to what each person's role lets them act on. The app keeps who has seen what;
 * the email digest is the same list, sent through the workspace's own mailbox. Digests are
 * internal, so they never appear in a client's messages.
 */
import { dateInZone, formatDateLong, type IsoDate } from "@ebo/core";
import { document, draftAction, flag, mailboxConnection, member, notification, notificationPref, task, transaction, user, workspace, type Db, type DigestFrequency, type NotificationKind, type NotificationPayload, type Role } from "@ebo/db";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { audit, type Mailer, type Workspace } from "./context";

export interface NeedsItem extends NotificationPayload {
  key: string;
  kind: NotificationKind;
  /** Only this person, when a task is assigned to someone still in the workspace. */
  assignedTo: string | null;
}

/** Everything open in the workspace that waits on a person. */
export async function openItems(db: Db, ws: Pick<Workspace, "id" | "slug">): Promise<NeedsItem[]> {
  const base = `/w/${ws.slug}`;
  const [drafts, tasks, flags, docs, payments, members] = await Promise.all([
    db
      .select({ id: draftAction.id, status: draftAction.status, subject: draftAction.subject, to: draftAction.toAddress, at: draftAction.createdAt })
      .from(draftAction)
      .where(and(eq(draftAction.workspaceId, ws.id), inArray(draftAction.status, ["draft", "blocked"]))),
    db
      .select({ id: task.id, title: task.title, ownerId: task.ownerId, dueOn: task.dueOn, at: task.createdAt })
      .from(task)
      .where(and(eq(task.workspaceId, ws.id), eq(task.status, "open"))),
    db
      .select({ id: flag.id, summary: flag.summary, at: flag.createdAt })
      .from(flag)
      .where(and(eq(flag.workspaceId, ws.id), eq(flag.status, "open"), eq(flag.severity, "high"))),
    db
      .select({ id: document.id, name: document.originalName, at: document.createdAt })
      .from(document)
      .where(and(eq(document.workspaceId, ws.id), eq(document.parseStatus, "needs_review"))),
    db
      .select({ id: transaction.id, payer: transaction.payerName, amount: transaction.amount, currency: transaction.currency, on: transaction.valueDate, at: transaction.createdAt })
      .from(transaction)
      .where(and(eq(transaction.workspaceId, ws.id), eq(transaction.matchStatus, "unmatched"))),
    db.select({ userId: member.userId }).from(member).where(eq(member.workspaceId, ws.id)),
  ]);
  const inWorkspace = new Set(members.map((m) => m.userId));
  const at = (d: Date) => d.toISOString();
  return [
    ...drafts.map((d): NeedsItem => ({
      key: `draft:${d.id}`,
      kind: "approval",
      title: d.status === "blocked" ? `Held back, needs fixing: ${d.subject ?? "a draft"}` : (d.subject ?? "A draft"),
      ...(d.to ? { detail: `To ${d.to}` } : {}),
      href: `${base}/drafts/${d.id}`,
      at: at(d.at),
      assignedTo: null,
    })),
    ...tasks.map((t): NeedsItem => ({
      key: `task:${t.id}`,
      kind: "task",
      title: t.title,
      ...(t.dueOn ? { detail: `Due ${formatDateLong(t.dueOn)}` } : {}),
      href: `${base}/inbox#tasks`,
      at: at(t.at),
      assignedTo: t.ownerId && inWorkspace.has(t.ownerId) ? t.ownerId : null,
    })),
    ...flags.map((f): NeedsItem => ({ key: `flag:${f.id}`, kind: "flag", title: f.summary, href: `${base}/flags/${f.id}`, severity: "high", at: at(f.at), assignedTo: null })),
    ...docs.map((d): NeedsItem => ({ key: `document:${d.id}`, kind: "review", title: `Check what was read from ${d.name ?? "a document"}`, href: `${base}/documents/${d.id}`, at: at(d.at), assignedTo: null })),
    ...payments.map((p): NeedsItem => ({
      key: `payment:${p.id}`,
      kind: "payment",
      title: `Say what this payment is for: ${p.currency} ${p.amount}${p.payer ? ` from ${p.payer}` : ""}`,
      detail: `Received ${formatDateLong(p.on)}`,
      href: `${base}/payments/${p.id}`,
      at: at(p.at),
      assignedTo: null,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

const acts = (role: Role) => role === "owner" || role === "finance";

/** A person sees what they can act on: anything for owners and finance, and tasks given to them. */
export function itemsFor(items: NeedsItem[], userId: string, role: Role): NeedsItem[] {
  return items.filter((i) => (i.assignedTo ? i.assignedTo === userId : acts(role)));
}

/** Records new items as unread for this person and retires the unread ones nobody is waiting on now. */
export async function syncNotifications(db: Db, ws: Pick<Workspace, "id" | "slug">, userId: string, role: Role): Promise<{ open: Set<string>; unread: number }> {
  const items = itemsFor(await openItems(db, ws), userId, role);
  const open = new Set(items.map((i) => i.key));
  const mine = await db
    .select({ id: notification.id, key: notification.key, readAt: notification.readAt })
    .from(notification)
    .where(and(eq(notification.workspaceId, ws.id), eq(notification.userId, userId)));
  const known = new Set(mine.map((n) => n.key));
  const fresh = items.filter((i) => !known.has(i.key));
  if (fresh.length) {
    await db
      .insert(notification)
      .values(fresh.map(({ key, kind, assignedTo: _a, ...payload }) => ({ workspaceId: ws.id, userId, key, kind, payload })))
      .onConflictDoNothing();
  }
  const stale = mine.filter((n) => !n.readAt && !open.has(n.key)).map((n) => n.id);
  if (stale.length) await db.update(notification).set({ readAt: new Date() }).where(inArray(notification.id, stale));
  return { open, unread: mine.filter((n) => !n.readAt && open.has(n.key)).length + fresh.length };
}

export interface NotificationLine extends NotificationPayload {
  id: string;
  kind: NotificationKind;
  unread: boolean;
  /** Still waiting on someone; otherwise it has been dealt with. */
  open: boolean;
}

export async function listNotifications(db: Db, ws: Pick<Workspace, "id" | "slug">, userId: string, role: Role, limit = 60): Promise<NotificationLine[]> {
  const { open } = await syncNotifications(db, ws, userId, role);
  const rows = await db
    .select()
    .from(notification)
    .where(and(eq(notification.workspaceId, ws.id), eq(notification.userId, userId)))
    .orderBy(asc(sql`${notification.readAt} is not null`), desc(notification.createdAt))
    .limit(limit);
  return rows
    .map((n) => ({ ...n.payload, id: n.id, kind: n.kind, unread: !n.readAt, open: open.has(n.key) }))
    .sort((a, b) => Number(b.unread) - Number(a.unread) || b.at.localeCompare(a.at));
}

/** Marks one read and returns where it points, if it's this person's. */
export async function openNotification(db: Db, workspaceId: string, userId: string, id: string): Promise<string | null> {
  const [row] = await db
    .update(notification)
    .set({ readAt: sql`coalesce(${notification.readAt}, now())` })
    .where(and(eq(notification.workspaceId, workspaceId), eq(notification.userId, userId), eq(notification.id, id)))
    .returning({ payload: notification.payload });
  return row?.payload.href ?? null;
}

export async function markAllRead(db: Db, workspaceId: string, userId: string): Promise<number> {
  const rows = await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.workspaceId, workspaceId), eq(notification.userId, userId), isNull(notification.readAt)))
    .returning({ id: notification.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// The email digest
// ---------------------------------------------------------------------------

export const DIGEST_LABELS: Record<DigestFrequency, string> = { daily: "Every morning", weekly: "Monday mornings", off: "No email" };
export const isDigestFrequency = (v: unknown): v is DigestFrequency => v === "daily" || v === "weekly" || v === "off";
/** People who approve things get it unless they turn it off; everyone else can turn it on. */
export const defaultDigest = (role: Role): DigestFrequency => (acts(role) ? "daily" : "off");
/** Digests go out from this local hour. */
export const DIGEST_HOUR = 9;
const DIGEST_SECTIONS: Array<{ kind: NotificationKind; heading: string; count: [string, string] }> = [
  { kind: "approval", heading: "To approve", count: ["to approve", "to approve"] },
  { kind: "flag", heading: "High-risk flags", count: ["high-risk flag", "high-risk flags"] },
  { kind: "task", heading: "Tasks", count: ["task", "tasks"] },
  { kind: "review", heading: "Documents to check", count: ["document to check", "documents to check"] },
  { kind: "payment", heading: "Payments to place", count: ["payment to place", "payments to place"] },
];
const PER_SECTION = 5;

export interface Digest {
  subject: string;
  body: string;
  counts: Partial<Record<NotificationKind, number>>;
}

/** The digest for this person's items, or null when nothing needs them. */
export function buildDigest(items: NeedsItem[], ws: Pick<Workspace, "name" | "slug">, today: IsoDate, appUrl: string): Digest | null {
  if (!items.length) return null;
  const url = appUrl.replace(/\/$/, "");
  const counts: Digest["counts"] = {};
  const parts: string[] = [];
  const lines = [`What needs you in ${ws.name}, as of ${formatDateLong(today)}.`, ""];
  for (const s of DIGEST_SECTIONS) {
    const list = items.filter((i) => i.kind === s.kind);
    if (!list.length) continue;
    counts[s.kind] = list.length;
    parts.push(`${list.length} ${s.count[list.length === 1 ? 0 : 1]}`);
    lines.push(`${s.heading} (${list.length})`);
    for (const i of list.slice(0, PER_SECTION)) lines.push(`- ${i.title}${i.detail ? ` (${i.detail})` : ""}`, `  ${url}${i.href}`);
    if (list.length > PER_SECTION) lines.push(`- and ${list.length - PER_SECTION} more`);
    lines.push("");
  }
  lines.push(`Open the inbox: ${url}/w/${ws.slug}/inbox`, "", `Change how often you get this: ${url}/w/${ws.slug}/notifications`);
  return { subject: `${ws.name}: ${parts.join(", ")}`, body: lines.join("\n"), counts };
}

export const appUrlFrom = (env: Record<string, string | undefined> = process.env) => env.BETTER_AUTH_URL ?? "http://localhost:3000";

const localHour = (now: Date, timeZone: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
const isMonday = (d: IsoDate) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1;

export interface DigestRunDeps {
  db: Db;
  mailer: Mailer;
  env?: Record<string, string | undefined>;
  /** Limits the sweep to these workspaces. The worker leaves it out and covers them all. */
  workspaceIds?: string[];
}

/**
 * Sends the digests due now. The worker calls this every hour. A digest is claimed before it goes,
 * so running twice can't send twice, and given back if sending fails, so the next hour tries again.
 * Demo workspaces, visitors and workspaces with no working mailbox send nothing.
 */
export async function sendDueDigests(deps: DigestRunDeps, now: Date = new Date()): Promise<{ sent: number; empty: number; errors: number }> {
  const { db, mailer } = deps;
  const out = { sent: 0, empty: 0, errors: 0 };
  const live = await db
    .select({ ws: workspace })
    .from(workspace)
    .innerJoin(mailboxConnection, eq(mailboxConnection.workspaceId, workspace.id))
    .where(and(eq(workspace.isDemo, false), inArray(mailboxConnection.status, ["ok", "error"]), deps.workspaceIds ? inArray(workspace.id, deps.workspaceIds) : undefined));
  for (const { ws } of live) {
    if (localHour(now, ws.timezone) < DIGEST_HOUR) continue;
    const today = dateInZone(now, ws.timezone);
    const [items, people, prefs] = await Promise.all([
      openItems(db, ws),
      db
        .select({ userId: member.userId, role: member.role, email: user.email, anon: user.isAnonymous })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.workspaceId, ws.id)),
      db.select().from(notificationPref).where(eq(notificationPref.workspaceId, ws.id)),
    ]);
    for (const p of people) {
      if (p.anon) continue;
      const pref = prefs.find((x) => x.userId === p.userId);
      const digest = pref?.digest ?? defaultDigest(p.role);
      if (digest === "off" || (digest === "weekly" && !isMonday(today))) continue;
      const [claimed] = await db
        .insert(notificationPref)
        .values({ workspaceId: ws.id, userId: p.userId, digest, lastDigestOn: today })
        .onConflictDoUpdate({
          target: [notificationPref.workspaceId, notificationPref.userId],
          set: { lastDigestOn: today },
          where: sql`${notificationPref.lastDigestOn} is distinct from ${today}`,
        })
        .returning({ id: notificationPref.id });
      if (!claimed) continue;
      const mail = buildDigest(itemsFor(items, p.userId, p.role), ws, today, appUrlFrom(deps.env));
      if (!mail) {
        out.empty++;
        continue;
      }
      if (await deliver(deps, ws, p, mail, claimed.id, now)) out.sent++;
      else {
        out.errors++;
        await db.update(notificationPref).set({ lastDigestOn: pref?.lastDigestOn ?? null }).where(eq(notificationPref.id, claimed.id));
      }
    }
  }
  return out;
}

async function deliver(deps: DigestRunDeps, ws: Workspace, to: { userId: string; email: string }, mail: Digest, prefId: string, now: Date): Promise<boolean> {
  try {
    const r = await deps.mailer.send({ workspaceId: ws.id, from: "", to: to.email, subject: mail.subject, body: mail.body, fromName: ws.name });
    if (r.via !== "smtp") return false;
  } catch (err) {
    console.error(`[digest] ${ws.slug}: ${err instanceof Error ? err.name : "error"}`);
    return false;
  }
  await deps.db.update(notificationPref).set({ lastSentAt: now }).where(eq(notificationPref.id, prefId));
  await audit(deps.db, { workspaceId: ws.id, actorType: "system", actorId: "digest", action: "digest.sent", objectType: "user", objectId: to.userId, details: { counts: mail.counts } });
  return true;
}

export interface DigestSettings {
  digest: DigestFrequency;
  isDefault: boolean;
  lastSentAt: Date | null;
  /** The workspace's mailbox can send, so digests can leave. */
  canSend: boolean;
  preview: Digest | null;
}

export async function digestSettings(db: Db, ws: Workspace, userId: string, role: Role, today: IsoDate, env: Record<string, string | undefined> = process.env): Promise<DigestSettings> {
  const [[pref], [mailbox], items] = await Promise.all([
    db
      .select()
      .from(notificationPref)
      .where(and(eq(notificationPref.workspaceId, ws.id), eq(notificationPref.userId, userId))),
    db.select({ n: count() }).from(mailboxConnection).where(and(eq(mailboxConnection.workspaceId, ws.id), inArray(mailboxConnection.status, ["ok", "error"]))),
    openItems(db, ws),
  ]);
  return {
    digest: pref?.digest ?? defaultDigest(role),
    isDefault: !pref,
    lastSentAt: pref?.lastSentAt ?? null,
    canSend: !ws.isDemo && Number(mailbox?.n ?? 0) > 0,
    preview: buildDigest(itemsFor(items, userId, role), ws, today, appUrlFrom(env)),
  };
}

/** A person's own choice; the day of their last digest is kept. */
export async function setDigest(db: Db, workspaceId: string, userId: string, digest: DigestFrequency): Promise<void> {
  await db
    .insert(notificationPref)
    .values({ workspaceId, userId, digest })
    .onConflictDoUpdate({ target: [notificationPref.workspaceId, notificationPref.userId], set: { digest } });
}

const RESEND_AFTER_MS = 5 * 60_000;

/** "Send me one now": to the person asking, at most once every 5 minutes, whatever their setting. */
export async function sendDigestNow(deps: DigestRunDeps, ws: Workspace, me: { id: string; email: string; isAnonymous?: boolean | null }, role: Role, now: Date = new Date()): Promise<{ ok: true } | { ok: false; problem: string }> {
  const { db } = deps;
  if (ws.isDemo || me.isAnonymous) return { ok: false, problem: "Demo workspaces don't send email. The digest is shown here instead." };
  const s = await digestSettings(db, ws, me.id, role, dateInZone(now, ws.timezone), deps.env);
  if (!s.canSend) return { ok: false, problem: "Connect the workspace's mailbox in Settings first: digests are sent from it." };
  if (!s.preview) return { ok: false, problem: "Nothing needs you right now, so there's nothing to send." };
  const cutoff = new Date(now.getTime() - RESEND_AFTER_MS);
  const [claimed] = await db
    .insert(notificationPref)
    .values({ workspaceId: ws.id, userId: me.id, digest: s.digest, lastSentAt: now })
    .onConflictDoUpdate({
      target: [notificationPref.workspaceId, notificationPref.userId],
      set: { lastSentAt: now },
      where: sql`${notificationPref.lastSentAt} is null or ${notificationPref.lastSentAt} < ${cutoff.toISOString()}::timestamptz`,
    })
    .returning({ id: notificationPref.id });
  if (!claimed) return { ok: false, problem: "One was sent a moment ago. Wait a few minutes before asking again." };
  if (await deliver(deps, ws, { userId: me.id, email: me.email }, s.preview, claimed.id, now)) return { ok: true };
  await db.update(notificationPref).set({ lastSentAt: s.lastSentAt }).where(eq(notificationPref.id, claimed.id));
  return { ok: false, problem: "The mailbox wouldn't send it. Check the connection in Settings." };
}
