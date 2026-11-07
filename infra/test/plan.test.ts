import type { VultrResources } from "@ebo/vultr";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { plan } from "../src/provision";

// Shaped like the real API's answers, read on 2026-11-07.
const account = {
  regions: async () => [{ id: "sgp" }],
  plans: async () => [{ id: "vc2-2c-4gb", monthly_cost: 20, locations: ["sgp"] }],
  marketplaceApps: async () => [{ name: "Coolify", short_name: "coolify", image_id: "coolify" }],
  sshKeys: async () => [],
  vpcs: async () => [],
  firewallGroups: async () => [],
  instances: async () => [],
  databases: async () => [],
  objectStorages: async () => [],
  objectStorageClusters: async () => [{ id: 4, region: "sgp", hostname: "sgp1.vultrobjects.com", deploy: "yes" }],
  objectStorageTiers: async () => [
    { id: 2, sales_name: "Standard", price: 18, is_default: "no" },
    { id: 3, sales_name: "Premium", price: 36, is_default: "no" },
    { id: 6, sales_name: "Archival", price: 6, is_default: "no" },
  ],
  inferenceSubscriptions: async () => [],
  databasePlans: async () => [
    { id: "startup", number_of_nodes: 1, monthly_cost: 28, locations: ["AMS", "SGP"] },
    { id: "hobbyist", number_of_nodes: 1, monthly_cost: 15, locations: ["AMS", "SGP"] },
    { id: "ha-pair", number_of_nodes: 2, monthly_cost: 10, locations: ["SGP"] },
    { id: "elsewhere", number_of_nodes: 1, monthly_cost: 5, locations: ["AMS"] },
  ],
} as unknown as VultrResources;

describe("the deployment plan", () => {
  it("finds a database plan though Vultr lists its locations in capitals", async () => {
    const p = await plan(account, readConfig({}));
    expect(p.context.dbPlanId).toBe("hobbyist");
    expect(p.warnings.filter((w) => w.includes("PostgreSQL"))).toEqual([]);
  });

  it("picks the Standard storage tier, not the cheaper one for data rarely read", async () => {
    const p = await plan(account, readConfig({}));
    expect(p.context.objectStorageTierId).toBe(2);
  });
});
