// A collapsible "Sent notifications" panel (ADR-0006/0009): the account's last 10 notifications, newest
// first, each with the channels it was sent on (Web / Discord / Telegram) and their delivery status.
// Uses a native <details> so the collapse needs no client state; the notification text is already
// privacy-safe and name-free (composed server-side), so rendering it is safe.
import type { NotificationChannel, NotificationView } from '@/lib/types'
import { relativeAgo } from '@/lib/format'
import { Pill } from './atoms'

const CHANNEL_LABEL: Record<string, string> = { webpush: 'Web', discord: 'Discord', telegram: 'Telegram' }
// Map a delivery status to a pill colour variant that already exists in globals.css.
const STATUS_KIND: Record<string, string> = { delivered: 'live', pending: 'quiet', failed: 'att', expired: 'stale' }

function ChannelBadge({ c }: { c: NotificationChannel }) {
  const label = CHANNEL_LABEL[c.channel] ?? c.channel
  return (
    <Pill kind={STATUS_KIND[c.status] ?? 'stale'} sm>
      {label}
      {c.status !== 'delivered' && <span className="muted"> · {c.status}</span>}
    </Pill>
  )
}

export function SentNotifications({ notifications }: { notifications: NotificationView[] }) {
  const anyUndelivered = notifications.some((n) => n.channels.length === 0)
  return (
    <section className="ov">
      <details className="sent-notifs">
        <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ fontWeight: 600 }}>Sent notifications</span>
          <span className="count" style={{ marginLeft: 8 }}>
            {notifications.length > 0 ? `last ${notifications.length}` : 'none yet'}
          </span>
        </summary>

        {notifications.length === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>
            No notifications sent yet. They appear here when an attention fires.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: '10px 0 0',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {notifications.map((n) => (
              <li
                key={n.id}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderTop: '1px solid var(--border, rgba(128,128,128,0.2))',
                }}
              >
                <span>{n.text}</span>
                <span className="count">{relativeAgo(n.createdAt)}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {n.channels.length > 0 ? (
                    n.channels.map((c) => <ChannelBadge key={c.channel} c={c} />)
                  ) : (
                    <span className="muted">not sent</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {anyUndelivered && (
          <p className="muted" style={{ marginTop: 10 }}>
            “not sent” = no delivery channel was set up when it fired. Enable <strong>Web Push</strong> on this device,
            or link <strong>Telegram / Discord</strong> — those need <strong>PRO</strong>, which you can get for free by
            grabbing the code on the{' '}
            <a href="/" style={{ textDecoration: 'underline' }}>
              homepage
            </a>{' '}
            and redeeming it here.
          </p>
        )}
      </details>
    </section>
  )
}
