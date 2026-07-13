// Dev-only: ensure a local account exists and mint an infinite ingest token, printing the secret.
// Run: pnpm --filter @zantiflow/backend exec tsx --env-file=.env scripts/dev-mint-token.ts
import { PrismaClient } from '@prisma/client'
import { generateToken } from '../src/tokens/secret'

const prisma = new PrismaClient()

async function main() {
  const account = await prisma.account.upsert({
    where: { oauthProvider_oauthId: { oauthProvider: 'dev', oauthId: 'local' } },
    update: {},
    create: { oauthProvider: 'dev', oauthId: 'local', name: 'Dev (local)', email: 'dev@localhost' },
  })
  const { secret, lookupPrefix, secretHash } = generateToken()
  await prisma.token.create({
    data: { accountId: account.id, lookupPrefix, secretHash, label: 'dev-plugin', expiresAt: null },
  })
  console.log(secret)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
