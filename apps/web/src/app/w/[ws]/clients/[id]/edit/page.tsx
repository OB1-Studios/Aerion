import { client, clientAlias, getDb } from "@ebo/db";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Notice, PageHeader } from "@/components/ui";
import { canAct, requireWorkspace } from "@/lib/session";
import { saveClientAction } from "../../../manage-actions";
import { ClientForm } from "../../client-form";
import { clientFormChoices } from "../../shared";

export const metadata = { title: "Edit client" };

export default async function EditClientPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [c] = await db.select().from(client).where(and(eq(client.workspaceId, ws.id), eq(client.id, id)));
  if (!c) notFound();
  const typed = await db.select().from(clientAlias).where(and(eq(clientAlias.clientId, c.id), eq(clientAlias.source, "manual"))).orderBy(asc(clientAlias.alias));
  return (
    <>
      <PageHeader
        title={`Edit ${c.name}`}
        actions={
          <Link href={`/w/${slug}/clients/${c.id}`} className="btn btn-secondary">
            Back to the client
          </Link>
        }
      />
      {canAct(role) ? (
        <Card>
          <ClientForm
            action={saveClientAction.bind(null, slug, c.id)}
            initial={{
              name: c.name,
              kind: c.kind,
              country: c.country ?? "",
              currency: c.defaultCurrency,
              termsDays: String(c.paymentTermsDays),
              preferredRoute: c.preferredRoute ?? "",
              contactName: c.contactName ?? "",
              contactEmails: c.contactEmails.join(", "),
              aliases: typed.map((a) => a.alias).join("\n"),
              notes: c.notes ?? "",
            }}
            submitLabel="Save changes"
            {...clientFormChoices()}
          />
        </Card>
      ) : (
        <Notice tone="amber">Your role can view clients but not change them.</Notice>
      )}
    </>
  );
}
