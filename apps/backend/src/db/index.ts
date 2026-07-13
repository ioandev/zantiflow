// Prisma client access. A single lazily-created client is shared process-wide (Prisma pools
// connections internally). Every feature module queries through this and MUST scope by
// `accountId` at the query (the plan's top invariant — IDOR is the highest-value bug class).
// Prisma 7 connects through a driver adapter: the MariaDB adapter takes the DATABASE_URL and owns
// the connection pool (the URL is no longer read implicitly from schema/env by the engine).
import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'

let client: PrismaClient | undefined

const createClient = (): PrismaClient => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return new PrismaClient({ adapter: new PrismaMariaDb(url) })
}

export const getPrisma = (): PrismaClient => (client ??= createClient())

export const disconnectPrisma = async (): Promise<void> => {
  if (client) {
    await client.$disconnect()
    client = undefined
  }
}

/**
 * Readiness probe: a trivial parameterized round-trip proving the DB is reachable. `$queryRaw`
 * with a tagged template is parameterized (never string-built SQL — ADR-0018 §5 / audit C2).
 */
export const checkDbReady = async (prisma: PrismaClient = getPrisma()): Promise<boolean> => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}
