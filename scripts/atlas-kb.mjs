#!/usr/bin/env node
// template/scripts/atlas-kb.mjs
//
// Compile a project knowledge base (markdown wiki) into a small JSON index
// that the Atlas viewer + any AI agent can consume efficiently.
//
// Reads:   kb/**.md      (the actual wiki — human-edited markdown)
// Reads:   atlas/backlog.json    (for bidirectional story↔article links)
// Writes:  kb/_index.json        (~5–20KB metadata index)
//
// Pure Node ESM. No dependencies — we hand-roll a minimal YAML frontmatter
// parser (only key: value and key: [a, b, c] are supported) so the install
// stays npm-install-free for the operator.
//
// Article frontmatter shape (all optional except title):
//   ---
//   title: ADKAR Model
//   slug: adkar-model         # defaults to the filename stem (kebab-cased)
//   tags: [methodology, change-management]
//   summary: One-line description.
//   related_stories: [S1.1, S3.2]
//   ---
//
// Body conventions:
//   - First `# Heading` becomes the title if frontmatter title is missing.
//   - First non-heading paragraph becomes the summary if frontmatter summary is missing.
//   - `[[wikilink]]` references — resolved against article slugs, both
//     `[[adkar-model]]` and `[[Adkar Model|the framework]]` forms supported.
//
// Bidirectional story link:
//   - Article frontmatter `related_stories: [S1.1]` → article linked from S1.1
//   - The compiler also reads `backlog.json` and merges `story.kb_articles`
//     into each story's reference list. The viewer's DrillDownPanel uses both.
//
// Usage:
//   node scripts/atlas-kb.mjs                # default kb path = "kb"
//   ATLAS_KB_PATH=docs/kb node scripts/atlas-kb.mjs
//   node scripts/atlas-kb.mjs --quiet

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname, basename, extname } from 'node:path'

// ── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const QUIET = args.includes('--quiet') || args.includes('-q')

// ── Config resolution ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(readFileSync('atlas/atlas.config.json', 'utf8'))
  } catch { return {} }
}
function loadBacklog() {
  try {
    return JSON.parse(readFileSync('atlas/backlog.json', 'utf8'))
  } catch { return null }
}

const config = loadConfig()
const KB_DIR = process.env.ATLAS_KB_PATH ?? config.kb?.path ?? 'kb'
const OUTPUT = process.env.ATLAS_KB_OUT ?? join(KB_DIR, '_index.json')

if (!existsSync(KB_DIR)) {
  if (!QUIET) console.warn(`[atlas-kb] No ${KB_DIR}/ directory — skipping KB compile.`)
  process.exit(0)
}

// ── File walk ──────────────────────────────────────────────────────────────
function walkMarkdown(dir, base = dir) {
  /** @type {string[]} */
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === '_index.json' || name === 'node_modules') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkMarkdown(full, base))
    else if (extname(name) === '.md') out.push(relative(base, full))
  }
  return out
}

// ── Minimal frontmatter parser ─────────────────────────────────────────────
// Accepts the documented subset only: scalar values + inline arrays.
// Anything more exotic (block lists, multiline strings) → ignored.
export function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { fm: {}, body: raw }
  const block = raw.slice(4, end).trim()
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const fm = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    // Inline arrays: [a, b, "c d"]
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim()
      if (inner.length === 0) fm[key] = []
      else fm[key] = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
    } else {
      // Strip optional quotes
      val = val.replace(/^["']|["']$/g, '')
      fm[key] = val
    }
  }
  return { fm, body }
}

