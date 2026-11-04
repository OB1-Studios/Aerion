import { AUTOPILOT_DEFAULTS, TEMPLATE_NAMES, type TemplateKey } from "@ebo/core";
import { getDb, member, receivingAccount, user } from "@ebo/db";
import { asc, eq } from "drizzle-orm";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, KeyValues, Notice, PageHeader, Table, cx } from "@/components/ui";
import { day, ROLE_LABEL } from "@/lib/format";
import { describeCredit } from "@ebo/vultr";
import { readerInfo, vultrStatus } from "@/lib/platform";
import { requireWorkspace } from "@/lib/session";
import { setAiReading, setPolicy } from "../actions";

export const metadata = { title: "Settings" };

const SEND_TEXT = { auto: "sends on its own", delay: "waits, then sends", approve: "always a person" } as const;

export default async function SettingsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const { ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [accounts, members] = await Promise.all([
    db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, ws.id)).orderBy(asc(receivingAccount.label)),
    db.select({ name: user.name, email: user.email, anon: user.isAnonymous, role: member.role }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.workspaceId, ws.id)),
  ]);
  const reader = readerInfo();
  let platform: Awaited<ReturnType<typeof vultrStatus>> = null;
  let platformError: string | null = null;
  try {
    platform = await vultrStatus();
  } catch (err) {
    platformError = err instanceof Error ? err.message : String(err);
  }
  const policy = ws.approvalPolicy;
  const isOwner = role === "owner";
  const s = ws.settings ?? {};

  return (
    <>
      <PageHeader title="Settings" sub="How this workspace sends, who signs, where money arrives, and what it runs on." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Who approves outgoing email" className="xl:col-span-2">
          <form action={setPolicy.bind(null, slug)} className="grid gap-3 md:grid-cols-2">
            {(
              [
                ["supervised", "Supervised", "A person approves every email before it goes out. The agent still plans, reads, matches, flags and drafts on its own."],
                ["autopilot", "Autopilot", `Routine emails go out on their own after passing every check; sensitive ones wait ${policy.delayMinutes} minutes so anyone can cancel, and a few always need a person.`],
              ] as const
            ).map(([value, label, text]) => (
              <label key={value} className={cx("flex cursor-pointer gap-3 rounded-xl border p-4", policy.mode === value ? "border-accent bg-accent/5" : "border-line", !isOwner && "cursor-not-allowed opacity-75")}>
                <input type="radio" name="mode" value={value} defaultChecked={policy.mode === value} disabled={!isOwner} className="mt-1 accent-[var(--accent)]" />
                <span>
                  <span className="font-medium text-ink">{label}</span>
                  <span className="mt-1 block text-sm text-muted">{text}</span>
                </span>
              </label>
            ))}
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              {isOwner ? <SubmitButton pendingText="Saving…">Save</SubmitButton> : <span className="text-sm text-muted">Only the owner can change this.</span>}
              <span className="text-xs text-muted">Takes effect from the next run. Under either policy a draft that fails the numbers check is never sent.</span>
            </div>
          </form>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-muted hover:text-ink">What autopilot does with each email</summary>
            <Table dense head={["Email", "Under autopilot"]}>
              {(Object.keys(TEMPLATE_NAMES) as TemplateKey[]).map((t) => {
                const mode = policy.overrides?.[t] ?? AUTOPILOT_DEFAULTS[t];
                return (
                  <tr key={t}>
                    <td>{TEMPLATE_NAMES[t]}</td>
                    <td>
                      <Badge tone={mode === "auto" ? "green" : mode === "delay" ? "blue" : "amber"}>{mode === "delay" ? `waits ${policy.delayMinutes} min, then sends` : SEND_TEXT[mode]}</Badge>
                    </td>
                  </tr>
                );
              })}
            </Table>
            <p className="mt-2 text-xs text-muted">Whatever the template, a person approves when the recipient isn&apos;t a contact on file or the client has an open dispute.</p>
          </details>
        </Card>

        <Card title="Signature and identity">
          <KeyValues
            rows={[
              ["Emails come from", s.mailboxAddress ?? "—"],
              ["Signed by", [s.senderName, s.senderTitle].filter(Boolean).join(", ") || "—"],
              ["Formal reminders from", [s.directorName, s.directorTitle].filter(Boolean).join(", ") || "—"],
              ["Legal name", ws.legalName ?? ws.name],
              ["NTN", ws.ntn ?? "—"],
              ["PSEB", ws.psebRegNo ? `${ws.psebRegNo}, valid until ${day(ws.psebValidUntil)}` : "not registered"],
              ["Active taxpayer list", `${ws.atlStatus}${ws.atlCheckedOn ? `, checked ${day(ws.atlCheckedOn)}` : ""}`],
            ]}
          />
        </Card>

        <Card title="Where money arrives" pad={false}>
          <ul className="divide-y divide-line text-sm">
            {accounts.map((a) => (
              <li key={a.id} className="px-4 py-2.5">
                <div className="flex justify-between gap-2">
                  <span className="font-medium text-ink">{a.label}</span>
                  <span className="text-xs text-muted">{a.currency}</span>
                </div>
                <div className="text-xs text-muted">{a.iban ? <code>{a.iban}</code> : (a.platformName ?? a.kind)}</div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="People">
          <ul className="space-y-1.5 text-sm">
            {members.map((m, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="text-ink">{m.anon ? "Visitor (demo)" : `${m.name} · ${m.email}`}</span>
                <span className="text-xs text-muted">{ROLE_LABEL[m.role]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Owners and finance approve and act; accountants and viewers can see everything but change nothing.</p>
        </Card>

        <Card title="Reading documents">
          {reader.mode === "vultr" ? (
            <>
              <p className="text-sm text-ink">
                {ws.aiReadingEnabled ? (
                  <>
                    Vultr Serverless Inference, model <code>{reader.model}</code>. Every call is logged with tokens, cost and time on the run timeline; every extracted value is checked against the document text before it is used. If the model can&apos;t be
                    reached, the run falls back to the built-in layout rules.
                  </>
                ) : (
                  "Built-in layout rules only: AI reading is switched off for this workspace."
                )}
              </p>
              {isOwner ? (
                <form action={setAiReading.bind(null, slug)} className="mt-3 flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="enabled" defaultChecked={ws.aiReadingEnabled} className="accent-[var(--accent)]" />
                    Read documents with Vultr Serverless Inference
                  </label>
                  <SubmitButton variant="secondary" pendingText="Saving…">
                    Save
                  </SubmitButton>
                </form>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-ink">Built-in layout rules (no Vultr Serverless Inference key in this environment). They read the demo&apos;s simulated documents; with a key, the same fields come from the model.</p>
          )}
          <p className="mt-2 text-xs text-muted">Models never write numbers into emails. CSV exports are always parsed by code.</p>
        </Card>

        <Card title="Running on Vultr" className="xl:col-span-2">
          {platform?.credit ? (
            <Notice tone={platform.credit.low ? "amber" : "green"}>
              Vultr credit: {describeCredit(platform.credit)}. Pending charges this month: USD {platform.credit.pendingChargesUsd.toFixed(2)}.
            </Notice>
          ) : null}
          {platform ? (
            <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Part title="App server (VM)" lines={platform.vm ? [`${platform.vm.label ?? ""} ${platform.vm.status ?? ""}`, `power ${platform.vm.power ?? "?"}, ${platform.vm.health ?? ""}`, `backups: ${platform.vm.backupSchedule ?? "?"}`, platform.vm.latestBackup ? `latest ${platform.vm.latestBackup}` : "no backup yet"] : ["not configured"]} />
              <Part title="Managed PostgreSQL" lines={platform.database ? [`${platform.database.label ?? ""} ${platform.database.status ?? ""}`, platform.database.plan ?? "", platform.database.latestBackup ? `latest backup ${platform.database.latestBackup}` : "no backup yet"] : ["not configured"]} />
              <Part title="Object Storage" lines={platform.objectStorage ? [`${platform.objectStorage.label ?? ""} ${platform.objectStorage.status ?? ""}`, platform.objectStorage.hostname ?? ""] : ["not configured"]} />
              <Part
                title="Serverless Inference"
                lines={platform.inference ? [...platform.inference.models.map((m) => `${m.model}: ${m.inputTokens + m.outputTokens} tokens`), `this month ≈ USD ${platform.inference.totalCostUsd.toFixed(4)}`] : ["not configured"]}
              />
              {platform.errors.length ? <p className="text-xs text-rose-600 sm:col-span-2 lg:col-span-4">{platform.errors.join(" · ")}</p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted">{platformError ? `Couldn't reach the Vultr API: ${platformError}` : "Live status needs a Vultr API key in this environment. Deployed, this shows the VM, Managed PostgreSQL, Object Storage and Serverless Inference usage read through the Vultr API."}</p>
          )}
        </Card>
      </div>
    </>
  );
}

function Part({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-lg bg-canvas p-3">
      <div className="font-medium text-ink">{title}</div>
      {lines.filter(Boolean).map((l, i) => (
        <div key={i} className="text-xs text-muted">
          {l}
        </div>
      ))}
    </div>
  );
}
