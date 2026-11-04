import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** Loads the repo's .env (if present) without overriding variables already set. */
export function loadEnv(): void {
  const file = resolve(REPO_ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface InfraConfig {
  apiKey: string | undefined;
  /** Prefix for every resource label, so the script only ever touches its own resources. */
  label: string;
  region: string;
  vmPlan: string;
  dbPlan: string | undefined;
  pgVersion: string;
  vpcSubnet: string;
  vpcSubnetMask: number;
  /** CIDR allowed to reach SSH and the Coolify dashboard, e.g. 203.0.113.7/32. */
  adminCidr: string | undefined;
  sshPublicKey: string | undefined;
  sshPublicKeyPath: string;
  domain: string | undefined;
  appSubdomain: string;
  /** Daily backup hours in UTC. 21:00 UTC is 02:00 in Pakistan. */
  vmBackupHourUtc: number;
  dbBackupHourUtc: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): InfraConfig {
  const sshPublicKeyPath = env.SSH_PUBLIC_KEY_PATH ?? resolve(homedir(), ".ssh/id_ed25519.pub");
  const sshPublicKey = existsSync(sshPublicKeyPath) ? readFileSync(sshPublicKeyPath, "utf8").trim() : undefined;
  return {
    apiKey: env.VULTR_API_KEY || undefined,
    label: env.INFRA_LABEL ?? "ebo",
    region: env.VULTR_REGION ?? "sgp",
    vmPlan: env.VM_PLAN ?? "vc2-2c-4gb",
    dbPlan: env.DB_PLAN || undefined,
    pgVersion: env.PG_VERSION ?? "17",
    vpcSubnet: env.VPC_SUBNET ?? "10.20.0.0",
    vpcSubnetMask: Number(env.VPC_SUBNET_MASK ?? 24),
    adminCidr: normaliseCidr(env.ADMIN_CIDR),
    sshPublicKey,
    sshPublicKeyPath,
    domain: env.DOMAIN || undefined,
    appSubdomain: env.APP_SUBDOMAIN ?? "app",
    vmBackupHourUtc: Number(env.VM_BACKUP_HOUR_UTC ?? 21),
    dbBackupHourUtc: Number(env.DB_BACKUP_HOUR_UTC ?? 20),
  };
}

function normaliseCidr(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.includes("/") ? value : `${value}/32`;
}

export function splitCidr(cidr: string): { subnet: string; size: number } {
  const [subnet = "", size = "32"] = cidr.split("/");
  return { subnet, size: Number(size) };
}

/** Resource names derived from the label. Lookups match on these, never on IDs typed by hand. */
export function names(cfg: InfraConfig) {
  return {
    sshKey: `${cfg.label}-admin`,
    vpc: `${cfg.label}-vpc`,
    firewall: `${cfg.label}-app`,
    instance: `${cfg.label}-app`,
    database: `${cfg.label}-db`,
    objectStorage: `${cfg.label}-objects`,
    inference: `${cfg.label}-inference`,
    tag: cfg.label,
  };
}
