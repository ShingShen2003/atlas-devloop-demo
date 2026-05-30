#!/usr/bin/env node
/**
 * validate-config.mjs — standalone Atlas config validator.
 * Pure Node ESM, zero external dependencies (node:fs + node:path only).
 * Usage:  node scripts/validate-config.mjs [path/to/atlas.config.json]
 * Default path: atlas/atlas.config.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const configPath = process.argv[2] ?? 'atlas/atlas.config.json';
const absConfig  = resolve(configPath);

// ── helpers ────────────────────────────────────────────────────────────────

function get(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// ── load + parse ───────────────────────────────────────────────────────────

if (!existsSync(absConfig)) {
  console.error(`ERROR: config file not found: ${absConfig}`);
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(absConfig, 'utf8'));
} catch (e) {
  console.error(`ERROR: failed to parse JSON: ${e.message}`);
  process.exit(1);
}

// ── required keys ──────────────────────────────────────────────────────────

// Always-required: the install fails without these.
const REQUIRED = [
  'projectName',
  'logoPath',
  'github.backlogPath',
  'github.ref',
  'auth.mode',
  'contactEmail',
];

// Optional-but-watched: empty values produce a WARNING but don't fail.
// github.repo can be intentionally empty for pure-static installs (the
// install skill explicitly documents this path). The warning is enough
// to surface "this install won't get reconciler updates" without blocking
// the install flow.
const RECOMMENDED = [
  {
    key: 'github.repo',
    hint: 'static install detected — reconciler workflow + /api/backlog read-through will be disabled. Fine for view-only installs; set this to "owner/repo" when you wire up a GitHub repo.',
  },
];

const missing = REQUIRED.filter((k) => {
  const v = get(raw, k);
  return v === undefined || v === null || v === '';
});

if (missing.length) {
  console.error(`ERROR: atlas.config.json missing required keys: ${missing.join(', ')}`);
  process.exit(1);
}

// Recommended-but-empty keys: warn, don't fail.
const warnings = RECOMMENDED.filter((r) => {
  const v = get(raw, r.key);
  return v === undefined || v === null || v === '';
});
for (const w of warnings) {
  console.warn(`WARN: atlas.config.json#/${w.key} is empty — ${w.hint}`);
}

// ── auth.mode enum ─────────────────────────────────────────────────────────

const AUTH_MODES = ['pin', 'clerk', 'none'];
if (!AUTH_MODES.includes(raw.auth.mode)) {
  console.error(
    `ERROR: auth.mode must be one of ${AUTH_MODES.join('|')} — got: "${raw.auth.mode}"`
  );
  process.exit(1);
}

// ── brand.primary union type ───────────────────────────────────────────────
// Accepted: string | { light: string, dark: string } | undefined

if (raw.brand !== undefined && raw.brand.primary !== undefined) {
  const p = raw.brand.primary;
  const isString = typeof p === 'string';
  const isDual =
    p !== null &&
    typeof p === 'object' &&
    !Array.isArray(p) &&
    typeof p.light === 'string' &&
    typeof p.dark === 'string';

  if (!isString && !isDual) {
    console.error(
      'ERROR: brand.primary must be a hex string (e.g. "#40B7FF") or { light: "#hex", dark: "#hex" }'
    );
    process.exit(1);
  }
}

// ── backlog file existence check (warn, not error) ─────────────────────────

const backlogRelPath = raw.github?.backlogPath ?? 'atlas/backlog.json';
const absBacklog = resolve(backlogRelPath);
if (!existsSync(absBacklog)) {
  console.warn(`WARN: backlog file not yet present at ${absBacklog} — create it before deploying`);
}

// ── success ────────────────────────────────────────────────────────────────

console.log('atlas.config.json valid');
process.exit(0);
