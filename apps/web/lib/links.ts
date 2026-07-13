// External destinations for the marketing homepage and outbound docs links. The public URLs match
// docs/astro.config.mjs (Starlight on GitHub Pages) and the GitHub repo — keep them in sync there.
const DOCS = 'https://ioandev.github.io/zantiflow'
export const GITHUB_URL = 'https://github.com/ioandev/zantiflow'

export const links = {
  docs: `${DOCS}/`,
  /** The plugin getting-started guide — installing the plugin is the real activation event (HOMEPAGE.md §5). */
  getStarted: `${DOCS}/plugin/getting-started/`,
  privacy: `${DOCS}/privacy/`,
  contributing: `${DOCS}/contributing/`,
  donations: `${DOCS}/donations/`,
  github: GITHUB_URL,
  deployExample: `${GITHUB_URL}/tree/main/deploy`,
  sponsors: 'https://github.com/sponsors/ioandev',
} as const
