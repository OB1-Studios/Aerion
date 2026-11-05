import { getDb } from "@ebo/db";
import { esfcaView, loadContext } from "@ebo/engine";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Empty, Notice, PageHeader, Stat, Table } from "@/components/ui";
import { day, money } from "@/lib/format";
import { canAct, requireWorkspace } from "@/lib/session";
import { recordConversionAction, removeConversionAction } from "../../manage-actions";
import { ConversionForm } from "./conversion-form";

export const metadata = { title: "ESFCA" };

export default async function EsfcaPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ recorded?: string; removed?: string }> }) {
  const { ws: slug } = await params;
  const { recorded, removed } = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const view = await esfcaView(db, await loadContext(db, ws.id));
  const acts = canAct(role);
  const base = `/w/${slug}`;

  if (!view.accounts.length) {
    return (
      <>
        <PageHeader title="ESFCA" />
        <Card>
          <Empty>
            No ESFCA is set up in this workspace. {role === "owner" ? <Link href={`${base}/setup`} className="link">Add one in Setup</Link> : "The owner can add one in Setup."}
          </Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="ESFCA" sub="What's in the foreign currency account, what's been converted and at what rate. Conversions are recorded here after the bank makes them." />
      {recorded ? <Notice>Conversion recorded.{recorded === "tied" ? " The matching PKR credit on your statement is no longer waiting for an invoice." : ""}</Notice> : null}
      {removed ? <Notice>Conversion removed. The audit log keeps the record.</Notice> : null}

      {view.accounts.map((a) => (
        <section key={a.id} className="mb-8">
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={`${a.label} balance`}
              value={money(a.balance, a.currency)}
              hint={a.basis.kind === "statement" ? `from the statement to ${day(a.basis.on)}, plus movements since` : "from recorded movements only; upload a statement to confirm it"}
              tone={Number(a.balance) < 0 ? "warn" : undefined}
            />
            <Stat label="Converted" value={money(a.totals.amount, a.currency)} hint={`${a.conversions.length} on record`} />
            <Stat label="PKR received" value={money(a.totals.pkr, "PKR")} />
            <Stat label="Below the reference rate" value={money(a.totals.costPkr, "PKR")} hint="what those conversions gave up" />
          </div>
          {Number(a.balance) < 0 ? <Notice tone="amber">Conversions are more than the credits on record. A credit may be missing, or the account held money before these records began. Upload a statement to settle it.</Notice> : null}

          <div className="space-y-4">
            <div>
              <Card title="Conversions" pad={false}>
                {a.conversions.length ? (
                  <Table head={["Date", "Converted", "PKR", "Bank rate", "Reference rate", "Cost", "", ""]}>
                    {a.conversions.map((c) => (
                      <tr key={c.id}>
                        <td className="whitespace-nowrap tabular-nums text-muted">
                          {c.on}
                          {c.reference ? <div className="text-xs">{c.reference}</div> : null}
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums">{money(c.amount, c.currency)}</td>
                        <td className="whitespace-nowrap text-right tabular-nums">{money(c.pkr, "PKR")}</td>
                        <td className="text-right tabular-nums">{Number(c.rate).toFixed(2)}</td>
                        <td className="text-right tabular-nums text-muted">{c.referenceRate ? Number(c.referenceRate).toFixed(2) : "—"}</td>
                        <td className="whitespace-nowrap text-right tabular-nums">
                          {c.costPkr ? money(c.costPkr, "PKR") : "—"}
                          {c.costPct ? <div className="text-xs text-muted">{c.costPct}%</div> : null}
                        </td>
                        <td>
                          {c.wide ? <Badge tone="amber">Wide spread</Badge> : null}
                          {c.tiedToStatement ? <Badge tone="green">On statement</Badge> : null}
                          {c.closed ? <Badge>Closed month</Badge> : null}
                        </td>
                        <td>{acts && !c.closed ? <ActionForm action={removeConversionAction.bind(null, slug, c.id)} label="Remove" pendingText="Removing…" variant="secondary" /> : null}</td>
                      </tr>
                    ))}
                  </Table>
                ) : (
                  <div className="p-4">
                    <Empty>No conversions recorded yet.</Empty>
                  </div>
                )}
              </Card>
            </div>
            <div className="grid items-start gap-4 lg:grid-cols-2">
              {acts ? (
                <Card title="Record a conversion">
                  <ConversionForm action={recordConversionAction.bind(null, slug)} accountId={a.id} currency={a.currency} today={view.today} />
                </Card>
              ) : null}
              {a.monthEnds.length ? (
                <Card title="Month-end balances, from statements" pad={false}>
                  <Table head={["Month", "Last posting", "Balance"]}>
                    {a.monthEnds.map((m) => (
                      <tr key={m.month}>
                        <td>{m.label}</td>
                        <td className="tabular-nums text-muted">{m.on}</td>
                        <td className="text-right tabular-nums">{money(m.balance, a.currency)}</td>
                      </tr>
                    ))}
                  </Table>
                </Card>
              ) : null}
            </div>
          </div>
        </section>
      ))}

      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Retention check
            <Link href={`${base}/rules`}>
              <Badge tone={view.rule.verified ? "green" : "amber"}>{view.rule.verified ? "Rule verified" : "Rule unverified"}</Badge>
            </Link>
          </span>
        }
        pad={false}
      >
        <p className="px-4 pt-3 text-sm text-muted">
          The limit we apply: the greater of USD {Number(view.rule.minUsd).toLocaleString("en-US")} a month or {view.rule.pct}% of the month&apos;s export proceeds, compared with what stayed in the ESFCA that month after conversions.
          {view.rule.verified ? "" : " This reading of the State Bank rule hasn't been checked against the source yet, so confirm with your bank before acting on it."}
        </p>
        {view.retention.length ? (
          <Table head={["Month", "Export proceeds", "Into the ESFCA", "Converted", "Kept", "Limit", ""]}>
            {view.retention.map((m) => (
              <tr key={m.month}>
                <td>{m.label}</td>
                <td className="text-right tabular-nums">{money(m.proceedsPkr, "PKR")}</td>
                <td className="text-right tabular-nums">{money(m.intoPkr, "PKR")}</td>
                <td className="text-right tabular-nums">{money(m.convertedPkr, "PKR")}</td>
                <td className="text-right tabular-nums font-medium">{money(m.retainedPkr, "PKR")}</td>
                <td className="text-right tabular-nums">{m.limitPkr ? money(m.limitPkr, "PKR") : "No USD rate"}</td>
                <td>{m.limitPkr ? m.over ? <Badge tone="amber">Above the limit</Badge> : <Badge tone="green">Within</Badge> : null}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No export proceeds yet this tax year.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
