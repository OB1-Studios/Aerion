import { document, getDb, run } from "@ebo/db";
import { UPLOAD_KINDS, UPLOAD_MAX_FILES } from "@ebo/engine";
import { and, count, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { FilterForm, FilterSearch, FilterSelect } from "@/components/filters";
import { RunPoller } from "@/components/run-poller";
import { SubmitButton } from "@/components/submit-button";
import { Card, Empty, Notice, PageHeader, Pager, Provenance, Status, Table, Tabs, pageOf } from "@/components/ui";
import { clock } from "@/lib/format";
import { DOCUMENT_KIND, documentKindLabel, documentStatusLabel, readerLabel, SOURCE_LABEL } from "@/lib/labels";
import { readerInfo } from "@/lib/platform";
import { canAct, requireWorkspace } from "@/lib/session";
import { pasteText, uploadDocuments, uploadSample } from "../actions";

export const metadata = { title: "Documents" };

const PAGE = 50;

const UPLOAD_PROBLEM: Record<string, string> = {
  none: "Choose at least one file to upload.",
  toomany: `Up to ${UPLOAD_MAX_FILES} files at a time, please.`,
  "empty-paste": "Paste the text of the SMS or alert first.",
  "long-paste": "That's longer than a bank alert (10,000 characters at most). Upload it as a file instead.",
  "nothing-open": "Every invoice paid by bank wire is settled, so there's nothing for a sample to pay. Reset the demo to start again.",
  "not-demo": "Sample documents are only for demo workspaces: a made-up payment must never reach real books.",
};

export default async function DocumentsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const reviewOnly = sp.show === "review";
  const kind = sp.kind && sp.kind in DOCUMENT_KIND ? sp.kind : "";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = pageOf(sp.page);

  const where: SQL[] = [eq(document.workspaceId, ws.id)];
  if (reviewOnly) where.push(eq(document.parseStatus, "needs_review"));
  if (kind) where.push(eq(document.kind, kind as "eprc"));
  if (q) where.push(ilike(document.originalName, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));

  const [docs, [total], [reviewCount], [allCount], kinds, [lastRun]] = await Promise.all([
    db
      .select()
      .from(document)
      .where(and(...where))
      .orderBy(desc(document.receivedAt), desc(document.createdAt))
      .limit(PAGE)
      .offset((page - 1) * PAGE),
    db.select({ n: count() }).from(document).where(and(...where)),
    db.select({ n: count() }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.parseStatus, "needs_review"))),
    db.select({ n: count() }).from(document).where(eq(document.workspaceId, ws.id)),
    db.selectDistinct({ kind: document.kind }).from(document).where(and(eq(document.workspaceId, ws.id), sql`${document.kind} is not null`)),
    db.select({ id: run.id, status: run.status }).from(run).where(eq(run.workspaceId, ws.id)).orderBy(desc(run.startedAt)).limit(1),
  ]);
  const running = lastRun?.status === "queued" || lastRun?.status === "running";
  const reader = readerInfo();
  const byModel = reader.mode === "vultr" && ws.aiReadingEnabled;
  const base = `/w/${slug}/documents`;
  const added = Number(sp.added ?? 0);
  const filtered = !!(kind || q);
  const keep = { show: reviewOnly ? "review" : undefined };
  const href = (p: number) => `${base}?${new URLSearchParams(Object.entries({ show: keep.show, kind, q, page: p > 1 ? String(p) : "" }).filter(([, v]) => v) as Array<[string, string]>)}`;

  return (
    <>
      <RunPoller active={running} everyMs={2000} />
      <PageHeader
        eyebrow="Compliance"
        title="Documents"
        sub="Everything that came in: credit advices, statements, ePRCs and certificates, wallet exports, screenshots and pasted bank alerts. Each file is kept once, however often it arrives."
      />

      {sp.upload && UPLOAD_PROBLEM[sp.upload] ? <Notice tone="amber">{UPLOAD_PROBLEM[sp.upload]}</Notice> : null}
      {sp.sample ? (
        <Notice tone="green">{sp.dup ? `That sample credit advice (for ${sp.sample}) is already here.` : `Added a SIMULATED credit advice: the client's payment for ${sp.sample}.`}</Notice>
      ) : added || sp.dup ? (
        <Notice tone="green">
          {added ? `${added} document${added === 1 ? "" : "s"} added.` : ""} {sp.dup ? `${sp.dup} already here (the same file), so not added twice.` : ""}
        </Notice>
      ) : null}
      {sp.rejected ? <Notice tone="red">Not added: {sp.rejected}</Notice> : null}
      {sp.run ? (
        <Notice tone="violet">
          {running ? "Aerion is reading them now; this page updates as it goes. " : "Read. "}
          <Link href={`/w/${slug}/runs/${sp.run}`} className="underline">
            See the run, step by step
          </Link>
        </Notice>
      ) : null}

      {canAct(role) ? (
        <Card title="Add documents" sub={byModel ? `Read by Vultr Serverless Inference (${reader.model}); every value quotes its source and is checked by code. CSV exports are parsed by code.` : "Read by the built-in layout rules. Owners can switch on AI reading in Settings."} className="mb-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <form action={uploadDocuments.bind(null, slug)} className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-ink">Upload files</span>
                <input
                  type="file"
                  name="files"
                  multiple
                  required
                  accept=".pdf,.csv,.txt,.svg,.png,.jpg,.jpeg,.webp,application/pdf,text/csv,text/plain,image/*"
                  className="input w-full file:mr-3 file:rounded-md file:border-0 file:bg-sunken file:px-3 file:py-1 file:text-sm file:text-ink"
                />
                <span className="mt-1 block text-xs text-muted">PDF, CSV, text or images; up to 10 MB each and {UPLOAD_MAX_FILES} at a time.</span>
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-muted">What are they?</span>
                  <select name="kind" className="input" defaultValue="">
                    <option value="">Let Aerion decide</option>
                    {UPLOAD_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 pb-2 text-sm text-ink">
                  <input type="checkbox" name="read" defaultChecked className="accent-[var(--accent)]" /> Read them now
                </label>
                <SubmitButton pendingText="Uploading…">Upload</SubmitButton>
              </div>
            </form>
            <form action={pasteText.bind(null, slug)} className="space-y-3 border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-ink">Or paste a bank SMS or alert</span>
                <textarea name="text" rows={3} maxLength={10000} placeholder="Your A/C ****4567 has been credited with USD 3,975.00 on 28-Oct-26. Ref: FT2630…" className="input w-full font-mono text-xs" />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <SubmitButton variant="secondary" pendingText="Adding…">
                  Add the text
                </SubmitButton>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="read" defaultChecked className="accent-[var(--accent)]" /> Read it now
                </label>
              </div>
            </form>
          </div>
          {ws.isDemo ? (
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-sm text-muted">
              <span>No document to hand?</span>
              <form action={uploadSample.bind(null, slug)}>
                <SubmitButton variant="secondary" pendingText="Adding the sample…">
                  Add a sample credit advice
                </SubmitButton>
              </form>
              <span>
                or{" "}
                <a href={`/api/w/${slug}/samples/credit-advice`} className="link">
                  download it as a PDF
                </a>{" "}
                to upload yourself. It pays the oldest open invoice (SIMULATED, demo only).
              </span>
            </div>
          ) : null}
          <p className="mt-4 text-xs text-muted">
            Files stay private to this workspace{ws.expiresAt ? " and are deleted with this demo copy" : ws.isDemo ? " and are removed when the demo is reset" : ""}. Scans and photos without a text layer go to a person to read.
          </p>
        </Card>
      ) : null}

      <Tabs
        items={[
          { href: base, label: "All documents", active: !reviewOnly, count: Number(allCount?.n ?? 0) },
          { href: `${base}?show=review`, label: "Needs a person", active: reviewOnly, count: Number(reviewCount?.n ?? 0) },
        ]}
      />
      <FilterForm keep={keep} clearHref={reviewOnly ? `${base}?show=review` : base} active={filtered}>
        <FilterSelect name="kind" label="Kind" value={kind} options={[["", "Any kind"], ...kinds.map((k) => [k.kind!, documentKindLabel(k.kind)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]))]} />
        <FilterSearch value={q} placeholder="File name" />
      </FilterForm>
      <Card pad={false}>
        {docs.length ? (
          <>
            <Table head={["Received", "Document", "Came from", "Read by", "Status"]}>
              {docs.map((d) => {
                const r = readerLabel(d.model);
                return (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap text-xs text-muted">{clock(d.receivedAt, ws.timezone)}</td>
                    <td className="min-w-56">
                      <Link href={`${base}/${d.id}`} className="break-all text-ink hover:text-accent">
                        {d.originalName ?? d.sha256.slice(0, 12)}
                      </Link>
                      <div className="text-xs text-muted">{documentKindLabel(d.kind)}</div>
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted">{SOURCE_LABEL[d.source] ?? d.source}</td>
                    <td className="whitespace-nowrap">{r.kind ? <Provenance kind={r.kind === "rules" ? "rules" : r.kind === "model" ? "model" : r.kind === "person" ? "person" : "simulated"} /> : <span className="text-xs text-muted">—</span>}</td>
                    <td>
                      <Status value={d.parseStatus} label={documentStatusLabel(d)} />
                    </td>
                  </tr>
                );
              })}
            </Table>
            <Pager page={page} pageSize={PAGE} total={Number(total?.n ?? 0)} href={href} noun="documents" />
          </>
        ) : (
          <div className="p-4">
            <Empty>{filtered ? "No documents match these filters." : reviewOnly ? "Nothing is waiting for a person: every document was read with confidence." : "No documents yet. The weekly run pulls them from the connected mailbox, or add some above."}</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
