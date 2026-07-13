import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import './globals.css'
import { RegisterSW } from './register-sw'

// Self-hosted (CSP-safe) — next/font downloads + serves these from our own origin at build time.
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
})
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
})

// The public origin the site is served from — needed so file-based OG/Twitter image URLs resolve to
// absolute links (crawlers reject relative ones). Set NEXT_PUBLIC_SITE_URL in prod (deploy/.env);
// falls back to localhost for dev. Read server-side at render time, so no rebuild is needed to change it.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

const defaultTitle = 'zantiflow — live Zellij session dashboard with attention notifications'
const defaultDescription =
  'See every Zellij terminal session across your machines, live — and get pinged the moment a pane needs you, like a Claude Code session waiting on input. Free, open source, privacy-first, self-hostable.'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  // Sub-pages set a short title (e.g. "Dashboard") and inherit the "· zantiflow" suffix; the homepage
  // opts out of the template with `title.absolute`.
  title: { default: defaultTitle, template: '%s · zantiflow' },
  description: defaultDescription,
  applicationName: 'zantiflow',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'zantiflow', statusBarStyle: 'black-translucent' },
  keywords: [
    'Zellij plugin',
    'terminal session dashboard',
    'Claude Code notifications',
    'AI agent waiting for input',
    'monitor terminal sessions remotely',
    'tmux Zellij session monitor',
  ],
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
  openGraph: {
    type: 'website',
    siteName: 'zantiflow',
    title: defaultTitle,
    description: defaultDescription,
    url: '/',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: defaultTitle,
    description: defaultDescription,
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#14181d' },
  ],
}

// Apply the saved theme before first paint (no flash). Only stamps `data-theme` when the user has
// explicitly chosen one; otherwise the CSS follows the OS `prefers-color-scheme`. Because this runs
// before hydration, it mutates `<html>` out from under React — `suppressHydrationWarning` on <html>
// tells React that element's attributes are expected to differ from the server render (theme-script
// pattern; the flag is shallow, so it only covers <html>'s own attributes, not any descendants).
const themeInit = `(function(){try{var t=localStorage.getItem('ztf-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  )
}
