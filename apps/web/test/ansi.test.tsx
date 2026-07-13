import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ansiLineToReact } from '../lib/ansi'

// ESC/BEL built from char codes so this test file stays pure ASCII.
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const html = (line: string) => renderToStaticMarkup(<div>{ansiLineToReact(line)}</div>)

describe('safe ANSI renderer (XSS)', () => {
  it('escapes HTML markup in untrusted pane output', () => {
    const out = html('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('neutralizes an event-handler injection attempt', () => {
    const out = html('<img src=x onerror="alert(1)">')
    expect(out).not.toContain('<img') // no live tag — the whole thing is escaped text
    expect(out).not.toContain('onerror="') // a live event-handler attribute would have an unescaped quote
    expect(out).toContain('&lt;img')
  })

  it('renders SGR colour and strips the raw escapes', () => {
    const out = html(`${ESC}[31mred${ESC}[0m plain`)
    expect(out).toContain('red')
    expect(out).toContain('plain')
    expect(out).not.toContain(ESC) // no raw escape byte leaks into the DOM
    expect(out).toContain('color:#e06c75') // 31 → red applied as an inline style
  })

  it('renders 24-bit truecolor (Zellij emits fg as 38;2;r;g;b — not the legacy 31m)', () => {
    // Regression: `38;2;177;185;249` used to be misread digit-by-digit → 2=dim, 0s=reset → opacity,
    // no colour. It must now render the actual RGB and NOT set opacity.
    const out = html(`${ESC}[38;2;177;185;249mclaude.thinking${ESC}[m`)
    expect(out).toContain('claude.thinking')
    expect(out).toContain('color:rgb(177, 185, 249)')
    expect(out).not.toContain('opacity') // the `2` in `38;2;…` is a colour param, not "dim"
  })

  it('renders a 256-colour index and a truecolor background', () => {
    const fg = html(`${ESC}[38;5;42mx`)
    expect(fg).toContain('color:rgb(0, 215, 135)') // xterm 42 → cube colour
    const bg = html(`${ESC}[48;2;10;20;30my`)
    expect(bg).toContain('background:rgb(10, 20, 30)')
  })

  it('strips an OSC title-injection sequence but keeps the visible text', () => {
    const out = html(`${ESC}]0;<img src=x onerror=alert(1)>${BEL}visible`)
    expect(out).toContain('visible')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
  })

  it('leaves plain text intact', () => {
    expect(html('cargo build --release')).toContain('cargo build --release')
  })
})
