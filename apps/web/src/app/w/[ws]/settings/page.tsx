import { AUTOPILOT_DEFAULTS, TEMPLATE_NAMES, type TemplateKey } from "@ebo/core";
import { getDb, invitation, member, receivingAccount, user } from "@ebo/db";
import { ROLE_TEXT, ROLES } from "@ebo/engine";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, KeyValues, Notice, PageHeader, Table, cx } from "@/components/ui";
import { day, ROLE_LABEL } from "@/lib/format";
import { describeCredit } from "@ebo/vultr";
import { isOperator, readerInfo, vultrStatus } from "@/lib/platform";
import { requireWorkspace } from "@/lib/session";
import { setAiReading, setPolicy } from "../actions";
import { inviteAction, revokeInviteAction, setRoleAction, setTwoFactorRequired } from "../manage-actions";
import { InviteForm } from "./invite-form";

export const metadata = { title: "Settings" };

const SEND_TEXT = { auto: "sends on its own", delay: "waits, then sends", approve: "always a person" } as const;

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ people?: string; twofactor?: string }> }) {
  const { ws: slug } = await params;
  const q = await searchParams;
  const { ws, role, user: me } = await requireWorkspace(slug);
  const db = getDb();
  const [accounts, members, invites] = await Promise.all([
    db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, ws.id)).orderBy(asc(receivingAccount.label)),
    db.select({ id: member.id, userId: member.userId, name: user.name, email: user.email, anon: user.isAnonymous, twoFactor: user.twoFactorEnabled, role: member.role }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.workspaceId, ws.id)).orderBy(asc(user.name)),
    db
      .select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt })
      .from(invitation)
      .where(and(eq(invitation.workspaceId, ws.id), isNull(invitation.acceptedAt), gt(invitation.expiresAt, new Date())))
      .orderBy(asc(invitation.email)),
  ]);
  const reader = readerInfo();
  let platform: Awaited<ReturnType<typeof vultrStatus>> = null;
  let platformError: string | null = null;
  try {
    platform = await vultrStatus();
  } catch (err) {
    platformError = err instanceof Error ? err.message : String(err);
  }
  // The hosting bill belongs to whoever runs the deployment, not to the businesses using it.
  const operator = isOperator(me as { email?: string | null; isAnonymous?: boolean | null });
  const policy = ws.approvalPolicy;
  const isOwner = role === "owner";
  const managePeople = isOwner && !ws.isDemo;
  const s = ws.settings ?? {};
  const approvers = members.filter((m) => m.role === "owner" || m.role === "finance");

  return (
    <>
      <PageHeader
        title="Settings"
        sub="How this workspace sends, who signs, where money arrives, and what it runs on."
        actions={
          isOwner ? (
            <Link href={`/w/${slug}/settings/data`} className="btn btn-secondary">
              Export or delete
            </Link>
          ) : undefined
        }
      />
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

        <Card title={<span id="people">People</span>} className={managePeople ? "xl:col-span-2" : undefined}>
          {q.people ? <Notice tone="red">{q.people.slice(0, 200)}</Notice> : null}
          <ul className="divide-y divide-line text-sm">
            {members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 text-ink">
                  {m.anon ? "Visitor (demo)" : `${m.name} · ${m.email}`}
                  {m.userId === me.id ? <span className="ml-1 text-xs text-muted">(you)</span> : null}
                </span>
                {managePeople ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <form action={setRoleAction.bind(null, slug, m.id, false)} className="flex items-center gap-2">
                      <select name="role" defaultValue={m.role} aria-label={`Role for ${m.name}`} className="input py-1 text-xs">
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                      <SubmitButton variant="secondary" pendingText="Saving…">
                        Change
                      </SubmitButton>
                    </form>
                    <form action={setRoleAction.bind(null, slug, m.id, true)}>
                      <SubmitButton variant="secondary" pendingText="Removing…">
                        {m.userId === me.id ? "Leave" : "Remove"}
                      </SubmitButton>
                    </form>
                  </span>
                ) : (
                  <span className="text-xs text-muted">{ROLE_LABEL[m.role]}</span>
                )}
              </li>
            ))}
          </ul>
          {invites.length ? (
            <div className="mt-3 border-t border-line pt-3">
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Invited, not joined yet</h3>
              <ul className="space-y-1 text-sm">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {i.email} <span className="text-xs text-muted">as {ROLE_LABEL[i.role]}, until {day(i.expiresAt.toISOString().slice(0, 10))}</span>
                    </span>
                    {managePeople ? (
                      <form action={revokeInviteAction.bind(null, slug, i.id)}>
                        <SubmitButton variant="secondary" pendingText="Revoking…">
                          Revoke
                        </SubmitButton>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {managePeople ? (
            <div className="mt-4 border-t border-line pt-4">
              <h3 className="mb-2 text-sm font-medium text-ink">Invite someone</h3>
              <InviteForm action={inviteAction.bind(null, slug)} roles={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r]!, text: ROLE_TEXT[r] }))} />
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted">
              Owners and finance approve and act; accountants and viewers can see everything but change nothing.{ws.isDemo ? " People can't be changed in a demo workspace." : isOwner ? "" : " Only an owner can invite people or change roles."}
            </p>
          )}
        </Card>

        <Card id="two-factor" title="Two-factor sign-in">
          {q.twofactor ? <Notice tone="red">{q.twofactor.slice(0, 200)}</Notice> : null}
          <p className="text-sm">Owners and finance approve the emails that go to clients and banks. When this workspace requires two-factor sign-in, a stolen password alone can&apos;t do that: signing in also takes a code from the person&apos;s phone.</p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {approvers.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate text-ink">
                  {m.anon ? "Visitor (demo)" : m.name} <span className="text-xs text-muted">{ROLE_LABEL[m.role]}</span>
                </span>
                <Badge tone={m.twoFactor ? "green" : "gray"}>{m.twoFactor ? "On" : "Off"}</Badge>
              </li>
            ))}
          </ul>
          {isOwner && !ws.isDemo ? (
            <form action={setTwoFactorRequired.bind(null, slug)} className="mt-3 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="required" defaultChecked={!!s.requireTwoFactor} className="accent-[var(--accent)]" />
                Require it for owners and finance
              </label>
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save
              </SubmitButton>
            </form>
          ) : (
            <p className="mt-3 text-sm text-muted">{ws.isDemo ? "Demo workspaces can't require it: visitors sign in without a password." : s.requireTwoFactor ? "Required for owners and finance." : "Not required."}</p>
          )}
          {s.requireTwoFactor && approvers.some((m) => !m.twoFactor) ? <p className="mt-2 text-xs text-muted">Anyone marked Off is asked to set it up the next time they open this workspace.</p> : null}
          <p className="mt-2 text-xs">
            <Link href="/account#two-factor" className="link">
              Your own two-factor sign-in
            </Link>
          </p>
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

        <Card title={operator ? "Running on Vultr" : "Where your data lives"} className="xl:col-span-2">
          <p className="mb-3 text-sm text-ink">
            Aerion runs on Vultr in Singapore: the app server, a managed PostgreSQL database with automatic backups, and private object storage for your documents. When an owner turns on AI reading, documents are read by Vultr Serverless Inference in Vultr&apos;s US data centres. Aerion never holds or moves money.
          </p>
          {operator && platform?.credit ? (
            <Notice tone={platform.credit.low ? "amber" : "green"}>
              Vultr credit: {describeCredit(platform.credit)}. Pending charges this month: USD {platform.credit.pendingChargesUsd.toFixed(2)}.
            </Notice>
          ) : null}
          {platform ? (
            <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Part title="App server" lines={platform.vm ? [`${platform.vm.status === "active" ? "Running" : (platform.vm.status ?? "")}${platform.vm.health ? `, ${platform.vm.health}` : ""}`, platform.vm.latestBackup ? `Latest backup ${platform.vm.latestBackup}` : "No backup yet", ...(operator ? [`${platform.vm.label ?? ""} · power ${platform.vm.power ?? "?"} · backups ${platform.vm.backupSchedule ?? "?"}`] : [])] : ["Not set up in this environment"]} />
              <Part title="Database (PostgreSQL)" lines={platform.database ? [`${platform.database.status === "Running" ? "Running" : (platform.database.status ?? "")}`, platform.database.latestBackup ? `Latest backup ${platform.database.latestBackup}` : "No backup yet", ...(operator ? [`${platform.database.label ?? ""} · ${platform.database.plan ?? ""}`] : [])] : ["Not set up in this environment"]} />
              <Part title="Document storage" lines={platform.objectStorage ? [platform.objectStorage.status === "active" ? "Running" : (platform.objectStorage.status ?? ""), "Private: files are only served to members", ...(operator ? [`${platform.objectStorage.label ?? ""} · ${platform.objectStorage.hostname ?? ""}`] : [])] : ["Not set up in this environment"]} />
              <Part
                title="AI reading (Serverless Inference)"
                lines={
                  platform.inference
                    ? operator
                      ? [...platform.inference.models.map((m) => `${m.model}: ${m.inputTokens + m.outputTokens} tokens`), `this month ≈ USD ${platform.inference.totalCostUsd.toFixed(4)}`]
                      : [reader.mode === "vultr" ? `Available (${reader.model})` : "Not available", "Used only where an owner switches it on"]
                    : ["Not set up in this environment"]
                }
              />
              {operator && platform.errors.length ? (
                <p className="text-xs text-muted sm:col-span-2 lg:col-span-4" title={platform.errors.join(" · ")}>
                  Some live figures couldn&apos;t be read from the Vultr API just now ({platform.errors.map((e) => e.split(":")[0]).join(", ")}). The app itself is unaffected; they&apos;ll show on the next visit once the API answers.
                </p>
              ) : null}
            </div>
          ) : operator ? (
            <p className="text-sm text-muted">{platformError ? `Couldn't reach the Vultr API: ${platformError}` : "Live status needs a Vultr API key in this environment. Deployed, this shows the VM, Managed PostgreSQL, Object Storage and Serverless Inference usage read through the Vultr API."}</p>
          ) : null}
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
