import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Where documents live. Vultr Object Storage (S3-compatible) when S3_* is configured,
 * a local folder otherwise (development, tests). Paths are relative keys such as
 * `ws/<workspace id>/docs/<sha256>.pdf`; nothing outside the root can be addressed.
 */
export interface Storage {
  readonly kind: "local" | "s3";
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  getText(key: string): Promise<string>;
  deletePrefix(prefix: string): Promise<void>;
  /** Every object under a prefix (a folder, like "db"). */
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
}

export interface StoredObject {
  key: string;
  size: number;
  modified: Date;
}

export function sha256(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Walks up from the current folder to the repo root (the folder with pnpm-workspace.yaml). */
export function repoRoot(from = process.cwd()): string {
  let dir = resolve(/*turbopackIgnore: true*/ from);
  for (;;) {
    if (existsSync(join(/*turbopackIgnore: true*/ dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(/*turbopackIgnore: true*/ from);
    dir = up;
  }
}

function checkKey(key: string): string {
  const clean = key.replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === ".." || part === "")) throw new Error(`bad storage key: ${key}`);
  return clean;
}

export function localStorage(root = process.env.STORAGE_DIR ?? join(repoRoot(), ".storage")): Storage {
  // The folder is chosen at run time; the ignore comments stop the bundler tracing the whole repo.
  const base = resolve(/*turbopackIgnore: true*/ root);
  const pathOf = (key: string) => {
    const p = resolve(/*turbopackIgnore: true*/ base, checkKey(key));
    if (!p.startsWith(base + sep)) throw new Error(`bad storage key: ${key}`);
    return p;
  };
  return {
    kind: "local",
    async put(key, body) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async get(key) {
      return new Uint8Array(await readFile(pathOf(key)));
    },
    async getText(key) {
      return readFile(pathOf(key), "utf8");
    },
    async deletePrefix(prefix) {
      await rm(pathOf(prefix), { recursive: true, force: true });
    },
    async list(prefix) {
      const dir = pathOf(prefix);
      if (!existsSync(dir)) return [];
      const out: StoredObject[] = [];
      for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = join(entry.parentPath, entry.name);
        const st = await stat(full);
        out.push({ key: relative(base, full).split(sep).join("/"), size: st.size, modified: st.mtime });
      }
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

export interface S3Settings {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

function s3Client(s: S3Settings): S3Client {
  return new S3Client({
    endpoint: s.endpoint.startsWith("http") ? s.endpoint : `https://${s.endpoint}`,
    region: s.region ?? "us-east-1", // Vultr ignores the region, but the SDK requires one
    forcePathStyle: true,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // The SDK's newer checksums are made for AWS. Not every S3-compatible service accepts them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** Creates the bucket unless it's already there. */
export async function ensureBucket(s: S3Settings): Promise<"created" | "exists"> {
  const client = s3Client(s);
  const found = await client.send(new HeadBucketCommand({ Bucket: s.bucket })).then(() => true, () => false);
  if (found) return "exists";
  await client.send(new CreateBucketCommand({ Bucket: s.bucket }));
  return "created";
}

export function s3Storage(s: S3Settings): Storage {
  const client = s3Client(s);
  const get = async (key: string) => {
    const out = await client.send(new GetObjectCommand({ Bucket: s.bucket, Key: checkKey(key) }));
    if (!out.Body) throw new Error(`empty object: ${key}`);
    return out.Body.transformToByteArray();
  };
  const list = async (prefix: string) => {
    const p = checkKey(prefix).replace(/\/?$/, "/");
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: s.bucket, Prefix: p, ContinuationToken: token }));
      for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, modified: o.LastModified ?? new Date(0) });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  };
  return {
    kind: "s3",
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: s.bucket, Key: checkKey(key), Body: body, ContentType: contentType }));
    },
    get,
    async getText(key) {
      return new TextDecoder().decode(await get(key));
    },
    async deletePrefix(prefix) {
      // One at a time: S3's bulk delete requires a checksum, in a form not every service accepts.
      for (const o of await list(prefix)) await client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: o.key }));
    },
    list,
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: checkKey(key) }));
    },
  };
}

/** S3 when S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY and S3_BUCKET_DOCUMENTS are all set; local otherwise. */
export function storageFromEnv(env: Record<string, string | undefined> = process.env): Storage {
  const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_DOCUMENTS } = env;
  if (S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY && S3_BUCKET_DOCUMENTS) {
    return s3Storage({ endpoint: S3_ENDPOINT, accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY, bucket: S3_BUCKET_DOCUMENTS });
  }
  return localStorage();
}

/**
 * Where database backups go: the separate backups bucket (S3_BUCKET_BACKUPS, created by
 * `pnpm infra:apply`) with the same Object Storage keys, or a local folder otherwise.
 */
export function backupStorageFromEnv(env: Record<string, string | undefined> = process.env): Storage {
  const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_BACKUPS } = env;
  if (S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY && S3_BUCKET_BACKUPS) {
    return s3Storage({ endpoint: S3_ENDPOINT, accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY, bucket: S3_BUCKET_BACKUPS });
  }
  return localStorage(env.BACKUP_DIR ?? join(repoRoot(), ".backups"));
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "message/rfc822": "eml",
  "application/json": "json",
};

/** Content-addressed key for a workspace document: the same file is stored once. */
export function documentKey(workspaceId: string, hash: string, mimeType: string): string {
  return `ws/${workspaceId}/docs/${hash}.${EXTENSIONS[mimeType] ?? "bin"}`;
}

export const workspacePrefix = (workspaceId: string) => `ws/${workspaceId}`;
