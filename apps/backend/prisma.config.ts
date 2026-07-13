// Prisma 7 config (ADR-0018 §Prisma). The datasource connection URL lives here now — Prisma 7 no
// longer accepts `url` in schema.prisma, and no longer auto-loads `.env`. The CLI (migrate/generate/
// db push) reads DATABASE_URL from the process env; we load the local `.env` as a fallback only when
// it isn't already set, so an explicit env (tests / prod / CI) always wins over the on-disk file.
import path from 'node:path'
import { defineConfig } from 'prisma/config'

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'))
  } catch {
    // No .env on disk — prod/CI inject DATABASE_URL directly. Fine.
  }
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