// ── Body parsers ───────────────────────────────────────────────────────────
function slugifyPath(p) {
  return basename(p, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
function firstH1(body) {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}
function firstParagraph(body) {
  // Skip leading headings + blank lines; take the first non-empty, non-heading line block.
  const lines = body.split(/\r?\n/)
  let i = 0
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#'))) i++
  let out = ''
  while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#')) {
    out += (out ? ' ' : '') + lines[i].trim()
    i++
  }
  return out || null
}
/** Extract slugs from [[wikilink]] syntax. Both `[[slug]]` and `[[slug|label]]` forms. */
function extractWikilinks(body) {
  /** @type {Set<string>} */
  const out = new Set()
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  let m
  while ((m = re.exec(body)) !== null) {
    out.add(slugifyPath(m[1].trim()))
  }
  return [...out]
}

// ── Build the index ────────────────────────────────────────────────────────
const files = walkMarkdown(KB_DIR)
if (files.length === 0) {
  if (!QUIET) console.warn(`[atlas-kb] ${KB_DIR}/ has no .md files yet.`)
  writeFileSync(OUTPUT, JSON.stringify({ generated_at: new Date().toISOString(), articles: [] }, null, 2) + '\n')
  process.exit(0)
}

/** @type {Array<{
 *   slug: string,
 *   path: string,
 *   title: string,
 *   tags: string[],
 *   summary: string,
 *   links_out: string[],
 *   related_stories: string[]
 * }>}
 */
const articles = []

for (const relPath of files) {
  const full = join(KB_DIR, relPath)
  const raw = readFileSync(full, 'utf8')
  const { fm, body } = parseFrontmatter(raw)

  const slug = (fm.slug || slugifyPath(relPath)).toLowerCase()
  const title = fm.title || firstH1(body) || basename(relPath, '.md')
  const tags = Array.isArray(fm.tags) ? fm.tags : []
  const summary = fm.summary || firstParagraph(body) || ''
  const linksOut = extractWikilinks(body)
  const relatedStories = Array.isArray(fm.related_stories) ? fm.related_stories : []

  articles.push({
    slug,
    path: relPath,
    title,
    tags,
    summary: summary.length > 300 ? summary.slice(0, 297) + '…' : summary,
    links_out: linksOut,
    related_stories: relatedStories,
  })
}

// Deduplicate by slug — last-write-wins, warn on collision.
const seen = new Map()
for (const a of articles) {
  if (seen.has(a.slug)) {
    if (!QUIET) console.warn(`[atlas-kb] WARNING: duplicate slug "${a.slug}" — ${seen.get(a.slug).path} vs ${a.path}`)
  }
  seen.set(a.slug, a)
}
const deduped = [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug))

// Compute links_in (reverse index of links_out)
const linksInBySlug = new Map()
for (const a of deduped) {
  for (const target of a.links_out) {
    if (!linksInBySlug.has(target)) linksInBySlug.set(target, [])
    linksInBySlug.get(target).push(a.slug)
  }
}
for (const a of deduped) {
  a.links_in = linksInBySlug.get(a.slug) || []
}

// Merge story.kb_articles → article.related_stories (bidirectional)
const backlog = loadBacklog()
if (backlog?.stories) {
  const articleBySlug = new Map(deduped.map((a) => [a.slug, a]))
  for (const story of backlog.stories) {
    const refs = Array.isArray(story.kb_articles) ? story.kb_articles : []
    for (const slug of refs) {
      const article = articleBySlug.get(slug.toLowerCase())
      if (article && !article.related_stories.includes(story.id)) {
        article.related_stories.push(story.id)
      }
    }
  }
}

const out = {
  generated_at: new Date().toISOString(),
  kb_path: KB_DIR,
  article_count: deduped.length,
  articles: deduped,
}
writeFileSync(OUTPUT, JSON.stringify(out, null, 2) + '\n')
if (!QUIET) {
  console.log(`[atlas-kb] Wrote ${OUTPUT}`)
  console.log(`  articles: ${deduped.length}`)
  const linked = deduped.filter((a) => a.related_stories.length > 0).length
  console.log(`  cross-linked to backlog stories: ${linked}`)
  const orphans = deduped.filter((a) => a.links_in.length === 0 && a.related_stories.length === 0).length
  if (orphans > 0) console.log(`  orphan articles (no backlinks, no stories): ${orphans}`)
}
