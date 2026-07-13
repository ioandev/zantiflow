// Server-component wrapper giving the client integrations page its metadata. Auth-gated → not indexed.
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Chat integrations',
  description: 'Connect Discord or Telegram to get DM notifications when a terminal pane needs your attention.',
  robots: { index: false, follow: false },
}

export default function IntegrationsLayout({ children }: { children: React.ReactNode }) {
  return children
}
