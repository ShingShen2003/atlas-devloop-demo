#!/usr/bin/env node
// template/scripts/atlas-seed.mjs
//
// One-shot backlog seeder. Reads atlas/atlas.config.json for github.repo, fetches
// every PR from the GitHub API, and writes atlas/backlog.json from scratch.
//
// Mapping rules (PR → task):
//   id           — from `(T-NN)`, `(POE-NN)`, or `T-NN` pattern in PR title or
//                  branch ref; falls back to `PR-<number>`
//   title        — PR title with the task-ID prefix stripped
//   module       — first label matching `module:<name>` or `mod:<name>`,
//                  else "General"
//   phase        — first label matching `phase:<int>` or `p:<int>`, else 1
//   status       — PR merged → "merged"; PR open → "in_progress"; closed → "deferred"
//   state        — PR merged → "merged"; draft → "claimed"; open non-draft → "pr_open";
//                  closed (not merged) → "blocked"
//   claimed_by   — PR user.login
//   merged_at    — PR merged_at (when set)
//   pr_url       — PR html_url
//   pr_number    — PR number
//   events       — synthesized: "opened" event at created_at, optional "merged" at merged_at
//
// Safety: refuses to overwrite an existing atlas/backlog.json unless --force.
//
// Auth resolution (first that succeeds wins):
//   1. process.env.GITHUB_TOKEN
//   2. process.env.ATLAS_GITHUB_TOKEN
//   3. `gh auth token` (the gh CLI's stored token) — works locally without env vars
//
// Empty repo (zero PRs returned): writes a minimum-viable stub with one queued
// task so the page renders a clean Phase 1 instead of an empty state.
//
// Usage:
//   node scripts/atlas-seed.mjs                # write if backlog.json absent
//   node scripts/atlas-seed.mjs --force        # overwrite existing
//   node scripts/atlas-seed.mjs --dry-run      # print to stdout, don't write
//   node scripts/atlas-seed.mjs --config PATH  # custom config path
//
// Pure helpers (named exports) are importable for tests; main() guards I/O
// behind an import.meta.url check.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Extract task ID from a PR title or branch ref. Returns null if none found. */
export function taskIdFrom(text) {
  if (typeof text !== 'string') return null
  // Order matters: (T-NN) takes priority over bare T-NN to avoid catching the
  // wrong instance when both are present.
  const paren = text.match(/\(([A-Z]{1,4}[-.]?\d+(?:\.\d+)*)\)/)
  if (paren) return paren[1].toUpperCase()
  const bare = text.match(/\b([A-Z]{1,4}-\d+)\b/)
  if (bare) return bare[1].toUpperCase()
  return null
}

/** Pull `phase:N` and `module:Foo` from a PR's labels. Returns { phase, module }. */
export function metaFromLabels(labels) {
  let phase = 1
  let mod = null
  for (const l of labels ?? []) {
    const name = typeof l === 'string' ? l : l?.name
    if (!name) continue
    const phaseM = name.match(/^(?:phase|p):\s*(\d+)$/i)
    if (phaseM) phase = Number(phaseM[1])
    const modM = name.match(/^(?:module|mod):\s*(.+)$/i)
    if (modM && !mod) mod = modM[1].trim()
  }
  return { phase, module: mod ?? 'General' }
}

/** Derive Atlas { status, state } from a PR API object. */
export function deriveStatusAndState(pr) {
  if (pr.merged_at) return { status: 'merged', state: 'merged' }
  if (pr.state === 'closed') return { status: 'deferred', state: 'blocked' }
  if (pr.draft) return { status: 'in_progress', state: 'claimed' }
  if (pr.state === 'open') return { status: 'in_progress', state: 'pr_open' }
  return { status: 'pending', state: 'queued' }
}

/** Strip a leading task-ID prefix from a PR title. */
export function stripTaskIdPrefix(title, id) {
  if (!id) return (title ?? '').trim()
  const t = (title ?? '').trim()
  // Patterns to strip: "(T-1) ", "T-1: ", "T-1 — ", "[T-1] "
  const patterns = [
    new RegExp(`^\\(${id}\\)\\s*[:\\-–—]?\\s*`),
    new RegExp(`^${id}\\s*[:\\-–—]\\s*`),
    new RegExp(`^\\[${id}\\]\\s*`),
  ]
  for (const p of patterns) {
    if (p.test(t)) return t.replace(p, '').trim()
  }
  return t
}

/** Transform one PR API response into one Atlas task. */
export function prToTask(pr) {
  const idFromTitle = taskIdFrom(pr.title)
  const idFromBranch = taskIdFrom(pr.head?.ref ?? '')
  const id = idFromTitle ?? idFromBranch ?? `PR-${pr.number}`
  const title = stripTaskIdPrefix(pr.title, id) || pr.title || `PR #${pr.number}`
  const { phase, module: mod } = metaFromLabels(pr.labels)
  const { status, state } = deriveStatusAndState(pr)

  const events = [{
    timestamp: pr.created_at,
    type: 'state_change',
    actor: pr.user?.login,
    message: `PR #${pr.number} opened`,
  }]
  if (pr.merged_at) {
    events.push({
      timestamp: pr.merged_at,
      type: 'state_change',
      actor: pr.merged_by?.login ?? pr.user?.login,
      message: `merged to ${pr.base?.ref ?? 'main'}`,
    })
  } else if (pr.state === 'closed' && pr.closed_at) {
    events.push({
      timestamp: pr.closed_at,
      type: 'state_change',
      message: 'PR closed without merging',
    })
  }

  return {
    id,
    title,
    module: mod,
    phase,
    status,
    state,
    claimed_by: pr.user?.login ?? null,
    merged_at: pr.merged_at ?? null,
    pr_url: pr.html_url,
    pr_number: pr.number,
    events,
  }
}

