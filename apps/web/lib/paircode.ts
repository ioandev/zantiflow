// Pairing-code helpers (ADR-0012). The plugin shows an 8-character code as `XXXX-XXXX` using a
// base32 alphabet with the visually ambiguous 0/O/1/I removed (mirrors the backend's `code.ts`).
// These keep the entry field forgiving: users can paste with or without the dash, in any case.

/** Strip to A–Z0–9, uppercase, cap at the 8 significant characters (drops the dash/spaces). */
export const stripUserCode = (input: string): string =>
  input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)

/** Format for display in the input: `XXXX-XXXX` once past 4 characters. */
export const formatUserCode = (input: string): string => {
  const raw = stripUserCode(input)
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

/** A code is submittable once all 8 significant characters are present. */
export const isCompleteCode = (input: string): boolean => stripUserCode(input).length === 8

/** Map a backend approve error (code + HTTP status) to a friendly, actionable message. */
export const approveErrorMessage = (code: string, status?: number): string => {
  switch (code) {
    case 'invalid_code':
      return "That code wasn't recognized. Check the characters and try again."
    case 'code_expired':
      return 'That code has expired. Restart pairing in your terminal to get a fresh one.'
    case 'code_not_pending':
      return 'That code was already used. Restart pairing in your terminal for a new one.'
    default:
      return status === 429
        ? 'Too many attempts — wait a minute, then try again.'
        : "Couldn't pair the device. Please try again."
  }
}
