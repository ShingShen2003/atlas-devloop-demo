#!/usr/bin/env node
// template/scripts/atlas-compliance.mjs
//
// Called by .github/workflows/atlas-compliance.yml on PR open/sync/reopen.
// Two responsibilities:
//
//   1. Inspect the PR (title + branch ref) against the live backlog state
//      on the atlas-state branch. Extract any story / claim / task IDs that
//      match. Exit non-zero (failed check) if none match.
//
//   2. Compose a comment for the PR with: matched story title + acceptance
//      checklist + linked KB articles (titles + summaries from kb/_index.json)
//      + sibling stories under the same claim. POST the comment via the
//      GitHub API (or update an existing atlas-compliance comment in place).
//
// Inputs (all required):
//   GITHUB_TOKEN       — provided by Actions
//   GITHUB_REPOSITORY  — "owner/repo"
//   PR_NUMBER          — the PR being checked
//   PR_TITLE           — the PR's title (passed by the workflow)
//   PR_BRANCH          — the PR head ref
//
// Pure-Node, no external deps. Re-uses applyPullsToBacklog's matching style
// indirectly by importing taskIdsFrom from atlas-reconcile.mjs.

import { readFileSync } from 'node:fs'
import { taskIdsFrom } from './atlas-reconcile.mjs'

const REPO = process.env.GITHUB_REPOSITORY
const PR_NUMBER = process.env.PR_NUMBER
const PR_TITLE = process.env.PR_TITLE ?? ''
const PR_BRANCH = process.env.PR_BRANCH ?? ''
const TOKEN = process.env.GITHUB_TOKEN

/**
 * PRs labeled `atlas:backlog-change` are mutating the backlog itself —
 * adding stories or tasks (via `/atlas-update --add`), splitting them,
 * etc. For those PRs we MUST read backlog.json from the PR's head branch,
 * not from main, otherwise a new id added in the PR diff isn't visible to
 * the dictionary lookup and the PR would fail its own check.
 */
const BACKLOG_CHANGE_LABEL = 'atlas:backlog-change'
const FEEDBACK_CHANGE_LABEL = 'atlas:feedback-change'
const GUARDRAIL_SYNC_LABEL = 'atlas:guardrail-sync'

if (!REPO || !PR_NUMBER || !TOKEN) {
  console.error('[atlas-compliance] Missing required env: GITHUB_REPOSITORY, PR_NUMBER, GITHUB_TOKEN')
  process.exit(2)
}

const COMMENT_MARKER = '<!-- atlas-compliance-comment -->'

// ── GitHub API helpers ─────────────────────────────────────────────────────
async function gh(path, init = {}) {
  const url = `https://api.github.com${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'atlas-compliance',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status}: ${res.statusText} — ${path} — ${body.slice(0, 200)}`)
  }
  return res
}

async function getJson(path) { return (await gh(path)).json() }

async function getRawFile(repo, ref, path) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'atlas-compliance',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`fetch ${path}@${ref} failed: ${res.status}`)
  return res.text()
}

// ── Resolve config to find the state branch + kb path ─────────────────────
async function loadConfig() {
  // Try local checkout first (the workflow runs in main's worktree); fall
  // back to a fresh fetch only if the local copy isn't there.
  try {
    return JSON.parse(readFileSync('atlas/atlas.config.json', 'utf8'))
  } catch {
    const text = await getRawFile(REPO, 'main', 'atlas/atlas.config.json')
    return text ? JSON.parse(text) : {}
  }
}

/**
 * Story CONTENT lives on the code branch (main): titles, AC, kb_articles,
 * phase layout. The reconciler only mutates STATE fields (pr_*, merged_at,
 * claimed_by) on atlas-state. For compliance comments we want the canonical
 * content — read from main directly. Falls back to the state branch only
 * if main has no backlog yet (shouldn't happen post-install).
 */
async function loadBacklog(mainRef, stateBranch) {
  const fromMain = await getRawFile(REPO, mainRef, 'atlas/backlog.json')
  if (fromMain) return JSON.parse(fromMain)
  const fromState = await getRawFile(REPO, stateBranch, 'atlas/backlog.json')
  return fromState ? JSON.parse(fromState) : null
}

