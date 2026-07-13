'use client'

// Chat integrations page (ADR-0007) — PRO users connect Discord/Telegram to get DM notifications. We
// mint a one-time link token; the user runs the bot's `/link <token>` command (or a Telegram deep
// link) to bind their account.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getIntegrations, mintChatLinkToken, signInHref, unlinkChat, UnauthorizedError } from '@/lib/api'
import type { ChannelLinkView } from '@/lib/api'
import { TopBar } from '@/components/TopBar'
import { copyText } from '@/lib/clipboard'

export default function Integrations() {
  const [links, setLinks] = useState<ChannelLinkView[]>([])
  const [status, setStatus] = useState<'loading' | 'anon' | 'ready'>('loading')
  const [command, setCommand] = useState<{ platform: string; token: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLinks(await getIntegrations())
      setStatus('ready')
    } catch (e) {
      setStatus(e instanceof UnauthorizedError ? 'anon' : 'ready')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Linking happens out of band — the user runs the /link command in their chat app, and the backend
  // pushes nothing to this page. So while a command is outstanding, poll for the link to land (up to
  // ~2 min), then hide the command banner once an active link for that platform appears.
  useEffect(() => {
    if (!command) return
    const platform = command.platform
    const sig = (ls: ChannelLinkView[]) =>
      JSON.stringify(ls.filter((l) => l.platform === platform).map((l) => [l.id, l.status, l.linkedAt]))
    let baseline: string | null = null
    let elapsed = 0
    const id = setInterval(async () => {
      elapsed += 3
      try {
        const fresh = await getIntegrations()
        setLinks(fresh)
        const now = sig(fresh)
        if (baseline === null) baseline = now
        else if (now !== baseline && fresh.some((l) => l.platform === platform && l.status === 'active')) {
          setCommand(null) // linked → drop the command banner
          clearInterval(id)
        }
      } catch {
        /* transient; keep polling */
      }
      if (elapsed >= 120) clearInterval(id)
    }, 3000)
    return () => clearInterval(id)
  }, [command])

  const connect = async (platform: 'discord' | 'telegram') => {
    if (busy) return // guard against double-clicks minting duplicate tokens
    setBusy(true)
    setCopied(false) // a fresh token invalidates any prior "Copied!" flash
    try {
      const { token } = await mintChatLinkToken(platform)
      setCommand({ platform, token })
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not create a link token')
    } finally {
      setBusy(false)
    }
  }

  // Copy only the token (not the `/link ` prefix) — that's what the bot's command argument needs.
  const copyToken = async () => {
    if (!command || !(await copyText(command.token))) return
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1600)
  }
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), [])

  if (status === 'loading')
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    )
  if (status === 'anon') {
    return (
      <main className="wrap">
        <a className="btn" href={signInHref('/integrations')}>
          Sign in
        </a>
      </main>
    )
  }

  return (
    <>
      <TopBar />
      <main className="wrap">
        <h1>Chat notifications (PRO)</h1>
        <p className="muted">
          Connect Discord or Telegram to receive attention alerts as DMs. Message the bot with the command below.
        </p>

        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
          <button className="btn" type="button" onClick={() => connect('discord')} disabled={busy}>
            Connect Discord
          </button>
          <button className="btn" type="button" onClick={() => connect('telegram')} disabled={busy}>
            Connect Telegram
          </button>
        </div>

        {command && (
          <div className="banner">
            <p>
              Message the <strong>{command.platform}</strong> bot with (valid ~10 min):
            </p>
            <p className="link-cmd">
              <span className="link-cmd-prefix">/link</span>{' '}
              <span className="code-wrap">
                <button
                  type="button"
                  className={`code-copy${copied ? ' is-copied' : ''}`}
                  onClick={copyToken}
                  title="Click to copy"
                  aria-label="Copy link code to clipboard"
                >
                  {command.token}
                </button>
                <span className={`code-copied${copied ? ' is-shown' : ''}`} aria-live="polite">
                  {copied ? 'Copied!' : ''}
                </span>
              </span>
            </p>
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Platform</th>
              <th>Account</th>
              <th>Status</th>
              <th>Linked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td>{l.platform}</td>
                <td>{l.platformUsername ?? <span className="muted">—</span>}</td>
                <td>{l.status}</td>
                <td className="muted">{new Date(l.linkedAt).toLocaleString()}</td>
                <td>
                  {l.status !== 'revoked' && (
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={async () => {
                        await unlinkChat(l.id).catch(() => {})
                        await refresh()
                      }}
                    >
                      Unlink
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {links.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No linked chat accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </main>
    </>
  )
}
