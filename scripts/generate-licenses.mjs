#!/usr/bin/env node
// Generate a third-party LICENSES manifest for the zantiflow monorepo.
//
//   node scripts/generate-licenses.mjs --scope all    --out LICENSES
//   node scripts/generate-licenses.mjs --scope web    --out apps/web/LICENSES
//   node scripts/generate-licenses.mjs --scope plugin --out apps/plugin/LICENSES
//
// `--scope all` covers every ecosystem in the repo: npm (the whole pnpm
// workspace), Cargo (the plugin's shipped dependency closure), and PyPI (the
// Discord + Telegram bot venvs). `--scope web` covers only the @zantiflow/web
// dependency tree (npm); `--scope plugin` covers only the Zellij plugin's
// Cargo dependency closure (what ships inside the .wasm). Built on tooling that
// already exists in the repo —
// `pnpm licenses`, `cargo metadata`, and each venv's Python stdlib — so there
// is nothing extra to install. Missing ecosystems degrade to a warning and are
// skipped rather than failing the whole run.
//
// Output is deterministic (sorted, no timestamps) so re-running only produces a
// diff when the dependency set actually changes. Do not edit the output by
// hand — run `just license`.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---- args --------------------------------------------------------------------
const argv = process.argv.slice(2)
const optionValue = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const scope = optionValue('--scope', 'all')
if (!['all', 'web', 'plugin'].includes(scope)) {
  console.error(`unknown --scope "${scope}" (expected "all", "web", or "plugin")`)
  process.exit(2)
}
const DEFAULT_OUT = { web: 'apps/web/LICENSES', plugin: 'apps/plugin/LICENSES', all: 'LICENSES' }
const outPath = resolve(ROOT, optionValue('--out', DEFAULT_OUT[scope]))

const warn = (msg) => console.warn(`  ! ${msg}`)

// ---- shared: read bundled license text from a package directory --------------
const LICENSE_FILE_RE =
  /^(LICEN[CS]E|COPYING|COPYRIGHT|UNLICEN[CS]E|NOTICE|MIT-LICENSE|LICENSE-MIT|LICENSE-APACHE)([.-].*)?$/i

function readLicenseTextFromDir(dir) {
  if (!dir || !existsSync(dir)) return ''
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return ''
  }
  const picks = files.filter((f) => LICENSE_FILE_RE.test(f)).sort()
  const texts = []
  for (const f of picks) {
    try {
      const p = join(dir, f)
      if (!statSync(p).isFile()) continue
      const t = readFileSync(p, 'utf8').trim()
      if (t) texts.push(t)
    } catch {
      /* unreadable file — skip */
    }
  }
  return texts.join('\n\n---\n\n')
}

