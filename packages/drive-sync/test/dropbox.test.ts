import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_PREFIX, VaultStore, parseHostProfile, type HostProfile } from '@mymius/vault'
import {
  AuthRevokedError, AuthSession, DriveError, DriveNotFoundError, DriveQuotaError, DriveSync, DropboxClient, META_FILE, OAuthDeniedError,
  beginDropboxAuth, dropboxOAuthConfig, finishDropboxAuth, fingerprint, restoreVault, revokeDropbox, type DropboxEndpoints, type SyncState
} from '../src'
import { startFakeDropbox, type FakeDropbox } from '../src/testing'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let d: FakeDropbox
let ep: DropboxEndpoints
let dir: string
let sleeps: number[]
const stopAtEnd: DriveSync[] = []
beforeEach(async () => {
  d = await startFakeDropbox({ pageSize: 2 })
  ep = { authEndpoint: d.authEndpoint, tokenEndpoint: d.tokenEndpoint, apiUrl: d.baseUrl }
  dir = await mkdtemp(join(tmpdir(), 'mymius-dbx-'))
  sleeps = []
})
afterEach(async () => {
  for (const s of stopAtEnd.splice(0)) s.stop()
  await d.close()
  await rm(dir, { recursive: true, force: true })
})

async function signIn() {
  const { url, verifier } = beginDropboxAuth(d.appKey, ep)
  const code = await d.browser(url)
  expect(code).toBeTruthy()
  return finishDropboxAuth(d.appKey, code!, verifier, ep)
}
async function client(over: Partial<ConstructorParameters<typeof DropboxClient>[0]> = {}) {
  const tokens = await signIn()
  const auth = new AuthSession(dropboxOAuthConfig(d.appKey, ep), tokens)
  return { auth, tokens, client: new DropboxClient({ auth, apiUrl: d.baseUrl, contentUrl: d.baseUrl, sleep: async (ms) => { sleeps.push(ms) }, ...over }) }
}

describe('signing in with a pasted code', () => {
  it('asks for PKCE and an offline token, takes no redirect, and yields tokens plus who signed in', async () => {
    const { url } = beginDropboxAuth(d.appKey, ep)
    const q = new URL(url).searchParams
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('token_access_type')).toBe('offline')
    expect(q.get('redirect_uri')).toBeNull()
    expect(q.get('client_id')).toBe(d.appKey)
    const t = await signIn()
    expect(t.refreshToken).toMatch(/^dbrt-/)
    expect(t).toMatchObject({ email: 'dbx-user@example.com', name: 'Dbx dbx-user' })
  })
  it('a code works once, only with its own verifier, and garbage never reaches Dropbox', async () => {
    const a = beginDropboxAuth(d.appKey, ep)
    const code = (await d.browser(a.url))!
    await expect(finishDropboxAuth(d.appKey, code, beginDropboxAuth(d.appKey, ep).verifier, ep)).rejects.toBeInstanceOf(OAuthDeniedError)
    await expect(finishDropboxAuth(d.appKey, code, a.verifier, ep)).rejects.toBeInstanceOf(OAuthDeniedError) // used up
    const before = d.stats.codeExchanges
    for (const bad of ['', '  ', 'a b', 'short', 'x'.repeat(600), '<script>']) await expect(finishDropboxAuth(d.appKey, bad, a.verifier, ep)).rejects.toBeInstanceOf(OAuthDeniedError)
    expect(d.stats.codeExchanges).toBe(before) // nothing malformed was sent to Dropbox
  })
  it('an unknown app key is refused', async () => {
    const { url } = beginDropboxAuth('nope', ep)
    expect(await d.browser(url)).toBeUndefined()
  })
  it('refreshes by itself, once at a time, keeping the same refresh token; a withdrawn grant means sign in again', async () => {
    const { auth, tokens } = await client()
    d.control.expireAccessTokens()
    const [a, b] = await Promise.all([auth.getAccessToken(true), auth.getAccessToken(true)])
    expect(a).toBe(b)
    expect(d.stats.refreshes).toBe(1)
    expect(auth.current.refreshToken).toBe(tokens.refreshToken)
    d.control.revokeAllGrants()
    await expect(auth.getAccessToken(true)).rejects.toBeInstanceOf(AuthRevokedError)
  })
  it('signing out invalidates the token', async () => {
    const t = await signIn()
    expect(await revokeDropbox(t.accessToken, ep)).toBe(true)
    expect(d.stats.revocations).toBe(1)
    expect(await revokeDropbox(t.accessToken, { ...ep, apiUrl: 'http://127.0.0.1:1' })).toBe(false)
  })
})

