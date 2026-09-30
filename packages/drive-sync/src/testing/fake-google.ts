import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { challengeFor } from '../pkce'

/**
 * A stand-in for the parts of Google this app talks to: the OAuth endpoints and the Drive v3
 * appDataFolder API. It enforces what real Google enforces and the client is most likely to get wrong
 * (PKCE, a matching state, one-shot codes, the client secret, token expiry, `spaces=appDataFolder`,
 * per-app isolation) and can inject the failures a real service produces.
 * It is NOT Google: passing against it proves the client is self-consistent, not that Google agrees.
 */
export interface FakeGoogleOptions {
  clientId?: string
  clientSecret?: string
  /** Access tokens live this long (ms). */
  accessTokenTtlMs?: number
  accountEmail?: string
  /** Drive storage limit for the account, in bytes. */
  quotaBytes?: number
}

interface StoredFile { id: string; name: string; content: Buffer; version: number; modifiedTime: string }
interface Account { email: string; files: Map<string, StoredFile> }

export interface FakeGoogle {
  /** Everything the client needs: pass to OAuthConfig / DriveClient. */
  clientId: string
  clientSecret: string
  authEndpoint: string
  tokenEndpoint: string
  revokeEndpoint: string
  baseUrl: string
  /** Stand-in for the user's browser: follow the consent URL and the redirect back to the app. */
  browser: (url: string) => Promise<void>
  control: {
    /** Make every access token expire now. */
    expireAccessTokens(): void
    /** Revoke every refresh token, as if the user removed the app in their Google account. */
    revokeAllGrants(): void
    /** The next N Drive calls answer with this status (e.g. 500, 429, 401, 403). */
    failNext(n: number, status: number, opts?: { reason?: string; retryAfter?: number }): void
    /** The next consent screen ends in "access denied". */
    denyNextConsent(): void
    setQuotaFull(full: boolean): void
    /** Skip the user: consent screens never finish (the redirect never comes). */
    stallConsent(stall: boolean): void
    /** Read or rewrite a stored file directly, as someone with access to the storage could. */
    files(email?: string): { id: string; name: string; text: string; version: number }[]
    write(name: string, text: string, email?: string): void
    remove(name: string, email?: string): void
  }
  stats: {
    driveRequests: number
    refreshes: number
    codeExchanges: number
    revocations: number
    /** Every Drive request as "METHOD path". */
    log: string[]
  }
  close(): Promise<void>
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers })
  res.end(text)
}
const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
const gerr = (res: ServerResponse, status: number, reason: string, message: string): void =>
  send(res, status, { error: { code: status, message, errors: [{ reason, message }] } })

