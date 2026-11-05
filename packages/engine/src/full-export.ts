/**
 * Full export of one workspace (W32): every record, table by table, as JSON and as CSV, plus every
 * document file it holds, in one zip kept in storage like a tax pack. Owners take it with them,
 * keep it as an archive, or download it before deleting the workspace.
 */
import { dateInZone, formatDateLong } from "@ebo/core";
import { exportJob, user, type Db, type PgPool, type Storage } from "@ebo/db";
import { and, desc, eq } from "drizzle-orm";
import { audit, workspaceClock, type Workspace } from "./context";
import { toCsv } from "./tax-file";
import { taxPackKey } from "./tax-pack";
import { zip, type ZipEntry } from "./zip";

/** Never exported: the sealed mailbox password, and invitation tokens, which let someone join. */
export const WITHHELD_COLUMNS: Record<string, string[]> = { mailbox_connection: ["secret_encrypted"], invitation: ["token"] };
/** The zip is built in memory, so document files past this total are left out; documents/index.csv lists them with a note. */
export const FULL_EXPORT_MAX_FILE_BYTES = 300 * 1024 * 1024;

/** Exports live next to the tax packs: `ws/<id>/exports/<job>.zip`. */
export const exportKey = taxPackKey;

type Row = Record<string, unknown>;
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Postgres JSON with each non-integer number kept as its exact text: "1364462.50", not 1364462.5. */
function parseExact(text: string): Row {
  const parse = JSON.parse as (t: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
  return parse(text, (_key, value, context) => (typeof value === "number" && context?.source && (!/^-?\d+$/.test(context.source) || !Number.isSafeInteger(value)) ? context.source : value)) as Row;
}

const stamp = (r: Row) => String(r.created_at ?? r.at ?? r.received_at ?? "");
const byTime = (a: Row, b: Row) => stamp(a).localeCompare(stamp(b)) || String(a.id ?? "").localeCompare(String(b.id ?? ""));

export interface WorkspaceData {
  workspace: Row;
  people: Row[];
  tables: Record<string, Row[]>;
}

/** Every row that belongs to the workspace, from one consistent snapshot, with times in UTC. */
export async function readWorkspaceData(pool: PgPool, workspaceId: string): Promise<WorkspaceData> {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local time zone 'UTC'");
    const names = (await client.query<{ t: string }>("select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id' group by table_name order by table_name")).rows.map((r) => r.t);
    const [ws] = (await client.query<{ j: string }>("select row_to_json(w)::text as j from public.workspace w where w.id = $1", [workspaceId])).rows;
    const people = (
      await client.query<{ j: string }>(
        `select json_build_object('member_id', m.id, 'name', case when u.is_anonymous then 'Visitor' else u.name end, 'email', case when u.is_anonymous then null else u.email end, 'role', m.role, 'two_factor', coalesce(u.two_factor_enabled, false), 'demo_visitor', coalesce(u.is_anonymous, false), 'joined_at', m.created_at)::text as j
           from public.member m join public."user" u on u.id = m.user_id where m.workspace_id = $1 order by u.name`,
        [workspaceId],
      )
    ).rows.map((r) => parseExact(r.j));
    const tables: Record<string, Row[]> = {};
    for (const t of names) {
      const { rows } = await client.query<{ j: string }>(`select row_to_json(t)::text as j from public.${ident(t)} t where t.workspace_id = $1`, [workspaceId]);
      const hide = WITHHELD_COLUMNS[t] ?? [];
      tables[t] = rows
        .map((r) => {
          const row = parseExact(r.j);
          for (const c of hide) delete row[c];
          return row;
        })
        .sort(byTime);
    }
    await client.query("commit");
    return { workspace: ws ? parseExact(ws.j) : {}, people, tables };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One spreadsheet per table: every column, nested values as JSON, formulas neutralised. */
export function tableCsv(rows: Row[]): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return toCsv([columns, ...rows.map((r) => columns.map((c) => cell(r[c])))]);
}

const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .slice(-120) || "file";

export type FullExportResult = { ok: true; jobId: string; name: string; bytes: number; tables: number; rows: number; files: number; skipped: number } | { ok: false; reason: string };

/** Builds the zip, keeps it in storage and records it as an export job (kind `full_export`). */
export async function buildFullExport(pool: PgPool, db: Db, storage: Storage, ws: Workspace, by: { id: string; name: string }): Promise<FullExportResult> {
  const data = await readWorkspaceData(pool, ws.id);
  const at = workspaceClock(ws);
  const day = dateInZone(at, ws.timezone);
  const folder = `${ws.slug}-export-${day}`;
  const entries: ZipEntry[] = [];

  // Every document file, with an index that ties each one back to its record.
  const index: Array<Array<string | number | null>> = [["document_id", "kind", "source", "received_at", "original_name", "file_in_export", "bytes", "note"]];
  const taken = new Set<string>();
  const unique = (wanted: string) => {
    if (!taken.has(wanted)) return wanted;
    const [, stem, ext = ""] = /^(.*?)(\.[^./]+)?$/.exec(wanted)!;
    for (let n = 2; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
  };
  let fileBytes = 0;
  let skipped = 0;
  for (const d of data.tables.document ?? []) {
    const receivedAt = new Date(String(d.received_at ?? ""));
    const received = Number.isNaN(receivedAt.getTime()) ? "" : dateInZone(receivedAt, ws.timezone); // the day it arrived where the business is
    const base = safeName(String(d.original_name ?? d.id));
    const name = unique(`documents/${safeName(String(d.kind ?? "other"))}/${received ? `${received}-` : ""}${base}`);
    let note = "";
    const size = Number(d.size_bytes) || 0;
    if (fileBytes + size > FULL_EXPORT_MAX_FILE_BYTES) note = "left out: the export reached its size limit";
    else {
      try {
        const bytes = await storage.get(String(d.storage_path));
        fileBytes += bytes.length;
        entries.push({ name: `${folder}/${name}`, data: bytes });
        taken.add(name);
      } catch {
        note = "missing from storage";
      }
    }
    if (note) skipped++;
    index.push([String(d.id), String(d.kind ?? ""), String(d.source ?? ""), String(d.received_at ?? ""), d.original_name == null ? null : String(d.original_name), note ? null : name, size || null, note || null]);
  }

  const filled = Object.entries(data.tables).filter(([, rows]) => rows.length);
  const rowCount = filled.reduce((n, [, rows]) => n + rows.length, 0);
  for (const [t, rows] of filled) entries.push({ name: `${folder}/csv/${t}.csv`, data: tableCsv(rows) });
  entries.push({ name: `${folder}/people.csv`, data: tableCsv(data.people) });
  entries.push({ name: `${folder}/documents/index.csv`, data: toCsv(index) });
  entries.push({ name: `${folder}/data.json`, data: JSON.stringify({ format: "it-export-back-office/full-export", version: 1, exportedAt: at.toISOString(), workspace: data.workspace, people: data.people, tables: data.tables }, null, 1) });

  const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
  const files = entries.filter((e) => e.name.startsWith(`${folder}/documents/`) && !e.name.endsWith("/index.csv")).length;
  const readme = [
    `Full export: ${ws.legalName ?? ws.name}`,
    `Exported by ${by.name} on ${formatDateLong(day)}.`,
    ...(ws.isDemo ? ["", "SIMULATED: this is the demo's fictional data, not a real business."] : []),
    "",
    "WHAT'S INSIDE",
    `- data.json: every record of this workspace, table by table, as stored (${rowCount} records in ${filled.length} tables). Amounts are exact text; times are UTC (ISO 8601).`,
    "- csv/: the same records, one spreadsheet per table.",
    "- people.csv: who had access, with their roles and whether they used two-factor sign-in.",
    `- documents/: ${files} file${files === 1 ? "" : "s"} (${size(fileBytes)}): uploads, email attachments, and the invoices and reports the app made. documents/index.csv ties each file to its record.`,
    "",
    "LEFT OUT",
    "- The mailbox password and invitation links: they would let someone read the mailbox or join.",
    "- Earlier exports (tax packs and full exports): they can be built again from these records.",
    "- Each person's sign-in details (password, sessions, two-factor secrets): they belong to the person's account, not to the workspace.",
    ...(skipped ? [`- ${skipped} document file${skipped === 1 ? "" : "s"}: see the note column in documents/index.csv.`] : []),
    "",
  ].join("\r\n");
  entries.unshift({ name: `${folder}/README.txt`, data: readme });

  const [job] = await db.insert(exportJob).values({ workspaceId: ws.id, kind: "full_export", period: day, status: "running", requestedBy: by.id, createdAt: at }).returning({ id: exportJob.id });
  try {
    const bytes = zip(entries, at, ws.timezone);
    await storage.put(exportKey(ws.id, job!.id), bytes, "application/zip");
    await db.update(exportJob).set({ status: "done" }).where(eq(exportJob.id, job!.id));
    await audit(db, { workspaceId: ws.id, actorType: "user", actorId: by.id, action: "workspace.exported", objectType: "export_job", objectId: job!.id, details: { tables: filled.length, rows: rowCount, files, skipped, bytes: bytes.length } });
    return { ok: true, jobId: job!.id, name: `${folder}.zip`, bytes: bytes.length, tables: filled.length, rows: rowCount, files, skipped };
  } catch (err) {
    await db.update(exportJob).set({ status: "failed" }).where(eq(exportJob.id, job!.id));
    throw err;
  }
}

/** Full exports of a workspace, newest first, with who asked for them. */
export async function fullExports(db: Db, workspaceId: string) {
  const rows = await db
    .select({ id: exportJob.id, period: exportJob.period, status: exportJob.status, createdAt: exportJob.createdAt, by: user.name, anon: user.isAnonymous })
    .from(exportJob)
    .leftJoin(user, eq(user.id, exportJob.requestedBy))
    .where(and(eq(exportJob.workspaceId, workspaceId), eq(exportJob.kind, "full_export")))
    .orderBy(desc(exportJob.createdAt))
    .limit(10);
  return rows.map(({ anon, ...r }) => ({ ...r, by: anon ? "Visitor" : r.by }));
}
