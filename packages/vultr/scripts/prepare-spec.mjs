// Trims Vultr's OpenAPI spec to the API areas this project uses and removes
// references the published spec leaves unresolved (external YAML files and
// missing shared responses), so openapi-typescript can generate types.
//
// Usage: node scripts/prepare-spec.mjs <input openapi.json> <output json>
import { readFileSync, writeFileSync } from "node:fs";

const [input = "openapi.json", output = "openapi.trimmed.json"] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(input, "utf8"));

// Tags (API areas) we call. Add to this list when the project needs more.
const KEEP_TAGS = new Set([
  "account",
  "application",
  "backup",
  "billing",
  "dns",
  "firewall",
  "instances",
  "managed-databases",
  "os",
  "plans",
  "region",
  "s3",
  "serverless-inference",
  "snapshot",
  "ssh",
  "startup",
  "VPCs",
]);
const DROP_PATH = (p) => p.includes("/nat-gateway");
const METHODS = ["get", "post", "put", "patch", "delete"];

const resolve = (ref) => {
  if (!ref.startsWith("#/")) return undefined;
  let node = spec;
  for (const raw of ref.slice(2).split("/")) {
    node = node?.[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
};

// 1. Keep only operations in the wanted tags.
const paths = {};
for (const [p, item] of Object.entries(spec.paths)) {
  if (DROP_PATH(p)) continue;
  const kept = {};
  for (const [k, v] of Object.entries(item)) {
    if (METHODS.includes(k)) {
      if ((v.tags ?? []).some((t) => KEEP_TAGS.has(t))) kept[k] = v;
    } else {
      kept[k] = v; // path-level parameters etc.
    }
  }
  if (Object.keys(kept).some((k) => METHODS.includes(k))) paths[p] = kept;
}
spec.paths = paths;
spec.tags = (spec.tags ?? []).filter((t) => KEEP_TAGS.has(t.name));

// 2. Drop unresolvable references: parameters are removed, responses replaced.
let dropped = 0;
const fix = (node) => {
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const v = node[i];
      if (v && typeof v === "object" && typeof v.$ref === "string" && resolve(v.$ref) === undefined) {
        node.splice(i, 1);
        dropped++;
      } else fix(v);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object" && typeof v.$ref === "string" && resolve(v.$ref) === undefined) {
        node[k] = { description: "Error (reference missing from the published spec)" };
        dropped++;
      } else fix(v);
    }
  }
};
fix(spec.paths);

// 3. Keep only components reachable from the kept paths.
const reachable = new Set();
const visit = (node) => {
  if (Array.isArray(node)) return node.forEach(visit);
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/components/") && !reachable.has(node.$ref)) {
      reachable.add(node.$ref);
      visit(resolve(node.$ref));
    }
    for (const v of Object.values(node)) visit(v);
  }
};
visit(spec.paths);
for (const section of ["schemas", "parameters", "responses"]) {
  const all = spec.components?.[section];
  if (!all) continue;
  for (const name of Object.keys(all)) {
    if (!reachable.has(`#/components/${section}/${name}`)) delete all[name];
  }
}
fix(spec.components);

writeFileSync(output, JSON.stringify(spec, null, 1));
const ops = Object.values(spec.paths).reduce((n, item) => n + METHODS.filter((m) => item[m]).length, 0);
console.log(`prepare-spec: kept ${Object.keys(spec.paths).length} paths (${ops} operations), dropped ${dropped} broken refs -> ${output}`);