export async function startFakeGoogle(opts: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const clientId = opts.clientId ?? 'test-client.apps.example'
  const clientSecret = opts.clientSecret ?? 'test-secret'
  const ttl = opts.accessTokenTtlMs ?? 3_600_000
  const defaultEmail = opts.accountEmail ?? 'user@example.com'
  const quota = opts.quotaBytes ?? Number.POSITIVE_INFINITY

  const accounts = new Map<string, Account>()
  const account = (email: string): Account => {
    let a = accounts.get(email)
    if (!a) accounts.set(email, (a = { email, files: new Map() }))
    return a
  }
  const codes = new Map<string, { challenge: string; redirectUri: string; email: string }>()
  const access = new Map<string, { email: string; expiresAt: number }>()
  const grants = new Map<string, { email: string; revoked: boolean }>()
  let failures: { n: number; status: number; reason: string; retryAfter?: number } | undefined
  let denyNext = false
  let stall = false
  let quotaFull = false
  const stats = { driveRequests: 0, refreshes: 0, codeExchanges: 0, revocations: 0, log: [] as string[] }
  let nextId = 1

  const issue = (email: string, withRefresh: boolean): Record<string, unknown> => {
    const token = 'at-' + randomBytes(12).toString('hex')
    access.set(token, { email, expiresAt: Date.now() + ttl })
    let refresh: string | undefined
    if (withRefresh) {
      refresh = 'rt-' + randomBytes(12).toString('hex')
      grants.set(refresh, { email, revoked: false })
    }
    const idToken = ['none', Buffer.from(JSON.stringify({ email })).toString('base64url'), ''].join('.')
    return { access_token: token, expires_in: Math.round(ttl / 1000), token_type: 'Bearer', scope: 'openid email https://www.googleapis.com/auth/drive.appdata', id_token: idToken, ...(refresh ? { refresh_token: refresh } : {}) }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const p = url.pathname

      // ---- OAuth ----
      if (p === '/o/oauth2/v2/auth' && req.method === 'GET') {
        const q = url.searchParams
        const redirect = q.get('redirect_uri') ?? ''
        if (q.get('client_id') !== clientId) return gerr(res, 400, 'invalid_client', 'Unknown client')
        if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(redirect)) return gerr(res, 400, 'redirect_uri_mismatch', 'Desktop clients may only use a loopback redirect')
        if (q.get('response_type') !== 'code') return gerr(res, 400, 'invalid_request', 'response_type must be code')
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return gerr(res, 400, 'invalid_request', 'PKCE with S256 is required')
        if (!q.get('state')) return gerr(res, 400, 'invalid_request', 'state is required')
        if (!(q.get('scope') ?? '').includes('drive.appdata')) return gerr(res, 400, 'invalid_scope', 'drive.appdata is required')
        if (q.get('access_type') !== 'offline') return gerr(res, 400, 'invalid_request', 'access_type=offline is required for a refresh token')
        if (stall) return void res.end('waiting for the user…') // the browser tab just sits there
        const back = new URL(redirect)
        back.searchParams.set('state', q.get('state')!)
        if (denyNext) {
          denyNext = false
          back.searchParams.set('error', 'access_denied')
        } else {
          const code = 'code-' + randomBytes(10).toString('hex')
          codes.set(code, { challenge: q.get('code_challenge')!, redirectUri: redirect, email: defaultEmail })
          back.searchParams.set('code', code)
        }
        res.writeHead(302, { Location: back.toString() })
        return void res.end()
      }
      if (p === '/token' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString())
        const fail = (status: number, error: string, description = ''): void => send(res, status, { error, error_description: description })
        if (form.get('client_id') !== clientId) return fail(401, 'invalid_client')
        if (form.get('client_secret') !== clientSecret) return fail(401, 'invalid_client', 'client_secret is missing or wrong')
        if (form.get('grant_type') === 'authorization_code') {
          const c = codes.get(form.get('code') ?? '')
          codes.delete(form.get('code') ?? '') // one shot, even if the rest fails
          if (!c) return fail(400, 'invalid_grant', 'Bad or already used code')
          if (form.get('redirect_uri') !== c.redirectUri) return fail(400, 'invalid_grant', 'redirect_uri does not match')
          if (challengeFor(form.get('code_verifier') ?? '') !== c.challenge) return fail(400, 'invalid_grant', 'PKCE verification failed')
          stats.codeExchanges++
          return send(res, 200, issue(c.email, true))
        }
        if (form.get('grant_type') === 'refresh_token') {
          const g = grants.get(form.get('refresh_token') ?? '')
          if (!g || g.revoked) return fail(400, 'invalid_grant', 'Token has been expired or revoked.')
          stats.refreshes++
          return send(res, 200, issue(g.email, false))
        }
        return fail(400, 'unsupported_grant_type')
      }
      if (p === '/revoke' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString())
        const g = grants.get(form.get('token') ?? '')
        if (!g) return send(res, 400, { error: 'invalid_token' })
        g.revoked = true
        stats.revocations++
        return send(res, 200, {})
      }

      // ---- Drive ----
      if (!p.startsWith('/drive/v3/') && !p.startsWith('/upload/drive/v3/')) return send(res, 404, 'not found')
      stats.driveRequests++
      stats.log.push(`${req.method} ${p}`)
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      const tok = auth ? access.get(auth) : undefined
      if (!tok || tok.expiresAt <= Date.now()) return gerr(res, 401, 'authError', 'Invalid Credentials')
      if (failures && failures.n > 0) {
        failures.n--
        return void (res.writeHead(failures.status, { 'Content-Type': 'application/json', ...(failures.retryAfter !== undefined ? { 'Retry-After': String(failures.retryAfter) } : {}) }),
          res.end(JSON.stringify({ error: { code: failures.status, message: 'injected', errors: [{ reason: failures.reason }] } })))
      }
      const acct = account(tok.email)
      const meta = (f: StoredFile): Record<string, unknown> => ({
        id: f.id, name: f.name, version: String(f.version), size: String(f.content.length), modifiedTime: f.modifiedTime, md5Checksum: createHash('md5').update(f.content).digest('hex')
      })
      const used = (): number => [...acct.files.values()].reduce((n, f) => n + f.content.length, 0)

      if (p === '/drive/v3/files' && req.method === 'GET') {
        // Without spaces=appDataFolder real Drive searches the user's visible Drive and finds none of our files.
        const inApp = url.searchParams.get('spaces') === 'appDataFolder'
        const q = url.searchParams.get('q') ?? ''
        if (inApp && !q.includes("'appDataFolder' in parents")) return gerr(res, 400, 'invalid', 'Invalid Value')
        const all = inApp ? [...acct.files.values()].sort((a, b) => a.name.localeCompare(b.name)) : []
        const size = Number(url.searchParams.get('pageSize') ?? 100)
        const from = Number(url.searchParams.get('pageToken') ?? 0)
        const page = all.slice(from, from + size)
        return send(res, 200, { files: page.map(meta), ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}) })
      }
      const m = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(p)
      if (m && req.method === 'GET') {
        const f = acct.files.get(decodeURIComponent(m[1]!))
        if (!f) return gerr(res, 404, 'notFound', 'File not found')
        if (url.searchParams.get('alt') === 'media') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(f.content.length) }); return void res.end(f.content) }
        return send(res, 200, meta(f))
      }
      if (m && req.method === 'DELETE') {
        if (!acct.files.delete(decodeURIComponent(m[1]!))) return gerr(res, 404, 'notFound', 'File not found')
        res.writeHead(204); return void res.end()
      }
      if (p === '/upload/drive/v3/files' && req.method === 'POST') {
        if (url.searchParams.get('uploadType') !== 'multipart') return gerr(res, 400, 'invalid', 'only multipart is supported here')
        const boundary = /boundary=(.+)$/.exec(String(req.headers['content-type']))?.[1]
        if (!boundary) return gerr(res, 400, 'invalid', 'missing boundary')
        const parts = (await readBody(req)).toString('utf8').split(`--${boundary}`).slice(1, -1)
        if (parts.length !== 2) return gerr(res, 400, 'invalid', 'expected metadata and media parts')
        const body = (part: string): string => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')
        const metadata = JSON.parse(body(parts[0]!)) as { name?: string; parents?: string[] }
        if (!metadata.name || metadata.parents?.[0] !== 'appDataFolder') return gerr(res, 400, 'invalid', 'parents must be ["appDataFolder"]')
        const content = Buffer.from(body(parts[1]!), 'utf8')
        if (quotaFull || used() + content.length > quota) return gerr(res, 403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota')
        const f: StoredFile = { id: `file${nextId++}`, name: metadata.name, content, version: 1, modifiedTime: new Date().toISOString() }
        acct.files.set(f.id, f)
        return send(res, 200, meta(f))
      }
      if (m && req.method === 'PATCH') {
        const f = acct.files.get(decodeURIComponent(m[1]!))
        if (!f) return gerr(res, 404, 'notFound', 'File not found')
        const content = await readBody(req)
        if (quotaFull || used() - f.content.length + content.length > quota) return gerr(res, 403, 'storageQuotaExceeded', 'quota')
        f.content = content; f.version++; f.modifiedTime = new Date().toISOString()
        return send(res, 200, meta(f))
      }
      return gerr(res, 404, 'notFound', 'Not found')
    })().catch((err) => { res.writeHead(500); res.end(String(err)) })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const find = (name: string, email = defaultEmail): StoredFile | undefined => [...account(email).files.values()].find((f) => f.name === name)

  return {
    clientId, clientSecret,
    authEndpoint: `${base}/o/oauth2/v2/auth`, tokenEndpoint: `${base}/token`, revokeEndpoint: `${base}/revoke`, baseUrl: base,
    browser: async (url) => { await fetch(url, { redirect: 'follow' }).catch(() => undefined) },
    control: {
      expireAccessTokens: () => { for (const t of access.values()) t.expiresAt = 0 },
      revokeAllGrants: () => { for (const g of grants.values()) g.revoked = true },
      failNext: (n, status, o = {}) => { failures = { n, status, reason: o.reason ?? '', ...(o.retryAfter !== undefined ? { retryAfter: o.retryAfter } : {}) } },
      denyNextConsent: () => { denyNext = true },
      setQuotaFull: (v) => { quotaFull = v },
      stallConsent: (v) => { stall = v },
      files: (email = defaultEmail) => [...account(email).files.values()].map((f) => ({ id: f.id, name: f.name, text: f.content.toString('utf8'), version: f.version })),
      write: (name, text, email = defaultEmail) => {
        const f = find(name, email)
        if (f) { f.content = Buffer.from(text); f.version++ }
        else { const id = `file${nextId++}`; account(email).files.set(id, { id, name, content: Buffer.from(text), version: 1, modifiedTime: new Date().toISOString() }) }
      },
      remove: (name, email = defaultEmail) => { const f = find(name, email); if (f) account(email).files.delete(f.id) }
    },
    stats,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}
