import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AuthRevokedError, AuthSession, NetworkError, OAuthCancelledError, OAuthDeniedError, OAuthTimeoutError,
  authorize, challengeFor, createPkce, emailFromIdToken, revoke, startLoopback, type OAuthConfig
} from '../src'
import { startFakeGoogle, type FakeGoogle } from '../src/testing'

let g: FakeGoogle
beforeEach(async () => { g = await startFakeGoogle() })
afterEach(async () => { await g.close() })

const cfg = (over: Partial<OAuthConfig> = {}): OAuthConfig => ({
  clientId: g.clientId, clientSecret: g.clientSecret, authEndpoint: g.authEndpoint, tokenEndpoint: g.tokenEndpoint, revokeEndpoint: g.revokeEndpoint, ...over
})

/** A raw request to the loopback server, with control over the method, path and Host header. */
const raw = (port: number, path: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { Host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
const portOf = (uri: string): number => Number(new URL(uri).port)
const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = http.request({ host: '127.0.0.1', port, timeout: 500 }, () => resolve(true))
  s.on('error', () => resolve(false)); s.end()
})

describe('PKCE', () => {
  it('matches the RFC 7636 example', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
  it('makes a long, URL-safe, unique verifier each time, and the challenge is not the verifier', () => {
    const a = createPkce(), b = createPkce()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(a.verifier)
    expect(a.challenge).toBe(challengeFor(a.verifier))
  })
})

describe('the loopback server that catches the redirect', () => {
  it('completes with the code when the state matches, then shuts down', async () => {
    const l = await startLoopback({ state: 'S', timeoutMs: 5000 })
    const port = portOf(l.redirectUri)
    const r = await raw(port, '/callback?code=abc&state=S')
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['content-security-policy']).toContain("default-src 'none'")
    expect(await l.code).toBe('abc')
    await l.close()
    expect(await listening(port)).toBe(false)
  })

  it('binds to the loopback interface only', async () => {
    const l = await startLoopback({ state: 'S', timeoutMs: 5000 })
    expect(l.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    l.cancel(); await l.code.catch(() => undefined)
  })

  it('a request with the wrong state is refused and does not spoil the real one', async () => {
    const l = await startLoopback({ state: 'RIGHT', timeoutMs: 5000 })
    const port = portOf(l.redirectUri)
    expect((await raw(port, '/callback?code=stolen&state=WRONG')).status).toBe(400)
    expect((await raw(port, '/callback?code=stolen')).status).toBe(400)
    expect((await raw(port, '/callback?error=access_denied&state=WRONG')).status).toBe(400) // cannot cancel it either
    expect((await raw(port, '/callback?code=real&state=RIGHT')).status).toBe(200)
    expect(await l.code).toBe('real')
  })

  it('ignores other paths and methods, and a Host header that is not the loopback address (DNS rebinding)', async () => {
    const l = await startLoopback({ state: 'S', timeoutMs: 5000 })
    const port = portOf(l.redirectUri)
    expect((await raw(port, '/')).status).toBe(404)
    expect((await raw(port, '/other?code=x&state=S')).status).toBe(404)
    expect((await raw(port, '/callback?code=x&state=S', { method: 'POST' })).status).toBe(405)
    expect((await raw(port, '/callback?code=x&state=S', { host: 'evil.example' })).status).toBe(400)
    expect((await raw(port, '/callback?code=x&state=S', { host: `localhost:${port}` })).status).toBe(400)
    expect((await raw(port, '/callback?code=ok&state=S')).status).toBe(200)
    expect(await l.code).toBe('ok')
  })

  it('only the first result counts', async () => {
    const l = await startLoopback({ state: 'S', timeoutMs: 5000 })
    const port = portOf(l.redirectUri)
    await raw(port, '/callback?code=first&state=S')
    expect(await l.code).toBe('first')
    await raw(port, '/callback?code=second&state=S').catch(() => undefined) // server is closing; either way it cannot change the result
    expect(await l.code).toBe('first')
  })

  it('reports the user refusing, without leaking anything into the page', async () => {
    const l = await startLoopback({ state: 'S', timeoutMs: 5000 })
    const r = await raw(portOf(l.redirectUri), '/callback?error=access_denied&state=S')
    expect(r.status).toBe(200)
    await expect(l.code).rejects.toBeInstanceOf(OAuthDeniedError)
  })

  it('escapes nothing dynamic: query values never appear in the page', async () => {
    const l = await startLoopback({ state: 'S', timeoutMs: 5000 })
    const r = await raw(portOf(l.redirectUri), '/callback?state=%3Cscript%3Ealert(1)%3C/script%3E&code=%3Cb%3E')
    expect(r.body).not.toContain('<script>alert')
    expect(r.body).not.toContain('<b>')
    l.cancel(); await l.code.catch(() => undefined)
  })

  it('gives up after the timeout, and can be cancelled', async () => {
    const t = await startLoopback({ state: 'S', timeoutMs: 40 })
    await expect(t.code).rejects.toBeInstanceOf(OAuthTimeoutError)
    expect(await listening(portOf(t.redirectUri))).toBe(false)
    const c = await startLoopback({ state: 'S', timeoutMs: 5000 })
    c.cancel()
    await expect(c.code).rejects.toBeInstanceOf(OAuthCancelledError)
    expect(await listening(portOf(c.redirectUri))).toBe(false)
  })
})

describe('signing in', () => {
  it('goes through the browser and returns long-lived credentials for the right account', async () => {
    const t = await authorize(cfg(), { openBrowser: g.browser })
    expect(t.refreshToken).toMatch(/^rt-/)
    expect(t.accessToken).toMatch(/^at-/)
    expect(t.email).toBe('user@example.com')
    expect(t.expiresAt).toBeGreaterThan(Date.now())
    expect(g.stats.codeExchanges).toBe(1)
  })

  it('sends PKCE, offline access and only the scopes it needs', async () => {
    let seen: URL | undefined
    await authorize(cfg(), { openBrowser: async (u) => { seen = new URL(u); await g.browser(u) } })
    const q = seen!.searchParams
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')!.split(' ').sort()).toEqual(['email', 'https://www.googleapis.com/auth/drive.appdata', 'openid'])
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(24)
    expect(seen!.toString()).not.toContain(g.clientSecret) // the secret never goes through the browser
  })

  it('a refused consent screen is reported', async () => {
    g.control.denyNextConsent()
    await expect(authorize(cfg(), { openBrowser: g.browser })).rejects.toMatchObject({ name: 'OAuthDeniedError', message: expect.stringMatching(/not granted/) })
  })

  it('a wrong client secret is reported and no credentials are returned', async () => {
    await expect(authorize(cfg({ clientSecret: 'wrong' }), { openBrowser: g.browser })).rejects.toBeInstanceOf(OAuthDeniedError)
  })

  it('a redirect carrying a different state is ignored, so the sign-in times out rather than accepting it', async () => {
    const hijack = async (url: string): Promise<void> => {
      const u = new URL(url)
      const back = new URL(u.searchParams.get('redirect_uri')!)
      back.searchParams.set('state', 'attacker-state'); back.searchParams.set('code', 'attacker-code')
      await fetch(back)
    }
    await expect(authorize(cfg(), { openBrowser: hijack, timeoutMs: 300 })).rejects.toBeInstanceOf(OAuthTimeoutError)
  })

  it('cancelling stops waiting and frees the port', async () => {
    g.control.stallConsent(true)
    let cancel!: () => void
    let port = 0
    const p = authorize(cfg(), { openBrowser: async (u) => { port = portOf(new URL(u).searchParams.get('redirect_uri')!); void fetch(u).catch(() => undefined) }, onCancelable: (c) => { cancel = c } })
    await new Promise((r) => setTimeout(r, 100))
    cancel()
    await expect(p).rejects.toBeInstanceOf(OAuthCancelledError)
    expect(await listening(port)).toBe(false)
  })

  it('if the browser cannot be opened the port is freed and the error passes through', async () => {
    let port = 0
    await expect(authorize(cfg(), { openBrowser: async (u) => { port = portOf(new URL(u).searchParams.get('redirect_uri')!); throw new Error('no browser') } })).rejects.toThrow('no browser')
    expect(await listening(port)).toBe(false)
  })

  it('an authorization code works once', async () => {
    let code = '', redirect = '', verifier = ''
    const original = globalThis.fetch
    const spy: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? '')
      if (String(input).endsWith('/token') && body.includes('authorization_code')) {
        const f = new URLSearchParams(body)
        code = f.get('code')!; redirect = f.get('redirect_uri')!; verifier = f.get('code_verifier')!
      }
      return original(input, init)
    }
    await authorize(cfg({ fetch: spy }), { openBrowser: g.browser })
    const replay = await fetch(g.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: g.clientId, client_secret: g.clientSecret, code_verifier: verifier }).toString() })
    expect(replay.status).toBe(400)
  })

  it('PKCE is really enforced: the right code with the wrong verifier gets nothing', async () => {
    let code = '', redirect = ''
    const original = globalThis.fetch
    // Intercept the exchange and lie about the verifier.
    const spy: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/token') && String(init?.body).includes('authorization_code')) {
        const f = new URLSearchParams(String(init!.body)); code = f.get('code')!; redirect = f.get('redirect_uri')!
        f.set('code_verifier', 'x'.repeat(50))
        return original(input, { ...init, body: f.toString() })
      }
      return original(input, init)
    }
    await expect(authorize(cfg({ fetch: spy }), { openBrowser: g.browser })).rejects.toBeInstanceOf(OAuthDeniedError)
    expect(code && redirect).toBeTruthy()
  })

  it('decodes the account from the ID token for display, and shrugs at garbage', () => {
    const jwt = ['h', Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url'), 's'].join('.')
    expect(emailFromIdToken(jwt)).toBe('me@example.com')
    for (const bad of [undefined, '', 'a.b', 'a.!!!.c', ['h', Buffer.from('{"email":5}').toString('base64url'), 's'].join('.')]) expect(emailFromIdToken(bad)).toBeUndefined()
  })
})

