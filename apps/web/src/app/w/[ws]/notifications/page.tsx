import { getDb } from "@ebo/db";
import { DIGEST_HOUR, DIGEST_LABELS, digestSettings, listNotifications, workspaceToday, type NotificationLine } from "@ebo/engine";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Empty, Notice, PageHeader } from "@/components/ui";
import { clock } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { markAllReadAction, sendDigestNowAction, setDigestAction } from "./actions";

export const metadata = { title: "Notifications" };

const KIND_LABEL: Record<NotificationLine["kind"], string> = { approval: "Approval", task: "Task", flag: "Flag", review: "Document", payment: "Payment" };
const FREQUENCIES = ["daily", "weekly", "off"] as const;

export default async function NotificationsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws: slug } = await params;
  const q = await searchParams;
  const { user, ws, role } = await requireWorkspace(slug);
  const db = getDb();
  const [lines, digest] = await Promise.all([listNotifications(db, ws, user.id, role), digestSettings(db, ws, user.id, role, workspaceToday(ws))]);
  const unread = lines.filter((l) => l.unread);
  const earlier = lines.filter((l) => !l.unread);
  const row = (n: NotificationLine) => (
    <li key={n.id} className="border-t border-line first:border-t-0">
      {/* A plain link: following it marks the notification read, so it mustn't be prefetched. */}
      <a href={`/w/${slug}/notifications/${n.id}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-canvas">
        <Badge tone={n.severity === "high" ? "red" : n.kind === "approval" ? "amber" : "gray"}>{KIND_LABEL[n.kind]}</Badge>
        <span className={n.unread ? "min-w-0 flex-1 font-medium" : "min-w-0 flex-1 text-muted"}>{n.title}</span>
        {n.open ? null : <Badge tone="green">dealt with</Badge>}
        <span className="w-full text-xs text-muted sm:w-auto">
          {n.detail ? `${n.detail} · ` : ""}
          {clock(new Date(n.at), ws.timezone)}
        </span>
      </a>
    </li>
  );

  return (
    <>
      <PageHeader title="Notifications" sub="What needs you: approvals, tasks, high-risk flags, documents to check and payments to place. Today is where you act on them." />
      {q.saved ? <Notice>Saved.</Notice> : null}
      {q.sent ? <Notice>Sent to {user.email}.</Notice> : null}

      <Card
        title={`New (${unread.length})`}
        pad={false}
        className="mb-6"
        actions={
          unread.length ? (
            <form action={markAllReadAction.bind(null, slug)}>
              <SubmitButton variant="secondary" pendingText="Marking…">
                Mark all read
              </SubmitButton>
            </form>
          ) : null
        }
      >
        {unread.length ? (
          <ul>{unread.map(row)}</ul>
        ) : (
          <div className="p-4">
            <Empty>
              Nothing new. <Link href={`/w/${slug}/inbox`} className="link">Open the inbox</Link> to see everything in progress.
            </Empty>
          </div>
        )}
      </Card>

      {earlier.length ? (
        <Card title="Earlier" pad={false} className="mb-6">
          <ul>{earlier.map(row)}</ul>
        </Card>
      ) : null}

      <Card title="Email digest" id="digest">
        <form action={setDigestAction.bind(null, slug)} className="space-y-3">
          <fieldset className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <legend className="sr-only">How often</legend>
            {FREQUENCIES.map((f) => (
              <label key={f} className="flex items-center gap-2">
                <input type="radio" name="digest" value={f} defaultChecked={digest.digest === f} />
                {DIGEST_LABELS[f]}
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted">
            Sent to {user.isAnonymous ? "your address" : user.email} from {DIGEST_HOUR}:00 {ws.timezone === "Asia/Karachi" ? "PKT" : ws.timezone}, only when something needs you. It lists only what your role can act on.
          </p>
          <SubmitButton variant="secondary" pendingText="Saving…">
            Save
          </SubmitButton>
        </form>

        <div className="mt-5 border-t border-line pt-4">
          {digest.canSend ? (
            digest.lastSentAt ? (
              <p className="mb-3 text-sm text-muted">Last sent {clock(digest.lastSentAt, ws.timezone)}.</p>
            ) : null
          ) : ws.isDemo ? (
            <p className="mb-3 text-sm text-muted">Demo workspaces don't send email. This is what today's digest would say.</p>
          ) : (
            <p className="mb-3 text-sm text-muted">
              Digests are sent from the workspace's own mailbox, and none is connected yet.{" "}
              {role === "owner" ? (
                <Link href={`/w/${slug}/settings`} className="link">
                  Connect it in Settings
                </Link>
              ) : (
                "An owner can connect it in Settings."
              )}
            </p>
          )}
          {digest.preview ? (
            <>
              <p className="mb-2 text-sm font-medium">{digest.preview.subject}</p>
              <pre className="mb-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-xs">{digest.preview.body}</pre>
              {digest.canSend ? <ActionForm action={sendDigestNowAction.bind(null, slug)} label="Send me this now" pendingText="Sending…" variant="secondary" /> : null}
            </>
          ) : (
            <p className="text-sm text-muted">Nothing needs you right now, so today's digest wouldn't go out.</p>
          )}
        </div>
      </Card>
    </>
  );
}
