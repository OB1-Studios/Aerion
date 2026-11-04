/**
 * Inviting people into a workspace, against the local database: links work once, only for the
 * invited address and only before they expire; only a hash of the token is stored; and a
 * workspace always keeps an owner.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, invitation, member, purgeWorkspace, user, workspace, type Db } from "@ebo/db";
import { and, eq } from "drizzle-orm";
import { acceptInvitation, createWorkspace, findInvitation, inviteMember, revokeInvitation, setMemberRole } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 4);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const owner = { id: `test-owner-${tag}`, name: "Bilal Ahmed", email: `bilal-${tag}@example.invalid` };
const accountant = { id: `test-acct-${tag}`, name: "Nadia Qureshi", email: `nadia-${tag}@example.invalid` };
const stranger = { id: `test-other-${tag}`, name: "Someone Else", email: `someone-${tag}@example.invalid` };
let db: Db;
let wsId = "";

describe.skipIf(!dbUp)("people in a workspace", () => {
  beforeAll(async () => {
    db = createDb(pool);
    await db.insert(user).values([owner, accountant, stranger].map((u) => ({ ...u, emailVerified: false })));
    const w = await createWorkspace(db, { kind: "company", name: `Team Test ${tag}`, legalName: "", city: "" }, owner);
    if (!w.ok) throw new Error("no workspace");
    wsId = w.id;
  });

  afterAll(async () => {
    if (dbUp) {
      if (wsId) await purgeWorkspace(db, null, wsId);
      for (const u of [owner, accountant, stranger]) await db.delete(user).where(eq(user.id, u.id));
    }
    await pool.end();
  });

  const ws = async () => (await db.select().from(workspace).where(eq(workspace.id, wsId)))[0]!;
  const roles = async () => (await db.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.workspaceId, wsId))).map((m) => `${m.userId === owner.id ? "owner" : m.userId === accountant.id ? "nadia" : m.userId}:${m.role}`).sort();

  it("invites by email; the link only works for that address, once", async () => {
    expect(await inviteMember(db, await ws(), { email: "nope", role: "boss" }, owner.id)).toEqual({ ok: false, problems: ["The email address doesn't look right.", "Choose a role."] });
    expect(await inviteMember(db, await ws(), { email: owner.email.toUpperCase(), role: "finance" }, owner.id)).toEqual({ ok: false, problems: [`${owner.email} is already in this workspace.`] });

    const first = await inviteMember(db, await ws(), { email: ` ${accountant.email.toUpperCase()} `, role: "viewer" }, owner.id);
    const inv = await inviteMember(db, await ws(), { email: accountant.email, role: "accountant" }, owner.id);
    if (!first.ok || !inv.ok) throw new Error("not invited");
    // Inviting again replaces the first link; only a hash of the token is stored.
    expect(await findInvitation(db, first.token)).toBeNull();
    const stored = await db.select().from(invitation).where(and(eq(invitation.workspaceId, wsId), eq(invitation.email, accountant.email)));
    expect(stored.map((s) => s.token)).toEqual([createHash("sha256").update(inv.token).digest("hex")]);
    expect(await findInvitation(db, inv.token)).toMatchObject({ email: accountant.email, role: "accountant", workspaceName: `Team Test ${tag}`, invitedByName: "Bilal Ahmed", problem: null });

    expect(await acceptInvitation(db, inv.token, { ...stranger, isAnonymous: false })).toEqual({ ok: false, reason: `This invitation is for ${accountant.email}. Sign in with that address to accept it.` });
    expect(await acceptInvitation(db, inv.token, { ...accountant, isAnonymous: true })).toEqual({ ok: false, reason: "Create an account first, with the invited email address." });
    expect(await acceptInvitation(db, inv.token, accountant)).toEqual({ ok: true, slug: `team-test-${tag}` });
    expect(await roles()).toEqual(["nadia:accountant", "owner:owner"]);
    expect(await acceptInvitation(db, inv.token, accountant)).toEqual({ ok: false, reason: "This invitation has already been used." });
    expect((await db.select().from(member).where(and(eq(member.workspaceId, wsId), eq(member.userId, accountant.id))))[0]!.invitedBy).toBe(owner.id);
  });

  it("links expire, can be revoked, and nonsense tokens find nothing", async () => {
    const inv = await inviteMember(db, await ws(), { email: stranger.email, role: "viewer" }, owner.id, new Date("2026-10-01T00:00:00Z"));
    if (!inv.ok) throw new Error("not invited");
    expect((await findInvitation(db, inv.token))?.problem).toBe("This invitation has expired. Ask for a new one.");
    expect(await acceptInvitation(db, inv.token, stranger)).toEqual({ ok: false, reason: "This invitation has expired. Ask for a new one." });
    const again = await inviteMember(db, await ws(), { email: stranger.email, role: "viewer" }, owner.id);
    if (!again.ok) throw new Error("not invited");
    expect(await revokeInvitation(db, wsId, again.id, owner.id)).toBe(true);
    expect(await findInvitation(db, again.token)).toBeNull();
    expect(await findInvitation(db, "x")).toBeNull();
    expect(await findInvitation(db, "A".repeat(32))).toBeNull();
  });

  it("roles change and people leave, but the last owner stays", async () => {
    const [mine] = await db.select().from(member).where(and(eq(member.workspaceId, wsId), eq(member.userId, owner.id)));
    const [hers] = await db.select().from(member).where(and(eq(member.workspaceId, wsId), eq(member.userId, accountant.id)));
    const keepOne = { ok: false, reason: "A workspace needs at least one owner. Make someone else an owner first." };
    expect(await setMemberRole(db, wsId, mine!.id, "finance", owner.id)).toEqual(keepOne);
    expect(await setMemberRole(db, wsId, mine!.id, null, owner.id)).toEqual(keepOne);
    expect(await setMemberRole(db, wsId, hers!.id, "owner", owner.id)).toEqual({ ok: true });
    expect(await setMemberRole(db, wsId, mine!.id, "finance", owner.id)).toEqual({ ok: true });
    expect(await roles()).toEqual(["nadia:owner", "owner:finance"]);
    expect(await setMemberRole(db, wsId, hers!.id, null, owner.id)).toEqual(keepOne);
    expect(await setMemberRole(db, wsId, mine!.id, null, accountant.id)).toEqual({ ok: true });
    expect(await roles()).toEqual(["nadia:owner"]);
  });
});
