import { getDb } from "@ebo/db";
import { fullExports } from "@ebo/engine";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { clock } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { buildFullExportAction, deleteWorkspaceAction } from "./actions";
import { DeleteWorkspaceForm } from "./delete-form";

export const metadata = { title: "Your data" };

export default async function DataPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ built?: string }> }) {
  const { ws: slug } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const isOwner = role === "owner";
  const exports = isOwner ? await fullExports(getDb(), ws.id) : [];
  const built = q.built ? exports.find((e) => e.id === q.built && e.status === "done") : undefined;
  const download = (id: string) => `/api/w/${slug}/full-export/${id}`;

  return (
    <>
      <PageHeader
        title="Your data"
        sub="Take everything with you, or delete the workspace."
        actions={
          <Link href={`/w/${slug}/settings`} className="btn btn-secondary">
            Settings
          </Link>
        }
      />
      {built ? (
        <Notice>
          The export is ready.{" "}
          <a href={download(built.id)} className="font-medium underline underline-offset-2">
            Download it (zip)
          </a>
        </Notice>
      ) : null}

      {!isOwner ? (
        <Card>
          <p className="text-sm">Only an owner can export everything or delete the workspace. The year&apos;s tax pack for the accountant is on Tax-year file.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
          <Card title="Download everything">
            <div className="space-y-3 text-sm">
              <p>
                One zip with every record in this workspace (invoices, payments, matches, flags, emails, tasks, the audit log and the rest) as JSON and as a spreadsheet per table, plus every document: uploads, email attachments, and the invoices and reports
                the app made.
              </p>
              <p className="text-muted">Left out: the mailbox password, invitation links, and each person&apos;s sign-in details.</p>
              <ActionForm action={buildFullExportAction.bind(null, slug)} label="Build the export" pendingText="Building the export…" title="Not built:" />
            </div>
            {exports.length ? (
              <div className="mt-4 border-t border-line pt-3">
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Built</h3>
                <ul className="divide-y divide-line text-sm">
                  {exports.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span>
                        {clock(e.createdAt, ws.timezone)} <span className="text-xs text-muted">by {e.by ?? "a person"}</span>
                      </span>
                      {e.status === "done" ? (
                        <a href={download(e.id)} className="link">
                          Download
                        </a>
                      ) : (
                        <Badge tone={e.status === "failed" ? "red" : "gray"}>{e.status === "failed" ? "failed" : "building"}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card title="Delete this workspace">
            {ws.isDemo ? (
              <p className="text-sm">Demo workspaces can&apos;t be deleted. Reset, at the top of every page, puts this one back the way it started, and a visitor&apos;s own copy is deleted a week after it was made.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <p>Deletes {ws.name} and everything in it, for everyone: records, documents, exports and the audit log. It can&apos;t be undone.</p>
                <p className="text-muted">Tax records usually have to be kept for years after the tax year ends, so download the export first.</p>
                <DeleteWorkspaceForm action={deleteWorkspaceAction.bind(null, slug)} name={ws.name} />
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
