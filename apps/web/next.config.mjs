// The web tier proxies /api/v1 → backend on the SAME origin (ADR-0018 §8), so the `ztf_session`
// cookie and CORS "just work" (the browser only ever talks to this origin). The backend URL is
// server-side only. Strict TLS + page CSP are owned by the Caddy tier in prod (ADR-0018 §D13);
// here we set the framework-level security headers.
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4000'

// Build identity — set at image-build time via build args (apps/web/Dockerfile + docker-publish.yml);
// falls back to a dev marker for a local build. Exposed to the bundle below so the footer + startup
// log can show which version is running.
const APP_VERSION = process.env.APP_VERSION ?? 'dev'
const GIT_SHA = process.env.GIT_SHA ?? 'unknown'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Inline the build identity for both server and client so no runtime env lookup is needed (the
  // image is immutable, so its version is fixed at build time).
  env: { APP_VERSION, GIT_SHA },
  // Build/run into an alternate output dir when NEXT_DIST_DIR is set — lets the e2e prod build run on
  // its own port WITHOUT clobbering a concurrent `next dev`'s `.next` (default stays `.next`).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Emit a self-contained server bundle for a slim Docker image (ADR-0021).
  output: 'standalone',
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${BACKEND_URL}/api/v1/:path*` }]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
