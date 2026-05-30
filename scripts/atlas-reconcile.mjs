#!/usr/bin/env node
// template/scripts/atlas-reconcile.mjs
//
// DB-free task-status reconciler. Reads atlas/backlog.json and the GitHub
// Pulls API, maps each PR to a task via T-<n> patterns found in the PR title
// or branch ref, and writes the updated backlog back in-place.
//
// Named exports (pure, no I/O) are importable for unit tests:
//   taskIdFrom(text)                       → 'T-<n>' | null
//   applyPullsToBacklog(backlog, pulls)    → new backlog object (immutable)
//
// main() performs all I/O and is guarded with import.meta.url so it
// does NOT execute on import.

import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Pure named exports — safe to import without side effects
// ---------------------------------------------------------------------------

/**
 * Extract the first known task identifier from a string.
 *
 * Scheme-agnostic: rather than guessing at one regex, the function matches
 * against the actual task IDs from the backlog (passed as `knownIds`). This
 * means every ID scheme works out of the box:
 *
 *   - `T-42`        (classic ticket-style)
 *   - `T1.1.1`      (Prosci hierarchical)
 *   - `POE-123`     (Jira-style)
 *   - `P1-T01`      (compound)
 *   - anything else the project actually uses
 *
 * Match rules: the ID must appear with word-boundary edges on both sides —
 * so `T1.1.1` matches inside `feat(T1.1.1): something` but won't false-match
 * inside `T1.1.10`. Longer IDs win over shorter ones when both are present,
 * preventing `T1.1.1` from stealing a hit meant for `T1.1.10`.
 *
 * When `knownIds` is empty the legacy `T-<n>` regex is used as a fallback so
 * older test fixtures keep working.
 *
 * @param {string} text        - PR title, branch ref, or any free-form string
 * @param {string[]} [knownIds] - the actual task IDs from the backlog
 * @returns {string|null} e.g. 'T1.1.1', or null if no match
 */
export function taskIdFrom(text, knownIds) {
  if (typeof text !== 'string') return null

  if (Array.isArray(knownIds) && knownIds.length > 0) {
    // Sort by length desc so longer IDs are tried first.
    const sorted = [...knownIds].sort((a, b) => b.length - a.length)
    for (const id of sorted) {
      // Escape regex meta-chars in the id (dots especially).
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Word-boundary on both sides so we don't match T1.1.1 inside T1.1.10.
      const re = new RegExp(`\\b${escaped}\\b`)
      if (re.test(text)) return id
    }
    return null
  }

  // Legacy fallback — only fires when no knownIds were provided.
  const m = text.match(/\bT-(\d+)\b/)
  return m ? `T-${m[1]}` : null
}

/**
 * Find ALL known IDs that appear in a PR title or branch ref. Used for
 * multi-story claims where one PR can ship several story IDs together,
 * e.g. "feat(S1.1, S1.2): foundation bundle".
 *
 * @param {string} text
 * @param {string[]} knownIds
 * @returns {string[]} matched IDs (deduplicated, longer IDs preferred — no
 *   false-match of T1.1.1 inside T1.1.10)
 */
export function taskIdsFrom(text, knownIds) {
  if (typeof text !== 'string') return []
  if (!Array.isArray(knownIds) || knownIds.length === 0) {
    const single = taskIdFrom(text, knownIds)
    return single ? [single] : []
  }
  // Sort by length desc so we match longer IDs first and don't double-count
  // an ID that's a prefix of another (T1.1.1 inside T1.1.10).
  const sorted = [...knownIds].sort((a, b) => b.length - a.length)
  const matched = new Set()
  let remaining = text
  for (const id of sorted) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'g')
    if (re.test(remaining)) {
      matched.add(id)
      // Black out the matched span(s) so a shorter prefix-ID can't match
      // inside the same place again.
      remaining = remaining.replace(re, '#'.repeat(id.length))
    }
  }
  return [...matched]
}

/** PR state derivation shared between story-level and task-level updates.
 *  Populates claimed_by from the PR author (pr.user.login) — this is what
 *  the viewer's People section aggregates on. The merging actor takes
 *  precedence on merged PRs (the person who actually shipped it). */
