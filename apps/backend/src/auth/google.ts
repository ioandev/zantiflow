// Build the hardened Google provider from config. Returns null when Google isn't configured, so a
// deployer can boot the backend before wiring OAuth (the auth router simply mounts no providers).
import { GoogleProvider } from '@zantiflow/oauth'
import type { Config } from '../config'

export const buildGoogleProvider = (config: Config): GoogleProvider | null => {
  const { clientId, clientSecret, redirectUri } = config.google
  if (!clientId || !clientSecret || !redirectUri) return null
  // GoogleProvider verifies the id_token against Google's JWKS internally (ADR-0004 hardening).
  return new GoogleProvider({ clientId, clientSecret, redirectUri })
}
