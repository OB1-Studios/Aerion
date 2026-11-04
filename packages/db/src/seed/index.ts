import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import { account, fxReferenceRate, member, rule, user, workspace } from "../schema";
import type { Storage } from "../storage";
import { purgeWorkspace } from "../workspace";
import { seedFreelancer } from "./freelancer";
import { seedOffice } from "./office";
import { rateRows } from "./rates";
import { globalRuleRows } from "./rules";

export { seedOffice, OFFICE_CLOCK } from "./office";
export { seedFreelancer, FREELANCER_CLOCK } from "./freelancer";
export { simulatedRate, BASE_RATES } from "./rates";
export { creditAdviceText, fakeUetr, generated, type AdviceFields, type Truth } from "./documents";
export { answerFor, answerKey, pkIban, type AnswerContext, type AnswerDoc, type AnswerKeyOptions } from "./answers";
export { officeInbox, OFFICE_FACTS } from "./office";
export { freelancerInbox, FREELANCER_FACTS } from "./freelancer";
export { adviceNo } from "./helpers";

export const DEMO_SLUGS = { office: "ravi-code-works", freelancer: "ayesha-siddiqui" } as const;

/** The people in the demo (data spec section 7 and 11). All fictional. */
export const DEMO_PEOPLE = {
  sana: { name: "Sana Malik", email: "sana@ravicodeworks.example" },
  hamza: { name: "Hamza Rafiq", email: "hamza@ravicodeworks.example" },
  qureshi: { name: "Imran Qureshi", email: "qureshi@qureshi-associates.example" },
  ayesha: { name: "Ayesha Siddiqui", email: "ayesha@ayeshabuilds.example" },
} as const;

/** Shared by every workspace: reference rates and the starting rules. Safe to run again. */
export async function seedReferenceData(db: Db): Promise<void> {
  const rates = rateRows();
  for (let i = 0; i < rates.length; i += 500) {
    await db
      .insert(fxReferenceRate)
      .values(rates.slice(i, i + 500))
      .onConflictDoUpdate({ target: [fxReferenceRate.currency, fxReferenceRate.rateDate], set: { midRate: sql`excluded.mid_rate`, source: sql`excluded.source` } });
  }
  for (const r of globalRuleRows()) {
    const existing = await db.select({ id: rule.id }).from(rule).where(and(isNull(rule.workspaceId), eq(rule.key, r.key)));
    if (existing.length) continue; // keep whatever a person verified or changed
    await db.insert(rule).values(r);
  }
}

/** Creates (or keeps) a password user directly in the better-auth tables. */
export async function ensurePasswordUser(db: Db, p: { name: string; email: string }, password: string): Promise<string> {
  const found = await db.select({ id: user.id }).from(user).where(eq(user.email, p.email));
  const hash = await hashPassword(password);
  if (found[0]) {
    await db.update(account).set({ password: hash, updatedAt: new Date() }).where(and(eq(account.userId, found[0].id), eq(account.providerId, "credential")));
    return found[0].id;
  }
  const id = randomUUID();
  await db.insert(user).values({ id, name: p.name, email: p.email, emailVerified: true });
  await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
  return id;
}

/**
 * Reloads the two shared demo workspaces from scratch (data spec section 13, "reset").
 * Their users sign in with DEMO_PASSWORD.
 */
export async function resetSharedDemo(db: Db, storage: Storage, password: string): Promise<{ office: string; freelancer: string }> {
  await seedReferenceData(db);
  const ids = {
    sana: await ensurePasswordUser(db, DEMO_PEOPLE.sana, password),
    hamza: await ensurePasswordUser(db, DEMO_PEOPLE.hamza, password),
    qureshi: await ensurePasswordUser(db, DEMO_PEOPLE.qureshi, password),
    ayesha: await ensurePasswordUser(db, DEMO_PEOPLE.ayesha, password),
  };
  const old = await db.select({ id: workspace.id }).from(workspace).where(inArray(workspace.slug, Object.values(DEMO_SLUGS)));
  for (const w of old) await purgeWorkspace(db, storage, w.id);
  const office = await seedOffice(db, storage, {
    slug: DEMO_SLUGS.office,
    members: [
      { userId: ids.sana, role: "owner" },
      { userId: ids.hamza, role: "finance" },
      { userId: ids.qureshi, role: "accountant" },
    ],
  });
  const freelancer = await seedFreelancer(db, storage, {
    slug: DEMO_SLUGS.freelancer,
    members: [
      { userId: ids.ayesha, role: "owner" },
      { userId: ids.qureshi, role: "accountant" },
    ],
  });
  return { office: office.workspaceId, freelancer: freelancer.workspaceId };
}

/** A private copy of both demo workspaces for one visitor ("Try the demo"). Expires after a week. */
export async function createVisitorDemo(db: Db, storage: Storage, userId: string, days = 7): Promise<{ office: { id: string; slug: string }; freelancer: { id: string; slug: string } }> {
  const tag = randomBytes(4).toString("hex");
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const officeSlug = `demo-${tag}-office`;
  const freelancerSlug = `demo-${tag}-freelancer`;
  const office = await seedOffice(db, storage, { slug: officeSlug, members: [{ userId, role: "owner" }], expiresAt });
  const freelancer = await seedFreelancer(db, storage, { slug: freelancerSlug, members: [{ userId, role: "owner" }], expiresAt });
  return { office: { id: office.workspaceId, slug: officeSlug }, freelancer: { id: freelancer.workspaceId, slug: freelancerSlug } };
}

/** Deletes visitor copies past their expiry date. Run daily by the worker. */
export async function purgeExpiredDemos(db: Db, storage: Storage, now = new Date()): Promise<number> {
  const expired = await db.select({ id: workspace.id }).from(workspace).where(and(eq(workspace.isDemo, true), lt(workspace.expiresAt, now)));
  for (const w of expired) await purgeWorkspace(db, storage, w.id);
  return expired.length;
}

/** Reloads one demo workspace in place: same slug, same members, fresh data and clock. */
export async function resetDemoWorkspace(db: Db, storage: Storage, workspaceId: string): Promise<string> {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId));
  if (!ws?.isDemo) throw new Error("only demo workspaces can be reset");
  const members = await db.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.workspaceId, workspaceId));
  await purgeWorkspace(db, storage, workspaceId);
  const opts = { slug: ws.slug, name: ws.name, members, expiresAt: ws.expiresAt };
  const seeded = ws.kind === "company" ? await seedOffice(db, storage, opts) : await seedFreelancer(db, storage, opts);
  return seeded.workspaceId;
}
