import Link from "next/link";
import { redirect } from "next/navigation";
import { PlainShell } from "@/components/plain-shell";
import { Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/session";
import { NewWorkspaceForm } from "./new-workspace-form";

export const metadata = { title: "New workspace" };

export default async function NewWorkspacePage() {
  const user = await requireUser();
  if (user.isAnonymous) redirect("/signup");
  return (
    <PlainShell
      width="max-w-2xl"
      actions={
        <Link href="/workspaces" className="btn btn-ghost">
          ← Your workspaces
        </Link>
      }
    >
      <PageHeader title="New workspace" sub="A workspace holds one business's clients, invoices, bank documents and payments. It starts empty, and everything in it is your own data: nothing is simulated." />
      <Card>
        <NewWorkspaceForm defaultName={`${user.name.split(" ")[0] ?? "My"}'s workspace`} />
      </Card>
    </PlainShell>
  );
}
