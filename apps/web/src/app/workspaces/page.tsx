import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Empty, Notice } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/format";
import { myWorkspaces, requireUser } from "@/lib/session";
import { signOut } from "../actions";

export const metadata = { title: "Workspaces" };

export default async function WorkspacesPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const { deleted } = await searchParams;
  const user = await requireUser();
  const list = await myWorkspaces(user.id);
  // Straight into the only workspace, or to making one, unless there's a deletion to confirm first.
  if (!deleted && list.length === 1) redirect(`/w/${list[0]!.slug}/inbox`);
  if (!deleted && !list.length && !user.isAnonymous) redirect("/workspaces/new");
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Your workspaces</h1>
        <div className="flex flex-wrap gap-2">
          {user.isAnonymous ? (
            <Link href="/signup" className="btn btn-primary">
              Create an account
            </Link>
          ) : (
            <>
              <Link href="/workspaces/new" className="btn btn-primary">
                New workspace
              </Link>
              <Link href="/account" className="btn btn-secondary">
                Your account
              </Link>
            </>
          )}
          <form action={signOut}>
            <button className="btn btn-secondary">Sign out</button>
          </form>
        </div>
      </div>
      {deleted ? <Notice>The workspace was deleted, with everything in it.</Notice> : null}
      {list.length ? (
        <ul className="space-y-2">
          {list.map((w) => (
            <li key={w.slug}>
              <Link href={`/w/${w.slug}/inbox`} className="flex items-center justify-between rounded-xl border border-line bg-panel p-4 hover:border-accent">
                <div>
                  <div className="font-medium">{w.name}</div>
                  <div className="text-xs text-muted">{w.kind === "company" ? "Software house" : "Freelancer"} · {ROLE_LABEL[w.role]}</div>
                </div>
                {w.isDemo ? <Badge tone="violet">demo</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>You aren&apos;t a member of any workspace yet.</Empty>
      )}
    </main>
  );
}
