import { dec, formatMoney, periodLabel, ROUTE_LABELS, type Grouping } from "@ebo/core";
import { getDb, storageFromEnv } from "@ebo/db";
import { IMPORT_SPECS, importView, OPENING_CHANNEL_LABELS, type ImportPlan } from "@ebo/engine";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Card, Notice, PageHeader, Table } from "@/components/ui";
import { countryName } from "@/lib/forms";
import { clock, day } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { applyImportAction, uploadImportAction } from "../actions";
import { ImportUploadForm } from "../upload-form";

export const metadata = { title: "Import" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN = 25;
const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** The rows as they'll be saved: the first few, in the template's terms. */
function Preview({ plan, grouping }: { plan: ImportPlan; grouping: Grouping }) {
  const cash = (amount: string, currency: string) => formatMoney(amount, currency, { grouping });
  let head: string[];
  let rows: Array<[number, ReactNode[]]>;
  if (plan.kind === "clients") {
    head = ["Row", "Name", "Country", "Kind", "Currency", "Terms", "Emails", "Payer names"];
    rows = plan.rows.map((p) => [p.row, [p.values.name, countryName(p.values.country), p.values.kind, p.values.defaultCurrency, `${p.values.paymentTermsDays} days`, p.values.contactEmails.join(", ") || "—", p.aliases.join("; ") || "—"]]);
  } else if (plan.kind === "invoices") {
    head = ["Row", "Number", "Client", "Issued", "Due", "Amount", "Already paid", "Owed", "Route"];
    rows = plan.rows.map((p) => [p.row, [p.number, p.clientName, day(p.issuedOn), day(p.dueOn), cash(p.amount, p.currency), dec(p.paid).gt(0) ? cash(p.paid, p.currency) : "—", cash(dec(p.amount).minus(p.paid).toFixed(2), p.currency), ROUTE_LABELS[p.route]]]);
  } else {
    head = ["Row", "Month", "How it came in", "Amount", "PKR", "ePRC"];
    rows = plan.rows.map((p) => [p.row, [periodLabel(p.month), OPENING_CHANNEL_LABELS[p.channel], cash(p.amount, p.currency), p.currency === "PKR" ? "—" : p.pkrAmount ? cash(p.pkrAmount, "PKR") : "at the reference rate", p.eprcOnFile == null ? "—" : p.eprcOnFile ? "yes" : "no"]]);
  }
  return (
    <Table head={head} dense>
      {rows.slice(0, SHOWN).map(([row, cells]) => (
        <tr key={row}>
          <td className="tabular-nums text-muted">{row}</td>
          {cells.map((c, i) => (
            <td key={i} className="whitespace-nowrap">
              {c}
            </td>
          ))}
        </tr>
      ))}
    </Table>
  );
}

export default async function ImportJobPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ done?: string; changed?: string }> }) {
  const { ws: slug, id } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  if (!UUID.test(id)) notFound();
  const v = await importView(getDb(), storageFromEnv(), ws, id);
  if (!v) notFound();
  const spec = IMPORT_SPECS[v.kind];
  const acts = canAct(role);
  const base = `/w/${slug}`;
  const next: Record<typeof v.kind, [string, string]> = { clients: [`${base}/clients`, "See the clients"], invoices: [`${base}/invoices`, "See the invoices"], opening_balances: [`${base}/export`, "See the tax-year file"] };
  const result = v.summary.result ?? {};

  return (
    <>
      <PageHeader
        title={`${spec.title} import`}
        sub={
          <>
            {v.file ?? "A file"}, uploaded {clock(v.createdAt, ws.timezone)}
            {v.by ? ` by ${v.by}` : ""}
          </>
        }
        actions={
          <Link href={`${base}/import`} className="btn btn-secondary">
            All imports
          </Link>
        }
      />

      {v.status === "applied" ? (
        <Notice>
          {q.done ? "Done. " : ""}Imported {plural(result.created ?? 0, spec.noun)}
          {result.replaced ? `, replacing ${plural(result.replaced, spec.noun)} imported earlier` : ""}
          {v.summary.appliedAt ? ` on ${clock(new Date(v.summary.appliedAt), ws.timezone)}` : ""}
          {v.appliedBy ? ` by ${v.appliedBy}` : ""}.{" "}
          <Link href={next[v.kind][0]} className="font-medium underline underline-offset-2">
            {next[v.kind][1]}
          </Link>
        </Notice>
      ) : null}
      {q.changed && v.errors.length ? <Notice tone="amber">Something in the workspace changed after the file was checked, and some rows no longer fit. Nothing was imported.</Notice> : null}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {v.errors.length ? (
            <Card title={`Not imported: ${plural(v.errors.length, ["problem", "problems"])} to fix`} pad={false}>
              <p className="px-4 pt-3 text-sm text-muted">Fix these in the spreadsheet, save it as CSV again and upload it. Rows are numbered as in the spreadsheet, with the headings on row 1.</p>
              <Table head={["Row", "Column", "Problem"]} dense>
                {v.errors.slice(0, 200).map((e, i) => (
                  <tr key={i}>
                    <td className="tabular-nums">{e.row}</td>
                    <td className="whitespace-nowrap font-mono text-xs">{e.column ?? "—"}</td>
                    <td>{e.error}</td>
                  </tr>
                ))}
              </Table>
              {v.errors.length > 200 ? <p className="px-4 py-3 text-sm text-muted">And {v.errors.length - 200} more.</p> : null}
            </Card>
          ) : null}

          {v.plan ? (
            <Card title={`Ready: ${plural(v.plan.rows.length, spec.noun)}`} pad={false}>
              <div className="space-y-3 px-4 pt-3 text-sm">
                <p className="text-muted">Every row is fine. This is what importing will add{v.plan.rows.length > SHOWN ? ` (the first ${SHOWN} rows)` : ""}:</p>
                {v.plan.kind === "opening_balances" && v.plan.replaces ? <Notice tone="amber">Importing replaces the {plural(v.plan.replaces, spec.noun)} imported earlier.</Notice> : null}
                {v.plan.kind === "invoices" ? <p className="text-muted">They come in as sent, without PDFs. Money already paid is taken off what&apos;s owed; the agent matches the rest when it arrives and chases it once it&apos;s overdue.</p> : null}
                {v.plan.kind === "opening_balances" ? <p className="text-muted">They count in the banking-channel share and the PSEB estimate on the tax-year file, as if the money had been recorded here.</p> : null}
              </div>
              <Preview plan={v.plan} grouping={ws.numberGrouping} />
              {acts ? (
                <div className="border-t border-line px-4 py-3">
                  <ActionForm action={applyImportAction.bind(null, slug, v.id)} label={`Import ${plural(v.plan.rows.length, spec.noun)}`} pendingText="Importing…" title="Not imported:" />
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          {v.status !== "applied" && acts ? (
            <Card title={v.errors.length ? "Upload the fixed file" : "Upload a different file"}>
              <ImportUploadForm action={uploadImportAction.bind(null, slug, v.kind)} />
            </Card>
          ) : null}
          {v.summary.columns?.length ? (
            <Card title="How the columns were read">
              <ul className="space-y-1 text-sm">
                {v.summary.columns.map(([heading, key]) => (
                  <li key={heading}>
                    {heading === key ? (
                      <span className="font-mono text-xs">{key}</span>
                    ) : (
                      <>
                        {heading} <span className="text-muted">as</span> <span className="font-mono text-xs">{key}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {v.summary.ignored?.length ? <p className="mt-3 text-sm text-muted">Left out (not in the template): {v.summary.ignored.join(", ")}.</p> : null}
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
