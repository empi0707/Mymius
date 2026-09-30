import { AuthRevokedError, DriveError, DriveNotFoundError, DriveQuotaError, NetworkError } from './errors'
import type { DriveFile, RemoteStore, TokenSource } from './drive'

export interface DropboxClientOptions {
  auth: TokenSource
  /** Overridable for tests. */
  apiUrl?: string
  contentUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  requestTimeoutMs?: number
  maxDownloadBytes?: number
}

interface Entry {
  '.tag'?: string
  name: string
  path_display?: string
  rev?: string
  size?: number
  content_hash?: string
  server_modified?: string
}

/**
 * The few Dropbox v2 calls this app needs, confined to the app's own folder (an "App folder" app sees only
 * `Apps/<app name>`, whose root is the empty path). Files are addressed by name: the id is `/<name>`.
 * Retries, token refresh and error reporting follow the same rules as the Google Drive client.
 */
export class DropboxClient implements RemoteStore {
  private readonly api: string
  private readonly content: string
  private readonly f: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxAttempts: number

  constructor(private readonly opts: DropboxClientOptions) {
    this.api = (opts.apiUrl ?? 'https://api.dropboxapi.com').replace(/\/$/, '')
    this.content = (opts.contentUrl ?? 'https://content.dropboxapi.com').replace(/\/$/, '')
    this.f = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxAttempts = opts.maxAttempts ?? 5
  }

  private async request(base: string, path: string, init: { headers?: Record<string, string>; body?: string }): Promise<Response> {
    let refreshed = false
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined
      let netErr: unknown
      try {
        res = await this.f(base + path, {
          method: 'POST',
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

      const text = res ? await res.text().catch(() => '') : ''
      let summary = ''
      let retryAfter = Number(res?.headers.get('retry-after'))
      try {
        const b = JSON.parse(text) as { error_summary?: string; error?: { retry_after?: number } }
        summary = b.error_summary ?? ''
        if (!Number.isFinite(retryAfter) || retryAfter <= 0) retryAfter = Number(b.error?.retry_after)
      } catch { summary = text.slice(0, 400) }

      // A token issued before a permission was switched on in the app console never gets it: sign in again.
      const missing = /required scope '([a-z_.]+)'/.exec(text)?.[1]
      if (res?.status === 400 && missing) {
        throw new AuthRevokedError(`ứng dụng Dropbox thiếu quyền ${missing}. Hãy bật quyền này ở tab Permissions của app trên Dropbox App Console, bấm Submit, rồi đăng nhập lại`)
      }
      if (res?.status === 409) {
        if (/not_found/.test(summary)) throw new DriveNotFoundError()
        if (/insufficient_space/.test(summary)) throw new DriveQuotaError()
        throw new DriveError(409, '', `Dropbox từ chối: ${summary || 'xung đột'}`)
      }
      const retryable = !res || res.status === 408 || res.status === 429 || res.status >= 500
      if (!retryable) throw new DriveError(res!.status, '', summary || res!.statusText)
      if (attempt >= this.maxAttempts) {
        if (!res) throw new NetworkError(netErr)
        throw new DriveError(res.status, '', 'Dropbox vẫn lỗi sau nhiều lần thử')
      }
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 500 * 2 ** (attempt - 1))
      await this.sleep(backoff + Math.floor(Math.random() * 250))
    }
  }

  private rpc(path: string, body: unknown): Promise<Response> {
    return this.request(this.api, path, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  private static file(e: Entry): DriveFile {
    return {
      id: e.path_display ?? `/${e.name}`,
      name: e.name,
      ...(e.rev ? { version: e.rev } : {}),
      ...(e.content_hash ? { md5Checksum: e.content_hash } : {}), // any content fingerprint will do
      ...(e.server_modified ? { modifiedTime: e.server_modified } : {}),
      ...(typeof e.size === 'number' ? { size: e.size } : {})
    }
  }

  async list(): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let page = (await (await this.rpc('/2/files/list_folder', { path: '', limit: 1000 })).json()) as { entries: Entry[]; has_more: boolean; cursor: string }
    for (;;) {
      for (const e of page.entries) if (e['.tag'] === 'file') out.push(DropboxClient.file(e))
      if (!page.has_more) return out
      page = (await (await this.rpc('/2/files/list_folder/continue', { cursor: page.cursor })).json()) as typeof page
    }
  }

  async download(id: string): Promise<string> {
    const limit = this.opts.maxDownloadBytes ?? 20 * 1024 * 1024
    const res = await this.request(this.content, '/2/files/download', { headers: { 'Dropbox-API-Arg': JSON.stringify({ path: id }) } })
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) throw new DriveError(413, 'tooLarge', 'File lớn hơn mọi file mà ứng dụng này từng ghi')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > limit) throw new DriveError(413, 'tooLarge', 'File lớn hơn mọi file mà ứng dụng này từng ghi')
    return buf.toString('utf8')
  }

  private async upload(path: string, mode: 'add' | 'overwrite', content: string): Promise<DriveFile> {
    const res = await this.request(this.content, '/2/files/upload', {
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false, mute: true }) },
      body: content
    })
    return DropboxClient.file((await res.json()) as Entry)
  }

  /** A new file. If another device created it first, this fails and the next round sees theirs. */
  create(name: string, content: string): Promise<DriveFile> {
    return this.upload(`/${name}`, 'add', content)
  }

  async update(id: string, content: string): Promise<DriveFile> {
    return this.upload(id, 'overwrite', content)
  }

  async delete(id: string): Promise<void> {
    try {
      await this.rpc('/2/files/delete_v2', { path: id })
    } catch (err) {
      if (!(err instanceof DriveNotFoundError)) throw err
    }
  }
}
