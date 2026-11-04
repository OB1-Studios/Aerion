import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Secrets the app has to use later (a mailbox app password) are sealed with AES-256-GCM
 * before they're stored. The key comes from APP_ENCRYPTION_KEY, or is derived from
 * BETTER_AUTH_SECRET when that isn't set. Changing the key makes stored secrets unreadable,
 * so the mailbox would have to be connected again.
 */

type Env = Record<string, string | undefined>;

function key(env: Env, info = "mailbox-secret-v1"): Buffer {
  const raw = env.APP_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET;
  if (!raw) throw new Error("Set APP_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) before storing secrets.");
  return Buffer.from(hkdfSync("sha256", raw, "ebo-secrets", info, 32));
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

/** Backups: "EBOBAK1\n", then the IV (12 bytes), the GCM tag (16 bytes) and the encrypted body. */
const BACKUP_MAGIC = Buffer.from("EBOBAK1\n");

export function sealBackup(body: Uint8Array, env: Env = process.env): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(env, "backup-v1"), iv);
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, iv, cipher.getAuthTag(), enc]);
}

export function openBackup(sealed: Uint8Array, env: Env = process.env): Buffer {
  const b = Buffer.from(sealed);
  if (b.length < BACKUP_MAGIC.length + 28 || !b.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error("This file isn't a backup made by this app.");
  const at = BACKUP_MAGIC.length;
  const decipher = createDecipheriv("aes-256-gcm", key(env, "backup-v1"), b.subarray(at, at + 12));
  decipher.setAuthTag(b.subarray(at + 12, at + 28));
  try {
    return Buffer.concat([decipher.update(b.subarray(at + 28)), decipher.final()]);
  } catch {
    throw new Error("Can't open this backup: it was made with a different APP_ENCRYPTION_KEY, or the file is damaged.");
  }
}