describe('keeping the access token fresh', () => {
  const fresh = async () => authorize(cfg(), { openBrowser: g.browser })

  it('uses the token it has while it is valid', async () => {
    const s = new AuthSession(cfg(), await fresh())
    const a = await s.getAccessToken(), b = await s.getAccessToken()
    expect(a).toBe(b)
    expect(g.stats.refreshes).toBe(0)
  })

  it('refreshes shortly before expiry, and reports the change so it can be saved', async () => {
    const saved: string[] = []
    const t = await fresh()
    const s = new AuthSession(cfg(), { ...t, expiresAt: Date.now() + 30_000 }, { onChange: (x) => saved.push(x.accessToken) })
    const token = await s.getAccessToken()
    expect(token).not.toBe(t.accessToken)
    expect(saved).toEqual([token])
    expect(s.current.refreshToken).toBe(t.refreshToken)
  })

  it('a burst of requests causes one refresh, not one each', async () => {
    const t = await fresh()
    const s = new AuthSession(cfg(), { ...t, expiresAt: 0 })
    const tokens = await Promise.all(Array.from({ length: 12 }, () => s.getAccessToken()))
    expect(new Set(tokens).size).toBe(1)
    expect(g.stats.refreshes).toBe(1)
  })

  it('revoked access is reported as such, so the app can ask the user to sign in again', async () => {
    const s = new AuthSession(cfg(), { ...(await fresh()), expiresAt: 0 })
    g.control.revokeAllGrants()
    await expect(s.getAccessToken()).rejects.toBeInstanceOf(AuthRevokedError)
  })

  it('being offline is a NetworkError, not a revocation (the user is not asked to sign in again)', async () => {
    const t = await fresh()
    const s = new AuthSession(cfg({ tokenEndpoint: 'http://127.0.0.1:1/token' }), { ...t, expiresAt: 0 })
    await expect(s.getAccessToken()).rejects.toBeInstanceOf(NetworkError)
  })

  it('a rotated refresh token replaces the old one', async () => {
    const t = await fresh()
    const rotating: typeof fetch = async (input, init) => {
      const res = await fetch(input, init)
      if (!String(init?.body).includes('refresh_token')) return res
      const body = (await res.json()) as Record<string, unknown>
      return new Response(JSON.stringify({ ...body, refresh_token: 'rt-rotated' }), { status: 200 })
    }
    const s = new AuthSession(cfg({ fetch: rotating }), { ...t, expiresAt: 0 })
    await s.getAccessToken()
    expect(s.current.refreshToken).toBe('rt-rotated')
  })
})

describe('signing out', () => {
  it('tells Google to forget the grant, after which it cannot be used', async () => {
    const t = await authorize(cfg(), { openBrowser: g.browser })
    expect(await revoke(cfg(), t.refreshToken)).toBe(true)
    expect(g.stats.revocations).toBe(1)
    await expect(new AuthSession(cfg(), { ...t, expiresAt: 0 }).getAccessToken()).rejects.toBeInstanceOf(AuthRevokedError)
  })
  it('cannot fail loudly when Google is unreachable', async () => {
    expect(await revoke(cfg({ revokeEndpoint: 'http://127.0.0.1:1/revoke' }), 'rt-x')).toBe(false)
  })
})
