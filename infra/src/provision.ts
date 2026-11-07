import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { ensureBucket } from "@ebo/db";
import type { VultrResources } from "@ebo/vultr";
import { REPO_ROOT, names, splitCidr, type InfraConfig } from "./config";
import { readState, writeState, type InfraState } from "./state";

export interface FirewallRuleSpec {
  ip_type: "v4" | "v6";
  protocol: "tcp";
  port: string;
  subnet: string;
  subnet_size: number;
  notes: string;
}

/** Only 80 and 443 are public. SSH and Coolify's dashboard ports are open to the admin CIDR only. */
export function wantedFirewallRules(cfg: InfraConfig): FirewallRuleSpec[] {
  const rules: FirewallRuleSpec[] = [];
  for (const port of ["80", "443"]) {
    rules.push({ ip_type: "v4", protocol: "tcp", port, subnet: "0.0.0.0", subnet_size: 0, notes: `public ${port}` });
    rules.push({ ip_type: "v6", protocol: "tcp", port, subnet: "::", subnet_size: 0, notes: `public ${port}` });
  }
  if (cfg.adminCidr) {
    const { subnet, size } = splitCidr(cfg.adminCidr);
    const adminPorts: Array<[string, string]> = [
      ["22", "ssh"],
      ["8000", "coolify dashboard"],
      ["6001:6002", "coolify realtime and terminal"],
    ];
    for (const [port, what] of adminPorts) {
      rules.push({ ip_type: "v4", protocol: "tcp", port, subnet, subnet_size: size, notes: `admin ${what}` });
    }
  }
  return rules;
}

const ruleKey = (r: { ip_type?: string; protocol?: string; port?: string; subnet?: string; subnet_size?: number }) =>
  `${r.ip_type}|${(r.protocol ?? "").toLowerCase()}|${r.port}|${r.subnet}/${r.subnet_size}`;

export interface PlanItem {
  resource: string;
  name: string;
  action: "exists" | "create" | "update" | "skip";
  detail: string;
  monthlyUsd?: number;
}

export interface Plan {
  items: PlanItem[];
  warnings: string[];
  monthlyUsd: number;
  context: {
    coolifyImageId?: string;
    dbPlanId?: string;
    objectStorageClusterId?: number;
    objectStorageTierId?: number;
  };
}

