import Link from "next/link";
import { redirect } from "next/navigation";
import { PlainShell } from "@/components/plain-shell";
import { Badge, Empty, Notice, PageHeader } from "@/components/ui";
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
    <PlainShell
      actions={
        <>
          {user.isAnonymous ? null : (
            <Link href="/account" className="btn btn-ghost">
              Your account
            </Link>
          )}
          <form action={signOut}>
            <button className="btn btn-ghost">Sign out</button>
          </form>
        </>
      }
    >
      <PageHeader
        title="Your workspaces"
        sub={user.isAnonymous ? "You're trying the demo. Create an account to keep your copy and set up your own business." : "One workspace per business. An accountant can belong to several."}
        actions={
          user.isAnonymous ? (
            <Link href="/signup" className="btn btn-primary">
              Create an account
            </Link>
          ) : (
            <Link href="/workspaces/new" className="btn btn-primary">
              New workspace
            </Link>
          )
        }
      />
      {deleted ? <Notice>The workspace was deleted, with everything in it.</Notice> : null}
      {list.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((w) => (
            <li key={w.slug}>
              <Link href={`/w/${w.slug}/inbox`} className="group flex h-full items-start justify-between gap-3 rounded-[10px] border border-line bg-panel p-4 transition-colors hover:border-line-strong hover:bg-sunken">
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink group-hover:text-accent">{w.name}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {w.kind === "company" ? "Software house" : "Freelancer"} · {ROLE_LABEL[w.role]}
                  </div>
                </div>
                {w.isDemo ? <Badge tone="violet">Demo</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>You aren&apos;t a member of any workspace yet.</Empty>
      )}
    </PlainShell>
  );
}
