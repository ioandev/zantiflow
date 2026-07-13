// Server-component wrapper giving the client pairing page its metadata. Auth-gated → not indexed.
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Pair a device',
  description: 'Approve a device pairing code to connect your Zellij plugin to your zantiflow account.',
  robots: { index: false, follow: false },
}

export default function PairLayout({ children }: { children: React.ReactNode }) {
  return children
}