/** Reads the account and works out what `apply` would create. Makes no changes. */
export async function plan(r: VultrResources, cfg: InfraConfig): Promise<Plan> {
  const n = names(cfg);
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const context: Plan["context"] = {};

  const [regions, vmPlans, apps, sshKeys, vpcs, firewalls, instances, databases, stores, clusters, inference, domains] =
    await Promise.all([
      r.regions(),
      r.plans("vc2"),
      r.marketplaceApps(),
      r.sshKeys(),
      r.vpcs(),
      r.firewallGroups(),
      r.instances({ label: n.instance }),
      r.databases({ label: n.database }),
      r.objectStorages(),
      r.objectStorageClusters(),
      r.inferenceSubscriptions(),
      cfg.domain ? r.domains() : Promise.resolve([]),
    ]);

  if (!regions.some((x) => x.id === cfg.region)) {
    warnings.push(`Region "${cfg.region}" not found. Available: ${regions.map((x) => x.id).join(", ")}`);
  }
  if (!cfg.adminCidr) {
    warnings.push("ADMIN_CIDR is not set: SSH and the Coolify dashboard would be unreachable. Set it to your IP, e.g. 203.0.113.7/32.");
  }

  // SSH key
  const key = sshKeys.find((k) => k.name === n.sshKey);
  if (key) items.push({ resource: "SSH key", name: n.sshKey, action: "exists", detail: key.id ?? "" });
  else if (cfg.sshPublicKey) items.push({ resource: "SSH key", name: n.sshKey, action: "create", detail: cfg.sshPublicKeyPath });
  else {
    items.push({ resource: "SSH key", name: n.sshKey, action: "skip", detail: `no public key at ${cfg.sshPublicKeyPath}` });
    warnings.push("No SSH public key found; the VM would only be reachable with the root password Vultr emails.");
  }

  // VPC
  const vpc = vpcs.find((v) => v.description === n.vpc && v.region === cfg.region);
  items.push(
    vpc
      ? { resource: "VPC", name: n.vpc, action: "exists", detail: `${vpc.v4_subnet}/${vpc.v4_subnet_mask}` }
      : { resource: "VPC", name: n.vpc, action: "create", detail: `${cfg.vpcSubnet}/${cfg.vpcSubnetMask} in ${cfg.region}` },
  );

  // Firewall group and rules
  const fw = firewalls.find((f) => f.description === n.firewall);
  const wantRules = wantedFirewallRules(cfg);
  if (fw?.id) {
    const have = new Set((await r.firewallRules(fw.id)).map(ruleKey));
    const missing = wantRules.filter((w) => !have.has(ruleKey(w)));
    items.push({
      resource: "Firewall group",
      name: n.firewall,
      action: missing.length ? "update" : "exists",
      detail: missing.length ? `add ${missing.length} rule(s): ${missing.map((m) => m.notes).join(", ")}` : `${have.size} rules`,
    });
  } else {
    items.push({
      resource: "Firewall group",
      name: n.firewall,
      action: "create",
      detail: wantRules.map((w) => `${w.ip_type} ${w.port} ${w.subnet}/${w.subnet_size}`).join("; "),
    });
  }

  // VM with the Coolify marketplace app
  const coolify = apps.find((a) => /coolify/i.test(`${a.name} ${a.short_name} ${a.deploy_name}`));
  if (coolify?.image_id) context.coolifyImageId = coolify.image_id;
  else warnings.push("Coolify was not found in the marketplace app list; the VM would need Coolify installed by hand.");
  const vmPlan = vmPlans.find((p) => p.id === cfg.vmPlan);
  if (!vmPlan) warnings.push(`VM plan "${cfg.vmPlan}" not found.`);
  else if (vmPlan.locations && !vmPlan.locations.includes(cfg.region)) {
    warnings.push(`VM plan "${cfg.vmPlan}" is not offered in ${cfg.region}.`);
  }
  const vm = instances[0];
  items.push(
    vm
      ? { resource: "VM (Coolify)", name: n.instance, action: "exists", detail: `${vm.main_ip} · ${vm.status}/${vm.power_status}` }
      : {
          resource: "VM (Coolify)",
          name: n.instance,
          action: "create",
          detail: `${cfg.vmPlan} in ${cfg.region}, image ${coolify?.image_id ?? "?"}, automatic backups daily ${cfg.vmBackupHourUtc}:00 UTC`,
          monthlyUsd: vmPlan?.monthly_cost,
        },
  );

  // Managed PostgreSQL
  const db = databases[0];
  if (db) {
    items.push({ resource: "Managed PostgreSQL", name: n.database, action: "exists", detail: `${db.plan} · ${db.status}` });
  } else {
    const dbPlans = await r.databasePlans(cfg.region, "pg");
    const chosen = cfg.dbPlan
      ? dbPlans.find((p) => p.id === cfg.dbPlan)
      : [...dbPlans]
          // Vultr lists a database plan's locations in capitals ("SGP"), unlike its regions everywhere else.
          .filter((p) => (p.number_of_nodes ?? 1) === 1 && (p.locations ?? [cfg.region]).some((l) => l.toLowerCase() === cfg.region))
          .sort((a, b) => (a.monthly_cost ?? Infinity) - (b.monthly_cost ?? Infinity))[0];
    if (chosen?.id) context.dbPlanId = chosen.id;
    else warnings.push(`No PostgreSQL plan found in ${cfg.region}${cfg.dbPlan ? ` matching ${cfg.dbPlan}` : ""}.`);
    items.push({
      resource: "Managed PostgreSQL",
      name: n.database,
      action: "create",
      detail: `PostgreSQL ${cfg.pgVersion}, ${chosen?.id ?? "?"} (${chosen?.vcpu_count ?? "?"} vCPU, ${chosen?.ram ?? "?"} MB, ${(chosen?.max_connections as { pg?: number } | undefined)?.pg ?? "?"} connections), on the VPC, daily backups ${cfg.dbBackupHourUtc}:00 UTC`,
      monthlyUsd: chosen?.monthly_cost,
    });
  }

  // Object Storage
  const store = stores.find((s) => s.label === n.objectStorage);
  if (store) {
    items.push({ resource: "Object Storage", name: n.objectStorage, action: "exists", detail: `${store.s3_hostname} · ${store.status}` });
  } else {
    const cluster = clusters.find((c) => c.region === cfg.region && c.deploy === "yes");
    if (!cluster?.id) {
      warnings.push(
        `No Object Storage cluster in ${cfg.region}. Regions with Object Storage: ${[...new Set(clusters.map((c) => c.region))].join(", ")}`,
      );
      items.push({ resource: "Object Storage", name: n.objectStorage, action: "skip", detail: "no cluster in region" });
    } else {
      const tiers = await r.objectStorageTiers(cluster.id);
      // The app reads its documents all the time, and the cheaper Archival tier is for data rarely read.
      const tier = tiers.find((t) => t.sales_name === "Standard") ?? tiers.find((t) => t.is_default === "yes") ?? [...tiers].sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
      context.objectStorageClusterId = cluster.id;
      if (tier?.id) context.objectStorageTierId = tier.id;
      items.push({
        resource: "Object Storage",
        name: n.objectStorage,
        action: "create",
        detail: `${cluster.hostname}, tier ${tier?.sales_name ?? tier?.slug ?? "?"}, buckets: documents and backups`,
        monthlyUsd: tier?.price,
      });
    }
  }

  // Serverless Inference
  const inf = inference.find((s) => s.label === n.inference);
  items.push(
    inf
      ? { resource: "Serverless Inference", name: n.inference, action: "exists", detail: inf.id ?? "" }
      : { resource: "Serverless Inference", name: n.inference, action: "create", detail: "subscription + API key (billed by usage)" },
  );

  // DNS
  if (cfg.domain) {
    const zone = domains.find((d) => d.domain === cfg.domain);
    items.push(
      zone
        ? { resource: "DNS record", name: `${cfg.appSubdomain}.${cfg.domain}`, action: "create", detail: "A record to the VM (if missing)" }
        : { resource: "DNS record", name: `${cfg.appSubdomain}.${cfg.domain}`, action: "skip", detail: `${cfg.domain} is not managed in Vultr DNS` },
    );
  }

  const monthlyUsd = items.filter((i) => i.action === "create").reduce((sum, i) => sum + (i.monthlyUsd ?? 0), 0);
  return { items, warnings, monthlyUsd, context };
}

