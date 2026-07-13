// Server-component wrapper giving the client Spotlight page its <title>/description (a `'use client'`
// page cannot export metadata). Auth + PRO gated, so it is excluded from search indexes.
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Spotlight',
  description: 'A live album of every active Claude session across your machines, with streaming output.',
  robots: { index: false, follow: false },
}

export default function SpotlightLayout({ children }: { children: React.ReactNode }) {
  return children
}
