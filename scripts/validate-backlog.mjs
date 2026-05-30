#!/usr/bin/env node
/**
 * validate-backlog.mjs — standalone Atlas backlog validator.
 * Pure Node ESM, zero external dependencies (node:fs + node:path only).
 * Does a manual required-field + enum check covering the fields the
 * Atlas viewer actually depends on — no ajv required.
 *
 * Usage:
 *   node scripts/validate-backlog.mjs [backlog.json] [backlog.schema.json]
 * Defaults:
 *   backlog  → atlas/backlog.json
 *   schema   → atlas/backlog.schema.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const backlogPath = process.argv[2] ?? 'atlas/backlog.json';
const schemaPath  = process.argv[3] ?? 'atlas/backlog.schema.json';

const absBacklog = resolve(backlogPath);
const absSchema  = resolve(schemaPath);

// ── load files ─────────────────────────────────────────────────────────────

if (!existsSync(absBacklog)) {
  console.log(`atlas: backlog file not found at ${absBacklog} — skipping validation (greenfield install)`);
  process.exit(0);
}
if (!existsSync(absSchema)) {
  console.error(`ERROR: schema file not found: ${absSchema}`);
  process.exit(1);
}

let data, schema;
try {
  data   = JSON.parse(readFileSync(absBacklog,  'utf8'));
  schema = JSON.parse(readFileSync(absSchema,   'utf8'));
} catch (e) {
  console.error(`ERROR: JSON parse failed: ${e.message}`);
  process.exit(1);
}

// ── minimal ad-hoc JSON Schema checker ────────────────────────────────────
// Supports: required, type (string|integer|array|object), enum
// Enough to cover the fields the Atlas viewer depends on.

const errors = [];

function checkType(value, expectedType, path) {
  if (expectedType === 'string'  && typeof value !== 'string')  return false;
  if (expectedType === 'integer' && !Number.isInteger(value))   return false;
  if (expectedType === 'array'   && !Array.isArray(value))      return false;
  if (expectedType === 'object'  && (value === null || typeof value !== 'object' || Array.isArray(value))) return false;
  return true;
}

function validateNode(value, schemaDef, path) {
  if (!schemaDef || typeof schemaDef !== 'object') return;

  // type check
  if (schemaDef.type && value !== undefined && value !== null) {
    if (!checkType(value, schemaDef.type, path)) {
      errors.push(`${path}: expected type "${schemaDef.type}", got "${Array.isArray(value) ? 'array' : typeof value}"`);
      return; // no point drilling further
    }
  }

  // enum check
  if (schemaDef.enum && value !== undefined) {
    if (!schemaDef.enum.includes(value)) {
      errors.push(`${path}: value "${value}" not in enum [${schemaDef.enum.map(String).join(', ')}]`);
    }
  }

  // required + properties check on objects
  if (schemaDef.type === 'object' && value !== null && typeof value === 'object') {
    if (schemaDef.required) {
      for (const req of schemaDef.required) {
        if (value[req] === undefined || value[req] === null || value[req] === '') {
          errors.push(`${path}.${req}: required field is missing or empty`);
        }
      }
    }
    if (schemaDef.properties) {
      for (const [key, propSchema] of Object.entries(schemaDef.properties)) {
        if (value[key] !== undefined) {
          validateNode(value[key], propSchema, `${path}.${key}`);
        }
      }
    }
  }

  // array items check
  if (schemaDef.type === 'array' && Array.isArray(value) && schemaDef.items) {
    value.forEach((item, i) => {
      validateNode(item, schemaDef.items, `${path}[${i}]`);
    });
  }
}

// ── root-level required fields ─────────────────────────────────────────────

const rootRequired = schema.required ?? [];
for (const key of rootRequired) {
  if (data[key] === undefined || data[key] === null) {
    errors.push(`(root).${key}: required field is missing`);
  }
}

// ── validate tasks array items ─────────────────────────────────────────────

if (Array.isArray(data.tasks)) {
  const taskSchema = schema?.properties?.tasks?.items ?? {};
  data.tasks.forEach((task, i) => {
    validateNode(task, taskSchema, `tasks[${i}]`);
  });
} else if (data.tasks !== undefined) {
  errors.push('tasks: expected array');
}

// ── stories[] structural validation (mirror of the tasks[] loop) ──────────

if (Array.isArray(data.stories)) {
  const storySchema = schema?.properties?.stories?.items ?? {};
  data.stories.forEach((story, i) => { validateNode(story, storySchema, `stories[${i}]`); });
}

// ── depends_on existence + cycle (cross-array; the schema can't express this) ──
// KEEP IN SYNC WITH lib/check-dependencies.mjs (zero-dep duplicate — see plan Phase 1).
{
  const deps = new Map();
  for (const n of [...(data.stories ?? []), ...(data.tasks ?? [])]) {
    if (n && typeof n.id === 'string') {
      deps.set(n.id, Array.isArray(n.depends_on) ? n.depends_on : []);
    }
  }
  for (const [id, ds] of deps) {
    for (const d of ds) {
      if (!deps.has(d)) errors.push(`${id} depends_on "${d}" which does not exist`);
    }
  }
  const color = new Map([...deps.keys()].map((id) => [id, 0]));
  const path = [];
  const visit = (id) => {
    color.set(id, 1); path.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      if (color.get(d) === 1) {
        const k = path.indexOf(d);
        errors.push(`dependency cycle: ${[...path.slice(k), d].join(' -> ')}`);
      } else if (color.get(d) === 0) visit(d);
    }
    path.pop(); color.set(id, 2);
  };
  for (const id of deps.keys()) if (color.get(id) === 0) visit(id);
}

// ── report ─────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error('BACKLOG VIOLATIONS:');
  errors.forEach((e) => console.error(' -', e));
  process.exit(1);
}

console.log('backlog.json valid');
process.exit(0);
