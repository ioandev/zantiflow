// Server-component wrapper giving the client tokens page its metadata. Auth-gated → not indexed.
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Ingest tokens',
  description: 'Create and revoke write-only ingest tokens for the zantiflow Zellij plugin — up to 10 per account.',
  robots: { index: false, follow: false },
}

export default function TokensLayout({ children }: { children: React.ReactNode }) {
  return children
}
