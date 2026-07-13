'use client'

// Pre-permission button (ADR-0006): a user GESTURE triggers `requestPermission()` → `PushManager
// .subscribe()` with the server's VAPID key → POSTs the subscription to the backend. Browsers require
// the request to come from a user action, so this is a button, not an on-load prompt.
import { useEffect, useState } from 'react'
import { getVapidKey, subscribePush } from '@/lib/api'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

type State = 'hidden' | 'default' | 'granted' | 'denied' | 'busy'

export function EnableNotifications() {
  const [state, setState] = useState<State>('hidden')

  useEffect(() => {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) setState('hidden')
    else setState(Notification.permission as 'default' | 'granted' | 'denied')
  }, [])

  if (state === 'hidden' || state === 'granted') return null

  const enable = async () => {
    setState('busy')
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        setState(perm as 'denied' | 'default')
        return
      }
      const key = await getVapidKey()
      if (!key) {
        alert('Push notifications are not configured on this server.')
        setState('default')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      })
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
      await subscribePush({ endpoint: json.endpoint, keys: json.keys })
      setState('granted')
    } catch {
      setState('default')
    }
  }

  return (
    <button className="btn ghost" type="button" onClick={enable} disabled={state === 'busy'} style={{ marginLeft: 12 }}>
      🔔 {state === 'denied' ? 'Notifications blocked' : 'Enable notifications'}
    </button>
  )
}
