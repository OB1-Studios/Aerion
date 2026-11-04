import type { VultrResources } from "./resources";

export interface PlatformIds {
  instanceId?: string | undefined;
  databaseId?: string | undefined;
  objectStorageId?: string | undefined;
  inferenceId?: string | undefined;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from Vultr's per-1M-token prices returned with the usage. */
  costUsd: number;
}

/** Below this much credit, or this many days of it, the team should top up or slow down. */
export const LOW_CREDIT_USD = 25;
export const LOW_CREDIT_DAYS = 14;

export interface CreditStatus {
  /** Vultr's account balance: negative while there is credit (-100 means USD 100 of credit). */
  balanceUsd: number;
  /** Charged so far this month and not yet billed against the balance. */
  pendingChargesUsd: number;
  /** Credit left once this month's charges so far are billed (never below 0). */
  remainingUsd: number;
  /** This month's spending per day, counted from when the first charge this month started. */
  spendPerDayUsd: number;
  /** How long the credit lasts at that rate; null while nothing is being charged. */
  daysLeft: number | null;
  /** Under LOW_CREDIT_USD left, or running out within LOW_CREDIT_DAYS. */
  low: boolean;
}

/**
 * The credit left on the Vultr account and how long it lasts at this month's rate.
 * `charges` are the pending-charge line items; their start dates say when spending began,
 * so resources created mid-month aren't averaged over days when nothing ran.
 */
export function creditStatus(
  account: { balance?: number | undefined; pending_charges?: number | undefined },
  charges: ReadonlyArray<Record<string, unknown>> = [],
  now: Date = new Date(),
): CreditStatus {
  const balanceUsd = Number(account.balance ?? 0);
  const pendingChargesUsd = Number(account.pending_charges ?? 0);
  const remainingUsd = Math.max(0, -balanceUsd - pendingChargesUsd);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const starts = charges
    .map((c) => (typeof c.start_date === "string" ? Date.parse(c.start_date) : NaN))
    .filter((t) => Number.isFinite(t) && t <= now.getTime())
    .map((t) => Math.max(t, monthStart));
  const since = starts.length ? Math.min(...starts) : monthStart;
  const days = Math.max((now.getTime() - since) / 86_400_000, 1);
  const spendPerDayUsd = pendingChargesUsd / days;
  const daysLeft = spendPerDayUsd > 0 ? remainingUsd / spendPerDayUsd : null;
  return {
    balanceUsd,
    pendingChargesUsd,
    remainingUsd,
    spendPerDayUsd,
    daysLeft,
    low: remainingUsd < LOW_CREDIT_USD || (daysLeft !== null && daysLeft < LOW_CREDIT_DAYS),
  };
}

/** One line for people: "USD 140.20 credit left, about 31 days at USD 4.50 a day". */
export function describeCredit(c: CreditStatus): string {
  const left = `USD ${c.remainingUsd.toFixed(2)} credit left`;
  const pace = c.daysLeft === null ? "nothing charged yet this month" : `about ${Math.floor(c.daysLeft)} days at USD ${c.spendPerDayUsd.toFixed(2)} a day`;
  return `${left}, ${pace}${c.low ? " (LOW: top up or scale down)" : ""}`;
}

export interface PlatformStatus {
  checkedAt: string;
  vm?: { label?: string; ip?: string; status?: string; power?: string; health?: string; latestBackup?: string; backupSchedule?: string };
  database?: { label?: string; status?: string; plan?: string; latestBackup?: string };
  objectStorage?: { label?: string; status?: string; hostname?: string };
  inference?: { models: ModelUsage[]; totalCostUsd: number };
  pendingChargesUsd?: number;
  credit?: CreditStatus;
  errors: string[];
}

/**
 * One read-only snapshot of the Vultr resources running the product: VM health and
 * backups, database status and latest backup, Object Storage, model usage and cost.
 * Shown in the app's platform page and printed by `pnpm infra:status`.
 * Each part fails independently, so one missing permission doesn't hide the rest.
 */
export async function platformStatus(r: VultrResources, ids: PlatformIds): Promise<PlatformStatus> {
  const status: PlatformStatus = { checkedAt: new Date().toISOString(), errors: [] };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      status.errors.push(`${what}: ${(err as Error).message}`);
    }
  };

  await Promise.all([
    ids.instanceId &&
      attempt("vm", async () => {
        const [vm, backups, schedule] = await Promise.all([
          r.instance(ids.instanceId!),
          r.backups(ids.instanceId!),
          r.instanceBackupSchedule(ids.instanceId!),
        ]);
        const latest = [...backups].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)))[0];
        status.vm = {
          label: vm?.label,
          ip: vm?.main_ip,
          status: vm?.status,
          power: vm?.power_status,
          health: vm?.server_status,
          latestBackup: latest?.date_created,
          backupSchedule: schedule?.enabled ? `${schedule.type} at ${schedule.hour}:00 UTC` : "off",
        };
      }),
    ids.databaseId &&
      attempt("database", async () => {
        const [db, backups] = await Promise.all([r.database(ids.databaseId!), r.databaseBackups(ids.databaseId!)]);
        const lb = backups.latest_backup;
        status.database = {
          label: db?.label,
          status: db?.status,
          plan: db?.plan,
          latestBackup: lb?.date ? `${lb.date} ${lb.time ?? ""}`.trim() : undefined,
        };
      }),
    ids.objectStorageId &&
      attempt("object storage", async () => {
        const s = await r.objectStorage(ids.objectStorageId!);
        status.objectStorage = { label: s?.label, status: s?.status, hostname: s?.s3_hostname };
      }),
    ids.inferenceId &&
      attempt("inference", async () => {
        const usage = await r.inferenceUsage(ids.inferenceId!);
        const models: ModelUsage[] = (usage?.chat_by_model?.current_month ?? []).map((m) => {
          const inputTokens = m.input_tokens ?? 0;
          const outputTokens = m.tokens ?? 0;
          const costUsd = (inputTokens * (m.input_price ?? 0) + outputTokens * (m.output_price ?? 0)) / 1_000_000;
          return { model: m.model ?? "unknown", inputTokens, outputTokens, costUsd };
        });
        status.inference = { models, totalCostUsd: models.reduce((s, m) => s + m.costUsd, 0) };
      }),
    attempt("billing", async () => {
      // The line items only refine the spending rate, so a failure there isn't fatal.
      const [account, charges] = await Promise.all([r.account(), r.pendingCharges().catch(() => [])]);
      status.credit = creditStatus(account ?? {}, charges as unknown as Array<Record<string, unknown>>);
      status.pendingChargesUsd = status.credit.pendingChargesUsd;
    }),
  ]);
  return status;
}
