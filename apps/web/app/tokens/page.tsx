'use client'

// Ingest tokens + the machines each one reports for (ADR-0003). A token is the write-only credential a
// plugin pushes with; changing the plugin's install location regenerates its machineId, so one account
// accumulates many machines (and, if re-paired, many tokens). This page groups each token's machines
// under it — with when each was added / last seen — so the owner can kick a stale machine, rename a
// token, or revoke a token AND forget its machines in one go. Machines with no recorded token yet
// (they predate the link, or their token was already removed) are listed under "Other machines".
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import {
  createToken,
  forgetMachine,
  getMachines,
  listTokens,
  signInHref,
  renameToken,
  revokeAllTokens,
  revokeToken,
  UnauthorizedError,
} from '@/lib/api'
import type { MachineSummary, TokenMeta } from '@/lib/types'
import { lastSeenLabel, longDate, pluralize } from '@/lib/format'
import { Dot, Name, Pill } from '@/components/dashboard/atoms'
import { TopBar } from '@/components/TopBar'

const TTLS = ['infinite', '365d', '90d', '30d', '7d', '24h', '1h']

// active → positive pill; revoked → red (reuse `.pill.exited`); expired → muted (reuse `.pill.stale`).
const statusPill = (s: TokenMeta['status']) => (s === 'active' ? 'active' : s === 'revoked' ? 'exited' : 'stale')
const byLastSeenDesc = (a: MachineSummary, b: MachineSummary) =>
  new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()

/** A destructive action that confirms INLINE (no browser dialog): clicking the trigger swaps it for a
 * de-emphasised "Confirm" and a green "Cancel", so the safe way out is the highlighted one. */
