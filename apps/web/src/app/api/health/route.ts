import { getPool } from "@ebo/db";

export const dynamic = "force-dynamic";

/** Coolify's health check: the app is up and can reach the database. */
export async function GET() {
  const t0 = Date.now();
  try {
    await getPool().query("select 1");
    return Response.json({ ok: true, db: "ok", ms: Date.now() - t0 });
  } catch (err) {
    return Response.json({ ok: false, db: String(err) }, { status: 503 });
  }
}
