// Decode the payload of an id_token (a JWT) WITHOUT verifying its signature.
// This is safe — and safe ONLY here — because these tokens arrive server-to-server
// directly from the provider's token endpoint over TLS (authenticated with your
// client secret), never through the browser. This mirrors Google's and Apple's own
// guidance for the authorization-code flow. Do NOT use this on a token that has
// transited an untrusted channel — there a JWKS signature check is mandatory.
// (For that reason `google.ts` now VERIFIES the id_token against Google's JWKS as
// defense-in-depth rather than calling this; only `apple.ts` still decodes here.)
export const decodeIdTokenPayload = (jwt: string): Record<string, unknown> => {
  const part = jwt.split('.')[1]
  if (!part) throw new Error('malformed id_token')
  return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>
}
