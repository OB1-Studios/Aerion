import Link from "next/link";
import { Card, Notice, PageHeader } from "@/components/ui";
import { canAct, requireWorkspace } from "@/lib/session";
import { saveClientAction } from "../../manage-actions";
import { ClientForm } from "../client-form";
import { clientFormChoices } from "../shared";

export const metadata = { title: "New client" };

export default async function NewClientPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { role } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader
        title="New client"
        sub="Who you invoice, how they pay, and the names their payments arrive under."
        actions={
          <Link href={`/w/${slug}/clients`} className="btn btn-secondary">
            All clients
          </Link>
        }
      />
      {canAct(role) ? (
        <Card>
          <ClientForm action={saveClientAction.bind(null, slug, null)} initial={{ kind: "business", currency: "USD", termsDays: "30" }} submitLabel="Add the client" {...clientFormChoices()} />
        </Card>
      ) : (
        <Notice tone="amber">Your role can view clients but not add them.</Notice>
      )}
    </>
  );
}
