// Self-host owner sign-in (ADR-0035). A single long secret set in config (`SELF_HOST_SECRET`) lets
// a self-hoster sign in as the ONE owner of their instance without Google. The secret is verified
// against config and NEVER stored — there is no at-rest artifact to crack (unlike a password hash),
// so a fast SHA-256 + timing-safe compare is the right primitive (same reasoning as ingest tokens,
// `tokens/secret.ts` — audit F2/F7). The owner is a normal Account under a reserved provider identity
// so the whole owner-session plane (`/auth/me`, logout, logout-all, per-account scoping) works unchanged.
import type { OAuthProfile } from '@zantiflow/oauth'
import type { Config } from '../config'
import { hashSecret, secretHashMatches } from '../tokens/secret'

/** Reserved provider + subject for the single self-host owner: identity `('local', 'owner')`. */
export const LOCAL_PROVIDER = 'local'
export const LOCAL_OWNER_ID = 'owner'

/** The fixed profile the local owner upserts to (funnels through the one `upsertAccount` path). */
export const localOwnerProfile = (): OAuthProfile => ({
  sub: LOCAL_OWNER_ID,
  email: null,
  emailVerified: null,
  name: 'Owner',
  picture: null,
})

/**
 * True iff `presented` matches the configured self-host secret. Non-strings return false. Comparison
 * is timing-safe over fixed-length SHA-256 hex (no length leak, no throw). Callers must only reach
 * here when `config.selfHostSecret` is set (the route is not mounted otherwise).
 */
export const localSecretMatches = (config: Config, presented: unknown): boolean => {
  if (typeof presented !== 'string' || !config.selfHostSecret) return false
  return secretHashMatches(presented, hashSecret(config.selfHostSecret))
}
