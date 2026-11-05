import { getDb } from "@ebo/db";
import { openNotification } from "@ebo/engine";
import { requireWorkspace } from "@/lib/session";

/** Marks a person's own notification read and goes to what it's about. */
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const { user, ws } = await requireWorkspace(slug);
  const uuid = /^[0-9a-f-]{36}$/i.test(id);
  const href = uuid ? await openNotification(getDb(), ws.id, user.id, id) : null;
  const inside = href?.startsWith(`/w/${slug}/`) ? href : `/w/${slug}/notifications`;
  // A relative address keeps whatever host the person came in on.
  return new Response(null, { status: 303, headers: { Location: inside } });
}
