/**
 * W31 notifications: what each person sees, read state that's theirs alone, and digests that go
 * out once, at the right time, only when something needs someone. Needs the dev database.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, createPool, draftAction, localStorage, mailboxConnection, member, notification, notificationPref, purgeWorkspace, task, user, workspace, type Db, type Role } from "@ebo/db";
import { seedOffice, seedReferenceData } from "@ebo/db/seed";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDigest, defaultDeps, itemsFor, listNotifications, markAllRead, openItems, openNotification, runWorkspace, sendDigestNow, sendDueDigests, setDigest, syncNotifications, type Mailer, type NeedsItem, type Workspace } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-notify-")));
const people: Array<{ id: string; role: Role }> = [
  { id: `n-owner-${tag}`, role: "owner" },
  { id: `n-fin-${tag}`, role: "finance" },
  { id: `n-acc-${tag}`, role: "accountant" },
  { id: `n-view-${tag}`, role: "viewer" },
  { id: `n-anon-${tag}`, role: "finance" },
];
const [owner, finance, accountant, viewer] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0], (typeof people)[0]];
let db: Db;
let wsId = "";
let ws: Workspace;

function recording(via: "smtp" | "recorded" = "smtp", fail = false) {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const mailer: Mailer = {
    kind: "smtp",
    async send(e) {
      if (fail) throw new Error("smtp down");
      sent.push({ to: e.to, subject: e.subject, body: e.body });
      return { messageId: "x", via };
    },
  };
  return { sent, mailer };
}
/** Mondays and Tuesdays in Karachi (UTC+5). */
const MON_10 = new Date("2026-11-09T05:00:00Z");
const MON_08 = new Date("2026-11-09T03:00:00Z");
const TUE_10 = new Date("2026-11-10T05:00:00Z");
const WED_10 = new Date("2026-11-11T05:00:00Z");
const clearPrefs = () => db.delete(notificationPref).where(eq(notificationPref.workspaceId, wsId));
const email = (p: { id: string }) => `${p.id}@example.org`;

describe("the digest's words", () => {
  const item = (kind: NeedsItem["kind"], n: number): NeedsItem => ({ key: `${kind}:${n}`, kind, title: `${kind} ${n}`, href: `/w/x/${kind}/${n}`, at: "2026-11-01T00:00:00Z", assignedTo: null });

  it("sends nothing when nothing needs the person", () => {
    expect(buildDigest([], { name: "Ravi", slug: "x" }, "2026-11-09", "http://a")).toBeNull();
  });

  it("counts everything, lists the first five of each kind and links back", () => {
    const d = buildDigest([...[1, 2, 3, 4, 5, 6, 7].map((n) => item("approval", n)), item("task", 1)], { name: "Ravi", slug: "x" }, "2026-11-09", "https://app.example/")!;
    expect(d.subject).toBe("Ravi: 7 to approve, 1 task");
    expect(d.counts).toEqual({ approval: 7, task: 1 });
    expect(d.body).toContain("To approve (7)");
    expect(d.body).toContain("approval 5");
    expect(d.body).not.toContain("approval 6");
    expect(d.body).toContain("and 2 more");
    expect(d.body).toContain("https://app.example/w/x/task/1");
    expect(d.body).toContain("https://app.example/w/x/notifications");
  });

  it("gives a task to the person it's assigned to, and nobody else", () => {
    const list = [{ ...item("task", 1), assignedTo: "a" }, item("flag", 1)];
    expect(itemsFor(list, "a", "viewer").map((i) => i.key)).toEqual(["task:1"]);
    expect(itemsFor(list, "b", "owner").map((i) => i.key)).toEqual(["flag:1"]);
    expect(itemsFor(list, "b", "accountant")).toEqual([]);
  });
});

