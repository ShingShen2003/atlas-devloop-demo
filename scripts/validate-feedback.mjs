#!/usr/bin/env node
// Standalone validator for atlas/feedback.json against feedback.schema.json.
// Pure Node ESM — no external dependencies. Mirrors validate-backlog.mjs.
// v1.8.0+.
//
// Usage:
//   node scripts/validate-feedback.mjs                                 # defaults
//   node scripts/validate-feedback.mjs atlas/feedback.json             # custom data
//   node scripts/validate-feedback.mjs <data> <schema>                 # custom both
//
// Exits 0 on success, 1 on validation failure or missing files.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const dataPath = resolve(process.argv[2] ?? "atlas/feedback.json");
const schemaPath = resolve(process.argv[3] ?? "atlas/feedback.schema.json");

function fail(msg) {
  console.error("[validate-feedback] ❌", msg);
  process.exit(1);
}

if (!existsSync(schemaPath)) {
  fail(`schema not found: ${schemaPath}`);
}
if (!existsSync(dataPath)) {
  // Missing feedback.json is an EMPTY state, not an error — a project
  // may not have any feedback yet. Print and exit 0 so CI doesn't fail.
  console.log(`[validate-feedback] no feedback.json yet at ${dataPath} — valid empty state`);
  process.exit(0);
}

let schema, data;
try {
  schema = JSON.parse(readFileSync(schemaPath, "utf8"));
} catch (e) {
  fail(`could not parse schema: ${e.message}`);
}
try {
  data = JSON.parse(readFileSync(dataPath, "utf8"));
} catch (e) {
  fail(`could not parse data: ${e.message}`);
}

const errors = [];

// Required top-level fields.
for (const key of schema.required ?? []) {
  if (!(key in data)) errors.push(`missing required field: ${key}`);
}

// items[] checks.
if (data.items != null) {
  if (!Array.isArray(data.items)) {
    errors.push("items must be an array");
  } else {
    const itemSchema = schema.properties?.items?.items;
    const requiredFields = itemSchema?.required ?? [];
    const statusEnum = new Set(itemSchema?.properties?.status?.enum ?? []);
    const urgencyEnum = new Set(itemSchema?.properties?.urgency?.enum ?? []);
    const typeEnum = new Set(itemSchema?.properties?.type?.enum ?? []);

    const seenIds = new Set();
    data.items.forEach((item, i) => {
      const at = `items[${i}]`;
      for (const f of requiredFields) {
        if (!(f in item)) errors.push(`${at} missing required field: ${f}`);
      }
      if (item.id != null) {
        if (seenIds.has(item.id)) {
          errors.push(`${at} duplicate id: ${item.id}`);
        }
        seenIds.add(item.id);
      }
      if (item.status != null && !statusEnum.has(item.status)) {
        errors.push(
          `${at} status "${item.status}" not in enum [${[...statusEnum].join(", ")}]`,
        );
      }
      if (item.urgency != null && !urgencyEnum.has(item.urgency)) {
        errors.push(
          `${at} urgency "${item.urgency}" not in enum [${[...urgencyEnum].join(", ")}]`,
        );
      }
      if (item.type != null && !typeEnum.has(item.type)) {
        errors.push(`${at} type "${item.type}" not in enum [${[...typeEnum].join(", ")}]`);
      }
      // evolution_log[] entries
      if (Array.isArray(item.evolution_log)) {
        const entrySchema = itemSchema?.properties?.evolution_log?.items;
        const entryOps = new Set(entrySchema?.properties?.operation?.enum ?? []);
        const entryRequired = entrySchema?.required ?? [];
        item.evolution_log.forEach((entry, j) => {
          const eAt = `${at}.evolution_log[${j}]`;
          for (const f of entryRequired) {
            if (!(f in entry)) errors.push(`${eAt} missing required field: ${f}`);
          }
          if (entry.operation != null && !entryOps.has(entry.operation)) {
            errors.push(
              `${eAt} operation "${entry.operation}" not in enum [${[...entryOps].join(", ")}]`,
            );
          }
        });
      }
    });
  }
}

if (errors.length) {
  console.error(`[validate-feedback] ❌ ${errors.length} validation error${errors.length === 1 ? "" : "s"}:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("feedback.json valid");
