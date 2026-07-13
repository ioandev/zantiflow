// A tiny, dependency-free SemVer parser + comparator — just enough to pick the highest release tag
// (ADR-0022 tags are `vX.Y.Z`). We deliberately skip the `semver` npm dep: the surface we need is
// small, and keeping it here with co-located tests (ADR-0015) makes the no-regression selection
// auditable. Build metadata (`+...`) is parsed but ignored for precedence, per the SemVer spec.

export interface SemVer {
  major: number
  minor: number
  patch: number
  /** Dot-separated pre-release identifiers (`[]` for a normal release). */
  prerelease: string[]
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a tag like `v1.2.3` / `1.2.3-rc.1`. Returns `null` for anything non-SemVer. */
export const parseSemVer = (tag: string): SemVer | null => {
  const m = RE.exec(tag.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  }
}

const isNumeric = (s: string): boolean => /^\d+$/.test(s)

// Compare pre-release identifier lists per SemVer §11: a version WITH a pre-release ranks BELOW the
// same core version without one; otherwise compare identifiers left-to-right (numeric identifiers
// rank below alphanumeric; if all shared fields tie, the longer list wins).
const comparePrerelease = (a: string[], b: string[]): number => {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    const xn = isNumeric(x)
    const yn = isNumeric(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/** `-1` if a < b, `0` if equal precedence, `1` if a > b. */
export const compareSemVer = (a: SemVer, b: SemVer): number => {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}
