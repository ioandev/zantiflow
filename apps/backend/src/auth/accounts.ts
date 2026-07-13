// Account resolution on login. Identity is `(oauthProvider, oauthId)` — there is NO account
// linking across providers (ADR-0004): `email` is a cached attribute, never a join key. A
// soft-deleted identity is refused (delete = soft-delete + anonymize, reject on next request).
import type { Account, PrismaClient } from '@prisma/client'
import type { OAuthProfile } from '@zantiflow/oauth'
import { forbidden } from '../http/errors'

export const upsertAccount = async (
  prisma: PrismaClient,
  provider: string,
  profile: OAuthProfile,
): Promise<Account> => {
  const existing = await prisma.account.findUnique({
    where: { oauthProvider_oauthId: { oauthProvider: provider, oauthId: profile.sub } },
  })
  if (existing?.deletedAt) throw forbidden('account_deleted')

  // `name` is required; fall back through the provider's name → cached name → email → "User".
  const name = profile.name ?? existing?.name ?? profile.email ?? 'User'
  const data = { email: profile.email, name, avatarUrl: profile.picture }

  if (existing) return prisma.account.update({ where: { id: existing.id }, data })
  return prisma.account.create({ data: { oauthProvider: provider, oauthId: profile.sub, ...data } })
}
