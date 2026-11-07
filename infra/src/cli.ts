import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { creditStatus, createVultrClient, describeCredit, platformStatus, vultrResources } from "@ebo/vultr";
import { loadEnv, names, readConfig } from "./config";
import { apply, plan, wantedFirewallRules } from "./provision";
import { readState } from "./state";

// Node gives each address 250 ms to connect, and from Pakistan Vultr's API often takes longer.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const usage = `Usage: pnpm infra:<plan|apply|status> [-- --yes]

  plan    Read-only. Shows what exists, what would be created and the monthly cost.
  apply   Creates the missing resources. Needs --yes. Costs money once it runs.
  status  Health, backups, model usage and pending charges of what's running.

Settings come from the repo's .env (see .env.example): VULTR_API_KEY, VULTR_REGION,
ADMIN_CIDR, VM_PLAN, DB_PLAN, PG_VERSION, DOMAIN, SSH_PUBLIC_KEY_PATH.`;

async function main() {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  const cfg = readConfig();
  const n = names(cfg);

  if (!command || !["plan", "apply", "status"].includes(command)) {
    console.log(usage);
    process.exit(command ? 1 : 0);
  }

  if (!cfg.apiKey) {
    console.log("VULTR_API_KEY is not set, so nothing can be checked against your account.");
    console.log("This is what `apply` would create:\n");
    console.log(`  SSH key           ${n.sshKey} (${cfg.sshPublicKey ? cfg.sshPublicKeyPath : "no key found"})`);
    console.log(`  VPC               ${n.vpc} ${cfg.vpcSubnet}/${cfg.vpcSubnetMask} in ${cfg.region}`);
    console.log(`  Firewall group    ${n.firewall}:`);
    for (const rule of wantedFirewallRules(cfg)) console.log(`                      ${rule.ip_type} tcp ${rule.port} from ${rule.subnet}/${rule.subnet_size}  (${rule.notes})`);
    console.log(`  VM                ${n.instance} ${cfg.vmPlan} with the Coolify marketplace app, daily backups`);
    console.log(`  PostgreSQL        ${n.database} managed PostgreSQL ${cfg.pgVersion} on the VPC, daily backups`);
    console.log(`  Object Storage    ${n.objectStorage} with a documents bucket and a backups bucket`);
    console.log(`  Inference         ${n.inference} Serverless Inference subscription`);
    console.log("\nAdd VULTR_API_KEY to .env to check prices and availability.");
    return;
  }

  const r = vultrResources(createVultrClient(cfg.apiKey));

  if (command === "status") {
    const s = readState();
    const st = await platformStatus(r, {
      instanceId: s.instanceId,
      databaseId: s.databaseId,
      objectStorageId: s.objectStorageId,
      inferenceId: s.inferenceId,
    });
    if (st.credit) console.log(`Vultr credit: ${describeCredit(st.credit)}\n`);
    console.log(JSON.stringify(st, null, 2));
    return;
  }

  const p = await plan(r, cfg);
  console.log(`Region ${cfg.region} · label prefix "${cfg.label}"\n`);
  for (const i of p.items) {
    const cost = i.monthlyUsd !== undefined ? `  ~$${i.monthlyUsd.toFixed(2)}/mo` : "";
    console.log(`  ${i.action.padEnd(7)} ${i.resource.padEnd(20)} ${i.name.padEnd(18)} ${i.detail}${cost}`);
  }
  console.log(`\n  New monthly cost (excluding inference usage and bandwidth): ~$${p.monthlyUsd.toFixed(2)}`);
  for (const w of p.warnings) console.log(`  ! ${w}`);

  // Running out of credit would take the demo down during judging, so show it before creating anything.
  const credit = await r
    .account()
    .then(async (a) => creditStatus(a ?? {}, (await r.pendingCharges().catch(() => [])) as unknown as Array<Record<string, unknown>>))
    .catch((err: Error) => {
      console.log(`  ! Couldn't read the account balance: ${err.message}`);
      return null;
    });
  if (credit) {
    console.log(`  Vultr credit: ${describeCredit(credit)}`);
    const perDay = credit.spendPerDayUsd + p.monthlyUsd / 30;
    if (p.monthlyUsd > 0 && perDay > 0) {
      console.log(`  With these resources added: about USD ${perDay.toFixed(2)} a day, so the credit lasts about ${Math.floor(credit.remainingUsd / perDay)} days.`);
    }
  }

  if (command === "plan") return;
  if (!rest.includes("--yes")) {
    console.log("\nNothing created. Re-run with `pnpm infra:apply -- --yes` to create the resources above.");
    return;
  }
  await apply(r, cfg, p);
  console.log("\nDone. Next: open Coolify on port 8000 from your admin IP, connect the GitHub repo, paste .env.vultr into its environment variables.");
}

main().catch((err) => {
  // A failed fetch only says "fetch failed"; the reason is in its cause.
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${(err.cause as NodeJS.ErrnoException).code ?? err.cause.message})` : "";
  console.error(`${err instanceof Error ? err.message : err}${cause}`);
  process.exit(1);
});