function DangerAction({
  label,
  disabled,
  sm = true,
  onConfirm,
}: {
  label: string
  disabled?: boolean
  sm?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const cls = sm ? ' sm' : ''
  if (!confirming) {
    return (
      <button className={`btn ghost${cls}`} type="button" disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </button>
    )
  }
  return (
    <span className="confirm-actions">
      <button
        className={`btn ghost${cls}`}
        type="button"
        disabled={disabled}
        onClick={async () => {
          await onConfirm()
          setConfirming(false)
        }}
      >
        Confirm
      </button>
      <button className={`btn grn${cls}`} type="button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  )
}

/** One machine row: status dot, name + machineId, when added / last seen, and an inline-confirm Kick.
 * The machineId is the plugin-generated id (persisted in the plugin's /data) — shown so the owner can
 * match a row to a specific install; `user-select: all` (CSS) makes it one-click copyable. */
function MachineRow({ m, disabled, onKick }: { m: MachineSummary; disabled: boolean; onKick: () => void | Promise<void> }) {
  return (
    <div className="mrow">
      <Dot kind={m.online ? 'live' : 'stale'} />
      <div className="mrow-main">
        <div className="mrow-top">
          <Name value={m.displayName} className="mname" hiddenText="<machine hidden>" />
          <span className="mmeta">added {longDate(m.firstSeenAt)}</span>
          <span className="mmeta">{m.online ? 'online now' : `last seen ${lastSeenLabel(m.lastSeenAt)}`}</span>
        </div>
        <span className="mid mono">{m.id}</span>
      </div>
      <span className="spacer" />
      <DangerAction label="Kick" disabled={disabled} onConfirm={onKick} />
    </div>
  )
}

export default function Tokens() {
  const [tokens, setTokens] = useState<TokenMeta[]>([])
  const [machines, setMachines] = useState<MachineSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'anon' | 'ready'>('loading')
  const [label, setLabel] = useState('')
  const [ttl, setTtl] = useState('30d')
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [ts, ms] = await Promise.all([listTokens(), getMachines()])
      setTokens(ts)
      setMachines(ms)
      setStatus('ready')
    } catch (e) {
      setStatus(e instanceof UnauthorizedError ? 'anon' : 'ready')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onCreate = async () => {
    setBusy(true)
    try {
      const created = await createToken({ label: label.trim() || undefined, ttl })
      setSecret(created.secret) // shown ONCE
      setLabel('')
      await refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create token')
    } finally {
      setBusy(false)
    }
  }

  const activeCount = tokens.filter((t) => t.status === 'active').length
  const onRevokeAll = async () => {
    setBusy(true)
    try {
      await revokeAllTokens()
      await refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to revoke tokens')
    } finally {
      setBusy(false)
    }
  }

  // Combined revoke + forget (ADR-0003): revoking a token also deletes the machines it last pushed for.
  const onRevoke = async (t: TokenMeta) => {
    setBusy(true)
    try {
      await revokeToken(t.id)
      await refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to revoke token')
    } finally {
      setBusy(false)
    }
  }

  const onKick = async (m: MachineSummary) => {
    setBusy(true)
    try {
      await forgetMachine(m.id)
      await refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to kick machine')
    } finally {
      setBusy(false)
    }
  }

  const saveRename = async () => {
    if (!renaming) return
    setBusy(true)
    try {
      await renameToken(renaming.id, renaming.value.trim() || null)
      setRenaming(null)
      await refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rename token')
    } finally {
      setBusy(false)
    }
  }

  if (status === 'loading')
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    )
  if (status === 'anon') {
    return (
      <main className="wrap">
        <a className="btn" href={signInHref('/tokens')}>
          Sign in
        </a>
      </main>
    )
  }

  // Group machines under the token that last pushed for them; the rest are "unlinked".
  const byToken = new Map<string, MachineSummary[]>()
  const unlinked: MachineSummary[] = []
  for (const m of machines) {
    if (m.tokenId) {
      const arr = byToken.get(m.tokenId) ?? []
      arr.push(m)
      byToken.set(m.tokenId, arr)
    } else {
      unlinked.push(m)
    }
  }

  return (
    <>
      <TopBar />
      <main className="wrap">
        <h1>Ingest tokens</h1>
        <p className="muted">
          Write-only credentials the plugin uses to push snapshots. Up to 10 active. The secret is shown once — copy it
          now. Prefer not to copy-paste? <Link href="/pair">Pair a device</Link> instead. Each token lists the machines
          it reports for; kick a stale one, or revoke a token to forget its machines.
        </p>

        {secret && (
          <div className="banner">
            <p>
              <strong>Copy your new token — it won&apos;t be shown again:</strong>
            </p>
            <p className="secret">{secret}</p>
            <button className="btn ghost" type="button" onClick={() => setSecret(null)}>
              Done
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '16px 0' }}>
          <input
            placeholder="name (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
          />
          <select value={ttl} onChange={(e) => setTtl(e.target.value)}>
            {TTLS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn" type="button" onClick={onCreate} disabled={busy}>
            Create token
          </button>
          {activeCount > 0 && <DangerAction label="Revoke all" sm={false} disabled={busy} onConfirm={onRevokeAll} />}
        </div>

        {tokens.length === 0 ? (
          <p className="muted">No tokens yet.</p>
        ) : (
          <div className="tok-list">
            {tokens.map((t) => {
              const ms = (byToken.get(t.id) ?? []).slice().sort(byLastSeenDesc)
              const editing = renaming?.id === t.id
              return (
                <div className={`tok-card ${t.status}`} key={t.id}>
                  <div className="tok-head">
                    {editing ? (
                      <>
                        <input
                          value={renaming.value}
                          maxLength={100}
                          autoFocus
                          placeholder="token name"
                          onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveRename()
                            if (e.key === 'Escape') setRenaming(null)
                          }}
                        />
                        <button className="btn sm" type="button" onClick={saveRename} disabled={busy}>
                          Save
                        </button>
                        <button className="btn ghost sm" type="button" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {t.label ? (
                          <span className="tok-label">{t.label}</span>
                        ) : (
                          <span className="tok-label none">unnamed token</span>
                        )}
                        <Pill kind={statusPill(t.status)} sm>
                          {t.status}
                        </Pill>
                        <button
                          className="btn ghost sm"
                          type="button"
                          onClick={() => setRenaming({ id: t.id, value: t.label ?? '' })}
                        >
                          Rename
                        </button>
                        <span className="spacer" />
                        {t.status === 'active' && (
                          <DangerAction
                            label={ms.length > 0 ? `Revoke + forget ${pluralize(ms.length, 'machine')}` : 'Revoke'}
                            disabled={busy}
                            onConfirm={() => onRevoke(t)}
                          />
                        )}
                      </>
                    )}
                  </div>

                  <div className="tok-meta">
                    <span>created {longDate(t.createdAt)}</span>
                    <span>expires {t.expiresAt ? longDate(t.expiresAt) : 'never'}</span>
                    <span>last used {t.lastUsedAt ? lastSeenLabel(t.lastUsedAt) : '—'}</span>
                  </div>

                  <div className="tok-machines">
                    {ms.length === 0 ? (
                      <span className="mempty muted">No machines have reported with this token yet.</span>
                    ) : (
                      ms.map((m) => <MachineRow key={m.id} m={m} disabled={busy} onKick={() => onKick(m)} />)
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {unlinked.length > 0 && (
          <section className="tok-other">
            <h2>Other machines</h2>
            <p className="muted">
              Not tied to a token — they reported before token tracking, or their token was already removed. Kick any
              you no longer use.
            </p>
            <div className="tok-machines">
              {unlinked.slice().sort(byLastSeenDesc).map((m) => (
                <MachineRow key={m.id} m={m} disabled={busy} onKick={() => onKick(m)} />
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  )
}
