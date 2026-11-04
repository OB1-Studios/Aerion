/**
 * The restore drill (main doc W33), against the local database: back up the whole database,
 * restore it into a new one, and check every row came back exactly. Then the refusals: a
 * database with data, one from another release, the wrong key, a damaged file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, localStorage, type PgPool } from "@ebo/db";
import { runMigrations } from "@ebo/db/migrate";
import { createBackup, listBackups, openBackup, restoreBackup } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://ebo:ebo@localhost:54329/ebo";
const pool = createPool(url, 2);
const dbUp = await pool.query("select 1").then(
  () => true,
  () => false,
);
const tag = Math.random().toString(36).slice(2, 8);
const env = { APP_ENCRYPTION_KEY: `test-backup-key-${tag}` };
const storage = localStorage(mkdtempSync(join(tmpdir(), "ebo-backup-")));
const names = { restored: `ebo_restore_${tag}`, blank: `ebo_blank_${tag}` };
const urlFor = (name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
let target: PgPool;
let blank: PgPool;

describe.skipIf(!dbUp)("backups", () => {
  beforeAll(async () => {
    for (const name of Object.values(names)) await pool.query(`create database ${name}`);
    await runMigrations(urlFor(names.restored));
    target = createPool(urlFor(names.restored), 2);
    blank = createPool(urlFor(names.blank), 1);
  }, 60_000);

  afterAll(async () => {
    await target?.end();
    await blank?.end();
    if (dbUp) for (const name of Object.values(names)) await pool.query(`drop database if exists ${name} with (force)`);
    await pool.end();
  });

  it("keeps the newest backups, and one restores every row exactly into a new database", async () => {
    const first = await createBackup(pool, storage, { env, keep: 2, now: new Date("2026-11-05T21:30:00Z") });
    await createBackup(pool, storage, { env, keep: 2, now: new Date("2026-11-06T21:30:00Z") });
    const latest = await createBackup(pool, storage, { env, keep: 2, now: new Date("2026-11-07T21:30:00Z") });
    expect((await listBackups(storage)).map((b) => b.key)).toEqual(["db/2026-11-06T21-30-00-000Z.ebobak", "db/2026-11-07T21-30-00-000Z.ebobak"]);
    expect(latest.removed).toEqual([first.key]);
    expect(latest.rows.workspace).toBeGreaterThan(0);

    const restored = await restoreBackup(target, storage, "latest", env);
    expect(restored).toMatchObject({ key: latest.key, createdAt: "2026-11-07T21:30:00.000Z", rows: latest.rows });

    // Row for row, value for value: what the new database holds is what the backup holds.
    const tables = new Map<string, string[]>();
    let current = "";
    for (const line of gunzipSync(openBackup(await storage.get(latest.key), env)).toString("utf8").split("\n").slice(1)) {
      if (line.startsWith("#table ")) tables.set((current = line.slice(7)), []);
      else if (line) tables.get(current)!.push(line);
    }
    expect([...tables.keys()].sort()).toEqual(Object.keys(latest.rows).sort());
    for (const [t, rows] of tables) {
      const got = (await target.query<{ j: string }>(`select translate(row_to_json(t)::text, E'\\n\\r', '  ') as j from public."${t}" t`)).rows.map((r) => r.j);
      expect(got.sort(), t).toEqual([...rows].sort());
    }
    // The audit log's ids carry on after the restored ones.
    const [seq] = (await target.query<{ max: string; next: string }>(`select coalesce(max(id), 0) as max, nextval(pg_get_serial_sequence('public.audit_event', 'id')) as next from audit_event`)).rows;
    expect(Number(seq!.next)).toBe(Number(seq!.max) + 1);
  }, 60_000);

  it("refuses a database with data, another release, the wrong key and a damaged file", async () => {
    await expect(restoreBackup(target, storage, "latest", env)).rejects.toThrow(/already has data/);
    await expect(restoreBackup(blank, storage, "latest", env)).rejects.toThrow(/migrations applied, and the target database has 0/);
    await expect(restoreBackup(blank, storage, "latest", { APP_ENCRYPTION_KEY: "another key" })).rejects.toThrow("Can't open this backup: it was made with a different APP_ENCRYPTION_KEY, or the file is damaged.");
    await expect(restoreBackup(blank, storage, "2026-01-01.ebobak", env)).rejects.toThrow("There's no backup called 2026-01-01.ebobak.");
    const sealed = Buffer.from(await storage.get((await listBackups(storage)).at(-1)!.key));
    sealed[sealed.length - 5]! ^= 0xff;
    expect(() => openBackup(sealed, env)).toThrow(/damaged/);
    expect(() => openBackup(Buffer.from("not a backup at all, just some text"), env)).toThrow("This file isn't a backup made by this app.");
  });
});
