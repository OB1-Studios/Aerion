import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { NewWorkspaceForm } from "./new-workspace-form";

export const metadata = { title: "New workspace" };

export default async function NewWorkspacePage() {
  const user = await requireUser();
  if (user.isAnonymous) redirect("/signup");
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <Link href="/workspaces" className="mb-6 inline-block text-sm text-muted hover:text-ink">
        ← Your workspaces
      </Link>
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-lg font-semibold">New workspace</h1>
        <p className="mt-1 text-sm text-muted">A workspace holds one business&apos;s clients, invoices, bank documents and payments. Its data is yours: nothing in it is simulated.</p>
        <NewWorkspaceForm defaultName={`${user.name.split(" ")[0] ?? "My"}'s workspace`} />
      </div>
    </main>
  );
}
