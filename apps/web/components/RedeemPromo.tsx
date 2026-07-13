'use client'

// Redeem a promo code → PRO (ADR-0011). Owner-authed; the backend enforces limits + the 60-day cap.
// The button is always clickable so an empty field gives feedback (where to get a code) instead of
// silently doing nothing; a bad code surfaces the backend's error.
import { useState } from 'react'
import Link from 'next/link'
import { redeemPromo } from '@/lib/api'

type Msg = { kind: 'ok' | 'err' | 'info'; node: React.ReactNode }

export function RedeemPromo({ onRedeemed }: { onRedeemed?: () => void }) {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = code.trim()
    if (!trimmed) {
      setMsg({
        kind: 'info',
        node: (
          <>
            Enter a promo code first — grab this period’s from the <Link href="/">homepage</Link>.
          </>
        ),
      })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await redeemPromo(trimmed)
      setMsg({ kind: 'ok', node: `PRO until ${new Date(res.tierExpiresAt).toLocaleDateString()}` })
      setCode('')
      onRedeemed?.()
    } catch (e) {
      setMsg({ kind: 'err', node: e instanceof Error ? e.message : 'Could not redeem that code.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="redeem">
      <input
        className="redeem-input"
        placeholder="promo code"
        value={code}
        onChange={(e) => {
          setCode(e.target.value)
          if (msg) setMsg(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        maxLength={32}
      />
      <button className="btn ghost" type="button" onClick={submit} disabled={busy}>
        Redeem
      </button>
      {msg && (
        <span className={`redeem-msg is-${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>
          {msg.node}
        </span>
      )}
    </span>
  )
}
