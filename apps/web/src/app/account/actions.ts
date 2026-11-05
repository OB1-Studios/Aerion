"use server";

import { getDb, member } from "@ebo/db";
import { audit } from "@ebo/engine";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { clearFailures, limited, recordFailure, TOO_MANY } from "@/lib/limits";
import { qrSvg } from "@/lib/qr";
import { requireUser } from "@/lib/session";
import { authProblem, twoFactorUnavailable, workspacesRequiringTwoFactor } from "@/lib/two-factor";

export interface SetupState {
  step: "password" | "verify";
  problems: string[];
  /** The authenticator link (otpauth://), its QR code, the key to type in by hand, and the backup codes. */
  uri?: string;
  qr?: string;
  key?: string;
  backupCodes?: string[];
}

export interface CodesState {
  problems: string[];
  backupCodes?: string[];
}

const URI_RE = /^otpauth:\/\/totp\/[^\s"<>]{1,400}$/;
const BACKUP_RE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;
const wrongPassword = (err: unknown) => (err as { body?: { code?: string } } | null)?.body?.code === "INVALID_PASSWORD";

/** The page for scanning the code. Rebuilt from the link each time, never from HTML the browser sent back. */
function verifyStep(uri: string, backupCodes: string[], problems: string[]): SetupState {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return { step: "verify", problems, uri, qr: qrSvg(uri, "QR code to scan with your authenticator app"), key: secret.replace(/(.{4})/g, "$1 ").trim(), backupCodes };
}

/** Each workspace the person belongs to gets the change in its audit log, so owners can see it. */
async function auditEverywhere(userId: string, action: string) {
  const db = getDb();
  const rows = await db.select({ id: member.workspaceId }).from(member).where(eq(member.userId, userId));
  await audit(
    db,
    rows.map((r) => ({ workspaceId: r.id, actorType: "user" as const, actorId: userId, action, objectType: "user", objectId: userId })),
  );
}

/**
 * Turning on two-factor sign-in. Step 1 checks the password and makes a new secret (not in use yet).
 * Step 2: the first code from the authenticator app proves it was saved, and turns it on.
 */
export async function setupTwoFactor(_prev: SetupState, form: FormData): Promise<SetupState> {
  const me = await requireUser();
  const blocked = twoFactorUnavailable(me);
  if (blocked) return { step: "password", problems: [blocked] };
  if (me.twoFactorEnabled) redirect("/account");
  const h = await headers();

  if (form.get("step") === "verify") {
    const uri = String(form.get("uri") ?? "");
    if (!URI_RE.test(uri)) return { step: "password", problems: ["Start again: enter your password to make a new code."] };
    const codes = String(form.get("codes") ?? "")
      .split(/\s+/)
      .filter((c) => BACKUP_RE.test(c))
      .slice(0, 20);
    const code = String(form.get("code") ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) return verifyStep(uri, codes, ["Enter the six digits the app shows."]);
    try {
      await auth.api.verifyTOTP({ body: { code }, headers: h });
    } catch (err) {
      return verifyStep(uri, codes, [authProblem(err)]);
    }
    await auditEverywhere(me.id, "two_factor.turned_on");
    const asked = String(form.get("required") ?? "");
    redirect(/^[a-z0-9-]{1,80}$/.test(asked) ? `/account?done=on&required=${asked}` : "/account?done=on");
  }

  const key = `password:${me.id}`;
  if (limited(key, 5)) return { step: "password", problems: [TOO_MANY] };
  let res: { totpURI?: string; backupCodes?: string[] };
  try {
    res = (await auth.api.enableTwoFactor({ body: { password: String(form.get("password") ?? "") }, headers: h })) as typeof res;
  } catch (err) {
    if (wrongPassword(err)) recordFailure(key);
    return { step: "password", problems: [authProblem(err)] };
  }
  clearFailures(key);
  if (!res.totpURI || !URI_RE.test(res.totpURI)) return { step: "password", problems: ["That didn't work. Try again in a minute."] };
  return verifyStep(res.totpURI, res.backupCodes ?? [], []);
}

/** Turning it off takes the password, and isn't allowed while a workspace requires it of this person. */
export async function turnOffTwoFactor(_prev: CodesState, form: FormData): Promise<CodesState> {
  const me = await requireUser();
  if (!me.twoFactorEnabled) redirect("/account");
  const required = await workspacesRequiringTwoFactor(me.id);
  if (required.length) {
    return { problems: [`${required.join(", ")} require${required.length === 1 ? "s" : ""} it for owners and finance. An owner there can lift the requirement in Settings.`] };
  }
  const key = `password:${me.id}`;
  if (limited(key, 5)) return { problems: [TOO_MANY] };
  try {
    await auth.api.disableTwoFactor({ body: { password: String(form.get("password") ?? "") }, headers: await headers() });
  } catch (err) {
    if (wrongPassword(err)) recordFailure(key);
    return { problems: [authProblem(err)] };
  }
  clearFailures(key);
  await auditEverywhere(me.id, "two_factor.turned_off");
  redirect("/account?done=off");
}

/** New backup codes replace the old ones, which stop working. */
export async function renewBackupCodes(_prev: CodesState, form: FormData): Promise<CodesState> {
  const me = await requireUser();
  if (!me.twoFactorEnabled) redirect("/account");
  const key = `password:${me.id}`;
  if (limited(key, 5)) return { problems: [TOO_MANY] };
  let res: { backupCodes?: string[] };
  try {
    res = await auth.api.generateBackupCodes({ body: { password: String(form.get("password") ?? "") }, headers: await headers() });
  } catch (err) {
    if (wrongPassword(err)) recordFailure(key);
    return { problems: [authProblem(err)] };
  }
  clearFailures(key);
  await auditEverywhere(me.id, "two_factor.backup_codes_renewed");
  return { problems: [], backupCodes: res.backupCodes ?? [] };
}
