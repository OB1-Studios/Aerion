import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Secrets the app has to use later (a mailbox app password) are sealed with AES-256-GCM
 * before they're stored. The key comes from APP_ENCRYPTION_KEY, or is derived from
 * BETTER_AUTH_SECRET when that isn't set. Changing the key makes stored secrets unreadable,
 * so the mailbox would have to be connected again.
 */

type Env = Record<string, string | undefined>;

function key(env: Env): Buffer {
  const raw = env.APP_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET;
  if (!raw) throw new Error("Set APP_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) before storing secrets.");
  return Buffer.from(hkdfSync("sha256", raw, "ebo-secrets", "mailbox-secret-v1", 32));
}

export function sealSecret(plain: string, env: Env = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(env), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function openSecret(sealed: string, env: Env = process.env): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || body == null) throw new Error("This secret isn't in a format the app can read.");
  const decipher = createDecipheriv("aes-256-gcm", key(env), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
