import { getDb } from "@ebo/db";
import { IMPORT_KINDS, IMPORT_SPECS, recentImports } from "@ebo/engine";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";
import { clock } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { uploadImportAction } from "./actions";
import { ImportUploadForm } from "./upload-form";

export const metadata = { title: "Import from spreadsheets" };

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" }> = {
  applied: { label: "imported", tone: "green" },
  validated: { label: "ready to import", tone: "amber" },
  failed: { label: "has problems", tone: "red" },
  pending: { label: "checking", tone: "gray" },
};

export default async function ImportPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws, role } = await requireWorkspace(slug);
  const acts = canAct(role);
  const recent = await recentImports(getDb(), ws.id);
  const base = `/w/${slug}/import`;

  return (
    <>
      <PageHeader title="Import from spreadsheets" sub="Bring in clients, open invoices and this tax year's earlier proceeds from a CSV file. Every row is checked first, and nothing is saved until all of them are right." />
      {!acts ? (
        <Card className="mb-6">
          <p className="text-sm">Your role can view this workspace but not import into it. Owners and finance can.</p>
        </Card>
      ) : null}
      <div className="mb-6 grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        {IMPORT_KINDS.map((kind, i) => {
          const spec = IMPORT_SPECS[kind];
          return (
            <Card key={kind} id={kind} title={`${i + 1}. ${spec.title}`}>
              <div className="space-y-3 text-sm">
                <p>{spec.about}</p>
                <p>
                  <a href={`/api/w/${slug}/import-template/${kind}`} className="link">
                    Download the template
                  </a>{" "}
                  <span className="text-muted">({spec.file}, with two example rows to replace)</span>
                </p>
                <details className="rounded-md border border-line px-3 py-2">
                  <summary className="cursor-pointer text-muted">What goes in each column</summary>
                  <dl className="mt-2 space-y-1.5">
                    {spec.columns.map((c) => (
                      <div key={c.key}>
                        <dt className="inline font-mono text-xs text-ink">{c.key}</dt>
                        <dd className="inline text-muted">
                          {c.required ? "" : " (optional)"}: {c.format}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
                {acts ? <ImportUploadForm action={uploadImportAction.bind(null, slug, kind)} /> : null}
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mb-6 text-xs text-muted">
        In Excel or Google Sheets, use Save as or Download, then CSV. Dates are read day first (01/10/2026 is 1 October), and the usual other column names (Customer, Invoice No, Total) are understood.
      </p>

      <Card title="Earlier imports" pad={false}>
        {recent.length ? (
          <Table head={["When", "What", "File", "Rows", "Result", ""]}>
            {recent.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-muted">{clock(r.createdAt, ws.timezone)}</td>
                <td className="whitespace-nowrap">{IMPORT_SPECS[r.kind].title}</td>
                <td className="max-w-56 truncate">{r.file ?? "—"}</td>
                <td className="tabular-nums">{r.rows}</td>
                <td>
                  <Badge tone={STATUS[r.status]?.tone ?? "gray"}>{r.status === "failed" ? `${r.problems} problem${r.problems === 1 ? "" : "s"}` : (STATUS[r.status]?.label ?? r.status)}</Badge>
                </td>
                <td className="text-right">
                  <Link href={`${base}/${r.id}`} className="link">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No files imported yet.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