function deriveFromPr(pr) {
  const author = pr.user?.login ?? null
  const merger = pr.merged_by?.login ?? null
  if (pr.merged_at) {
    return {
      status: 'merged',
      state: 'merged',
      pr_number: pr.number,
      merged_at: pr.merged_at,
      pr_url: pr.html_url,
      claimed_by: merger ?? author,
    }
  }
  if (pr.state === 'open' && !pr.draft) {
    return {
      status: 'in_progress',
      state: 'pr_open',
      pr_number: pr.number,
      pr_url: pr.html_url,
      claimed_by: author,
    }
  }
  if (pr.state === 'closed' && !pr.merged_at) {
    // Closed-without-merge — treat as blocked. Devs / orchestrator can re-open
    // the PR to clear the state.
    return {
      status: 'blocked',
      state: 'blocked',
      pr_number: pr.number,
      pr_url: pr.html_url,
      claimed_by: author,
    }
  }
  // draft PR
  return {
    status: 'in_progress',
    state: 'claimed',
    pr_number: pr.number,
    pr_url: pr.html_url,
    claimed_by: author,
  }
}

/**
 * Apply a list of GitHub pull-request objects to a backlog, returning a new
 * backlog with updated story AND task statuses. Pure — does not mutate input.
 *
 * Matching rules (in order of precedence):
 *   1. A PR title containing one or more story IDs (e.g. `feat(S1.1, S1.2)`)
 *      updates each matched story + propagates state to all child tasks.
 *   2. A PR title containing a `claim_id` (e.g. `feat(C-001)`) updates every
 *      story carrying that claim_id + propagates to their tasks.
 *   3. A PR title containing only task IDs updates those tasks individually
 *      (legacy task-level model; the parent story state is rolled up later
 *      by the viewer).
 *
 * Merged PRs always beat open ones for the same target.
 *
 * @param {object} backlog - source backlog (may include stories[] + tasks[])
 * @param {object[]} pulls - GitHub PR objects
 * @returns {object} new backlog (immutable)
 */
export function applyPullsToBacklog(backlog, pulls) {
  const stories = Array.isArray(backlog.stories) ? backlog.stories : []
  // Retired stories — superseded or deferred — are NOT matchable against PRs.
  // A PR landing for an old superseded id should be a no-op; the work has
  // moved to the successor story / claim.
  const isRetired = (s) =>
    (Array.isArray(s.superseded_by) && s.superseded_by.length > 0) ||
    Boolean(s.deferred_reason)
  const activeStoryIds = stories.filter((s) => !isRetired(s)).map((s) => s.id)
  const taskIds = backlog.tasks.map((t) => t.id)
  const claimIds = [...new Set(stories.filter((s) => !isRetired(s)).map((s) => s.claim_id).filter(Boolean))]
  // Variable kept for clarity below — same value, named so the intent reads.
  const storyIds = activeStoryIds

  // Dictionary the matcher uses — story + claim IDs preferred over task IDs.
  const knownIds = [...storyIds, ...claimIds, ...taskIds]

  // best PR per target ID — prefer merged over open
  const bestPrByStory = new Map() // story_id  → pr
  const bestPrByClaim = new Map() // claim_id  → pr
  const bestPrByTask  = new Map() // task_id   → pr

  const storyIdSet = new Set(storyIds)
  const claimIdSet = new Set(claimIds)

  const promoteBetter = (map, id, pr) => {
    const existing = map.get(id)
    if (!existing || (!existing.merged_at && pr.merged_at)) map.set(id, pr)
  }

  for (const pr of pulls) {
    const hits = new Set([
      ...taskIdsFrom(pr.title, knownIds),
      ...taskIdsFrom(pr.head?.ref, knownIds),
    ])
    if (hits.size === 0) continue
    for (const id of hits) {
      if (storyIdSet.has(id))      promoteBetter(bestPrByStory, id, pr)
      else if (claimIdSet.has(id)) promoteBetter(bestPrByClaim, id, pr)
      else                         promoteBetter(bestPrByTask,  id, pr)
    }
  }

  // Expand claim matches → stories sharing that claim_id
  for (const [claimId, pr] of bestPrByClaim) {
    for (const s of stories) {
      if (s.claim_id === claimId) promoteBetter(bestPrByStory, s.id, pr)
    }
  }

  // Apply story-level updates.
  // For retired stories (superseded or deferred): CLEAR any stale PR state
  // that may have been recorded before the story was retired. The reconciler
  // never matches new PRs to retired stories, but legacy state lingers
  // otherwise and shows up as a "merged" badge on a deferred card.
  const updatedStories = stories.map((s) => {
    if (isRetired(s)) {
      return {
        ...s,
        // Preserve content + retirement fields; clear PR state.
        pr_number: null,
        pr_url: null,
        merged_at: null,
        // Reset state to the canonical retirement state:
        //   deferred  → keep `blocked` (the canonical deferred state)
        //   superseded → `queued` (no work happens here anymore)
        state: s.deferred_reason ? 'blocked' : 'queued',
        status: s.deferred_reason ? 'deferred' : 'pending',
        // Clear claimed_by (the prior owner moved to the successor).
        claimed_by: null,
      }
    }
    const pr = bestPrByStory.get(s.id)
    if (!pr) return { ...s }

    const updated = { ...s, ...deriveFromPr(pr) }

    // v1.8.1+ — capture actual AI-hours on merge. Window is pr.created_at
    // → pr.merged_at; this is the cleanest proxy for "AI agent worked on
    // this story" because the PR open is the canonical claim signal.
    // (Earlier signals — branch push, first commit — also work but
    // require extra API calls; PR-open is on the PR object we already
    // have.) Only writes when the PR is merged AND actual_ai_hours
    // isn't already set (don't overwrite a manually-curated value).
    if (
      pr.merged_at &&
      pr.created_at &&
      typeof s.actual_ai_hours !== 'number'
    ) {
      const startMs = Date.parse(pr.created_at)
      const endMs = Date.parse(pr.merged_at)
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        updated.actual_ai_hours = +((endMs - startMs) / 3_600_000).toFixed(2)
      }
    }
    return updated
  })

  // Apply task-level updates: story PRs cascade to child tasks; otherwise the
  // task may have its own PR (legacy mode).
  const storyPrById = new Map()
  for (const s of updatedStories) {
    const pr = bestPrByStory.get(s.id)
    if (pr) storyPrById.set(s.id, pr)
  }

  const updatedTasks = backlog.tasks.map((task) => {
    // Story-level PR cascades first.
    if (task.story_id && storyPrById.has(task.story_id)) {
      const pr = storyPrById.get(task.story_id)
      return { ...task, ...deriveFromPr(pr) }
    }
    // Otherwise task may have its own PR (legacy task-level model).
    const pr = bestPrByTask.get(task.id)
    if (!pr) return { ...task }
    return { ...task, ...deriveFromPr(pr) }
  })

  return { ...backlog, stories: updatedStories, tasks: updatedTasks }
}

