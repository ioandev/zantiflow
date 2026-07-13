'use client'

// Public homepage promo code (ADR-0011). Auto-generated on the backend; anyone can see it, sign in,
// and redeem it for a month of PRO.
import { useEffect, useState } from 'react'
import { getCurrentPromo } from '@/lib/api'

export function PromoBanner() {
  const [code, setCode] = useState<{ code: string; durationDays: number } | null>(null)

  useEffect(() => {
    getCurrentPromo()
      .then(setCode)
      .catch(() => {})
  }, [])

  if (!code) return null
  return (
    <div className="banner">
      🎁 This period’s code: <span className="secret">{code.code}</span> — sign in and redeem it for{' '}
      <strong>{code.durationDays} days of PRO</strong>.
    </div>
  )
}