describe('files in the app folder', () => {
  it('create, list (across pages), download, update and delete round-trip', async () => {
    const { client: c } = await client()
    expect(await c.list()).toEqual([])
    const a = await c.create('a.json', '{"hello":"wörld ✓"}')
    for (const n of ['b.json', 'c.json', 'd.json', 'e.json']) await c.create(n, n)
    expect((await c.list()).map((f) => f.name)).toEqual(['a.json', 'b.json', 'c.json', 'd.json', 'e.json'])
    expect(await c.download(a.id)).toBe('{"hello":"wörld ✓"}')
    const u = await c.update(a.id, '{"v":2}')
    expect(u.id).toBe(a.id)
    expect(await c.download(a.id)).toBe('{"v":2}')
    await c.delete(a.id)
    expect((await c.list()).map((f) => f.name)).not.toContain('a.json')
  })
  it('reports a change through the fingerprint, and only when something changed', async () => {
    const { client: c } = await client()
    const f = await c.create('a.json', 'one')
    const before = fingerprint((await c.list())[0]!)
    expect(fingerprint((await c.list())[0]!)).toBe(before)
    await c.update(f.id, 'two')
    expect(fingerprint((await c.list())[0]!)).not.toBe(before)
  })
  it('creating never overwrites a file another device made first; updating a vanished file says so', async () => {
    const { client: c } = await client()
    await c.create('x.json', 'theirs')
    await expect(c.create('x.json', 'mine')).rejects.toBeInstanceOf(DriveError)
    expect(await c.download('/x.json')).toBe('theirs')
    d.control.remove('x.json')
    await expect(c.download('/x.json')).rejects.toBeInstanceOf(DriveNotFoundError)
    await c.delete('/x.json') // already gone: fine
  })
  it('handles a couple of megabytes', async () => {
    const { client: c } = await client()
    const big = JSON.stringify({ data: 'x'.repeat(2_000_000) })
    const f = await c.create('big.json', big)
    expect(await c.download(f.id)).toBe(big)
  })
  it('refuses to download something larger than this app ever writes', async () => {
    const { client: c } = await client({ maxDownloadBytes: 10 })
    d.control.write('huge.json', 'x'.repeat(100))
    await expect(c.download('/huge.json')).rejects.toMatchObject({ status: 413 })
  })
})

describe('when Dropbox misbehaves', () => {
  it('retries server errors and rate limits with backoff, honouring Retry-After', async () => {
    const { client: c } = await client()
    d.control.failNext(2, 500)
    await c.list()
    expect(sleeps).toHaveLength(2)
    sleeps.length = 0
    d.control.failNext(1, 429, { retryAfter: 7 })
    await c.list()
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000)
  })
  it('gives up after the attempts are used, with a specific error', async () => {
    const { client: c } = await client({ maxAttempts: 3 })
    d.control.failNext(10, 503)
    await expect(c.list()).rejects.toMatchObject({ status: 503 })
  })
  it('an expired access token is refreshed once and the call succeeds; a rejected refresh means sign in again', async () => {
    const { client: c } = await client()
    d.control.expireAccessTokens()
    await c.list()
    expect(d.stats.refreshes).toBe(1)
    d.control.expireAccessTokens()
    d.control.revokeAllGrants()
    await expect(c.list()).rejects.toBeInstanceOf(AuthRevokedError)
  })
  it('a server that keeps saying 401 even after a fresh token is treated as withdrawn access, not retried forever', async () => {
    const { client: c } = await client()
    d.control.failNext(50, 401)
    await expect(c.list()).rejects.toBeInstanceOf(AuthRevokedError)
    expect(d.stats.refreshes).toBe(1)
  })
  it('a full Dropbox is reported as such', async () => {
    const { client: c } = await client()
    d.control.setQuotaFull(true)
    await expect(c.create('a.json', 'x')).rejects.toBeInstanceOf(DriveQuotaError)
  })
})

describe('sync between two devices through Dropbox', () => {
  const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: `pw-${name}` }, createdAt: 1, updatedAt: 1 })
  const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
  const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()

  async function device(name: string, opts: { create?: boolean; restore?: boolean }) {
    const store = new VaultStore(join(dir, `${name}.json`), { kdf: FAST })
    const { client: remote } = await client()
    if (opts.create) await store.create(PASS)
    if (opts.restore) { await restoreVault(remote, store); await store.unlock(PASS) }
    let saved: SyncState | undefined
    const sync = new DriveSync({ store, drive: remote, state: { load: () => saved, save: async (s) => { saved = structuredClone(s) } }, debounceMs: 10, intervalMs: 60_000, now: () => Date.now() })
    stopAtEnd.push(sync)
    return { store, sync }
  }

  it('publishes only unreadable files, and a second device restored from them receives the hosts', async () => {
    const a = await device('a', { create: true })
    await hosts(a.store).put(host('prod'))
    await a.sync.syncNow()
    expect(d.control.files().map((f) => f.name).sort()).toEqual([META_FILE, `mymius-device-${a.store.deviceId}.json`].sort())
    const everything = JSON.stringify(d.control.files())
    for (const secret of ['prod', 'pw-prod', PASS]) expect(everything).not.toContain(secret)

    const b = await device('b', { restore: true })
    await b.sync.syncNow()
    expect(names(b.store)).toEqual(['prod'])
    await hosts(b.store).put(host('from-b'))
    await b.sync.syncNow()
    await a.sync.syncNow()
    expect(names(a.store)).toEqual(['from-b', 'prod'])
  })

  it('a file altered in Dropbox is refused', async () => {
    const a = await device('a', { create: true })
    await hosts(a.store).put(host('prod'))
    await a.sync.syncNow()
    const b = await device('b', { restore: true })
    await b.sync.syncNow()
    const own = d.control.files().find((f) => f.name === `mymius-device-${a.store.deviceId}.json`)!
    const forged = JSON.parse(own.text)
    forged.records[0].deleted = true
    d.control.write(own.name, JSON.stringify(forged))
    await b.sync.syncNow()
    expect(names(b.store)).toEqual(['prod']) // the forged deletion did not go through
  })
})
