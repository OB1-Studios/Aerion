import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./config";

/** IDs of the resources this script created. Holds no secrets; still not committed. */
export interface InfraState {
  region?: string;
  bucketSuffix?: string;
  sshKeyId?: string | undefined;
  vpcId?: string | undefined;
  firewallGroupId?: string | undefined;
  instanceId?: string | undefined;
  appIp?: string | undefined;
  databaseId?: string | undefined;
  objectStorageId?: string | undefined;
  buckets?: { documents: string; backups: string };
  inferenceId?: string | undefined;
}

const FILE = resolve(REPO_ROOT, "infra/.state.json");

export function readState(): InfraState {
  if (!existsSync(FILE)) return {};
  return JSON.parse(readFileSync(FILE, "utf8")) as InfraState;
}

export function writeState(state: InfraState): void {
  writeFileSync(FILE, JSON.stringify(state, null, 2) + "\n");
}
