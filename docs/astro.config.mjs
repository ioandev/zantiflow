import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

// Starlight docs (ADR-0021). Covers the plugin, backend, dashboard, bots, privacy, contributing, and
// what ADRs are. Pagefind search is built in. Deployed to GitHub Pages.
export default defineConfig({
  site: 'https://docs.zantiflow.com',
  integrations: [
    starlight({
      title: 'zantiflow',
      description: 'Live Zellij session telemetry — a plugin, a multi-tenant backend, a PWA dashboard, and bots.',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/z-signal-logo.svg' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ioandev/zantiflow' }],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', slug: 'overview' },
            { label: 'Plugin: getting started', slug: 'plugin/getting-started' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Backend', slug: 'backend' },
            { label: 'Dashboard', slug: 'dashboard' },
            { label: 'Notifications & bots', slug: 'bots' },
          ],
        },
        {
          label: 'Project',
          items: [
            { label: 'Privacy', slug: 'privacy' },
            { label: 'Licensing & compliance', slug: 'licensing' },
            { label: 'Contributing', slug: 'contributing' },
            { label: 'What ADRs are', slug: 'adrs' },
            { label: 'Donations', slug: 'donations' },
          ],
        },
      ],
    }),
  ],
})
