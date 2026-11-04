import "server-only";
import { account, getDb, session, twoFactor as twoFactorTable, user, verification } from "@ebo/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { anonymous, twoFactor } from "better-auth/plugins";

/**
 * Sign-in (better-auth): email and password, optional TOTP two-factor, and anonymous
 * visitors for "Try the demo". Workspaces, roles and invitations are our own tables.
 */
export const auth = betterAuth({
  appName: "IT Export Back Office",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET ?? (process.env.NODE_ENV === "production" ? undefined : "dev-only-secret-change-me-0123456789"),
  database: drizzleAdapter(getDb(), { provider: "pg", schema: { user, session, account, verification, twoFactor: twoFactorTable } }),
  emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  plugins: [twoFactor({ issuer: "IT Export Back Office" }), anonymous({ emailDomainName: "visitor.invalid" }), nextCookies()],
});
