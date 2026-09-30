import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AuthRevokedError, AuthSession, DriveClient, DriveError, DriveNotFoundError, DriveQuotaError, NetworkError,
  authorize, fingerprint, type OAuthConfig
} from '../src'
import { startFakeGoogle, type FakeGoogle } from '../src/testing'

let g: FakeGoogle
let oauth: OAuthConfig
let sleeps: number[]
beforeEach(async () => {
  g = await startFakeGoogle()
  oauth = { clientId: g.clientId, clientSecret: g.clientSecret, authEndpoint: g.authEndpoint, tokenEndpoint: g.tokenEndpoint, revokeEndpoint: g.revokeEndpoint }
  sleeps = []
})
afterEach(async () => { await g.close() })

const client = async (over: Partial<ConstructorParameters<typeof DriveClient>[0]> = {}) => {
  const tokens = await authorize(oauth, { openBrowser: g.browser })
  const auth = new AuthSession(oauth, tokens)
  return new DriveClient({ auth, baseUrl: g.baseUrl, sleep: async (ms) => { sleeps.push(ms) }, ...over })
}

describe('files in the app folder', () => {
  it('starts empty; create, list, download, update and delete round-trip', async () => {
    const d = await client()
    expect(await d.list()).toEqual([])
    const made = await d.create('a.json', '{"hello":"wörld ✓"}')
    expect(made).toMatchObject({ name: 'a.json', size: Buffer.byteLength('{"hello":"wörld ✓"}') })
    expect((await d.list()).map((f) => f.name)).toEqual(['a.json'])
    expect(await d.download(made.id)).toBe('{"hello":"wörld ✓"}')
    const updated = await d.update(made.id, '{"v":2}')
    expect(updated.id).toBe(made.id)
    expect(await d.download(made.id)).toBe('{"v":2}')
    await d.delete(made.id)
    expect(await d.list()).toEqual([])
  })

  it('reports a change through the fingerprint, and only when something changed', async () => {
    const d = await client()
    const f = await d.create('a.json', 'one')
    const before = fingerprint((await d.list())[0]!)
    expect(fingerprint((await d.list())[0]!)).toBe(before)
    await d.update(f.id, 'two')
    expect(fingerprint((await d.list())[0]!)).not.toBe(before)
  })

  it('handles a couple of megabytes and content that looks like multipart framing', async () => {
    const d = await client()
    const big = JSON.stringify({ data: 'x'.repeat(2_000_000) })
    const f = await d.create('big.json', big)
    expect(await d.download(f.id)).toBe(big)
    const tricky = '{"a":"--boundary\\r\\nContent-Type: text/plain"}'
    const t = await d.create('t.json', tricky)
    expect(await d.download(t.id)).toBe(tricky)
  })

  it('lists more than one page of files', async () => {
    const d = await client()
    for (let i = 0; i < 1050; i += 50) await Promise.all(Array.from({ length: 50 }, (_, k) => d.create(`f${i + k}.json`, '{}')))
    const names = (await d.list()).map((f) => f.name)
    expect(names).toHaveLength(1050)
    expect(new Set(names).size).toBe(1050)
  })

  it('only ever sees the hidden app folder: other apps and other accounts are invisible', async () => {
    const d = await client()
    await d.create('mine.json', '{}')
    g.control.write('other-account.json', '{}', 'someone.else@example.com')
    expect((await d.list()).map((f) => f.name)).toEqual(['mine.json'])
  })

  it('a download larger than the limit is refused', async () => {
    const d = await client({ maxDownloadBytes: 100 })
    const f = await d.create('big.json', 'x'.repeat(500))
    await expect(d.download(f.id)).rejects.toMatchObject({ status: 413 })
  })

  it('deleting something already gone is fine; updating it is a NotFound', async () => {
    const d = await client()
    const f = await d.create('a.json', '{}')
    await d.delete(f.id)
    await d.delete(f.id)
    await expect(d.update(f.id, '{}')).rejects.toBeInstanceOf(DriveNotFoundError)
  })
})

describe('when things go wrong', () => {
  it('an expired token is refreshed once and the call is retried invisibly', async () => {
    const d = await client()
    await d.create('a.json', '{}')
    g.control.expireAccessTokens()
    expect((await d.list()).length).toBe(1)
    expect(g.stats.refreshes).toBe(1)
  })

  it('a token the server rejects even after refreshing means the access was withdrawn', async () => {
    const d = await client()
    g.control.failNext(5, 401)
    await expect(d.list()).rejects.toBeInstanceOf(AuthRevokedError)
  })

  it('revoked access is surfaced as such', async () => {
    const d = await client()
    g.control.expireAccessTokens()
    g.control.revokeAllGrants()
    await expect(d.list()).rejects.toBeInstanceOf(AuthRevokedError)
  })

  it('rate limiting is waited out, honouring Retry-After', async () => {
    const d = await client()
    g.control.failNext(2, 429, { retryAfter: 3 })
    expect(await d.list()).toEqual([])
    expect(sleeps).toHaveLength(2)
    expect(sleeps.every((ms) => ms >= 3000 && ms < 3300)).toBe(true)
  })

  it('server errors are retried with growing delays and then succeed', async () => {
    const d = await client()
    g.control.failNext(3, 503)
    expect(await d.list()).toEqual([])
    expect(sleeps).toHaveLength(3)
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!)
    expect(sleeps[2]!).toBeGreaterThan(sleeps[1]!)
  })

  it('403 "rate limit exceeded" is a retry, not a failure', async () => {
    const d = await client()
    g.control.failNext(1, 403, { reason: 'userRateLimitExceeded' })
    expect(await d.list()).toEqual([])
  })

  it('gives up after the allowed attempts and says what Google said', async () => {
    const d = await client({ maxAttempts: 3 })
    g.control.failNext(99, 500)
    await expect(d.list()).rejects.toMatchObject({ name: 'DriveError', status: 500 })
    expect(sleeps).toHaveLength(2)
  })

  it('a full Drive is reported at once, without pointless retries', async () => {
    const d = await client()
    g.control.setQuotaFull(true)
    const before = g.stats.driveRequests
    await expect(d.create('a.json', '{}')).rejects.toBeInstanceOf(DriveQuotaError)
    expect(g.stats.driveRequests - before).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('other client errors are not retried', async () => {
    const d = await client()
    g.control.failNext(1, 400, { reason: 'invalid' })
    const before = g.stats.driveRequests
    await expect(d.list()).rejects.toBeInstanceOf(DriveError)
    expect(g.stats.driveRequests - before).toBe(1)
  })

  it('being offline is a NetworkError after the retries, and is not mistaken for a revocation', async () => {
    const d = await client({ baseUrl: 'http://127.0.0.1:1', maxAttempts: 3 })
    await expect(d.list()).rejects.toBeInstanceOf(NetworkError)
    expect(sleeps).toHaveLength(2)
  })

  it('a request that hangs is cut off', async () => {
    const d = await client({ requestTimeoutMs: 50, maxAttempts: 1, fetch: (_i, init) => new Promise((_r, reject) => (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')))) })
    await expect(d.list()).rejects.toBeInstanceOf(NetworkError)
  })
})
