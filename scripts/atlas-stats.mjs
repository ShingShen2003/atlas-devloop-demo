#!/usr/bin/env node
// template/scripts/atlas-stats.mjs
//
// Generates atlas/engineering-stats.json (or $ATLAS_STATS_OUT) with live
// engineering velocity stats. Config-driven: reads backlog path and lessons
// paths from atlas/atlas.config.json. phases_shipped is derived from the
// backlog (count of distinct phases whose tasks are ALL merged). Falls back
// to null if the backlog has no phase data.
//
// Named exports (pure, no I/O) are importable for unit tests:
//   countMergesFromBacklog(backlog, {now?, windowDays?})  → {total}
//   isExcluded(filePath, excludes)                        → boolean
//   computeLoc(numstatText, excludes)                     → {total_net, ...}
//
// main() writes the output file and is guarded with import.meta.url so it
// does NOT execute on import.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Inline config reader — self-contained after install; no plugin-lib import.
// ---------------------------------------------------------------------------
function readAtlasConfig(path = 'atlas/atlas.config.json') {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

// ---------------------------------------------------------------------------
// Default noise excludes — generic paths; extend via config.stats.noiseExcludes.
// ---------------------------------------------------------------------------
// Default noise excludes — what we never want counted as "project code":
//
//   1. Atlas's own footprint inside the target repo. `atlas/` (the viewer + its
//      data + bundles), `scripts/atlas-*.mjs` (plugin-shipped helpers), and
//      `api/backlog.mjs` (the optional Vercel read-through) are all plugin
//      scaffolding. Including them inflates LOC with code the project team
//      didn't write — exactly the opposite of what the stats panel is for.
//
//   2. CI / config files. `.github/workflows/*.{yml,yaml}` are infrastructure
//      glue, not feature code. Same for top-level lockfiles.
//
//   3. Auto-regenerated reports + tooling caches.
//
// Projects can extend this list via `atlas.config.json#/stats.noiseExcludes`
// for project-specific patterns (e.g. "*.snap", "*.generated.ts").
const DEFAULT_NOISE_EXCLUDES = [
  // Atlas scaffolding inside the target repo
  'atlas/*',
  'scripts/atlas-stats.mjs',
  'scripts/atlas-diagrams.mjs',
  'scripts/atlas-reconcile.mjs',
  'scripts/atlas-seed.mjs',
  'scripts/validate-config.mjs',
  'scripts/validate-backlog.mjs',
  'api/backlog.mjs',
  // CI / workflow YAML — infrastructure glue, not feature code
  '.github/workflows/atlas-reconcile.yml',
  '*.yml',
  '*.yaml',
  // Stub the script used to write
  'public/engineering-stats.json',
  // Lockfiles
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]

// ---------------------------------------------------------------------------
// Pure named exports — safe to import without side effects
// ---------------------------------------------------------------------------

/**
 * Returns true if filePath matches any entry in the excludes list.
 * Supports exact path match and simple suffix/glob match (same semantics
 * used when building git pathspecs): if an exclude starts with a glob
 * wildcard `*` the suffix is checked; otherwise exact equality.
 *
 * @param {string} filePath   - path from numstat (e.g. "src/app.ts")
 * @param {string[]} excludes - plain path strings (no git :(exclude) syntax)
 * @returns {boolean}
 */
export function isExcluded(filePath, excludes) {
  for (const ex of excludes) {
    if (ex.startsWith('*')) {
      // Suffix glob: "*.snap" → match any path ending in ".snap" (recursive).
      if (filePath.endsWith(ex.slice(1))) return true
    } else if (ex.endsWith('/*')) {
      // Directory glob: "atlas/*" → match anything under that directory at any depth.
      const prefix = ex.slice(0, -1) // keep the trailing slash → "atlas/"
      if (filePath.startsWith(prefix)) return true
    } else {
      // Exact match.
      if (filePath === ex) return true
    }
  }
  return false
}

/**
 * Parse `git log --numstat` output (plain text) and return LOC stats,
 * skipping lines whose filename appears in excludes.
 *
 * @param {string}   numstatText - raw stdout of git log --numstat
 * @param {string[]} excludes    - plain-path exclude list
 * @returns {{ total_net: number, total_additions: number, total_deletions: number }}
 */
export function computeLoc(numstatText, excludes) {
  let adds = 0
  let dels = 0
  for (const line of numstatText.split('\n')) {
    const parts = line.split('\t')
    if (parts.length !== 3) continue
    const a = Number(parts[0])
    const d = Number(parts[1])
    const filePath = parts[2].trim()
    // Binary files are reported as "-" — skip them
    if (!Number.isFinite(a) || !Number.isFinite(d)) continue
    if (isExcluded(filePath, excludes)) continue
    adds += a
    dels += d
  }
  return { total_net: adds - dels, total_additions: adds, total_deletions: dels }
}

/**
 * Count merged PRs from a backlog object. A task is counted as merged when
 * it has both `pr_number` and a non-null `merged_at` ISO timestamp.
 *
 * @param {object} backlog     - parsed backlog JSON (must have .tasks array)
 * @param {object} [opts]
 * @param {number} [opts.now]        - epoch ms for "now" (default Date.now())
 * @param {number} [opts.windowDays] - if provided, only count tasks merged
 *                                     within the last N days
 * @returns {{ total: number }}
 */
export function countMergesFromBacklog(backlog, { now = Date.now(), windowDays } = {}) {
  const tasks = Array.isArray(backlog?.tasks) ? backlog.tasks : []
  const cutoff = windowDays != null ? now - windowDays * 86_400_000 : null
  let total = 0
  for (const t of tasks) {
    if (!t?.pr_number || !t?.merged_at) continue
    if (cutoff !== null) {
      const ts = Date.parse(t.merged_at)
      if (!Number.isFinite(ts) || ts < cutoff) continue
    }
    total++
  }
  return { total }
}

/**
 * Count distinct phases in the backlog whose tasks are ALL merged.
 * Returns null if the backlog has no phase data or no fully-shipped phases.
 *
 * Derives phases_shipped directly from the authoritative backlog data
 * rather than from any hand-maintained HTML or config file.
 *
 * @param {object} backlog - parsed backlog JSON
 * @returns {number|null}
 */
function phasesShippedFromBacklog(backlog) {
  const tasks = Array.isArray(backlog?.tasks) ? backlog.tasks : []
  if (tasks.length === 0) return null

  // Group tasks by phase
  /** @type {Map<number, {total: number, merged: number}>} */
  const phases = new Map()
  for (const t of tasks) {
    const phase = t?.phase
    if (typeof phase !== 'number' || !Number.isFinite(phase)) continue
    const entry = phases.get(phase) ?? { total: 0, merged: 0 }
    entry.total++
    if (t.status === 'merged') entry.merged++
    phases.set(phase, entry)
  }

  if (phases.size === 0) return null

  let count = 0
  for (const { total, merged } of phases.values()) {
    if (total > 0 && total === merged) count++
  }
  return count > 0 ? count : null
}

// ---------------------------------------------------------------------------
// Runtime (I/O) helpers — only used inside main()
// ---------------------------------------------------------------------------

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function isShallowClone(cwd) {
  return sh('git rev-parse --is-shallow-repository', cwd) === 'true'
}

/**
 * Build the git pathspec excludes string from the merged noise list.
 * Converts plain paths to git :(exclude) pathspecs.
 */
function buildGitExcludes(noisePaths) {
  // Use git's `:(exclude,glob)` pathspec magic so `**` works recursively. For
  // a "atlas/*" pattern we want to exclude every depth under atlas/, not just
  // the immediate children — `:(exclude,glob)atlas/**` does that. For "*.yml"
  // we want it to apply to any depth too, so prefix with `**/`.
  return noisePaths
    .map((p) => {
      let pattern = p
      if (pattern.startsWith('*')) {
        pattern = `**/${pattern}` // *.yml → **/*.yml
      } else if (pattern.endsWith('/*')) {
        pattern = `${pattern.slice(0, -1)}**` // atlas/* → atlas/**
      }
      return `':(exclude,glob)${pattern}'`
    })
    .join(' ')
}

/**
 * Run git log --numstat for the given since-arg and return the raw text.
 */
function gitNumstat(sinceArg, noisePaths, cwd) {
  const since = sinceArg ? ` --since='${sinceArg}'` : ''
  const excludes = buildGitExcludes(noisePaths)
  return sh(`git log${since} --pretty=tformat: --numstat -- . ${excludes}`, cwd)
}

/**
 * Count '## ' section headers across the given markdown file paths.
 */
function lessonsCount(lessonsPaths, repoRoot) {
  let n = 0
  for (const f of lessonsPaths) {
    const p = join(repoRoot, f)
    if (!existsSync(p)) continue
    const txt = readFileSync(p, 'utf8')
    n += (txt.match(/^##\s/gm) || []).length
  }
  return n
}

// ---------------------------------------------------------------------------
// main() — writes the stats JSON; guarded to not run on import
// ---------------------------------------------------------------------------

async function main() {
  // Scripts run from the project root (cwd). All paths are resolved relative
  // to cwd — no __dirname climbing needed after install.
  const OUTPUT = process.env.ATLAS_STATS_OUT ?? 'atlas/engineering-stats.json'

  // Load atlas.config.json from the canonical installed location.
  const config = readAtlasConfig('atlas/atlas.config.json')

  // Resolved config values
  const backlogPath = config?.github?.backlogPath ?? 'atlas/backlog.json'

  // Lessons paths — overridable via config.stats.lessonsPaths (repo-relative).
  const lessonsPaths = config?.stats?.lessonsPaths ?? [
    'docs/operations/LESSONS.md',
  ]

  // Noise excludes: merge defaults + config overrides
  const configNoise = Array.isArray(config?.stats?.noiseExcludes) ? config.stats.noiseExcludes : []
  const noisePaths = [...DEFAULT_NOISE_EXCLUDES, ...configNoise]

  // Shallow clone detection — preserve prior LOC values if shallow
  const repoRoot = process.cwd()
  const shallow = isShallowClone(repoRoot)
  if (shallow) {
    console.warn('Shallow git clone detected — keeping previously-committed LOC values.')
  }

  let prior = null
  if (existsSync(OUTPUT)) {
    try { prior = JSON.parse(readFileSync(OUTPUT, 'utf8')) } catch { /* */ }
  }

  function locOrPrior(sinceArg, priorKey) {
    if (shallow && prior?.loc) {
      return {
        total_net: prior.loc[priorKey + '_net'] ?? prior.loc[priorKey + '_additions'] ?? 0,
        total_additions: prior.loc[priorKey + '_additions'] ?? 0,
        total_deletions: 0,
      }
    }
    return computeLoc(gitNumstat(sinceArg, noisePaths, repoRoot), noisePaths)
  }

  // LOC windows
  const allTime = locOrPrior(null, 'total')
  const last7d = locOrPrior('7 days ago', 'last_7d')
  const last24h = locOrPrior('24 hours ago', 'last_24h')

  // Backlog-derived merge counts
  let backlog = { tasks: [] }
  if (existsSync(backlogPath)) {
    try { backlog = JSON.parse(readFileSync(backlogPath, 'utf8')) } catch { /* */ }
  }

  const now = Date.now()
  const merges = {
    total: countMergesFromBacklog(backlog).total,
    last_24h: countMergesFromBacklog(backlog, { now, windowDays: 1 }).total,
    last_7d: countMergesFromBacklog(backlog, { now, windowDays: 7 }).total,
  }

  const stats = {
    generated_at: new Date().toISOString(),
    loc: {
      total_net: allTime.total_net,
      last_7d_net: last7d.total_net,
      last_24h_net: last24h.total_net,
      total_additions: allTime.total_additions,
      total_deletions: allTime.total_deletions,
      last_7d_additions: last7d.total_additions,
      last_24h_additions: last24h.total_additions,
      per_day_7d_net: Math.round(last7d.total_net / 7),
    },
    merges,
    phases_shipped: phasesShippedFromBacklog(backlog),
    lessons_recorded: lessonsCount(lessonsPaths, repoRoot),
  }

  writeFileSync(OUTPUT, JSON.stringify(stats, null, 2) + '\n')
  console.log(`Wrote ${OUTPUT}`)
  console.log(JSON.stringify(stats, null, 2))
}

// Guard: only run main() when executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
