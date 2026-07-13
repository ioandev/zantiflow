// Thin GitHub REST client: list a repo's Releases and download release-asset bytes/text — only the
// calls this service needs (ADR-0022 distribution). `fetchImpl` is injectable so tests never touch
// the network.
//
// Downloads use the asset's public `browser_download_url` with NO Authorization header — exactly how
// Zellij itself pulls the plugin. That both matches real usage and sidesteps the cross-origin
// redirect-auth pitfall (GitHub 302s asset downloads to a storage host that rejects a forwarded
// bearer). The optional token is sent only on the JSON API `list` call, purely to raise the rate
// limit; it is never needed for a public repo.

export interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
}

export interface GithubRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: GithubAsset[]
}

export interface GithubClientOptions {
  apiUrl: string
  repo: string // "owner/name"
  token?: string
  timeoutMs: number
  userAgent: string
  fetchImpl?: typeof fetch
}

export interface GithubClient {
  listReleases(): Promise<GithubRelease[]>
  downloadBytes(url: string): Promise<Buffer>
  downloadText(url: string): Promise<string>
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rateLimited = false,
  ) {
    super(message)
    this.name = 'GithubError'
  }
}

export const createGithubClient = (opts: GithubClientOptions): GithubClient => {
  const doFetch = opts.fetchImpl ?? fetch
  const signal = (): AbortSignal => AbortSignal.timeout(opts.timeoutMs)

  const apiHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': opts.userAgent,
    }
    if (opts.token) h.authorization = `Bearer ${opts.token}`
    return h
  }

  const listReleases = async (): Promise<GithubRelease[]> => {
    const url = `${opts.apiUrl}/repos/${opts.repo}/releases?per_page=100`
    const res = await doFetch(url, { headers: apiHeaders(), signal: signal() })
    if (!res.ok) {
      const rateLimited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
      throw new GithubError(res.status, `GitHub list-releases failed (${res.status})`, rateLimited)
    }
    return (await res.json()) as GithubRelease[]
  }

  const downloadBytes = async (url: string): Promise<Buffer> => {
    const res = await doFetch(url, { headers: { 'user-agent': opts.userAgent }, signal: signal() })
    if (!res.ok) throw new GithubError(res.status, `Asset download failed (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }

  const downloadText = async (url: string): Promise<string> => {
    const res = await doFetch(url, { headers: { 'user-agent': opts.userAgent }, signal: signal() })
    if (!res.ok) throw new GithubError(res.status, `Checksum download failed (${res.status})`)
    return await res.text()
  }

  return { listReleases, downloadBytes, downloadText }
}