describe.skipIf(!dbUp)("notifications (W31)", () => {
  beforeAll(async () => {
    db = createDb(pool);
    await seedReferenceData(db);
    wsId = (await seedOffice(db, storage, { slug: `test-${tag}-notify` })).workspaceId;
    await db.insert(user).values(people.map((p, i) => ({ id: p.id, name: p.role, email: email(p), emailVerified: true, isAnonymous: i === 4 })));
    await db.insert(member).values(people.map((p) => ({ workspaceId: wsId, userId: p.id, role: p.role })));
    await runWorkspace(defaultDeps({ db, storage }), wsId, { kind: "manual" });
    await db.update(workspace).set({ isDemo: false }).where(eq(workspace.id, wsId));
    await db.insert(mailboxConnection).values({ workspaceId: wsId, imapHost: "i.example", imapPort: 993, smtpHost: "s.example", smtpPort: 465, username: "books@example.org", secretEncrypted: "x" });
    ws = (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
  }, 120_000);

  afterAll(async () => {
    if (dbUp) {
      if (wsId) await purgeWorkspace(db, storage, wsId);
      await db.delete(user).where(inArray(user.id, people.map((p) => p.id)));
    }
    await pool.end();
  });

  it("shows owners what's open, and a viewer nothing", async () => {
    const owners = await syncNotifications(db, ws, owner.id, "owner");
    expect(owners.unread).toBeGreaterThan(0);
    expect(owners.unread).toBe(itemsFor(await openItems(db, ws), owner.id, "owner").length);
    expect((await syncNotifications(db, ws, viewer.id, "viewer")).unread).toBe(0);
  });

  it("records each item once, however often it syncs", async () => {
    const first = await syncNotifications(db, ws, finance.id, "finance");
    const second = await syncNotifications(db, ws, finance.id, "finance");
    expect(second.unread).toBe(first.unread);
    const rows = await db.select().from(notification).where(and(eq(notification.workspaceId, wsId), eq(notification.userId, finance.id)));
    expect(rows).toHaveLength(first.unread);
  });

  it("keeps read state per person", async () => {
    const before = (await syncNotifications(db, ws, owner.id, "owner")).unread;
    const [line] = await listNotifications(db, ws, finance.id, "finance");
    // Someone else can't open or read another person's notification.
    expect(await openNotification(db, wsId, owner.id, line!.id)).toBeNull();
    expect(await openNotification(db, wsId, finance.id, line!.id)).toBe(line!.href);
    expect((await syncNotifications(db, ws, owner.id, "owner")).unread).toBe(before);
    await markAllRead(db, wsId, finance.id);
    expect((await syncNotifications(db, ws, finance.id, "finance")).unread).toBe(0);
    expect((await syncNotifications(db, ws, owner.id, "owner")).unread).toBe(before);
  });

  it("drops an item from the count once it's dealt with, and keeps it as history", async () => {
    const [draft] = await db.select().from(draftAction).where(and(eq(draftAction.workspaceId, wsId), eq(draftAction.status, "draft"))).limit(1);
    expect(draft).toBeTruthy();
    const before = (await syncNotifications(db, ws, owner.id, "owner")).unread;
    await db.update(draftAction).set({ status: "rejected" }).where(eq(draftAction.id, draft!.id));
    expect((await syncNotifications(db, ws, owner.id, "owner")).unread).toBe(before - 1);
    const line = (await listNotifications(db, ws, owner.id, "owner")).find((l) => l.href.endsWith(draft!.id));
    expect(line).toMatchObject({ unread: false, open: false });
    await db.update(draftAction).set({ status: "draft" }).where(eq(draftAction.id, draft!.id));
  });

  it("sends an assigned task only to its owner, even a viewer", async () => {
    const [t] = await db.insert(task).values({ workspaceId: wsId, title: `Sign the form ${tag}`, ownerId: viewer.id, key: `t-${tag}` }).returning();
    const titles = async (id: string, role: Role) => itemsFor(await openItems(db, ws), id, role).map((i) => i.title);
    expect(await titles(viewer.id, "viewer")).toEqual([`Sign the form ${tag}`]);
    expect(await titles(owner.id, "owner")).not.toContain(`Sign the form ${tag}`);
    // Someone no longer in the workspace can't hold a task: it goes back to those who can act.
    await db.update(task).set({ ownerId: "gone" }).where(eq(task.id, t!.id));
    expect(await titles(owner.id, "owner")).toContain(`Sign the form ${tag}`);
    await db.delete(task).where(eq(task.id, t!.id));
  });

  it("emails owners and finance by default, once a day, from 9 o'clock", async () => {
    await clearPrefs();
    const { sent, mailer } = recording();
    expect(await sendDueDigests({ db, workspaceIds: [wsId], mailer }, MON_08)).toEqual({ sent: 0, empty: 0, errors: 0 });
    const r = await sendDueDigests({ db, workspaceIds: [wsId], mailer }, MON_10);
    expect(r.sent).toBe(2);
    expect(sent.map((s) => s.to).sort()).toEqual([email(finance), email(owner)].sort());
    expect(sent[0]!.subject).toMatch(/to approve/);
    await sendDueDigests({ db, workspaceIds: [wsId], mailer }, MON_10);
    expect(sent).toHaveLength(2);
    await sendDueDigests({ db, workspaceIds: [wsId], mailer }, TUE_10);
    expect(sent).toHaveLength(4);
  });

  it("respects each person's choice: off, Mondays only, or turned on", async () => {
    await clearPrefs();
    await setDigest(db, wsId, owner.id, "off");
    await setDigest(db, wsId, finance.id, "weekly");
    await setDigest(db, wsId, accountant.id, "daily");
    const { sent, mailer } = recording();
    await sendDueDigests({ db, workspaceIds: [wsId], mailer }, WED_10);
    expect(sent).toHaveLength(0); // the accountant has nothing to act on, the owner is off, finance waits for Monday
    await sendDueDigests({ db, workspaceIds: [wsId], mailer }, MON_10);
    expect(sent.map((s) => s.to)).toEqual([email(finance)]);
  });

  it("tries again next hour when sending fails, and doesn't count an unsent email", async () => {
    await clearPrefs();
    const broken = recording("smtp", true);
    expect((await sendDueDigests({ db, workspaceIds: [wsId], mailer: broken.mailer }, MON_10)).errors).toBe(2);
    const recorded = recording("recorded");
    expect((await sendDueDigests({ db, workspaceIds: [wsId], mailer: recorded.mailer }, MON_10)).errors).toBe(2);
    const { sent, mailer } = recording();
    expect((await sendDueDigests({ db, workspaceIds: [wsId], mailer }, MON_10)).sent).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it("never sends for a demo workspace or without a mailbox", async () => {
    await clearPrefs();
    const { sent, mailer } = recording();
    await db.update(workspace).set({ isDemo: true }).where(eq(workspace.id, wsId));
    await sendDueDigests({ db, workspaceIds: [wsId], mailer }, MON_10);
    await db.update(workspace).set({ isDemo: false }).where(eq(workspace.id, wsId));
    await db.update(mailboxConnection).set({ status: "paused" }).where(eq(mailboxConnection.workspaceId, wsId));
    await sendDueDigests({ db, workspaceIds: [wsId], mailer }, MON_10);
    await db.update(mailboxConnection).set({ status: "ok" }).where(eq(mailboxConnection.workspaceId, wsId));
    expect(sent).toHaveLength(0);
  });

  it("sends on request at most every five minutes, and says why not", async () => {
    await clearPrefs();
    const { sent, mailer } = recording();
    const me = { id: owner.id, email: email(owner) };
    const t = new Date("2026-11-09T05:00:00Z");
    expect(await sendDigestNow({ db, mailer }, ws, me, "owner", t)).toEqual({ ok: true });
    expect(await sendDigestNow({ db, mailer }, ws, me, "owner", new Date(t.getTime() + 60_000))).toMatchObject({ ok: false, problem: expect.stringContaining("moment ago") });
    expect(await sendDigestNow({ db, mailer }, ws, me, "owner", new Date(t.getTime() + 6 * 60_000))).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
    expect(await sendDigestNow({ db, mailer }, ws, { id: viewer.id, email: email(viewer) }, "viewer", t)).toMatchObject({ ok: false, problem: expect.stringContaining("Nothing needs you") });
    expect(await sendDigestNow({ db, mailer }, { ...ws, isDemo: true }, me, "owner", t)).toMatchObject({ ok: false, problem: expect.stringContaining("Demo") });
  });
});