// ---------------------------------------------------------------------------
// Network helper — not unit-tested
// ---------------------------------------------------------------------------

/**
 * Fetch all pull requests (open + closed) from the GitHub API.
 *
 * @param {string} repo  - 'owner/repo'
 * @param {string} token - GitHub personal access token or GITHUB_TOKEN
 * @returns {Promise<object[]>}
 */
async function fetchPulls(repo, token) {
  const url = `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'atlas',
    },
  })
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText} — ${url}`)
  }
  return res.json()
}

/**
 * Fetch all branches (paginated). Used to detect claim state from a pushed
 * feature branch BEFORE a PR exists. Closes the gap where a dev has
 * checked out `feat/S1.2-foo` and pushed it but hasn't opened a PR yet —
 * without this step, the Atlas viewer shows S1.2 as still queued even
 * though work is underway.
 */
async function fetchBranches(repo, token) {
  const out = []
  let page = 1
  // Cap at 5 pages (500 branches) so the reconciler is bounded even on
  // pathological repos with thousands of stale branches.
  for (; page <= 5; page++) {
    const url = `https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'atlas',
      },
    })
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText} — ${url}`)
    }
    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

/**
 * Resolve a branch's head-commit author.
 *
 * The /repos/{repo}/branches LIST endpoint returns only { commit: { sha,
 * url } } — no author info. To get the author login we have to follow
 * the commit URL (or hit /repos/{repo}/commits/{sha} directly). Cached
 * per-sha so two branches pointing at the same commit only cost one
 * lookup.
 */
const commitAuthorCache = new Map() // sha → { login: string | null } (or null = lookup failed)

async function resolveCommitAuthor(repo, token, sha) {
  if (!sha) return null
  if (commitAuthorCache.has(sha)) return commitAuthorCache.get(sha)
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'atlas',
        },
      },
    )
    if (!res.ok) {
      commitAuthorCache.set(sha, null)
      return null
    }
    const c = await res.json()
    const login = c?.author?.login ?? c?.committer?.login ?? null
    commitAuthorCache.set(sha, { login })
    return { login }
  } catch {
    commitAuthorCache.set(sha, null)
    return null
  }
}

