import { document, getDb, run } from "@ebo/db";
import { UPLOAD_KINDS, UPLOAD_MAX_FILES } from "@ebo/engine";
import { and, count, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { RunPoller } from "@/components/run-poller";
import { SubmitButton } from "@/components/submit-button";
import { Card, cx, Empty, Notice, PageHeader, Status, Table } from "@/components/ui";
import { clock, humanize } from "@/lib/format";
import { readerInfo } from "@/lib/platform";
import { canAct, requireWorkspace } from "@/lib/session";
import { pasteText, uploadDocuments, uploadSample } from "../actions";

export const metadata = { title: "Documents" };

type Search = { show?: string; upload?: string; added?: string; dup?: string; rejected?: string; sample?: string; run?: string };

export default async function DocumentsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Search> }) {
  const { ws: slug } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const reviewOnly = q.show === "review";
  const [docs, [reviewCount], [lastRun]] = await Promise.all([
    db
      .select()
      .from(document)
      .where(reviewOnly ? and(eq(document.workspaceId, ws.id), eq(document.parseStatus, "needs_review")) : eq(document.workspaceId, ws.id))
      .orderBy(desc(document.receivedAt), desc(document.createdAt))
      .limit(300),
    db.select({ n: count() }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.parseStatus, "needs_review"))),
    db.select({ id: run.id, status: run.status }).from(run).where(eq(run.workspaceId, ws.id)).orderBy(desc(run.startedAt)).limit(1),
  ]);
  const running = lastRun?.status === "queued" || lastRun?.status === "running";
  const reader = readerInfo();
  const byModel = reader.mode === "vultr" && ws.aiReadingEnabled;
  const base = `/w/${slug}/documents`;
  const added = Number(q.added ?? 0);

  return (
    <>
      <RunPoller active={running} everyMs={2000} />
      <PageHeader title="Documents" sub="Everything that came in: credit advices, ePRCs, wallet exports, screenshots, pasted bank texts. Stored once by content hash." />

      {q.upload === "none" ? <Notice tone="amber">Choose at least one file to upload.</Notice> : null}
      {q.upload === "toomany" ? <Notice tone="amber">Up to {UPLOAD_MAX_FILES} files at a time, please.</Notice> : null}
      {q.upload === "empty-paste" ? <Notice tone="amber">Paste the text of the SMS or alert first.</Notice> : null}
      {q.upload === "long-paste" ? <Notice tone="amber">That&apos;s longer than a bank alert (10,000 characters at most). Upload it as a file instead.</Notice> : null}
      {q.upload === "nothing-open" ? <Notice tone="amber">Every invoice paid by bank wire is settled, so there&apos;s nothing for a sample to pay. Reset the demo to start again.</Notice> : null}
      {q.sample ? (
        <Notice tone="green">{q.dup ? `That sample credit advice (for ${q.sample}) is already here.` : `Uploaded a sample credit advice: the client's payment for ${q.sample}.`}</Notice>
      ) : added || q.dup ? (
        <Notice tone="green">
          {added ? `${added} document${added === 1 ? "" : "s"} uploaded.` : ""} {q.dup ? `${q.dup} already here (same file), so not added twice.` : ""}
        </Notice>
      ) : null}
      {q.rejected ? <Notice tone="red">Not uploaded: {q.rejected}</Notice> : null}
      {q.run ? (
        <Notice tone="violet">
          {running ? "The agent is reading them now; this page updates as it goes. " : "Read. "}
          <Link href={`/w/${slug}/runs/${q.run}`} className="link">
            See the run, step by step
          </Link>
        </Notice>
      ) : null}

      {canAct(role) ? (
        <Card title="Add documents" className="mb-6">
          <form action={uploadDocuments.bind(null, slug)} className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 basis-72 text-sm">
              <span className="mb-1 block text-muted">Files</span>
              <input
                type="file"
                name="files"
                multiple
                required
                accept=".pdf,.csv,.txt,.svg,.png,.jpg,.jpeg,.webp,application/pdf,text/csv,text/plain,image/*"
                className="input w-full file:mr-3 file:rounded-md file:border-0 file:bg-canvas file:px-3 file:py-1 file:text-sm file:text-ink"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">What are they?</span>
              <select name="kind" className="input" defaultValue="">
                <option value="">Let the agent decide</option>
                {UPLOAD_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input type="checkbox" name="read" defaultChecked /> Read them now
            </label>
            <SubmitButton pendingText="Uploading…">Upload</SubmitButton>
          </form>
          <form action={pasteText.bind(null, slug)} className="mt-4 space-y-2 border-t border-line pt-4">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Or paste a bank SMS or alert</span>
              <textarea name="text" rows={3} maxLength={10000} placeholder="e.g. Your A/C ****4567 has been credited with USD 3,975.00 on 28-Oct-26. Ref: FT2630..." className="input w-full font-mono text-xs" />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton variant="secondary" pendingText="Adding…">
                Add the text
              </SubmitButton>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name="read" defaultChecked /> Read it now
              </label>
            </div>
          </form>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-sm text-muted">
            <span>No document to hand?</span>
            <form action={uploadSample.bind(null, slug)}>
              <SubmitButton variant="secondary" pendingText="Uploading the sample…">
                Upload a sample credit advice
              </SubmitButton>
            </form>
            <span>
              or{" "}
              <a href={`/api/w/${slug}/samples/credit-advice`} className="link">
                download it as a PDF
              </a>{" "}
              and upload it yourself. It pays the oldest open invoice (SIMULATED).
            </span>
          </div>
          <p className="mt-3 text-xs text-muted">
            PDF, CSV, text, SVG, PNG, JPEG or WebP, up to 10 MB each and {UPLOAD_MAX_FILES} at a time. Files stay private to this workspace
            {ws.expiresAt ? " and are deleted with this demo copy" : ws.isDemo ? " and are removed when the demo is reset" : ""}. {byModel ? `Their text is read by Vultr Serverless Inference (${reader.model}); CSV exports are parsed by code.` : "They're read by the built-in layout rules (switch on reading with Vultr Serverless Inference in Settings)."} Scans and photos without a text layer go to a person.
          </p>
        </Card>
      ) : null}

      <div className="mb-3 flex gap-2 text-sm">
        <Link href={base} className={cx("rounded-full px-3 py-1", !reviewOnly ? "bg-ink text-panel" : "text-muted hover:text-ink")}>
          All
        </Link>
        <Link href={`${base}?show=review`} className={cx("rounded-full px-3 py-1", reviewOnly ? "bg-ink text-panel" : "text-muted hover:text-ink")}>
          Need a person ({reviewCount?.n ?? 0})
        </Link>
      </div>
      <Card pad={false}>
        {docs.length ? (
          <Table head={["Received", "Document", "Kind", "Came from", "Read by", "Status"]}>
            {docs.map((d) => (
              <tr key={d.id} className="hover:bg-canvas">
                <td className="whitespace-nowrap text-xs text-muted">{clock(d.receivedAt, ws.timezone)}</td>
                <td className="min-w-48">
                  <Link href={`${base}/${d.id}`} className="text-ink hover:text-accent">
                    {d.originalName ?? d.sha256.slice(0, 12)}
                  </Link>
                </td>
                <td className="whitespace-nowrap text-xs">{humanize(d.kind)}</td>
                <td className="text-xs text-muted">{d.source}</td>
                <td className="text-xs text-muted">{d.model ?? "—"}</td>
                <td>
                  <Status value={d.parseStatus} label={d.source === "generated" ? (d.kind === "report" ? "made by the app" : "sent, on file") : d.parseStatus === "needs_review" ? "needs a person" : d.reviewReasons?.[0]?.startsWith("Set aside by") ? "set aside" : undefined} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>{reviewOnly ? "Nothing is waiting for a person." : "No documents yet. The run pulls them from the mailbox, or upload some above."}</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
