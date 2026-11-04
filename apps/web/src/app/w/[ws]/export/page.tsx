import { Badge, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { day, money } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { taxYearFile } from "@/lib/tax-file";

export const metadata = { title: "Tax-year file" };

const COUNTS_LABEL = { numerator_and_denominator: "banked", denominator_only: "received in wallet", not_proceeds: "spent from wallet" } as const;

export default async function ExportPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws } = await requireWorkspace(slug);
  const f = await taxYearFile(ws);
  const share = f.share;
  const missing = f.lines.filter((l) => !l.ownTransfer && (l.eprc === "missing" || l.eprc === "requested")).length;
  const csv = `/api/w/${slug}/export`;

  return (
    <>
      <PageHeader
        title={`Tax-year file ${f.year.label}`}
        sub={`${day(f.year.start)} to ${day(f.year.end)}, as of ${day(f.today)}. What an accountant needs at year end: every export credit with its paperwork, and the banking-channel working.`}
        actions={
          <>
            <a href={csv} className="btn btn-primary">
              Download credits (CSV)
            </a>
            <a href={`${csv}?part=share`} className="btn btn-secondary">
              Share working (CSV)
            </a>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Banking-channel share" value={share ? `${share.sharePct}%` : "—"} hint={`minimum ${f.rules["banking_share.min_pct"]}% (rule unverified)`} tone={share ? (Number(share.sharePct) >= Number(f.rules["banking_share.warn_pct"]) ? "good" : "warn") : undefined} />
        <Stat label="Export credits" value={f.lines.filter((l) => !l.ownTransfer).length} hint={`${f.lines.filter((l) => l.ownTransfer).length} more from our own wallet`} />
        <Stat label="ePRCs outstanding" value={missing} tone={missing ? "warn" : "good"} hint="missing or requested" />
        <Stat label="Wallet money not yet banked" value={share ? `USD ${share.walletHeldUsd}` : "—"} hint={share && share.walletSpentUsd !== "0.00" ? `USD ${share.walletSpentUsd} spent by card` : "at reference rates"} />
      </div>

      {f.estimate ? (
        <Card title="PSEB registration: what it would save" className="mb-6">
          <p className="text-sm text-ink">
            {money(f.estimate.proceedsPkr, "PKR")} received in Pakistan this tax year. Final tax at {f.estimate.standardRatePct}% is {money(f.estimate.without, "PKR")}; with PSEB registration at {f.estimate.psebRatePct}% it would be{" "}
            {money(f.estimate.withPseb, "PKR")}, a saving of <b>{money(f.estimate.saving, "PKR")}</b>.
          </p>
          <p className="mt-1 text-xs text-muted">Estimate from the PKR actually credited. Both rates are rules marked unverified until checked against FBR sources. Not tax advice.</p>
        </Card>
      ) : null}

      <Card title="Export credits into Pakistani banks" pad={false} className="mb-6">
        {f.lines.length ? (
          <Table head={["Date", "Payer", "Amount", "PKR", "Code", "Invoices", "ePRC", "WHT cert."]}>
            {f.lines.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap tabular-nums text-muted">{l.valueDate}</td>
                <td className="min-w-40">
                  {l.payer ?? "—"}
                  {l.ownTransfer ? <div className="text-xs text-muted">from our own wallet</div> : null}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">{money(l.amount, l.currency)}</td>
                <td className="whitespace-nowrap text-right tabular-nums text-muted">{l.pkrAmount && l.currency !== "PKR" ? money(l.pkrAmount, "PKR") : ""}</td>
                <td className="tabular-nums">{l.purposeCode ?? "—"}</td>
                <td className="whitespace-nowrap text-xs">{l.invoices.join(", ")}</td>
                <td>
                  <Paper status={l.eprc} />
                </td>
                <td>
                  <Paper status={l.whtCertificate} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No credits this tax year yet.</Empty>
          </div>
        )}
      </Card>

      {share ? (
        <Card title="Banking-channel share: the working" pad={false}>
          <div className="grid gap-3 border-b border-line p-4 text-sm sm:grid-cols-3">
            <div>
              <div className="text-muted">Banked (numerator)</div>
              <div className="tabular-nums text-ink">USD {share.numeratorUsd}</div>
              <div className="text-xs text-muted">direct USD {share.directBankUsd} + withdrawn USD {share.walletWithdrawnUsd}</div>
            </div>
            <div>
              <div className="text-muted">All proceeds (denominator)</div>
              <div className="tabular-nums text-ink">USD {share.denominatorUsd}</div>
              <div className="text-xs text-muted">direct USD {share.directBankUsd} + received in wallets USD {share.walletReceivedUsd}</div>
            </div>
            <div>
              <div className="text-muted">Method</div>
              <div className="text-xs text-muted">USD at the reference rate on each value date. Wallet money counts when withdrawn to a Pakistani bank, oldest first; card spending never counts. (How the 80% rule is measured is still to be verified.)</div>
            </div>
          </div>
          <Table dense head={["Date", "Event", "Amount", "USD", "Counts as", "Note"]}>
            {share.lines.map((l) => (
              <tr key={`${l.id}-${l.kind}`}>
                <td className="whitespace-nowrap tabular-nums text-muted">{l.date}</td>
                <td className="whitespace-nowrap text-xs">{l.kind.replace(/_/g, " ")}</td>
                <td className="whitespace-nowrap text-right tabular-nums">{money(l.amount, l.currency)}</td>
                <td className="whitespace-nowrap text-right tabular-nums">{l.usd}</td>
                <td>
                  <Badge tone={l.counts === "numerator_and_denominator" ? "green" : l.counts === "denominator_only" ? "blue" : "gray"}>{COUNTS_LABEL[l.counts]}</Badge>
                </td>
                <td className="text-xs text-muted">{l.note}</td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </>
  );
}

function Paper({ status }: { status: string }) {
  const tone = status === "on file" ? "green" : status.startsWith("wrong") ? "red" : status === "requested" ? "blue" : status === "missing" ? "amber" : "gray";
  return <Badge tone={tone}>{status}</Badge>;
}