/**
 * Take the PR-reconciled backlog and overlay claim-from-branch state on
 * any story/claim that has a matching pushed branch but no covering PR.
 * Stories already in a state derived from a PR (working / in_review /
 * merged / blocked / closed-without-merge) are NOT downgraded — the PR
 * is always the stronger signal.
 *
 * The branch match closes the gap: dev checks out `feat/S1.2-foo`,
 * pushes it, runs `git push -u origin feat/S1.2-foo` — within ~30s
 * (the push-trigger reconcile), the Atlas viewer flips S1.2 from
 * 'queued' to 'claimed' with claimed_by + worktree_branch set, even
 * without a draft PR.
 *
 * @param {object} backlog   - backlog already updated by applyPullsToBacklog
 * @param {object[]} branches - GitHub branch objects from fetchBranches
 * @param {Map<string,string>} authorBySha - optional sha → gh-login map.
 *   The List Branches endpoint doesn't return author info; main() resolves
 *   it from /repos/{repo}/commits/{sha} and passes the map here so the
 *   transform stays pure. Tests pass an empty map (or a stubbed one).
 * @returns {object} new backlog (immutable)
 */
export function applyBranchesToBacklog(backlog, branches, authorBySha = new Map()) {
  const stories = Array.isArray(backlog.stories) ? backlog.stories : []
  if (stories.length === 0 || !Array.isArray(branches) || branches.length === 0) {
    return backlog
  }

  const isRetired = (s) =>
    (Array.isArray(s.superseded_by) && s.superseded_by.length > 0) ||
    Boolean(s.deferred_reason)

  // States the branch signal can NOT override — these are derived from a
  // real PR and carry stronger signal. The branch overlay only fires when
  // the story is otherwise in a queued/empty state.
  const PR_DERIVED_STATES = new Set([
    'pr_open',
    'in_review',
    'ci_running',
    'ci_passed',
    'ci_failed',
    'merged',
    'verified',
    'working',
    'blocked',
  ])

  const activeIds = new Set(
    stories.filter((s) => !isRetired(s)).map((s) => s.id),
  )
  const claimIds = new Set(
    stories
      .filter((s) => !isRetired(s))
      .map((s) => s.claim_id)
      .filter(Boolean),
  )
  const knownIds = [...activeIds, ...claimIds]
  if (knownIds.length === 0) return backlog

  // Group matched branches by story/claim id. Most-recent commit wins
  // when multiple branches match the same id (latest claim).
  const bestBranchByStory = new Map() // story_id → { branch, commitTime }
  const bestBranchByClaim = new Map() // claim_id → { branch, commitTime }

  const promote = (map, id, branch) => {
    const time = branch?.commit?.commit?.committer?.date
      ? new Date(branch.commit.commit.committer.date).getTime()
      : 0
    const existing = map.get(id)
    if (!existing || existing.commitTime < time) {
      map.set(id, { branch, commitTime: time })
    }
  }

  for (const branch of branches) {
    const name = branch?.name
    if (!name) continue
    const hits = taskIdsFrom(name, knownIds)
    if (hits.length === 0) continue
    for (const id of hits) {
      if (activeIds.has(id)) promote(bestBranchByStory, id, branch)
      else if (claimIds.has(id)) promote(bestBranchByClaim, id, branch)
    }
  }

  // Expand claim matches → every story sharing that claim_id
  for (const [claimId, hit] of bestBranchByClaim) {
    for (const s of stories) {
      if (s.claim_id === claimId && !bestBranchByStory.has(s.id)) {
        bestBranchByStory.set(s.id, hit)
      }
    }
  }

  if (bestBranchByStory.size === 0) return backlog

  const updatedStories = stories.map((s) => {
    const hit = bestBranchByStory.get(s.id)
    if (!hit) return s
    // Don't downgrade a PR-derived state.
    if (s.state && PR_DERIVED_STATES.has(s.state)) return s
    if (isRetired(s)) return s
    const { branch } = hit
    const author = authorBySha.get(branch?.commit?.sha) ?? null
    return {
      ...s,
      state: 'claimed',
      status: 'in_progress',
      claimed_by: author ?? s.claimed_by ?? null,
      worktree_branch: branch.name,
    }
  })

  // Cascade to child tasks of stories the branch overlay just updated,
  // matching the PR-cascade semantics in applyPullsToBacklog. Only touch
  // tasks whose parent story flipped to claimed via the branch overlay
  // AND whose own state is also not PR-derived.
  const storiesFlippedById = new Map()
  for (const s of updatedStories) {
    const prev = stories.find((x) => x.id === s.id)
    if (prev && prev.state !== s.state && s.state === 'claimed') {
      storiesFlippedById.set(s.id, s)
    }
  }

  const updatedTasks = (Array.isArray(backlog.tasks) ? backlog.tasks : []).map((t) => {
    if (!t.story_id || !storiesFlippedById.has(t.story_id)) return t
    if (t.state && PR_DERIVED_STATES.has(t.state)) return t
    const parent = storiesFlippedById.get(t.story_id)
    return {
      ...t,
      state: 'claimed',
      status: 'in_progress',
      claimed_by: parent.claimed_by ?? t.claimed_by ?? null,
      worktree_branch: parent.worktree_branch ?? t.worktree_branch ?? null,
    }
  })

  return { ...backlog, stories: updatedStories, tasks: updatedTasks }
}

