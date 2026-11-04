import { document, getDb, storageFromEnv, transaction } from "@ebo/db";
import { csvRecords } from "@ebo/engine";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, KeyValues, Notice, PageHeader, Status, Table } from "@/components/ui";
import { clock, humanize, money } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";

export const metadata = { title: "Document" };

interface Extracted {
  classification?: { kind?: string; confidence?: string; reason?: string; workspaceMatch?: boolean };
  fields?: Record<string, string | null> | null;
  evidence?: Record<string, { quote?: string | null; confidence?: string }> | null;
  notes?: string | null;
}

export default async function DocumentPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: slug, id } = await params;
  const { ws } = await requireWorkspace(slug);
  const db = getDb();
  const [d] = await db
    .select()
    .from(document)
    .where(and(eq(document.workspaceId, ws.id), eq(document.id, id)));
  if (!d) notFound();
  const txs = await db.select().from(transaction).where(and(eq(transaction.workspaceId, ws.id), eq(transaction.sourceDocumentId, d.id))).limit(50);
  const mime = d.mimeType ?? "application/octet-stream";
  const isText = mime.startsWith("text/") && mime !== "text/html";
  let text: string | null = null;
  if (isText) {
    try {
      text = await storageFromEnv().getText(d.storagePath);
    } catch {
      text = null;
    }
  }
  const x = (d.extracted ?? {}) as Extracted;
  const fields = Object.entries(x.fields ?? {}).filter(([, v]) => v != null);
  const fileUrl = `/api/w/${slug}/documents/${d.id}`;
  const base = `/w/${slug}`;

  return (
    <>
      <PageHeader
        title={d.originalName ?? "Document"}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Status value={d.parseStatus} label={d.parseStatus === "needs_review" ? "needs review" : undefined} />
            <span>
              {humanize(d.kind)} · received {clock(d.receivedAt, ws.timezone)} · {d.source}
            </span>
          </span>
        }
        actions={
          <>
            <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
              Open original
            </a>
            <Link href={`${base}/documents`} className="btn btn-secondary">
              All documents
            </Link>
          </>
        }
      />
      {d.reviewReasons?.length ? (
        <Notice tone="amber">
          <b>Needs a person:</b> {d.reviewReasons.join(" ")}
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card title="The document" pad={false}>
          {mime === "image/svg+xml" || mime.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element -- served from our own route with the membership check
            <img src={fileUrl} alt={d.originalName ?? "document"} className="mx-auto max-h-[70vh] w-auto p-4" />
          ) : mime === "application/pdf" ? (
            <p className="p-4 text-sm text-muted">
              PDF:{" "}
              <a href={fileUrl} target="_blank" rel="noreferrer" className="link">
                open the original
              </a>
              . The reader works from its text layer.
            </p>
          ) : text != null && mime === "text/csv" ? (
            <CsvView text={text} />
          ) : text != null ? (
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-ink">{text}</pre>
          ) : (
            <p className="p-4 text-sm text-muted">No preview for {mime}.</p>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="What the reader saw">
            <KeyValues
              rows={[
                ["Read by", d.model ?? "—"],
                ["Classified as", `${humanize(x.classification?.kind ?? d.kind)}${x.classification?.confidence ? ` (${x.classification.confidence} confidence)` : ""}`],
                ...(x.classification?.workspaceMatch === false ? ([["Addressed to us?", <Badge key="m" tone="red">no: different account holder</Badge>]] as Array<[string, React.ReactNode]>) : []),
                ...(d.promptVersion ? ([["Prompt version", d.promptVersion]] as Array<[string, string]>) : []),
              ]}
            />
          </Card>
          {fields.length ? (
            <Card title="Extracted fields" pad={false}>
              <ul className="divide-y divide-line text-sm">
                {fields.map(([k, v]) => {
                  const e = x.evidence?.[k];
                  return (
                    <li key={k} className="px-4 py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <code className="text-xs text-muted">{k}</code>
                        <span className="break-all text-right text-ink">{v}</span>
                      </div>
                      {e?.quote ? <div className="mt-0.5 truncate text-xs text-muted">from “{e.quote}”</div> : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
          {txs.length ? (
            <Card title="Became these records" pad={false}>
              <ul className="divide-y divide-line text-sm">
                {txs.map((t) => (
                  <li key={t.id} className="flex justify-between gap-2 px-4 py-2">
                    <Link href={`${base}/payments/${t.id}`} className="text-ink hover:text-accent">
                      {t.valueDate} · {humanize(t.kind)}
                    </Link>
                    <span className="tabular-nums">{money(t.amount, t.currency)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function CsvView({ text }: { text: string }) {
  const { header, records } = csvRecords(text);
  return (
    <Table dense head={header}>
      {records.map((r, i) => (
        <tr key={i}>
          {header.map((h) => (
            <td key={h} className="whitespace-nowrap text-xs">
              {r[h]}
            </td>
          ))}
        </tr>
      ))}
    </Table>
  );
}
