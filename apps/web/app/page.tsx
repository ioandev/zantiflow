import type { Metadata } from 'next'
import { Homepage } from '@/components/home/Homepage'
import './home.css'

// SEO/social metadata (HOMEPAGE.md §6). This is a server component so the title/description/OG card are
// emitted in the initial HTML; the marketing markup below is server-rendered too, so crawlers see the
// full pitch. The Homepage client component only layers on the signed-in → /dashboard redirect.
const title = 'zantiflow — live Zellij session dashboard with attention notifications'
const description =
  'See every Zellij terminal session across your machines, live — and get pinged the moment a pane needs you, like a Claude Code session waiting on input. Free, open source, privacy-first, self-hostable.'

export const metadata: Metadata = {
  // `absolute` opts out of the root layout's "%s · zantiflow" template — the homepage title is already
  // fully branded. The site-wide OG/Twitter card + image are inherited from the root layout.
  title: { absolute: title },
  description,
  openGraph: { title, description },
}

export default function Page() {
  return <Homepage />
}
