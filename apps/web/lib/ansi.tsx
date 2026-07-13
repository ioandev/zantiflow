// Safe ANSI → React renderer for pane output (ADR-0016 §D / audit C6). Pane output is UNTRUSTED
// terminal bytes. We build React <span> elements with the text as CHILDREN — React escapes markup, so
// `<script>` / `onerror=` in the output can never execute. We allowlist a subset of SGR (colour/bold/
// underline) and STRIP every other escape (OSC/CSI/etc.). There is NO dangerouslySetInnerHTML anywhere.
import type { CSSProperties, ReactNode } from 'react'

interface Style {
  color?: string
  background?: string
  fontWeight?: 'bold'
  fontStyle?: 'italic'
  textDecoration?: 'underline'
  opacity?: number
}

// The standard 16-colour palette (0-7 normal, 8-15 bright), tuned for the dark output panel. Zellij
// emits terminal colour mostly as EXTENDED SGR — truecolor `38;2;r;g;b` and 256-colour `38;5;n` (its
// `CharacterStyles` never uses the legacy `31m` form) — so those MUST be parsed, not ignored: a
// half-parsed `38;2;…` used to leak its `2` as "dim" and its `0` components as "reset all", which is
// why output showed opacity flicker but no colour.
const PALETTE16 = [
  '#3b4048',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#abb2bf', // 0-7
  '#5c6370',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#ffffff', // 8-15 (bright)
]

const clampByte = (n: number): number => (Number.isFinite(n) ? Math.min(255, Math.max(0, n | 0)) : 0)

/** Map an xterm 256-colour index (0-255) to a CSS colour: 0-15 palette, 16-231 cube, 232-255 grey. */
function xterm256(n: number): string | undefined {
  if (!Number.isFinite(n) || n < 0 || n > 255) return undefined
  if (n < 16) return PALETTE16[n]
  if (n < 232) {
    const i = n - 16
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${level(Math.floor(i / 36))}, ${level(Math.floor(i / 6) % 6)}, ${level(i % 6)})`
  }
  const v = 8 + (n - 232) * 10
  return `rgb(${v}, ${v}, ${v})`
}

function applySgr(style: Style, codes: number[]): Style {
  let s: Style = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) s = {}
    else if (c === 1) s.fontWeight = 'bold'
    else if (c === 2) s.opacity = 0.7
    else if (c === 3) s.fontStyle = 'italic'
    else if (c === 4) s.textDecoration = 'underline'
    else if (c === 22) {
      delete s.fontWeight
      delete s.opacity
    } else if (c === 23) delete s.fontStyle
    else if (c === 24) delete s.textDecoration
    else if (c === 39) delete s.color
    else if (c === 49) delete s.background
    else if (c >= 30 && c <= 37) s.color = PALETTE16[c - 30]
    else if (c >= 90 && c <= 97) s.color = PALETTE16[c - 90 + 8]
    else if (c >= 40 && c <= 47) s.background = PALETTE16[c - 40]
    else if (c >= 100 && c <= 107) s.background = PALETTE16[c - 100 + 8]
    else if (c === 38 || c === 48) {
      // Extended colour. `…;5;n` = 256-colour, `…;2;r;g;b` = truecolor — consume the parameters so
      // they can't leak back into the loop as bogus attributes.
      const target = c === 38 ? 'color' : 'background'
      const mode = codes[i + 1]
      if (mode === 5) {
        const col = xterm256(codes[i + 2])
        if (col) s[target] = col
        i += 2
      } else if (mode === 2) {
        s[target] = `rgb(${clampByte(codes[i + 2])}, ${clampByte(codes[i + 3])}, ${clampByte(codes[i + 4])})`
        i += 4
      }
      // a malformed 38/48 (no 2/5) is left as-is and ignored
    }
    // all other SGR codes (5/7/25/27/28/29/53/58/…) are intentionally ignored
  }
  return s
}

// ESC () + BEL () built from strings so the source stays pure ASCII. Matches SGR `ESC[…m`
// (codes captured) plus other CSI / OSC / single-char escapes — all of which we STRIP.
const ESC = '\\u001b'
const BEL = '\\u0007'
const ESCAPE = new RegExp(
  `${ESC}\\[([0-9;]*)m|${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[\\s\\S]`,
  'g',
)

/** Render one line of ANSI output as safe React nodes. */
export function ansiLineToReact(line: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let style: Style = {}
  let last = 0
  let key = 0
  const push = (text: string) => {
    if (text)
      nodes.push(
        <span key={key++} style={style as CSSProperties}>
          {text}
        </span>,
      )
  }

  ESCAPE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ESCAPE.exec(line)) !== null) {
    // Guard against a zero-width match looping forever.
    if (m.index === ESCAPE.lastIndex) {
      ESCAPE.lastIndex += 1
      continue
    }
    push(line.slice(last, m.index))
    last = ESCAPE.lastIndex
    if (m[1] !== undefined) {
      const codes = m[1] === '' ? [0] : m[1].split(';').map((n) => Number(n) || 0)
      style = applySgr(style, codes)
    }
    // non-SGR escapes are stripped (not emitted)
  }
  push(line.slice(last))
  return nodes
}

/** Render a block of pane-output lines. */
export function AnsiOutput({ lines }: { lines: string[] }) {
  return (
    <pre className="ansi">
      {lines.map((line, i) => (
        <div key={i}>{ansiLineToReact(line)}</div>
      ))}
    </pre>
  )
}
