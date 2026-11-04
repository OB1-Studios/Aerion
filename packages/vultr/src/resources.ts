import { listAll, unwrap, type VultrClient } from "./client";
import type { paths } from "./schema";

type Json<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;

export type CreateInstanceBody = Json<"/instances", "post">;
export type CreateDatabaseBody = Json<"/databases", "post">;
export type UpdateDatabaseBody = Json<"/databases/{database-id}", "put">;
export type CreateFirewallRuleBody = Json<"/firewalls/{firewall-group-id}/rules", "post">;
export type CreateVpcBody = Json<"/vpcs", "post">;
export type CreateDnsRecordBody = Json<"/domains/{dns-domain}/records", "post">;

const next = (meta: { links?: { next?: string } } | undefined) => meta?.links?.next || undefined;

/**
 * The Vultr resources this project provisions and watches, as plain async functions.
 * Used by the infrastructure script (infra/) and by the worker's platform checks.
 */
export function vultrResources(client: VultrClient) {
  return {
    // Account and billing
    async account() {
      return unwrap(await client.GET("/account"), "GET /account").account;
    },
    async pendingCharges() {
      return unwrap(await client.GET("/billing/pending-charges"), "GET /billing/pending-charges").pending_charges ?? [];
    },

    // Catalogue
    async regions() {
      return listAll(async (cursor) => {
        const r = unwrap(await client.GET("/regions", { params: { query: { per_page: 500, cursor } } }), "GET /regions");
        return { items: r.regions ?? [], next: next(r.meta) };
      });
    },
    async regionAvailability(regionId: string) {
      return unwrap(
        await client.GET("/regions/{region-id}/availability", { params: { path: { "region-id": regionId } } }),
        "GET /regions/{region-id}/availability",
      );
    },
    async plans(type = "vc2") {
      return listAll(async (cursor) => {
        const r = unwrap(await client.GET("/plans", { params: { query: { type, per_page: 500, cursor } } }), "GET /plans");
        return { items: r.plans ?? [], next: next(r.meta) };
      });
    },
    async databasePlans(region: string, engine = "pg") {
      const r = unwrap(await client.GET("/databases/plans", { params: { query: { engine, region } } }), "GET /databases/plans");
      return r.plans ?? [];
    },
    async marketplaceApps() {
      return listAll(async (cursor) => {
        const r = unwrap(
          await client.GET("/applications", { params: { query: { type: "marketplace", per_page: 500, cursor } } }),
          "GET /applications",
        );
        return { items: r.applications ?? [], next: next(r.meta) };
      });
    },

    // SSH keys
    async sshKeys() {
      return listAll(async (cursor) => {
        const r = unwrap(await client.GET("/ssh-keys", { params: { query: { per_page: 500, cursor } } }), "GET /ssh-keys");
        return { items: r.ssh_keys ?? [], next: next(r.meta) };
      });
    },
    async createSshKey(name: string, sshKey: string) {
      return unwrap(await client.POST("/ssh-keys", { body: { name, ssh_key: sshKey } }), "POST /ssh-keys").ssh_key;
    },

    // Networking
    async vpcs() {
      return listAll(async (cursor) => {
        const r = unwrap(await client.GET("/vpcs", { params: { query: { per_page: 500, cursor } } }), "GET /vpcs");
        return { items: r.vpcs ?? [], next: next(r.meta) };
      });
    },
    async createVpc(body: CreateVpcBody) {
      return unwrap(await client.POST("/vpcs", { body }), "POST /vpcs").vpc;
    },
    async firewallGroups() {
      return listAll(async (cursor) => {
        const r = unwrap(await client.GET("/firewalls", { params: { query: { per_page: 500, cursor } } }), "GET /firewalls");
        return { items: r.firewall_groups ?? [], next: next(r.meta) };
      });
    },
    async createFirewallGroup(description: string) {
      return unwrap(await client.POST("/firewalls", { body: { description } }), "POST /firewalls").firewall_group;
    },
    async firewallRules(groupId: string) {
      return listAll(async (cursor) => {
        const r = unwrap(
          await client.GET("/firewalls/{firewall-group-id}/rules", {
            params: { path: { "firewall-group-id": groupId }, query: { per_page: 500, cursor } },
          }),
          "GET /firewalls/{id}/rules",
        );
        return { items: r.firewall_rules ?? [], next: next(r.meta) };
      });
    },
    async createFirewallRule(groupId: string, body: CreateFirewallRuleBody) {
      return unwrap(
        await client.POST("/firewalls/{firewall-group-id}/rules", { params: { path: { "firewall-group-id": groupId } }, body }),
        "POST /firewalls/{id}/rules",
      ).firewall_rule;
    },

    // Compute
    async instances(filter: { label?: string; tag?: string } = {}) {
      return listAll(async (cursor) => {
        const r = unwrap(
          await client.GET("/instances", { params: { query: { ...filter, per_page: 500, cursor } } }),
          "GET /instances",
        );
        return { items: r.instances ?? [], next: next(r.meta) };
      });
    },
    async instance(id: string) {
      return unwrap(await client.GET("/instances/{instance-id}", { params: { path: { "instance-id": id } } }), "GET /instances/{id}")
        .instance;
    },
    async createInstance(body: CreateInstanceBody) {
      return unwrap(await client.POST("/instances", { body }), "POST /instances").instance;
    },
    async setBackupSchedule(instanceId: string, hourUtc: number) {
      unwrap(
        await client.POST("/instances/{instance-id}/backup-schedule", {
          params: { path: { "instance-id": instanceId } },
          body: { type: "daily", hour: hourUtc },
        }),
        "POST /instances/{id}/backup-schedule",
      );
    },
    async instanceBackupSchedule(instanceId: string) {
      return unwrap(
        await client.GET("/instances/{instance-id}/backup-schedule", { params: { path: { "instance-id": instanceId } } }),
        "GET /instances/{id}/backup-schedule",
      ).backup_schedule;
    },
    async backups(instanceId?: string) {
      return listAll(async (cursor) => {
        const r = unwrap(
          await client.GET("/backups", { params: { query: { instance_id: instanceId, per_page: 500, cursor } } }),
          "GET /backups",
        );
        return { items: r.backups ?? [], next: next(r.meta) };
      });
    },

    // Managed PostgreSQL
    async databases(filter: { label?: string; tag?: string } = {}) {
      const r = unwrap(await client.GET("/databases", { params: { query: filter } }), "GET /databases");
      return r.databases ?? [];
    },
    async database(id: string) {
      return unwrap(await client.GET("/databases/{database-id}", { params: { path: { "database-id": id } } }), "GET /databases/{id}")
        .database;
    },
    async createDatabase(body: CreateDatabaseBody) {
      return unwrap(await client.POST("/databases", { body }), "POST /databases").database;
    },
    async updateDatabase(id: string, body: UpdateDatabaseBody) {
      return unwrap(
        await client.PUT("/databases/{database-id}", { params: { path: { "database-id": id } }, body }),
        "PUT /databases/{id}",
      ).database;
    },
    async databaseBackups(id: string) {
      return unwrap(
        await client.GET("/databases/{database-id}/backups", { params: { path: { "database-id": id } } }),
        "GET /databases/{id}/backups",
      );
    },

    // Object Storage
    async objectStorageClusters() {
      return listAll(async (cursor) => {
        const r = unwrap(
          await client.GET("/object-storage/clusters", { params: { query: { per_page: 500, cursor } } }),
          "GET /object-storage/clusters",
        );
        return { items: r.clusters ?? [], next: next(r.meta) };
      });
    },
    async objectStorageTiers(clusterId: number) {
      return (
        unwrap(
          await client.GET("/object-storage/clusters/{cluster-id}/tiers", { params: { path: { "cluster-id": String(clusterId) } } }),
          "GET /object-storage/clusters/{id}/tiers",
        ).tiers ?? []
      );
    },
    async objectStorages() {
      return listAll(async (cursor) => {
        const r = unwrap(
          await client.GET("/object-storage", { params: { query: { per_page: 500, cursor } } }),
          "GET /object-storage",
        );
        return { items: r.object_storages ?? [], next: next(r.meta) };
      });
    },
    async objectStorage(id: string) {
      return unwrap(
        await client.GET("/object-storage/{object-storage-id}", { params: { path: { "object-storage-id": id } } }),
        "GET /object-storage/{id}",
      ).object_storage;
    },
    async createObjectStorage(clusterId: number, tierId: number, label: string) {
      return unwrap(
        await client.POST("/object-storage", { body: { cluster_id: clusterId, tier_id: tierId, label } }),
        "POST /object-storage",
      ).object_storage;
    },
    async createBucket(objectStorageId: string, bucketName: string) {
      unwrap(
        await client.POST("/object-storage/{object-storage-id}/bucket", {
          params: { path: { "object-storage-id": objectStorageId } },
          body: { bucket_name: bucketName },
        }),
        "POST /object-storage/{id}/bucket",
      );
    },

    // Serverless Inference
    async inferenceSubscriptions() {
      return unwrap(await client.GET("/inference"), "GET /inference").subscriptions ?? [];
    },
    async createInference(label: string) {
      return unwrap(await client.POST("/inference", { body: { label } }), "POST /inference").subscription;
    },
    async inferenceUsage(id: string) {
      return unwrap(
        await client.GET("/inference/{inference-id}/usage", { params: { path: { "inference-id": id } } }),
        "GET /inference/{id}/usage",
      ).usage;
    },

    // DNS
    async domains() {
      return listAll(async (cursor) => {
        const r = unwrap(await client.GET("/domains", { params: { query: { per_page: 500, cursor } } }), "GET /domains");
        return { items: r.domains ?? [], next: next(r.meta) };
      });
    },
    async dnsRecords(domain: string) {
      return listAll(async (cursor) => {
        const r = unwrap(
          await client.GET("/domains/{dns-domain}/records", {
            params: { path: { "dns-domain": domain }, query: { per_page: 500, cursor } },
          }),
          "GET /domains/{domain}/records",
        );
        return { items: r.records ?? [], next: next(r.meta) };
      });
    },
    async createDnsRecord(domain: string, body: CreateDnsRecordBody) {
      return unwrap(
        await client.POST("/domains/{dns-domain}/records", { params: { path: { "dns-domain": domain } }, body }),
        "POST /domains/{domain}/records",
      ).record;
    },
  };
}

export type VultrResources = ReturnType<typeof vultrResources>;
