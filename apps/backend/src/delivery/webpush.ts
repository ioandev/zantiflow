// The Web Push channel adapter (ADR-0006). `WebPushSender` is a small port so the dispatcher is
// testable with a mock (no real push service). The real implementation signs with the VAPID keypair
// and maps 404/410 → `gone` so the dispatcher can prune dead subscriptions.
import webpush from 'web-push'
import type { Config } from '../config'

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}
export interface PushPayload {
  title: string
  body: string
  url?: string
}
export interface SendResult {
  ok: boolean
  /** The subscription is gone (404/410) → the dispatcher should delete it. */
  gone?: boolean
  error?: string
}

export interface WebPushSender {
  send(target: PushTarget, payload: PushPayload): Promise<SendResult>
}

export const createWebPushSender = (vapid: Config['vapid']): WebPushSender => {
  const configured = Boolean(vapid.publicKey && vapid.privateKey)
  if (configured) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey!, vapid.privateKey!)
  }
  return {
    async send(target, payload) {
      if (!configured) return { ok: false, error: 'vapid_not_configured' }
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
        )
        return { ok: true }
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) return { ok: false, gone: true }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
