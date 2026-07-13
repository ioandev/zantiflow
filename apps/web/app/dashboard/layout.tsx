// Server-component wrapper that gives the client dashboard page its <title>/description (a
// `'use client'` page cannot export metadata). Auth-gated, so it is excluded from search indexes.
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Your machines, sessions, tabs, and panes — live, with attention badges the moment a pane needs you.',
  robots: { index: false, follow: false },
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children
}
