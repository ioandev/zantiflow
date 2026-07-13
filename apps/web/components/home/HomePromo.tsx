'use client'

// The current auto-minted PRO promo code, shown understated near the hero CTAs (HOMEPAGE.md §2.1,
// ADR-0020). Public + best-effort: if the code hasn't been minted or the fetch fails, render nothing.
// The code is click-to-copy — clicking it copies the code and flashes a "Copied!" tooltip.
import { useEffect, useRef, useState } from 'react'
import { getCurrentPromo } from '@/lib/api'
import { copyText } from '@/lib/clipboard'

export function HomePromo() {
  const [code, setCode] = useState<{ code: string; durationDays: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    getCurrentPromo()
      .then(setCode)
      .catch(() => {})
  }, [])

  // Clear a pending "Copied!" reset if the component unmounts first.
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  if (!code) return null

  const onCopy = async () => {
    if (!(await copyText(code.code))) return
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="hp-promo">
      <span className="hp-promo-tag">PRO promo</span>
      <span>This period’s code:</span>
      <span className="hp-code-wrap">
        <button
          type="button"
          className={`hp-promo-code${copied ? ' is-copied' : ''}`}
          onClick={onCopy}
          title="Click to copy"
          aria-label={`Copy promo code ${code.code} to clipboard`}
        >
          {code.code}
        </button>
        <span className={`hp-copied${copied ? ' is-shown' : ''}`} aria-live="polite">
          {copied ? 'Copied!' : ''}
        </span>
      </span>
      <span>— sign in and redeem for a month of PRO.</span>
    </div>
  )
}
