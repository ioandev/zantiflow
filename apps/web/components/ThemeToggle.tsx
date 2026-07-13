'use client'

// Light/dark toggle (ADR-0016 §A). Writes an explicit choice to <html data-theme> + localStorage so
// it wins over the OS preference; layout.tsx replays the saved choice pre-paint (no flash). The label
// shows the theme you'll switch TO, matching the vendored design.
import { useEffect, useState } from 'react'

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null)

  useEffect(() => {
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'light' || attr === 'dark') setTheme(attr)
    else setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  }, [])

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem('ztf-theme', next)
    } catch {
      /* private mode — in-memory only */
    }
    setTheme(next)
  }

  const dark = theme === 'dark'
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Toggle light or dark theme">
      <span aria-hidden>{theme === null ? '◐' : dark ? '☀' : '☾'}</span>
      {theme === null ? 'Theme' : dark ? 'Light' : 'Dark'}
    </button>
  )
}