/**
 * The app's own settings for Coolify. Without a domain, sslip.io gives the VM's IP a name that can
 * get a certificate. Secrets are generated once and kept on every re-run: a new APP_ENCRYPTION_KEY
 * would lock out the sealed mailbox passwords and the backups made with the old one. They never
 * come from the local .env, which holds development values.
 */
export function appSettings(cfg: InfraConfig, appIp: string, previous: NodeJS.Dict<string>, demoPassword: string | undefined) {
  return {
    BETTER_AUTH_URL: cfg.domain ? `https://${cfg.appSubdomain}.${cfg.domain}` : `https://${appIp.replaceAll(".", "-")}.sslip.io`,
    BETTER_AUTH_SECRET: previous.BETTER_AUTH_SECRET || randomBytes(32).toString("hex"),
    APP_ENCRYPTION_KEY: previous.APP_ENCRYPTION_KEY || randomBytes(32).toString("hex"),
    DEMO_PASSWORD: previous.DEMO_PASSWORD || demoPassword || randomBytes(18).toString("base64url"),
  };
}

export interface ApplyOptions {
  log?: (msg: string) => void;
  /** How long to wait for the VM and database to come up. */
  waitMs?: number;
}

/** Creates whatever `plan` found missing, then writes everything Coolify needs to .env.vultr. */
export async function apply(r: VultrResources, cfg: InfraConfig, p: Plan, opts: ApplyOptions = {}): Promise<InfraState> {
  const log = opts.log ?? console.log;
  const n = names(cfg);
  const state = readState();
  state.region = cfg.region;
  state.bucketSuffix ??= Math.random().toString(36).slice(2, 8);
  const save = () => writeState(state);
  // For what the app can run without. A refusal is reported, and .env.vultr is still written for what worked.
  const orWarn = <T>(what: string, step: () => Promise<T>): Promise<T | undefined> =>
    step().catch((err: Error) => {
      log(`! ${what} failed, and the rest carries on: ${err.message}`);
      return undefined;
    });

  // SSH key
  let sshKeyId = (await r.sshKeys()).find((k) => k.name === n.sshKey)?.id;
  if (!sshKeyId && cfg.sshPublicKey) {
    sshKeyId = (await r.createSshKey(n.sshKey, cfg.sshPublicKey))?.id;
    log(`created SSH key ${n.sshKey}`);
  }
  state.sshKeyId = sshKeyId;

  // VPC
  let vpc = (await r.vpcs()).find((v) => v.description === n.vpc && v.region === cfg.region);
  if (!vpc) {
    vpc = await r.createVpc({ region: cfg.region, description: n.vpc, v4_subnet: cfg.vpcSubnet, v4_subnet_mask: cfg.vpcSubnetMask });
    log(`created VPC ${n.vpc}`);
  }
  state.vpcId = vpc?.id;
  save();

  // Firewall
  let fw = (await r.firewallGroups()).find((f) => f.description === n.firewall);
  if (!fw) {
    fw = await r.createFirewallGroup(n.firewall);
    log(`created firewall group ${n.firewall}`);
  }
  if (fw?.id) {
    const have = new Set((await r.firewallRules(fw.id)).map(ruleKey));
    for (const rule of wantedFirewallRules(cfg)) {
      if (have.has(ruleKey(rule))) continue;
      await r.createFirewallRule(fw.id, rule);
      log(`  + firewall rule ${rule.notes} (${rule.ip_type} ${rule.port})`);
    }
  }
  state.firewallGroupId = fw?.id;
  save();

  // VM
  let vm = (await r.instances({ label: n.instance }))[0];
  if (!vm) {
    vm = await r.createInstance({
      region: cfg.region,
      plan: cfg.vmPlan,
      label: n.instance,
      hostname: n.instance,
      tags: [n.tag],
      ...(p.context.coolifyImageId ? { image_id: p.context.coolifyImageId } : {}),
      ...(vpc?.id ? { attach_vpc: [vpc.id] } : {}),
      ...(fw?.id ? { firewall_group_id: fw.id } : {}),
      ...(sshKeyId ? { sshkey_id: [sshKeyId] } : {}),
      backups: "enabled",
      enable_ipv6: true,
    });
    log(`created VM ${n.instance} (${vm?.id}); waiting for it to boot…`);
  }
  if (!vm?.id) throw new Error("VM creation returned no id");
  state.instanceId = vm.id;
  save();
  vm = await waitFor(
    () => r.instance(vm!.id!),
    (i) => i?.status === "active" && i?.power_status === "running" && !!i?.main_ip && i.main_ip !== "0.0.0.0",
    opts.waitMs ?? 15 * 60_000,
    "VM to become active",
  );
  state.appIp = vm?.main_ip;
  log(`VM ready at ${vm?.main_ip}`);
  save();
  await orWarn("Setting the VM's backup hour", async () => {
    await r.setBackupSchedule(vm!.id!, cfg.vmBackupHourUtc);
    log(`  daily backup at ${cfg.vmBackupHourUtc}:00 UTC`);
  });

  // Managed PostgreSQL, reachable only from inside the VPC
  let db = (await r.databases({ label: n.database }))[0];
  const vpcCidr = `${cfg.vpcSubnet}/${cfg.vpcSubnetMask}`;
  if (!db) {
    if (!p.context.dbPlanId) throw new Error("No database plan chosen; run plan and check the warnings.");
    db = await r.createDatabase({
      database_engine: "pg",
      database_engine_version: cfg.pgVersion,
      region: cfg.region,
      plan: p.context.dbPlanId,
      label: n.database,
      tag: n.tag,
      ...(vpc?.id ? { vpc_id: vpc.id } : {}),
      backup_hour: String(cfg.dbBackupHourUtc),
      backup_minute: "0",
      trusted_ips: [vpcCidr],
    });
    log(`created managed PostgreSQL ${n.database}; waiting for it to start (this can take several minutes)…`);
  }
  if (!db?.id) throw new Error("Database creation returned no id");
  state.databaseId = db.id;
  save();
  db = await waitFor(() => r.database(db!.id!), (d) => d?.status === "Running", opts.waitMs ?? 20 * 60_000, "database to start");

  // Object Storage and buckets. Without it, documents and backups go to a volume on the VM.
  const store = await orWarn("Object Storage", async () => {
    let found = (await r.objectStorages()).find((s) => s.label === n.objectStorage);
    if (!found && p.context.objectStorageClusterId && p.context.objectStorageTierId) {
      found = await r.createObjectStorage(p.context.objectStorageClusterId, p.context.objectStorageTierId, n.objectStorage);
      log(`created Object Storage ${n.objectStorage}; waiting for it…`);
    }
    if (!found?.id) return undefined;
    const id = found.id;
    state.objectStorageId = id;
    const ready = await waitFor(() => r.objectStorage(id), (s) => s?.status === "active", opts.waitMs ?? 10 * 60_000, "Object Storage");
    state.buckets = {
      documents: `${cfg.label}-docs-${state.bucketSuffix}`,
      backups: `${cfg.label}-backups-${state.bucketSuffix}`,
    };
    // Through S3 itself, because Vultr's API answers its own documented request with "Missing bucket name".
    for (const bucket of Object.values(state.buckets)) {
      const result = await ensureBucket({ endpoint: ready?.s3_hostname ?? "", accessKeyId: ready?.s3_access_key ?? "", secretAccessKey: ready?.s3_secret_key ?? "", bucket });
      log(`  ${result === "created" ? "+" : "="} bucket ${bucket}`);
    }
    save();
    return ready;
  });

  // Serverless Inference. Without it, documents are read by the built-in layout rules.
  const inf = await orWarn("Serverless Inference", async () => {
    const found = (await r.inferenceSubscriptions()).find((s) => s.label === n.inference);
    if (found) return found;
    const created = await r.createInference(n.inference);
    log(`created Serverless Inference subscription ${n.inference}`);
    return created;
  });
  state.inferenceId = inf?.id;
  save();

  // DNS
  if (cfg.domain && state.appIp) {
    const appIp = state.appIp;
    await orWarn("The DNS record", async () => {
      const zone = (await r.domains()).find((d) => d.domain === cfg.domain);
      if (!zone) return;
      const records = await r.dnsRecords(cfg.domain!);
      if (!records.some((x) => x.type === "A" && x.name === cfg.appSubdomain)) {
        await r.createDnsRecord(cfg.domain!, { name: cfg.appSubdomain, type: "A", data: appIp, ttl: 300 });
        log(`created DNS A record ${cfg.appSubdomain}.${cfg.domain} -> ${appIp}`);
      }
    });
  }

  // Everything for Coolify's environment variables. Never committed (.gitignore covers .env.*).
  const out = resolve(REPO_ROOT, ".env.vultr");
  const previous = existsSync(out) ? parseEnv(readFileSync(out, "utf8")) : {};
  const settings = appSettings(cfg, state.appIp ?? "", previous, process.env.DEMO_PASSWORD);
  const lines = [
    "# Written by `pnpm infra:apply`. Paste these into Coolify's environment variables. Do not commit.",
    "# Keep a copy of APP_ENCRYPTION_KEY off the server: without it, mailbox passwords and backups can't be opened.",
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
    `VULTR_REGION=${cfg.region}`,
    `VULTR_INSTANCE_ID=${state.instanceId ?? ""}`,
    `VULTR_DATABASE_ID=${state.databaseId ?? ""}`,
    `VULTR_OBJECT_STORAGE_ID=${state.objectStorageId ?? ""}`,
    `VULTR_INFERENCE_ID=${state.inferenceId ?? ""}`,
    `APP_VM_IP=${state.appIp ?? ""}`,
    db
      ? `DATABASE_URL=postgres://${encodeURIComponent(db.user ?? "")}:${encodeURIComponent(db.password ?? "")}@${db.host}:${db.port}/${db.dbname}?sslmode=require`
      : "DATABASE_URL=",
    `S3_ENDPOINT=${store?.s3_hostname ? `https://${store.s3_hostname}` : ""}`,
    `S3_ACCESS_KEY=${store?.s3_access_key ?? ""}`,
    `S3_SECRET_KEY=${store?.s3_secret_key ?? ""}`,
    `S3_BUCKET_DOCUMENTS=${state.buckets?.documents ?? ""}`,
    `S3_BUCKET_BACKUPS=${state.buckets?.backups ?? ""}`,
    `VULTR_INFERENCE_API_KEY=${inf?.api_key ?? ""}`,
  ];
  writeFileSync(out, lines.join("\n") + "\n", { mode: 0o600 });
  log(`wrote the settings for Coolify to ${out} (secret; not committed)`);
  log(`the app's address will be ${settings.BETTER_AUTH_URL}`);
  return state;
}

async function waitFor<T>(get: () => Promise<T>, ready: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  let delay = 5_000;
  for (;;) {
    const v = await get();
    if (ready(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 1.5, 30_000);
  }
}