async function loadKbIndex(kbPath, ref) {
  const text = await getRawFile(REPO, ref, `${kbPath}/_index.json`)
  return text ? JSON.parse(text) : null
}

// ── Comment management ────────────────────────────────────────────────────
async function findExistingComment() {
  // Walk PR comments — the marker pins the atlas-compliance comment so we
  // can update it in place instead of spamming a new one each run.
  const comments = await getJson(`/repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`)
  return comments.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER))
}

async function upsertComment(body) {
  const existing = await findExistingComment()
  const fullBody = `${COMMENT_MARKER}\n${body}`
  if (existing) {
    await gh(`/repos/${REPO}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: fullBody }),
    })
    console.log(`[atlas-compliance] Updated existing comment ${existing.id}`)
  } else {
    await gh(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: fullBody }),
    })
    console.log('[atlas-compliance] Posted new comment')
  }
}

// ── Compose the comment body ──────────────────────────────────────────────
function renderUnknownIdComment() {
  return [
    '### ⚠️ Atlas compliance: no story / claim / task id found',
    '',
    '_This PR does not reference any item from `atlas/backlog.json`._',
    '',
    'Open this PR via `/atlas-claim` to get a guided flow, or amend the title to include the ID — e.g. `feat(S1.2): connector layer`.',
    '',
    'Accepted forms (any one of):',
    '- `(SX.Y)` — a story id like `(S1.2)` (preferred)',
    '- `(C-NNN)` — a multi-story claim id like `(C-001)`',
    '- `(TX.Y.Z)` — a task id like `(T1.1.1)` (legacy task-level PRs)',
    '- The id in the branch name also counts — e.g. branch `feat/S1.2-something`',
    '',
    'If the work doesn\'t fit any existing story, run `/atlas-update` to add one before continuing.',
  ].join('\n')
}

/**
 * Compute the evolution_log entries introduced by this PR. For
 * atlas:backlog-change PRs we compare PR-head stories[] against the
 * canonical main stories[] — anything in PR-head's evolution_log that
 * isn't in main's is a NEW entry the reviewer needs to audit.
 *
 * Returns an array of { storyId, storyTitle, entry } objects. Empty for
 * non-backlog-change PRs (or when no new entries were introduced).
 */
function deriveNewEvolutionEntries(prStories, baseStories) {
  if (!Array.isArray(prStories) || prStories.length === 0) return []
  const baseById = new Map(
    (Array.isArray(baseStories) ? baseStories : []).map((s) => [s.id, s]),
  )
  const out = []
  for (const prStory of prStories) {
    const prLog = Array.isArray(prStory.evolution_log) ? prStory.evolution_log : []
    if (prLog.length === 0) continue
    const baseStory = baseById.get(prStory.id)
    const baseLog = Array.isArray(baseStory?.evolution_log) ? baseStory.evolution_log : []
    // Key by timestamp + operation + reason — that triple is effectively
    // unique within a story's evolution and survives the reconciler's
    // pr_url/pr_number backfill.
    const baseKeys = new Set(
      baseLog.map((e) => `${e.timestamp}|${e.operation}|${e.reason}`),
    )
    for (const entry of prLog) {
      const key = `${entry.timestamp}|${entry.operation}|${entry.reason}`
      if (!baseKeys.has(key)) {
        out.push({ storyId: prStory.id, storyTitle: prStory.title, entry })
      }
    }
  }
  return out
}

function renderEvolutionSection(newEntries) {
  if (!newEntries || newEntries.length === 0) return []
  const lines = [
    '### 📜 Plan changes introduced by this PR',
    '',
    'These `evolution_log` entries are appended to the named stories when this',
    'PR merges. Delivery Managers will see them in the Atlas viewer\'s drill-down,',
    'Activity feed, and `/changes` page — audit the justifications before approving.',
    '',
  ]
  for (const { storyId, storyTitle, entry } of newEntries) {
    const op = entry.operation || '(unknown)'
    const by = entry.by ? `by \`@${entry.by}\`` : ''
    lines.push(`#### \`${storyId}\` — ${storyTitle}`)
    lines.push(`**Operation:** \`${op}\`${by ? '  •  ' + by : ''}`)
    lines.push('')
    lines.push(`**Reason:** ${entry.reason || '_(missing — PR should not merge without one)_'}`)
    if (entry.changes && Object.keys(entry.changes).length) {
      lines.push('')
      lines.push('**Changes:**')
      for (const [field, diff] of Object.entries(entry.changes)) {
        lines.push(`- \`${field}\`: ${diff}`)
      }
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  return lines
}

/**
 * Find stories the PR adds that have zero child tasks (own no tasks via
 * tasks[].story_id). prd-intake / add ops are expected to land tasks in
 * the same PR; story-only stubs trigger a soft warning per v1.6.3.
 *
 * Inputs: the PR-head stories + tasks, plus the canonical main stories so
 * we can identify which stories are NEW (story-only IS allowed on a story
 * that's been around for a while — it's specifically the intake-without-
 * decomposition pattern we're catching).
 */
function deriveStoriesWithoutTasks(prStories, prTasks, mainStories) {
  if (!Array.isArray(prStories)) return []
  const mainIds = new Set((Array.isArray(mainStories) ? mainStories : []).map((s) => s.id))
  const taskCountByStory = new Map()
  for (const t of Array.isArray(prTasks) ? prTasks : []) {
    if (t.story_id) {
      taskCountByStory.set(t.story_id, (taskCountByStory.get(t.story_id) ?? 0) + 1)
    }
  }
  const out = []
  for (const s of prStories) {
    if (mainIds.has(s.id)) continue // not a NEW story
    const n = taskCountByStory.get(s.id) ?? 0
    if (n === 0) out.push({ id: s.id, title: s.title })
  }
  return out
}

function renderStoryWithoutTasksSection(storiesWithoutTasks) {
  if (!storiesWithoutTasks || storiesWithoutTasks.length === 0) return []
  const lines = [
    '### 🪜 Stories landed without child tasks',
    '',
    `${storiesWithoutTasks.length} new ${storiesWithoutTasks.length === 1 ? 'story is' : 'stories are'} landing in this PR with zero child tasks. Per the \`atlas-update\` skill (v1.6.3+), \`prd-intake\` and \`add\` MUST land tasks in the same PR by default — story-only stubs are a known bug pattern (the story is operationally inert, nothing can be claimed, and earlier viewer versions even failed to render the parent phase).`,
    '',
  ]
  for (const s of storiesWithoutTasks) lines.push(`- \`${s.id}\` — ${s.title}`)
  lines.push('')
  lines.push('**Resolution options** (pick one before merging):')
  lines.push('- **Decompose now (preferred):** add the missing tasks to this PR using the heuristic in the skill (one task per AC item, or design/build/verify). The PR diff will reflect a complete story-with-tasks unit.')
  lines.push('- **Defer explicitly:** if the PRD is still high-level and decomposition genuinely needs a follow-up pass, update the `--reason` text to name the deferred decomposition (e.g. "tasks deferred to <date> — story-shaped intent locks in here") and have a sibling follow-up PR open within the sprint.')
  lines.push('')
  lines.push('---')
  lines.push('')
  return lines
}

function renderStructuralSection({ orphanedModules, newPhasesOnRecord }) {
  const out = []
  if (newPhasesOnRecord && newPhasesOnRecord.length) {
    out.push('### 🆕 New phase numbers introduced')
    out.push('')
    out.push(`This PR adds stories/tasks under phase number${newPhasesOnRecord.length === 1 ? '' : 's'} **${newPhasesOnRecord.join(', ')}** which did not exist on \`main\` yet.`)
    out.push('')
    out.push('Make sure `atlas/atlas.config.json#/phases.<N>` carries the new phase metadata (`name`, `tagline`, `insight`, `deliverables`) in this same PR — without it, the viewer falls back to generic `Phase N` headers and the phase card has no editorial framing. The recommended `/atlas-update phase-create` op writes both sides for you.')
    out.push('')
    out.push('---')
    out.push('')
  }
  if (orphanedModules && orphanedModules.length) {
    out.push('### ⚠️ Orphaned module references')
    out.push('')
    out.push(`These module names are referenced by \`stories[].module\` or \`tasks[].module\` but do not appear in \`backlog.modules[]\`:`)
    out.push('')
    for (const m of orphanedModules) out.push(`- \`${m}\``)
    out.push('')
    out.push('Add an entry to `modules[]` in the same PR (or fix the typo on the story/task). The viewer derives PhaseCard deliverables + module chips from this registry — orphaned references render as bare strings without context.')
    out.push('')
    out.push('---')
    out.push('')
  }
  return out
}

function renderMatchedComment({ stories, claimIds, tasks, kbIndex, newEvolutionEntries, orphanedModules, newPhasesOnRecord, storiesWithoutTasks }) {
  const lines = ['### ✅ Atlas compliance — matched references', '']
  // Surface evolution_log changes FIRST when this is a backlog-change PR —
  // that's the reviewer's primary signal.
  lines.push(...renderEvolutionSection(newEvolutionEntries))
  // Then surface structural signals (new phases, orphaned modules,
  // stories-without-tasks) — these are PRD-intake / phase-create concerns
  // that don't appear in the story sections below.
  lines.push(...renderStoryWithoutTasksSection(storiesWithoutTasks))
  lines.push(...renderStructuralSection({ orphanedModules, newPhasesOnRecord }))

  for (const s of stories) {
    lines.push(`#### Story \`${s.id}\` — ${s.title}`)
    lines.push('')
    if (s.acceptance?.length) {
      lines.push('**Acceptance criteria** (tick when satisfied — copy into the PR description):')
      for (const ac of s.acceptance) lines.push(`- [ ] ${ac}`)
      lines.push('')
    } else {
      lines.push('_No acceptance criteria recorded on this story._')
      lines.push('')
    }

    const articles = (s.kb_articles ?? [])
      .map((slug) => kbIndex?.articles?.find((a) => a.slug === slug))
      .filter(Boolean)
    if (articles.length) {
      lines.push('**KB articles linked to this story** (read these before reviewing code):')
      for (const a of articles) {
        lines.push(`- [\`${a.path}\`](../tree/main/${a.path}) — ${a.summary || a.title}`)
      }
      lines.push('')
    } else if (s.kb_articles?.length) {
      lines.push('_Story declares `kb_articles` but none resolved against `kb/_index.json` — run `npm run atlas:kb` to refresh._')
      lines.push('')
    }
  }

  for (const c of claimIds) {
    lines.push(`#### Claim \`${c}\``)
    lines.push('All stories under this claim ship in this PR. See individual story sections above.')
    lines.push('')
  }

  if (tasks.length && stories.length === 0) {
    lines.push('#### Task-level reference')
    lines.push('_This PR matched a task id directly (legacy task-level PR). Consider re-titling with the parent story id when the next PR opens — story-level PRs cascade state to every child task in one go._')
    lines.push('')
    for (const t of tasks) lines.push(`- \`${t.id}\` — ${t.title}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('_The Atlas dashboard at `/api/backlog` reflects this PR within 60s of any event. See [the README](../tree/main/README.md#enforcement-model) for the discipline this check is enforcing._')
  return lines.join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────────
async function loadPrLabels() {
  const pr = await getJson(`/repos/${REPO}/pulls/${PR_NUMBER}`)
  return Array.isArray(pr.labels) ? pr.labels.map((l) => l.name) : []
}

async function main() {
  const config = await loadConfig()
  const stateBranch = config.github?.stateBranch || 'atlas-state'
  const kbPath = config.kb?.path || 'kb'

  // For atlas:backlog-change PRs, the canonical backlog source IS the PR's
  // head branch (it contains the new ids the PR is introducing). Otherwise
  // read from main — that's the merged canonical content.
  const labels = await loadPrLabels()
  const isBacklogChange = labels.includes(BACKLOG_CHANGE_LABEL)
  const isFeedbackChange = labels.includes(FEEDBACK_CHANGE_LABEL)
  const backlogRef = isBacklogChange ? PR_BRANCH : (config.github?.ref || 'main')
  if (isBacklogChange) {
    console.log(`[atlas-compliance] PR labeled "${BACKLOG_CHANGE_LABEL}" — reading backlog from PR head (${PR_BRANCH}) instead of main`)
  }
  if (isFeedbackChange) {
    console.log(`[atlas-compliance] PR labeled "${FEEDBACK_CHANGE_LABEL}" — reading feedback from PR head (${PR_BRANCH})`)
  }
  const backlog = await loadBacklog(backlogRef, stateBranch)
  if (!backlog) {
    console.warn(`[atlas-compliance] No backlog.json on ${stateBranch} — skipping check.`)
    await upsertComment('_Atlas compliance: no `backlog.json` on `atlas-state` yet. Skipping check until the first reconciler run lands._')
    return
  }

  const stories = Array.isArray(backlog.stories) ? backlog.stories : []
  const tasks = Array.isArray(backlog.tasks) ? backlog.tasks : []
  const storyIds = stories.map((s) => s.id)
  const taskIds = tasks.map((t) => t.id)
  const claimIds = [...new Set(stories.map((s) => s.claim_id).filter(Boolean))]

  // For atlas:feedback-change PRs, also load the PR-head feedback file so
  // F-NNN ids in the PR title can be matched as known references.
  let feedbackIds = []
  let feedbackItemsByMatchedId = new Map()
  if (isFeedbackChange) {
    const feedbackText = await getRawFile(REPO, PR_BRANCH, 'atlas/feedback.json')
    if (feedbackText) {
      try {
        const feedback = JSON.parse(feedbackText)
        const items = Array.isArray(feedback.items) ? feedback.items : []
        feedbackIds = items.map((f) => f.id).filter(Boolean)
        for (const item of items) {
          if (item.id) feedbackItemsByMatchedId.set(item.id, item)
        }
      } catch (e) {
        console.warn(`[atlas-compliance] feedback.json on PR head invalid JSON: ${e.message}`)
      }
    }
  }

  const knownIds = [...storyIds, ...claimIds, ...taskIds, ...feedbackIds]

  const idsFromTitle = taskIdsFrom(PR_TITLE, knownIds)
  const idsFromBranch = taskIdsFrom(PR_BRANCH, knownIds)
  const matched = new Set([...idsFromTitle, ...idsFromBranch])

  console.log(`[atlas-compliance] PR title: "${PR_TITLE}"`)
  console.log(`[atlas-compliance] Branch:   "${PR_BRANCH}"`)
  console.log(`[atlas-compliance] Matched:  ${[...matched].join(', ') || '(none)'}`)

  // atlas:guardrail-sync PRs are exempt from the story-id check — they're
  // auto-generated by the weekly watchdog to keep guardrail files in sync
  // with upstream. The PR touches no backlog content; requiring a story
  // ref makes no sense. v1.8.4+.
  const isGuardrailSync = labels.includes(GUARDRAIL_SYNC_LABEL)

  if (matched.size === 0 && !isGuardrailSync) {
    await upsertComment(renderUnknownIdComment())
    console.error('[atlas-compliance] ❌ No Atlas reference found in this PR.')
    process.exit(1)
  }
  if (isGuardrailSync) {
    await upsertComment([
      '<!-- atlas-compliance-comment -->',
      '### ✅ Atlas compliance — guardrail sync',
      '',
      `This PR is labeled \`${GUARDRAIL_SYNC_LABEL}\` — auto-generated by the weekly watchdog that keeps plugin-distributed files (scripts, workflows, schemas, hooks, viewer bundle) in sync with the upstream \`atlas-plugin\`. No story-id reference is required.`,
      '',
      'Review the file diff for any upstream changes you don\'t want to consume yet. Merge when ready.',
    ].join('\n'))
    console.log('[atlas-compliance] ✅ guardrail-sync PR — exempt from story-id check.')
    return
  }

  const matchedStories = []
  const matchedClaims = new Set()
  const matchedTasks = []

  const storyById = new Map(stories.map((s) => [s.id, s]))
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  for (const id of matched) {
    if (storyById.has(id)) matchedStories.push(storyById.get(id))
    else if (claimIds.includes(id)) {
      matchedClaims.add(id)
      // Expand: include every story in this claim in matchedStories.
      for (const s of stories) {
        if (s.claim_id === id && !matchedStories.includes(s)) matchedStories.push(s)
      }
    }
    else if (taskById.has(id)) matchedTasks.push(taskById.get(id))
  }

  // KB content lives on MAIN (the reconciler only syncs atlas/* to atlas-state).
  // Try main first, fall back to the state branch on the off chance the project
  // is using a non-standard layout.
  const kbIndex =
    (await loadKbIndex(kbPath, config.github?.ref || 'main')) ??
    (await loadKbIndex(kbPath, stateBranch))

  // For atlas:backlog-change PRs, also load the canonical main backlog and
  // compute which evolution_log entries this PR is INTRODUCING. Those are
  // the DM-visible plan changes the reviewer needs to audit.
  let newEvolutionEntries = []
  let orphanedModules = []
  let newPhasesOnRecord = []
  let storiesWithoutTasks = []
  if (isBacklogChange) {
    const mainBacklog = await loadBacklog(config.github?.ref || 'main', stateBranch)
    newEvolutionEntries = deriveNewEvolutionEntries(stories, mainBacklog?.stories)

    // Stories landed without child tasks — soft warning per v1.6.3.
    storiesWithoutTasks = deriveStoriesWithoutTasks(stories, tasks, mainBacklog?.stories)
    if (storiesWithoutTasks.length) {
      console.warn(`[atlas-compliance] ${storiesWithoutTasks.length} new stor${storiesWithoutTasks.length === 1 ? 'y has' : 'ies have'} no child tasks (soft warn): ${storiesWithoutTasks.map((s) => s.id).join(', ')}`)
    }
    if (newEvolutionEntries.length) {
      console.log(`[atlas-compliance] PR introduces ${newEvolutionEntries.length} evolution_log entr${newEvolutionEntries.length === 1 ? 'y' : 'ies'}`)
    } else {
      console.warn('[atlas-compliance] atlas:backlog-change PR but no new evolution_log entries — every plan change must carry a justification')
    }

    // Modules referential integrity — every story.module / task.module value
    // must appear in modules[].name. Catches typos and PRD-intake PRs that
    // forget to add the module registry entry.
    const knownModuleNames = new Set(
      (Array.isArray(backlog.modules) ? backlog.modules : [])
        .map((m) => m?.name)
        .filter(Boolean),
    )
    const orphanSet = new Set()
    for (const s of stories) {
      if (s.module && !knownModuleNames.has(s.module)) orphanSet.add(s.module)
    }
    for (const t of tasks) {
      if (t.module && !knownModuleNames.has(t.module)) orphanSet.add(t.module)
    }
    orphanedModules = [...orphanSet]
    if (orphanedModules.length) {
      console.warn(`[atlas-compliance] orphaned module references: ${orphanedModules.join(', ')}`)
    }

    // Detect new phase numbers (phases that didn't exist on main yet).
    // phase-create / phase-update entries explicitly call this out, but we
    // also derive empirically from the story/task phase fields so reviewers
    // see "this PR introduces phase 7" even when the op isn't tagged that way.
    const mainPhases = new Set([
      ...((mainBacklog?.stories ?? []).map((s) => s.phase)),
      ...((mainBacklog?.tasks ?? []).map((t) => t.phase)),
    ].filter((p) => typeof p === 'number'))
    const prPhases = new Set([
      ...stories.map((s) => s.phase),
      ...tasks.map((t) => t.phase),
    ].filter((p) => typeof p === 'number'))
    newPhasesOnRecord = [...prPhases].filter((p) => !mainPhases.has(p)).sort((a, b) => a - b)
    if (newPhasesOnRecord.length) {
      console.log(`[atlas-compliance] PR introduces phase number${newPhasesOnRecord.length === 1 ? '' : 's'}: ${newPhasesOnRecord.join(', ')}`)
    }
  }

  const body = renderMatchedComment({
    stories: matchedStories,
    claimIds: [...matchedClaims],
    tasks: matchedTasks,
    kbIndex,
    newEvolutionEntries,
    orphanedModules,
    newPhasesOnRecord,
    storiesWithoutTasks,
  })
  await upsertComment(body)
  console.log(`[atlas-compliance] ✅ Comment upserted with ${matchedStories.length} story / ${matchedTasks.length} task references.`)
}

main().catch((err) => {
  console.error('[atlas-compliance]', err)
  process.exit(1)
})
