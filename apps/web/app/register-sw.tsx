'use client'

import { useEffect } from 'react'

/** Registers the service worker so the dashboard is installable as a PWA (ADR-0006). */
export function RegisterSW() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* SW registration is best-effort; the app works without it */
      })
    }
  }, [])
  return null
}
