import { AuthRevokedError, DriveError, DriveNotFoundError, DriveQuotaError, NetworkError } from './errors'

export interface DriveFile {
  id: string
  name: string
  /** Google bumps this on every change; together with the checksum it tells us whether a file changed. */
  version?: string
  md5Checksum?: string
  modifiedTime?: string
  size?: number
}

export interface TokenSource {
  getAccessToken(force?: boolean): Promise<string>
}

export interface DriveClientOptions {
  auth: TokenSource
  /** Overridable for tests. */
  baseUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  requestTimeoutMs?: number
  /** Largest file we are willing to download. */
  maxDownloadBytes?: number
}

const FIELDS = 'id,name,version,md5Checksum,modifiedTime,size'
const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError'])

/** What the sync engine needs from wherever the files live (Google Drive, Dropbox...). */
export interface RemoteStore {
  list(): Promise<DriveFile[]>
  download(id: string): Promise<string>
  create(name: string, content: string): Promise<DriveFile>
  /** Throws DriveNotFoundError if the file is gone. */
  update(id: string, content: string): Promise<DriveFile>
  delete(id: string): Promise<void>
}

/** "Has this file changed since I last looked?" */
export const fingerprint = (f: DriveFile): string => `${f.version ?? ''}:${f.md5Checksum ?? f.modifiedTime ?? ''}`

interface GoogleErrorBody {
  error?: { message?: string; errors?: { reason?: string }[]; status?: string }
}

/**
 * The few Drive v3 calls this app needs, all confined to the hidden per-app `appDataFolder`.
 * Transient trouble (rate limits, 5xx, dropped connections) is retried with backoff; an expired token is
 * refreshed once; anything else is reported as a specific error the caller can act on.
 */
export class DriveClient implements RemoteStore {
  private readonly base: string
  private readonly f: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxAttempts: number

  constructor(private readonly opts: DriveClientOptions) {
    this.base = (opts.baseUrl ?? 'https://www.googleapis.com').replace(/\/$/, '')
    this.f = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxAttempts = opts.maxAttempts ?? 5
  }

  private async request(method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    let refreshed = false
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined
      let netErr: unknown
      try {
        res = await this.f(this.base + path, {
          method,
          headers: { Authorization: `Bearer ${await this.opts.auth.getAccessToken()}`, ...init.headers },
          ...(init.body !== undefined ? { body: init.body } : {}),
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 30_000)
        })
      } catch (err) {
        if (err instanceof AuthRevokedError) throw err
        netErr = err
      }

      if (res?.ok) return res

      if (res?.status === 401) {
        if (refreshed) throw new AuthRevokedError('the server rejected the refreshed token')
        refreshed = true
        await this.opts.auth.getAccessToken(true) // may throw AuthRevokedError
        continue
      }

      const body = res ? ((await res.json().catch(() => ({}))) as GoogleErrorBody) : {}
      const reason = body.error?.errors?.[0]?.reason ?? ''
      if (res?.status === 404) throw new DriveNotFoundError()
      if (res?.status === 403 && (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded')) throw new DriveQuotaError()

      const retryable = !res || res.status === 408 || res.status === 429 || res.status >= 500 || (res.status === 403 && RETRYABLE_REASONS.has(reason))
      if (!retryable) throw new DriveError(res!.status, reason, body.error?.message ?? res!.statusText)
      if (attempt >= this.maxAttempts) {
        if (!res) throw new NetworkError(netErr)
        throw new DriveError(res.status, reason, body.error?.message ?? 'vẫn lỗi sau nhiều lần thử')
      }
      const retryAfter = Number(res?.headers.get('retry-after'))
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 500 * 2 ** (attempt - 1))
      await this.sleep(backoff + Math.floor(Math.random() * 250))
    }
  }

  /** Every file the app has stored, across pages. */
  async list(): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({
        spaces: 'appDataFolder',
        q: "'appDataFolder' in parents and trashed = false",
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {})
      })
      const page = (await (await this.request('GET', `/drive/v3/files?${q}`)).json()) as { files?: RawFile[]; nextPageToken?: string }
      for (const f of page.files ?? []) out.push(normalize(f))
      pageToken = page.nextPageToken
    } while (pageToken)
    return out
  }

  async download(id: string): Promise<string> {
    const limit = this.opts.maxDownloadBytes ?? 20 * 1024 * 1024
    const res = await this.request('GET', `/drive/v3/files/${encodeURIComponent(id)}?alt=media`)
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) throw new DriveError(413, 'tooLarge', 'File lớn hơn mọi file mà ứng dụng này từng ghi')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > limit) throw new DriveError(413, 'tooLarge', 'File lớn hơn mọi file mà ứng dụng này từng ghi')
    return buf.toString('utf8')
  }

  /** Create a new file in the app folder. */
  async create(name: string, content: string): Promise<DriveFile> {
    const boundary = `mymius-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`
    const res = await this.request('POST', `/upload/drive/v3/files?uploadType=multipart&fields=${FIELDS}`, {
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    })
    return normalize((await res.json()) as RawFile)
  }

  /** Replace the content of an existing file. Throws DriveNotFoundError if it is gone. */
  async update(id: string, content: string): Promise<DriveFile> {
    const res = await this.request('PATCH', `/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=${FIELDS}`, {
      headers: { 'Content-Type': 'application/json' },
      body: content
    })
    return normalize((await res.json()) as RawFile)
  }

  async delete(id: string): Promise<void> {
    try {
      await this.request('DELETE', `/drive/v3/files/${encodeURIComponent(id)}`)
    } catch (err) {
      if (!(err instanceof DriveNotFoundError)) throw err
    }
  }
}

type RawFile = Omit<DriveFile, 'size'> & { size?: string | number }

/** Drive reports sizes as strings. */
function normalize(f: RawFile): DriveFile {
  const { size, ...rest } = f
  return { ...rest, ...(size !== undefined ? { size: Number(size) } : {}) }
}
