import { FIELDS } from "@ebo/ai";
import { document, getDb, run, storageFromEnv, transaction, type DocumentKind } from "@ebo/db";
import { csvRecords, documentText, type ConfirmedReading } from "@ebo/engine";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunPoller } from "@/components/run-poller";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, cx, KeyValues, Notice, PageHeader, Status, Table } from "@/components/ui";
import { clock, humanize, money } from "@/lib/format";
import { fieldLabel, REVIEW_KINDS } from "@/lib/review";
import { canAct, requireWorkspace } from "@/lib/session";
import { confirmDocument, setAsideDocument } from "../../actions";
import { ReviewForm, type ReviewField } from "./review-form";

export const metadata = { title: "Document" };

interface Extracted {
  classification?: { kind?: string; confidence?: string; reason?: string; workspaceMatch?: string | boolean };
  fields?: Record<string, string | null> | null;
  evidence?: Record<string, { quote?: string | null; confidence?: string }> | null;
  notes?: string | null;
  confirmed?: ConfirmedReading;
}

const KIND_TABS: Array<{ kind: DocumentKind; label: string }> = [
  { kind: "credit_advice", label: "Credit advice" },
  { kind: "pasted_text", label: "Bank SMS or text" },
  { kind: "eprc", label: "ePRC" },
];

export default async function DocumentPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ as?: string; confirmed?: string; run?: string }> }) {
  const { ws: slug, id } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [d] = await db
    .select()
    .from(document)
    .where(and(eq(document.workspaceId, ws.id), eq(document.id, id)));
  if (!d) notFound();
  const [txs, [lastRun]] = await Promise.all([
    db.select().from(transaction).where(and(eq(transaction.workspaceId, ws.id), eq(transaction.sourceDocumentId, d.id))).limit(50),
    db.select({ status: run.status }).from(run).where(eq(run.workspaceId, ws.id)).orderBy(desc(run.startedAt)).limit(1),
  ]);
  const running = lastRun?.status === "queued" || lastRun?.status === "running";
  const mime = d.mimeType ?? "application/octet-stream";
  const isText = mime.startsWith("text/") && mime !== "text/html";
  let text: string | null = null;
  if (isText || mime === "application/pdf") {
    try {
      text = isText ? await storageFromEnv().getText(d.storagePath) : await documentText(await storageFromEnv().get(d.storagePath), mime);
    } catch {
      text = null;
    }
  }
  const x = (d.extracted ?? {}) as Extracted;
  const fields = Object.entries(x.fields ?? {}).filter(([, v]) => v != null);
  const fileUrl = `/api/w/${slug}/documents/${d.id}`;
  const base = `/w/${slug}`;
  const setAside = d.parseStatus === "skipped" && d.reviewReasons?.[0]?.startsWith("Set aside by");

  // The review queue: documents waiting on a person, checked by someone who may change things.
  const reviewable = (d.parseStatus === "needs_review" || d.parseStatus === "failed") && canAct(role);
  const guess = [q.as, d.kind, x.classification?.kind].find((k): k is DocumentKind => !!k && REVIEW_KINDS.includes(k as DocumentKind)) ?? "credit_advice";
  const reviewFields: ReviewField[] = reviewable
    ? Object.entries(FIELDS[guess] ?? {}).map(([name, spec]) => ({
        name,
        label: fieldLabel(name),
        note: spec.note,
        value: x.fields?.[name] ?? "",
        doubtful: x.evidence?.[name]?.confidence === "low" || !!d.reviewReasons?.some((r) => r.includes(`"${name}"`)),
      }))
    : [];

  return (
    <>
      <RunPoller active={running} everyMs={2000} />
      <PageHeader
        title={d.originalName ?? "Document"}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Status value={d.parseStatus} label={d.parseStatus === "needs_review" ? "needs a person" : setAside ? "set aside" : undefined} />
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
      {q.confirmed ? (
        <Notice tone="violet">
          Confirmed. {running ? "The agent is applying it now; this page updates when it's done. " : ""}
          {q.run ? (
            <Link href={`${base}/runs/${q.run}`} className="link">
              See the run
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {d.reviewReasons?.length ? (
        <Notice tone={setAside || d.parseStatus === "skipped" ? "violet" : "amber"}>
          <b>{d.parseStatus === "needs_review" ? "Needs a person:" : d.parseStatus === "failed" ? "Couldn't be read:" : "Note:"}</b> {d.reviewReasons.join(" ")}
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <Card title="The document" pad={false}>
            {mime === "image/svg+xml" || mime.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element -- served from our own route with the membership check
              <img src={fileUrl} alt={d.originalName ?? "document"} className="mx-auto max-h-[70vh] w-auto p-4" />
            ) : mime === "application/pdf" ? (
              <div className="p-4 text-sm">
                <p className="text-muted">
                  PDF:{" "}
                  <a href={fileUrl} target="_blank" rel="noreferrer" className="link">
                    open the original
                  </a>
                  . {text ? "Below is its text layer, which is what the reader works from." : "It has no text layer (a scan or a photo), so a person reads it."}
                </p>
                {text ? <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-3 font-mono text-xs leading-relaxed text-ink">{text}</pre> : null}
              </div>
            ) : text != null && mime === "text/csv" ? (
              <CsvView text={text} />
            ) : text != null ? (
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-ink">{text}</pre>
            ) : (
              <p className="p-4 text-sm text-muted">No preview for {mime}.</p>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {reviewable ? (
            <Card title="Check and confirm">
              <p className="mb-3 text-sm text-muted">Compare with the document, correct what&apos;s wrong, then confirm. The agent applies it at once, with the same checks as anything it reads.</p>
              <div className="mb-3 flex flex-wrap gap-1 text-xs">
                {KIND_TABS.map((t) => (
                  <Link key={t.kind} href={`?as=${t.kind}`} className={cx("rounded-full px-2.5 py-1", t.kind === guess ? "bg-ink text-panel" : "bg-canvas text-muted hover:text-ink")}>
                    {t.label}
                  </Link>
                ))}
              </div>
              <ReviewForm action={confirmDocument.bind(null, slug, d.id, guess)} fields={reviewFields} />
              <form action={setAsideDocument.bind(null, slug, d.id)} className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                <input name="reason" placeholder="Not ours, a duplicate…" className="input min-w-0 flex-1" />
                <SubmitButton variant="secondary" pendingText="Setting aside…">
                  Set aside
                </SubmitButton>
              </form>
            </Card>
          ) : null}
          <Card title="What the reader saw">
            <KeyValues
              rows={[
                ["Read by", d.model ?? "—"],
                ["Classified as", `${humanize(x.classification?.kind ?? d.kind)}${x.classification?.confidence ? ` (${x.classification.confidence} confidence)` : ""}`],
                ...(x.classification?.workspaceMatch === "no" || x.classification?.workspaceMatch === false ? ([["Addressed to us?", <Badge key="m" tone="red">no: different account holder</Badge>]] as Array<[string, React.ReactNode]>) : []),
                ...(x.confirmed ? ([["Checked by", `${x.confirmed.byName}, ${clock(new Date(x.confirmed.at), ws.timezone)}`]] as Array<[string, string]>) : []),
                ...(d.promptVersion ? ([["Prompt version", d.promptVersion]] as Array<[string, string]>) : []),
              ]}
            />
          </Card>
          {fields.length && !reviewable ? (
            <Card title="Extracted fields" pad={false}>
              <ul className="divide-y divide-line text-sm">
                {fields.map(([k, v]) => {
                  const e = x.evidence?.[k];
                  return (
                    <li key={k} className="px-4 py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs text-muted">{fieldLabel(k)}</span>
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
