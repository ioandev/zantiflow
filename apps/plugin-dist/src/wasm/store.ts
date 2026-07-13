// The single in-memory slot holding the currently-served plugin artifact. In-process only (like the
// backend's PaneOutputStore, ADR-0032) — one backend, no DB. Swapped atomically by the refresh
// service; read by the HTTP router on every request.

export interface WasmArtifact {
  /** The release tag we mirrored, e.g. `v1.2.3`. */
  version: string
  bytes: Buffer
  size: number
  /** SHA-256 of `bytes`, lower-case hex — computed locally, used as the strong ETag body. */
  sha256: string
  /** Strong ETag, `"<sha256>"`. */
  etag: string
  contentType: string
  /** When we fetched it (ISO 8601). */
  fetchedAt: string
  /** Did the bytes match a checksum published on the release (ADR-0022)? */
  verified: boolean
}

export interface WasmStore {
  get(): WasmArtifact | null
  set(artifact: WasmArtifact): void
}

export const createWasmStore = (): WasmStore => {
  let current: WasmArtifact | null = null
  return {
    get: () => current,
    set: (artifact) => {
      current = artifact
    },
  }
}
