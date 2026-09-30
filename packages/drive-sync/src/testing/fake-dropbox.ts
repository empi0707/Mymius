import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { challengeFor } from '../pkce'

/**
 * A stand-in for the parts of Dropbox this app talks to: the code-without-redirect OAuth flow (PKCE, offline
 * refresh tokens) and the files API inside one app folder. It enforces what the client is most likely to get
 * wrong and can inject failures. It is NOT Dropbox: passing against it proves the client is self-consistent,
 * not that Dropbox agrees.
 */
export interface FakeDropboxOptions {
  appKey?: string
  accessTokenTtlMs?: number
  accountEmail?: string
  /** Entries returned per list_folder page, to exercise paging. */
  pageSize?: number
}

interface StoredFile { name: string; content: Buffer; rev: number; modified: string }

export interface FakeDropbox {
  appKey: string
  baseUrl: string
  authEndpoint: string
  tokenEndpoint: string
  /** Stand-in for the user's browser: open the consent page. Returns the code Dropbox would display. */
  browser: (url: string) => Promise<string | undefined>
  control: {
    expireAccessTokens(): void
    revokeAllGrants(): void
    failNext(n: number, status: number, opts?: { body?: unknown; retryAfter?: number }): void
    denyNextConsent(): void
    setQuotaFull(full: boolean): void
    /** The code shown by the most recent consent page. */
    lastCode(): string | undefined
    files(): { name: string; text: string; rev: number }[]
    write(name: string, text: string): void
    remove(name: string): void
  }
  stats: { fileRequests: number; refreshes: number; codeExchanges: number; revocations: number; log: string[] }
  close(): Promise<void>
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

export async function startFakeDropbox(opts: FakeDropboxOptions = {}): Promise<FakeDropbox> {
  const appKey = opts.appKey ?? 'testappkey12345'
  const ttl = opts.accessTokenTtlMs ?? 14_400_000
  const email = opts.accountEmail ?? 'dbx-user@example.com'
  const pageSize = opts.pageSize ?? 1000

  const files = new Map<string, StoredFile>()
  const codes = new Map<string, { challenge: string }>()
  const access = new Map<string, number>()
  const grants = new Map<string, { revoked: boolean }>()
  let failures: { n: number; status: number; body?: unknown; retryAfter?: number } | undefined
  let denyNext = false
  let quotaFull = false
  let lastCode: string | undefined
  let rev = 1
  const cursors = new Map<string, number>()
  const stats = { fileRequests: 0, refreshes: 0, codeExchanges: 0, revocations: 0, log: [] as string[] }

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const conflict = (res: ServerResponse, summary: string): void => json(res, 409, { error_summary: summary, error: { '.tag': summary.split('/')[0] } })
  const entry = (f: StoredFile): Record<string, unknown> => ({
    '.tag': 'file', name: f.name, path_display: `/${f.name}`, path_lower: `/${f.name.toLowerCase()}`, id: 'id:' + f.name,
    rev: 'rev' + f.rev.toString(16).padStart(8, '0'), size: f.content.length, server_modified: f.modified,
    content_hash: createHash('sha256').update(f.content).digest('hex')
  })
  const tokens = (withRefresh: boolean): Record<string, unknown> => {
    const at = 'sl.' + randomBytes(12).toString('hex')
    access.set(at, Date.now() + ttl)
    let rt: string | undefined
    if (withRefresh) { rt = 'dbrt-' + randomBytes(12).toString('hex'); grants.set(rt, { revoked: false }) }
    return { access_token: at, token_type: 'bearer', expires_in: Math.round(ttl / 1000), scope: 'files.content.read files.content.write account_info.read', account_id: 'dbid:test', ...(rt ? { refresh_token: rt } : {}) }
  }
  const nameOf = (p: string): string | undefined => (/^\/[^/]+$/.test(p) ? p.slice(1) : undefined)

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const p = url.pathname

      if (p === '/oauth2/authorize' && req.method === 'GET') {
        const q = url.searchParams
        const bad = (why: string): void => { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(why) }
        if (q.get('client_id') !== appKey) return bad('unknown app')
        if (q.get('response_type') !== 'code') return bad('response_type must be code')
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return bad('PKCE S256 required')
        if (q.get('token_access_type') !== 'offline') return bad('token_access_type=offline required for a refresh token')
        if (q.get('redirect_uri')) return bad('this flow shows a code and takes no redirect_uri')
        if (denyNext) { denyNext = false; lastCode = undefined; res.writeHead(200, { 'Content-Type': 'text/plain' }); return void res.end('denied') }
        lastCode = 'dbcode' + randomBytes(10).toString('hex')
        codes.set(lastCode, { challenge: q.get('code_challenge')! })
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        return void res.end(lastCode)
      }

      if (p === '/oauth2/token' && req.method === 'POST') {
        const f = new URLSearchParams((await readBody(req)).toString())
        if (f.get('client_id') !== appKey) return json(res, 400, { error: 'invalid_client' })
        if (f.get('grant_type') === 'authorization_code') {
          stats.codeExchanges++
          const c = codes.get(f.get('code') ?? '')
          codes.delete(f.get('code') ?? '')
          if (!c) return json(res, 400, { error: 'invalid_grant', error_description: 'code has expired or was already used' })
          if (challengeFor(f.get('code_verifier') ?? '') !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
          return json(res, 200, tokens(true))
        }
        if (f.get('grant_type') === 'refresh_token') {
          stats.refreshes++
          const g = grants.get(f.get('refresh_token') ?? '')
          if (!g || g.revoked) return json(res, 400, { error: 'invalid_grant' })
          const t = tokens(false) // Dropbox keeps the same refresh token
          return json(res, 200, t)
        }
        return json(res, 400, { error: 'unsupported_grant_type' })
      }

      // ---- everything else needs a valid access token ----
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      const expiry = bearer ? access.get(bearer) : undefined
      if (!expiry || expiry < Date.now()) return json(res, 401, { error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } })

      if (p === '/2/users/get_current_account') return json(res, 200, { account_id: 'dbid:test', email, name: { display_name: 'Dbx ' + email.split('@')[0] } })
      if (p === '/2/auth/token/revoke') {
        stats.revocations++
        access.delete(bearer!)
        for (const g of grants.values()) g.revoked = true
        return json(res, 200, {})
      }

      stats.fileRequests++
      stats.log.push(`${req.method} ${p}`)
      if (failures && failures.n > 0) {
        failures.n--
        const headers: Record<string, string> = failures.retryAfter ? { 'Retry-After': String(failures.retryAfter) } : {}
        return json(res, failures.status, failures.body ?? { error_summary: 'injected/' }, headers)
      }

      const raw = await readBody(req)
      if (p === '/2/files/list_folder' || p === '/2/files/list_folder/continue') {
        const body = raw.length ? (JSON.parse(raw.toString()) as { path?: string; cursor?: string }) : {}
        const all = [...files.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
        let start = 0
        if (p.endsWith('/continue')) {
          const at = cursors.get(body.cursor ?? '')
          if (at === undefined) return conflict(res, 'reset/')
          start = at
        } else if (body.path !== '') return conflict(res, 'path/not_found/') // an app folder's root is the empty path
        const page = all.slice(start, start + pageSize)
        const more = start + pageSize < all.length
        const cursor = 'cur' + randomBytes(6).toString('hex')
        if (more) cursors.set(cursor, start + pageSize)
        return json(res, 200, { entries: page.map(entry), cursor, has_more: more })
      }

      const arg = req.headers['dropbox-api-arg'] ? (JSON.parse(String(req.headers['dropbox-api-arg'])) as { path?: string; mode?: string }) : undefined
      if (p === '/2/files/download') {
        const f = files.get(nameOf(arg?.path ?? '') ?? '')
        if (!f) return conflict(res, 'path/not_found/')
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Result': JSON.stringify(entry(f)) })
        return void res.end(f.content)
      }
      if (p === '/2/files/upload') {
        const name = nameOf(arg?.path ?? '')
        if (!name) return json(res, 400, { error_summary: 'path/malformed_path/' })
        if (quotaFull) return conflict(res, 'path/insufficient_space/')
        const existing = files.get(name)
        if (existing && arg?.mode !== 'overwrite') return conflict(res, 'path/conflict/file/')
        const f: StoredFile = { name, content: raw, rev: rev++, modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }
        files.set(name, f)
        return json(res, 200, entry(f))
      }
      if (p === '/2/files/delete_v2') {
        const body = JSON.parse(raw.toString()) as { path?: string }
        const name = nameOf(body.path ?? '')
        if (!name || !files.has(name)) return conflict(res, 'path_lookup/not_found/')
        const f = files.get(name)!
        files.delete(name)
        return json(res, 200, { metadata: entry(f) })
      }
      json(res, 404, { error_summary: 'not_found/' })
    })().catch((err) => { res.writeHead(500); res.end(String(err)) })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    appKey, baseUrl, authEndpoint: `${baseUrl}/oauth2/authorize`, tokenEndpoint: `${baseUrl}/oauth2/token`,
    browser: async (url) => {
      const r = await fetch(url)
      const text = await r.text()
      return r.ok && text !== 'denied' ? text : undefined
    },
    control: {
      expireAccessTokens: () => { for (const k of access.keys()) access.set(k, 0) },
      revokeAllGrants: () => { for (const g of grants.values()) g.revoked = true },
      failNext: (n, status, o = {}) => { failures = { n, status, ...(o.body !== undefined ? { body: o.body } : {}), ...(o.retryAfter ? { retryAfter: o.retryAfter } : {}) } },
      denyNextConsent: () => { denyNext = true },
      setQuotaFull: (v) => { quotaFull = v },
      lastCode: () => lastCode,
      files: () => [...files.values()].map((f) => ({ name: f.name, text: f.content.toString('utf8'), rev: f.rev })),
      write: (name, text) => { files.set(name, { name, content: Buffer.from(text), rev: rev++, modified: new Date().toISOString() }) },
      remove: (name) => { files.delete(name) }
    },
    stats,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
  }
}