// ---------------------------------------------------------------------------
// main() — performs all I/O; guarded to not run on import
// ---------------------------------------------------------------------------

async function main() {
  // Config: read github.repo from atlas/atlas.config.json
  let config = {}
  try {
    config = JSON.parse(readFileSync('atlas/atlas.config.json', 'utf8'))
  } catch {
    // file absent or invalid — handled below
  }

  const repo = config?.github?.repo
  const token = process.env.GITHUB_TOKEN ?? process.env.ATLAS_GITHUB_TOKEN

  if (!repo || !token) {
    if (!repo) console.warn('[atlas-reconcile] Warning: github.repo not set in atlas/atlas.config.json — skipping.')
    if (!token) console.warn('[atlas-reconcile] Warning: GITHUB_TOKEN / ATLAS_GITHUB_TOKEN not set — skipping.')
    process.exit(0)
  }

  const backlogPath = config?.github?.backlogPath ?? 'atlas/backlog.json'
  let backlog = { tasks: [] }
  try {
    backlog = JSON.parse(readFileSync(backlogPath, 'utf8'))
  } catch {
    console.warn(`[atlas-reconcile] Warning: could not read ${backlogPath} — starting with empty task list.`)
  }

  const pulls = await fetchPulls(repo, token)
  const fromPulls = applyPullsToBacklog(backlog, pulls)

  // Branch overlay closes the no-PR-yet gap. Fail-soft: if the branches
  // endpoint flakes, we still ship the PR-derived state.
  let branches = []
  try {
    branches = await fetchBranches(repo, token)
  } catch (e) {
    console.warn(`[atlas-reconcile] Branch fetch failed — continuing with PR-only state. ${e.message}`)
  }

  // Pre-resolve commit authors for branches whose names match a known
  // story / claim id. The List Branches endpoint doesn't return author
  // info; each commit requires a follow-up /repos/{repo}/commits/{sha}
  // call. Cap at 30 author lookups per reconcile run so a repo with
  // hundreds of stale feat branches doesn't burn API budget.
  const authorBySha = new Map()
  const activeStoryIds = (fromPulls.stories ?? [])
    .filter((s) => !((Array.isArray(s.superseded_by) && s.superseded_by.length > 0) || s.deferred_reason))
    .map((s) => s.id)
  const activeClaimIds = [
    ...new Set(
      (fromPulls.stories ?? [])
        .filter((s) => !((Array.isArray(s.superseded_by) && s.superseded_by.length > 0) || s.deferred_reason))
        .map((s) => s.claim_id)
        .filter(Boolean),
    ),
  ]
  const knownForBranches = [...activeStoryIds, ...activeClaimIds]
  let lookupBudget = 30
  for (const branch of branches) {
    if (lookupBudget <= 0) break
    if (taskIdsFrom(branch.name, knownForBranches).length === 0) continue
    const sha = branch?.commit?.sha
    if (!sha || authorBySha.has(sha)) continue
    const resolved = await resolveCommitAuthor(repo, token, sha)
    if (resolved?.login) {
      authorBySha.set(sha, resolved.login)
    } else {
      authorBySha.set(sha, null)
    }
    lookupBudget--
  }

  const updated = applyBranchesToBacklog(fromPulls, branches, authorBySha)
  updated.generated_at = new Date().toISOString()

  // Visibility: log how many stories got claim state from branch overlay.
  const branchClaimed = updated.stories?.filter((s) => {
    const prev = fromPulls.stories?.find((x) => x.id === s.id)
    return prev && prev.state !== s.state && s.state === 'claimed' && s.worktree_branch
  }) ?? []
  if (branchClaimed.length) {
    console.log(`[atlas-reconcile] Branch overlay: ${branchClaimed.length} ${branchClaimed.length === 1 ? 'story' : 'stories'} flipped to claimed from a pushed feat branch — ${branchClaimed.map((s) => `${s.id}@${s.worktree_branch}`).join(', ')}`)
  }

  writeFileSync(backlogPath, JSON.stringify(updated, null, 2) + '\n')
  console.log(`[atlas-reconcile] Wrote ${backlogPath} (${updated.tasks.length} tasks, ${pulls.length} PRs, ${branches.length} branches processed)`)
}

// Guard: only run main() when executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
