import { addDays, isIsoDate, periodLabel, taxYearOf } from "@ebo/core";
import { OPENING_CHANNEL_LABELS, taxYearOpenings, workspaceToday } from "@ebo/engine";
import Link from "next/link";
import { Badge, Card, Empty, KeyValues, Notice, PageHeader, Stat, Table, cx } from "@/components/ui";
import { clock, day, money } from "@/lib/format";
import { canAct, canExport, requireWorkspace } from "@/lib/session";
import { builtPacks, taxPackPreview } from "@/lib/tax-file";
import { buildTaxPackAction } from "./actions";
import { ActionForm } from "@/components/action-form";

export const metadata = { title: "Tax-year file" };

const COUNTS_LABEL = { numerator_and_denominator: "banked", denominator_only: "received in wallet", not_proceeds: "spent from wallet" } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default async function ExportPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ year?: string; built?: string }> }) {
  const { ws: slug } = await params;
  const q = await searchParams;
  const { ws, role } = await requireWorkspace(slug);
  const asked = q.year && isIsoDate(q.year) ? q.year : undefined;
  const [{ file: f, summary: s }, packs] = await Promise.all([taxPackPreview(ws, asked), builtPacks(ws.id)]);
  const share = f.share;
  const openings = taxYearOpenings(f.books, f.context);
  const missing = f.lines.filter((l) => !l.ownTransfer && (l.eprc === "missing" || l.eprc === "requested")).length;
  const base = `/w/${slug}`;
  const csv = `/api/w/${slug}/export`;

  // Tax years with anything in them, newest first; the current one is "so far".
  const startMonth = ws.fiscalYearStartMonth;
  const current = taxYearOf(workspaceToday(ws), startMonth);
  const isCurrent = f.year.start === current.start;
  const firstDate = [...f.books.invoices.map((i) => i.issuedOn), ...f.books.transactions.map((t) => t.valueDate)].sort()[0];
  const first = taxYearOf([firstDate ?? current.start, f.year.start].sort()[0]!, startMonth);
  const years = [current];
  while (years.length < 6 && years.at(-1)!.start > first.start) years.push(taxYearOf(addDays(years.at(-1)!.start, -1), startMonth));
  const yearStart = isCurrent ? null : f.year.start;
  const yq = yearStart ? `year=${yearStart}` : "";

  // What the accountant will ask about: each with where to sort it out.
  const itCode = f.rules["purpose_code.it_services"][0] ?? "9186";
  const gaps: Array<{ text: string; href: string; cta: string }> = [];
  if (s.eprc.missing) gaps.push({ text: `${plural(s.eprc.missing, "ePRC")} not on file yet. Banks issue them after each credit; ask for any that are late.`, href: "#credits", cta: "See which" });
  if (s.eprc.wrongCode) gaps.push({ text: `${plural(s.eprc.wrongCode, "ePRC")} issued with a non-IT purpose code. Ask the bank to reissue ${s.eprc.wrongCode === 1 ? "it" : "them"} under ${itCode}.`, href: "#credits", cta: "See which" });
  if (s.wht.missing) gaps.push({ text: `${plural(s.wht.missing, "withholding certificate")} not on file yet.`, href: "#credits", cta: "See which" });
  if (s.sharePct != null && Number(s.sharePct) < Number(s.minSharePct)) gaps.push({ text: `The banking-channel share is ${s.sharePct}%, under the ${s.minSharePct}% rule.`, href: "#share", cta: "See the working" });
  if (s.pseb.lapsesInYear) gaps.push({ text: `PSEB registration lapses on ${day(s.pseb.validUntil)}, before the tax year ends.`, href: `${base}/settings`, cta: "Update it" });
  if (s.exceptions) gaps.push({ text: `${plural(s.exceptions, "open flag")} will go in as exceptions.`, href: `${base}/flags`, cta: "Review them" });
  const empty = !s.credits && !s.invoices;
  const built = q.built ? packs.find((p) => p.id === q.built && p.status === "done") : undefined;

  return (
    <>
      <PageHeader
        title={`Tax-year file ${f.year.label}`}
        sub={`${day(f.year.start)} to ${day(f.year.end)}${isCurrent ? `, as of ${day(f.today)}` : ""}. What an accountant needs at year end: every export credit with its paperwork, and the banking-channel working.`}
        actions={
          <>
            <a href={yq ? `${csv}?${yq}` : csv} className="btn btn-secondary">
              Credits (CSV)
            </a>
            <a href={`${csv}?part=share${yq ? `&${yq}` : ""}`} className="btn btn-secondary">
              Share working (CSV)
            </a>
          </>
        }
      />
      {years.length > 1 ? (
        <nav aria-label="Tax year" className="-mt-2 mb-5 flex flex-wrap gap-2">
          {years.map((y) => {
            const on = y.start === f.year.start;
            return (
              <Link
                key={y.start}
                href={y.start === current.start ? `${base}/export` : `${base}/export?year=${y.start}`}
                aria-current={on ? "page" : undefined}
                className={cx("rounded-full border px-3 py-1 text-sm tabular-nums", on ? "border-accent bg-accent/10 font-medium text-ink" : "border-line text-muted hover:border-ink/30 hover:text-ink")}
              >
                {y.label}
                {y.start === current.start ? " (so far)" : ""}
              </Link>
            );
          })}
        </nav>
      ) : null}
      {built ? (
        <Notice>
          Built the {built.period} tax pack.{" "}
          <a href={`/api/w/${slug}/tax-pack/${built.id}`} className="font-medium underline underline-offset-2">
            Download it
          </a>
          .
        </Notice>
      ) : null}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Banking-channel share" value={share ? `${share.sharePct}%` : "—"} hint={`minimum ${f.rules["banking_share.min_pct"]}% (rule unverified)`} tone={share ? (Number(share.sharePct) >= Number(f.rules["banking_share.warn_pct"]) ? "good" : "warn") : undefined} />
        <Stat label="Export credits" value={f.lines.filter((l) => !l.ownTransfer).length} hint={`${f.lines.filter((l) => l.ownTransfer).length} more from our own wallet`} />
        <Stat label="ePRCs outstanding" value={missing} tone={missing ? "warn" : "good"} hint="missing or requested" />
        <Stat label="Wallet money not yet banked" value={share ? `USD ${share.walletHeldUsd}` : "—"} hint={share && share.walletSpentUsd !== "0.00" ? `USD ${share.walletSpentUsd} spent by card` : "at reference rates"} />
      </div>

      <Card title={`Year-end tax pack ${f.year.label}`} className="mb-6">
        <p className="max-w-prose text-sm text-muted">
          One zip for your accountant: the year&apos;s export proceeds by month, every credit with its ePRC and withholding certificate, the banking-share working, invoices, credit notes and open flags, with copies of the certificates on file.
        </p>
        {empty ? (
          <p className="mt-4 text-sm text-ink">Nothing to pack for {f.year.label} yet: no export credits or invoices in that tax year.</p>
        ) : (
          <>
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">In the pack{isCurrent ? ", so far" : ""}</h3>
                <KeyValues
                  rows={[
                    ["Proceeds banked", `${money(s.proceedsPkr ?? "0", "PKR")} from ${plural(s.credits, "credit")}`],
                    ["ePRCs", `${s.eprc.onFile} of ${s.eprc.needed} on file`],
                    ["Withholding certificates", `${s.wht.onFile} of ${s.wht.needed} on file`],
                    ["Certificate copies", plural(s.files, "file")],
                    ["Invoices", `${s.invoices} issued; ${plural(s.creditNotes, "credit note, write-off or void", "credit notes, write-offs or voids")}`],
                    ["Open flags", `${s.exceptions}, listed as exceptions`],
                  ]}
                />
              </div>
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Before you send it</h3>
                {gaps.length ? (
                  <ul className="space-y-2 text-sm text-ink">
                    {gaps.map((g) => (
                      <li key={g.text} className="flex gap-2">
                        <span aria-hidden className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-amber-500" />
                        <span>
                          {g.text}{" "}
                          <Link href={g.href} className="link whitespace-nowrap">
                            {g.cta}
                          </Link>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink">Nothing missing: every credit has its certificates on file, and no flags are open.</p>
                )}
              </div>
            </div>
            <div className="mt-5 border-t border-line pt-4">
              {canExport(role) ? (
                <ActionForm
                  action={buildTaxPackAction.bind(null, slug, yearStart)}
                  title="Not built:"
                  pendingText="Building the pack…"
                  label={`Build the ${f.year.label} pack`}
                  hint={isCurrent ? "From the records as they stand today. Build it again after anything changes; earlier packs are kept." : "From the records for that year. Earlier packs are kept."}
                />
              ) : (
                <p className="text-xs text-muted">Your role can download packs. An owner, finance or the accountant builds them.</p>
              )}
            </div>
          </>
        )}
      </Card>

      {packs.length ? (
        <Card title="Built packs" pad={false} className="mb-6" id="packs">
          <Table dense head={["Tax year", "Built", "By", ""]}>
            {packs.map((p) => (
              <tr key={p.id} className={cx(p.id === built?.id && "bg-accent/5")}>
                <td className="tabular-nums">{p.period}</td>
                <td className="whitespace-nowrap text-muted">{clock(p.createdAt, ws.timezone)}</td>
                <td>{p.by ?? "—"}</td>
                <td className="text-right">
                  {p.status === "done" ? (
                    <a href={`/api/w/${slug}/tax-pack/${p.id}`} className="link whitespace-nowrap">
                      Download .zip
                    </a>
                  ) : (
                    <Badge tone={p.status === "failed" ? "red" : "blue"}>{p.status === "failed" ? "failed" : "building"}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {f.estimate ? (
        <Card title="PSEB registration: what it would save" className="mb-6">
          <p className="text-sm text-ink">
            {money(f.estimate.proceedsPkr, "PKR")} received in Pakistan this tax year. Final tax at {f.estimate.standardRatePct}% is {money(f.estimate.without, "PKR")}; with PSEB registration at {f.estimate.psebRatePct}% it would be{" "}
            {money(f.estimate.withPseb, "PKR")}, a saving of <b>{money(f.estimate.saving, "PKR")}</b>.
          </p>
          <p className="mt-1 text-xs text-muted">Estimate from the PKR actually credited. Both rates are rules marked unverified until checked against FBR sources. Not tax advice.</p>
        </Card>
      ) : null}

      <Card title="Export credits into Pakistani banks" pad={false} className="mb-6" id="credits">
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
            <Empty>No credits in this tax year.</Empty>
          </div>
        )}
      </Card>

      {openings.length ? (
        <Card title="Opening balances" pad={false} className="mb-6" id="opening">
          <p className="px-4 pt-3 text-sm text-muted">Proceeds from before the records here began, imported from a spreadsheet. They count in the share and the PSEB estimate above.</p>
          <Table head={["Month", "How it came in", "Amount", "PKR", "ePRC"]}>
            {openings.map((o) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap">{periodLabel(o.month)}</td>
                <td>{OPENING_CHANNEL_LABELS[o.channel]}</td>
                <td className="whitespace-nowrap text-right tabular-nums">{money(o.amount, o.currency)}</td>
                <td className="whitespace-nowrap text-right tabular-nums text-muted">
                  {o.currency === "PKR" || !o.pkr ? "" : money(o.pkr.toFixed(2), "PKR")}
                  {o.pkrEstimated && o.pkr ? " est." : ""}
                </td>
                <td>{o.eprcOnFile == null ? "—" : o.eprcOnFile ? "on file" : "not on file"}</td>
              </tr>
            ))}
          </Table>
          {canAct(role) && isCurrent ? (
            <p className="px-4 py-3 text-sm">
              <Link href={`${base}/import#opening_balances`} className="link">
                Import them again
              </Link>{" "}
              <span className="text-muted">(a new file replaces these)</span>
            </p>
          ) : null}
        </Card>
      ) : canAct(role) && isCurrent ? (
        <p className="mb-6 text-sm text-muted">
          Started here partway through the tax year?{" "}
          <Link href={`${base}/import#opening_balances`} className="link">
            Import opening balances
          </Link>{" "}
          so the share and the PSEB estimate cover the whole year.
        </p>
      ) : null}

      {share ? (
        <Card title="Banking-channel share: the working" pad={false} id="share">
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