// ---- npm (pnpm workspace) ----------------------------------------------------
function collectNpm() {
  if (scope === 'plugin') return [] // plugin ships no npm code
  const pnpmArgs = []
  if (scope === 'web') pnpmArgs.push('--filter', '@zantiflow/web')
  pnpmArgs.push('licenses', 'list', '--json')
  let raw
  try {
    raw = execFileSync('pnpm', pnpmArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    // `pnpm licenses` exits non-zero if any dep is missing a license; its JSON
    // still lands on stdout, so keep whatever we got.
    raw = e.stdout ? e.stdout.toString() : ''
  }
  if (!raw.trim()) {
    warn('pnpm produced no license data — is `pnpm install` up to date?')
    return []
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    warn('could not parse `pnpm licenses list --json` output — skipping npm')
    return []
  }
  const entries = []
  for (const [licenseKey, pkgs] of Object.entries(data)) {
    for (const p of pkgs) {
      const name = p.name
      if (!name || name.startsWith('@zantiflow/')) continue // first-party
      const dir = (p.paths || [])[0] || ''
      entries.push({
        ecosystem: 'npm',
        name,
        version: (p.versions || []).join(', '),
        spdx: p.license || licenseKey || '',
        author: p.author || '',
        homepage: p.homepage || '',
        text: readLicenseTextFromDir(dir),
      })
    }
  }
  return entries
}

// ---- Cargo (plugin) ----------------------------------------------------------
function collectRust() {
  if (scope === 'web') return [] // the web app has no Rust deps
  let raw
  try {
    raw = execFileSync(
      'cargo',
      ['metadata', '--format-version', '1', '--filter-platform', 'wasm32-wasip1', '--manifest-path', 'Cargo.toml'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    warn('`cargo metadata` failed (cargo not installed?) — skipping Rust crates')
    return []
  }
  let meta
  try {
    meta = JSON.parse(raw)
  } catch {
    warn('could not parse `cargo metadata` output — skipping Rust crates')
    return []
  }
  const byId = Object.fromEntries(meta.packages.map((p) => [p.id, p]))
  const nodes = Object.fromEntries(meta.resolve.nodes.map((n) => [n.id, n]))
  const roots = new Set(meta.workspace_members)

  // Walk the normal (non-dev, non-build) dependency closure from the workspace
  // members — i.e. exactly what the shipped .wasm links against.
  const seen = new Set()
  const stack = [...roots]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes[id]
    if (!node) continue
    for (const dep of node.deps) {
      const kinds = dep.dep_kinds || []
      if (kinds.some((k) => k.kind === null || k.kind === 'normal')) stack.push(dep.pkg)
    }
  }

  const entries = []
  for (const id of seen) {
    if (roots.has(id)) continue // first-party workspace crates
    const p = byId[id]
    if (!p) continue
    const dir = p.manifest_path ? dirname(p.manifest_path) : ''
    entries.push({
      ecosystem: 'cargo',
      name: p.name,
      version: p.version,
      spdx: p.license || (p.license_file ? '(see bundled license file)' : ''),
      author: (p.authors || []).join(', '),
      homepage: p.homepage || p.repository || '',
      text: readLicenseTextFromDir(dir),
    })
  }
  return entries
}

// ---- PyPI (bot venvs) --------------------------------------------------------
function collectPython() {
  if (scope !== 'all') return []
  const collector = join(ROOT, 'scripts', 'licenses-python.py')
  const venvs = [
    { app: 'discord-bot', py: join(ROOT, 'apps/discord-bot/.venv/bin/python') },
    { app: 'telegram-bot', py: join(ROOT, 'apps/telegram-bot/.venv/bin/python') },
  ]
  const merged = new Map() // name@version -> entry (dedupe across both bots)
  for (const v of venvs) {
    if (!existsSync(v.py)) {
      warn(`no venv at apps/${v.app}/.venv (run \`just setup\` there) — skipping its Python deps`)
      continue
    }
    let raw
    try {
      raw = execFileSync(v.py, [collector], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      warn(`Python license collection failed for ${v.app} — skipping`)
      continue
    }
    let arr
    try {
      arr = JSON.parse(raw)
    } catch {
      warn(`could not parse Python license output for ${v.app} — skipping`)
      continue
    }
    for (const p of arr) {
      const key = `${p.name.toLowerCase()}@${p.version}`
      if (!merged.has(key)) merged.set(key, { ecosystem: 'pypi', ...p })
    }
  }
  return [...merged.values()]
}

// ---- license classification (compliance flagging) ----------------------------
// Sort every package into a compliance category so copyleft/unknown licenses are
// surfaced automatically on each run. Anything not recognised as clearly
// permissive is flagged for review (fail-closed, like the privacy model).
const CATEGORY = {
  permissive: { rank: 0, label: 'Permissive', note: 'keep the copyright + license notice; no other obligation' },
  attribution: {
    rank: 1,
    label: 'Attribution (data/docs)',
    note: 'attribution required (CC-BY / OFL); usually build-time data',
  },
  weak: {
    rank: 2,
    label: 'Weak copyleft (file-level)',
    note: 'MPL/EPL/CDDL: keep notices; publish source of any file YOU modify',
  },
  lgpl: {
    rank: 3,
    label: 'LGPL',
    note: 'keep it a replaceable library + provide its source when you distribute a binary',
  },
  strong: {
    rank: 4,
    label: 'Strong copyleft (GPL/AGPL)',
    note: 'REVIEW: can force your combined work open — verify before shipping',
  },
  review: {
    rank: 5,
    label: 'Needs review (unrecognised)',
    note: 'REVIEW: license string not recognised — classify by hand',
  },
}
const rankToCategory = Object.fromEntries(Object.entries(CATEGORY).map(([k, v]) => [v.rank, k]))

// Whole-phrase free-text names (from npm `license` fields / Python classifiers) → SPDX id.
// Ordered longest-first so specific phrases win. Applied before SPDX-expression parsing.
const FREETEXT = [
  ['Mozilla Public License 2.0 (MPL 2.0)', 'MPL-2.0'],
  ['GNU Lesser General Public License v3 or later (LGPLv3+)', 'LGPL-3.0-or-later'],
  ['GNU Lesser General Public License', 'LGPL-3.0'],
  ['GNU Affero General Public License', 'AGPL-3.0'],
  ['GNU General Public License', 'GPL-3.0'],
  ['Python Software Foundation License', 'PSF-2.0'],
  ['Apache Software License', 'Apache-2.0'],
  ['Apache License 2.0', 'Apache-2.0'],
  ['The MIT License (MIT)', 'MIT'],
  ['MIT License', 'MIT'],
  ['BSD License', 'BSD-3-Clause'],
  ['ISC License', 'ISC'],
]
const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'BSD-3-CLAUSE-CLEAR',
  '0BSD',
  'APACHE-2.0',
  'UNLICENSE',
  'BLUEOAK-1.0.0',
  'UNICODE-3.0',
  'UNICODE-DFS-2016',
  'ZLIB',
  'WTFPL',
  'PSF-2.0',
  'PYTHON-2.0',
  'NCSA',
  'BSL-1.0',
  'CC0-1.0',
  'BSD',
  'AFL-2.1',
  'MPL-2.0-NO-COPYLEFT-EXCEPTION',
])
const WEAK = new Set(['MPL-2.0', 'MPL-1.1', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1', 'OSL-3.0'])

function classifyAtom(tokenRaw) {
  let t = (tokenRaw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+WITH\s+.*/i, '') // exceptions loosen; classify the base
  if (!t) return null
  if (t.startsWith('AGPL')) return 'strong'
  if (t.startsWith('LGPL')) return 'lgpl'
  if (t.startsWith('GPL')) return 'strong'
  if (t.startsWith('CC-BY-SA')) return 'weak' // share-alike
  if (t.startsWith('CC-BY') || t.startsWith('OFL')) return 'attribution'
  if (t.startsWith('CC0')) return 'permissive'
  if (WEAK.has(t)) return 'weak'
  if (PERMISSIVE.has(t)) return 'permissive'
  return 'review'
}

// Classify a full SPDX expression. AND = must satisfy all (max severity); OR and
// the `/` shorthand = pick the least restrictive (min severity). Handles parens.
function classifyLicense(spdxRaw) {
  let src = ` ${spdxRaw || ''} `
  for (const [phrase, id] of FREETEXT) {
    src = src.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), id)
  }
  src = src.replace(/\//g, ' OR ').replace(/\s+WITH\s+[A-Za-z0-9.-]+/gi, '')
  const tokens = src.match(/\(|\)|\bOR\b|\bAND\b|[^()\s]+/gi) || []
  if (!tokens.length) return 'review'
  let i = 0
  const peek = () => tokens[i]
  const primary = () => {
    if (peek() === '(') {
      i++
      const v = orExpr()
      if (peek() === ')') i++
      return v
    }
    return CATEGORY[classifyAtom(tokens[i++]) || 'review'].rank
  }
  const andExpr = () => {
    let v = primary()
    while ((peek() || '').toUpperCase() === 'AND') {
      i++
      v = Math.max(v, primary())
    }
    return v
  }
  const orExpr = () => {
    let v = andExpr()
    while ((peek() || '').toUpperCase() === 'OR') {
      i++
      v = Math.min(v, andExpr())
    }
    return v
  }
  return rankToCategory[orExpr()]
}

function renderCompliance(entries) {
  const tally = new Map(Object.keys(CATEGORY).map((k) => [k, []]))
  for (const e of entries) tally.get(classifyLicense(e.spdx)).push(e)

  const summary = Object.keys(CATEGORY)
    .map((k) => `${CATEGORY[k].label}: ${tally.get(k).length}`)
    .join('\n  ')

  const flagged = tally.get('strong').length + tally.get('review').length
  const verdict =
    flagged > 0
      ? `⚠  ATTENTION: ${flagged} package(s) carry a strong-copyleft or unrecognised license — review before shipping.`
      : '✓  No strong-copyleft (GPL/AGPL) or unrecognised licenses detected.'

  const lines = [`  ${summary}`, '', verdict, '']
  // List every non-permissive package (the whole point: flag them up top).
  const flagOrder = ['strong', 'review', 'lgpl', 'weak', 'attribution']
  const anyFlagged = flagOrder.some((k) => tally.get(k).length)
  if (anyFlagged) {
    lines.push('Packages requiring attention (non-permissive):', '')
    for (const k of flagOrder) {
      const list = tally.get(k).slice().sort(byNameThenVersion)
      if (!list.length) continue
      lines.push(`  ▸ ${CATEGORY[k].label} — ${CATEGORY[k].note}`)
      for (const e of list)
        lines.push(`      ${packageKey(e)}  (${ECOSYSTEM_LABEL[e.ecosystem]})  [${e.spdx || 'UNKNOWN'}]`)
      lines.push('')
    }
  }
  return lines.join('\n').replace(/\n+$/, '')
}

// ---- rendering ---------------------------------------------------------------
const ECOSYSTEM_LABEL = { npm: 'npm', cargo: 'Cargo (Rust)', pypi: 'PyPI (Python)' }
const byNameThenVersion = (a, b) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.version || '').localeCompare(b.version || '')

function packageKey(e) {
  return `${e.name}@${e.version}`
}

function renderIndex(entries) {
  const lines = []
  const groups = new Map()
  for (const e of entries) {
    if (!groups.has(e.ecosystem)) groups.set(e.ecosystem, [])
    groups.get(e.ecosystem).push(e)
  }
  for (const eco of ['npm', 'cargo', 'pypi']) {
    const list = (groups.get(eco) || []).slice().sort(byNameThenVersion)
    if (!list.length) continue
    lines.push(`### ${ECOSYSTEM_LABEL[eco]} — ${list.length} package${list.length === 1 ? '' : 's'}`, '')
    const nameW = Math.min(48, Math.max(...list.map((e) => `${e.name}@${e.version}`.length)))
    for (const e of list) {
      const id = `${e.name}@${e.version}`.padEnd(nameW)
      const spdx = (e.spdx || 'UNKNOWN').padEnd(24)
      lines.push(`  ${id}  ${spdx}  ${e.homepage || ''}`.trimEnd())
    }
    lines.push('')
  }
  return lines.join('\n')
}

function renderTexts(entries) {
  // Group packages that ship byte-identical license text.
  const byText = new Map()
  const noText = []
  for (const e of entries) {
    const t = (e.text || '').trim()
    if (!t) {
      noText.push(e)
      continue
    }
    if (!byText.has(t)) byText.set(t, [])
    byText.get(t).push(e)
  }

  // Deterministic order: sort groups by their first (sorted) member key.
  const groups = [...byText.entries()].map(([text, members]) => ({
    text,
    members: members.slice().sort(byNameThenVersion),
  }))
  groups.sort((a, b) => packageKey(a.members[0]).toLowerCase().localeCompare(packageKey(b.members[0]).toLowerCase()))

  const bar = '─'.repeat(78)
  const lines = []
  for (const g of groups) {
    lines.push(bar)
    for (const m of g.members) lines.push(`  ${packageKey(m)}  (${ECOSYSTEM_LABEL[m.ecosystem]})`)
    lines.push(bar, '', g.text, '')
  }

  if (noText.length) {
    lines.push(bar)
    lines.push('  Packages with no bundled license text')
    lines.push('  (refer to the SPDX identifier and homepage in the index above)')
    lines.push(bar, '')
    for (const e of noText.slice().sort(byNameThenVersion)) {
      lines.push(`  ${packageKey(e)}  (${ECOSYSTEM_LABEL[e.ecosystem]})  —  ${e.spdx || 'UNKNOWN'}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function render(entries) {
  const counts = { npm: 0, cargo: 0, pypi: 0 }
  for (const e of entries) counts[e.ecosystem]++
  const ecoSummary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([eco, n]) => `${ECOSYSTEM_LABEL[eco]}: ${n}`)
    .join(' · ')

  // License summary (by SPDX id) — a quick skim of what obligations exist.
  const licenseCounts = new Map()
  for (const e of entries) {
    const key = e.spdx || 'UNKNOWN'
    licenseCounts.set(key, (licenseCounts.get(key) || 0) + 1)
  }
  const licenseSummary = [...licenseCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lic, n]) => `  ${String(n).padStart(4)}  ${lic}`)
    .join('\n')

  const title = {
    web: 'zantiflow dashboard (@zantiflow/web) — Third-Party Licenses',
    plugin: 'zantiflow Zellij plugin (zantiflow.wasm) — Third-Party Licenses',
    all: 'zantiflow — Third-Party Licenses',
  }[scope]
  const scopeNote = {
    web: 'Covers the npm dependency tree of the @zantiflow/web app (runtime + dev).',
    plugin: 'Covers the Cargo dependency closure compiled into the zantiflow.wasm plugin.',
    all: 'Covers the whole monorepo: the pnpm workspace (npm), the Zellij plugin\n(Cargo/Rust), and the Discord + Telegram bots (PyPI/Python).',
  }[scope]
  const ownLicenseNote =
    scope === 'plugin'
      ? 'The zantiflow plugin is licensed under Apache-2.0 — see ./LICENSE and\n./NOTICE. The crates below are compiled into the .wasm and are'
      : "zantiflow's own source code is licensed under Apache-2.0 — see ./LICENSE and\n./NOTICE. The third-party packages below are"

  return `${title}
${'='.repeat(title.length)}

GENERATED FILE — do not edit by hand. Regenerate with \`just license\`.

${scopeNote}

${ownLicenseNote} redistributed under their own
licenses; this file reproduces those licenses and notices.

Total third-party packages: ${entries.length}   (${ecoSummary})

Licenses in use (package count):
${licenseSummary}


${'='.repeat(78)}
LICENSE COMPLIANCE OVERVIEW
${'='.repeat(78)}

Category rollup (${entries.length} packages):
${renderCompliance(entries)}


${'='.repeat(78)}
PACKAGE INDEX
${'='.repeat(78)}

${renderIndex(entries)}

${'='.repeat(78)}
FULL LICENSE TEXTS
${'='.repeat(78)}

The texts below are the LICENSE / NOTICE / COPYING files bundled with each
package. Packages that ship byte-identical text are grouped together.

${renderTexts(entries)}`.replace(/[ \t]+\n/g, '\n')
}

// ---- main --------------------------------------------------------------------
console.log(`Generating ${scope} LICENSES -> ${outPath}`)
const entries = [...collectNpm(), ...collectRust(), ...collectPython()]
if (!entries.length) {
  console.error('No third-party packages found — refusing to overwrite with an empty file.')
  process.exit(1)
}
const output = render(entries).replace(/\n+$/, '\n')
writeFileSync(outPath, output)
const counts = entries.reduce((acc, e) => ((acc[e.ecosystem] = (acc[e.ecosystem] || 0) + 1), acc), {})
console.log(
  `Wrote ${outPath}: ${entries.length} packages (` +
    Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') +
    ')',
)