/** Build the modules[] array from a derived task list. */
export function modulesFromTasks(tasks) {
  const seen = new Map()
  for (const t of tasks) {
    if (!seen.has(t.module)) {
      seen.set(t.module, { id: `M${seen.size + 1}`, name: t.module })
    }
  }
  return [...seen.values()]
}

/** Greenfield stub — used when a repo has zero PRs. */
export function greenfieldStub(repoName) {
  return {
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source_prd: 'greenfield-stub',
    modules: [{ id: 'M1', name: 'Foundation' }],
    tasks: [
      {
        id: 'T-001',
        title: 'Define first PRD slice',
        module: 'Foundation',
        phase: 1,
        status: 'pending',
        state: 'queued',
        events: [],
      },
    ],
    _note: repoName ? `Seeded from ${repoName} — repo had zero PRs.` : 'Seeded with greenfield stub.',
  }
}

/** Build the final backlog object from a list of fetched PRs. */
export function buildBacklog(pulls, { repoName } = {}) {
  if (!Array.isArray(pulls) || pulls.length === 0) return greenfieldStub(repoName)
  const tasks = pulls.map(prToTask).sort((a, b) => {
    if (a.phase !== b.phase) return a.phase - b.phase
    return a.id.localeCompare(b.id, undefined, { numeric: true })
  })
  return {
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source_prd: `seeded-from-github:${repoName ?? 'unknown'}`,
    modules: modulesFromTasks(tasks),
    tasks,
  }
}

// ---------------------------------------------------------------------------
// I/O — only runs when invoked directly
// ---------------------------------------------------------------------------

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN env' }
  if (process.env.ATLAS_GITHUB_TOKEN) return { token: process.env.ATLAS_GITHUB_TOKEN, source: 'ATLAS_GITHUB_TOKEN env' }
  // Fallback to the gh CLI's stored token. Lets local dogfood runs work without
  // setting env vars — the user's `gh auth login` already covers this.
  try {
    const tok = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (tok) return { token: tok, source: 'gh auth token' }
  } catch { /* gh not installed or not authed — fall through */ }
  return { token: null, source: null }
}

async function fetchAllPulls(repo, token) {
  // Paginate through 100-at-a-time results until an empty page comes back.
  const all = []
  let page = 1
  // Safety cap so a runaway never floods.
  while (page < 50) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100&page=${page}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'atlas-seed',
      },
    })
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText} — ${url}`)
    }
    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < 100) break
    page += 1
  }
  return all
}

function parseArgs(argv) {
  const flags = { force: false, dryRun: false, configPath: 'atlas/atlas.config.json' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force' || a === '-f') flags.force = true
    else if (a === '--dry-run' || a === '-n') flags.dryRun = true
    else if (a === '--config' && argv[i + 1]) { flags.configPath = argv[++i] }
  }
  return flags
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))

  let config
  try {
    config = JSON.parse(readFileSync(flags.configPath, 'utf8'))
  } catch (e) {
    console.error(`[atlas-seed] Could not read ${flags.configPath}: ${e.message}`)
    process.exit(1)
  }

  const repo = config?.github?.repo
  if (!repo) {
    console.error('[atlas-seed] github.repo not set in atlas.config.json — nothing to seed from.')
    console.error('               Set it via the install skill (Step 0) or edit the config directly.')
    process.exit(1)
  }

  const backlogPath = config?.github?.backlogPath ?? 'atlas/backlog.json'
  if (existsSync(backlogPath) && !flags.force && !flags.dryRun) {
    console.error(`[atlas-seed] Refusing to overwrite existing ${backlogPath}.`)
    console.error('               Re-run with --force to overwrite, or --dry-run to preview.')
    process.exit(2)
  }

  const { token, source } = resolveToken()
  if (!token) {
    console.error('[atlas-seed] No GitHub token available. Tried:')
    console.error('               1. GITHUB_TOKEN env var')
    console.error('               2. ATLAS_GITHUB_TOKEN env var')
    console.error('               3. `gh auth token` (gh CLI fallback)')
    console.error('               Set one, or run `gh auth login`, then retry.')
    process.exit(3)
  }

  console.log(`[atlas-seed] Authenticated via ${source}.`)
  console.log(`[atlas-seed] Fetching PRs from ${repo} …`)
  const pulls = await fetchAllPulls(repo, token)
  console.log(`[atlas-seed] Got ${pulls.length} PR(s).`)

  const backlog = buildBacklog(pulls, { repoName: repo })

  if (flags.dryRun) {
    console.log(JSON.stringify(backlog, null, 2))
    return
  }

  writeFileSync(backlogPath, JSON.stringify(backlog, null, 2) + '\n')
  console.log(`[atlas-seed] Wrote ${backlogPath} — ${backlog.tasks.length} task(s), ${backlog.modules.length} module(s).`)
  if (pulls.length === 0) {
    console.log('[atlas-seed] Note: repo has zero PRs; wrote a greenfield stub.')
    console.log('             As soon as you open a PR with `T-NN` in the title, the reconciler will pick it up.')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
