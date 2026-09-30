import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { META_FILE } from '@mymius/drive-sync'
import { startFakeDropbox, type FakeDropbox } from '@mymius/drive-sync/testing'
import { HOST_PREFIX, VaultStore, parseHostProfile, type HostProfile } from '@mymius/vault'
import { DriveSyncService, type DriveHost } from '../src/main/drive-service'
import type { DriveStatus } from '../src/shared/ipc'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let d: FakeDropbox
let dir: string
let services: DriveSyncService[]
beforeEach(async () => { d = await startFakeDropbox(); dir = await mkdtemp(join(tmpdir(), 'mymius-dbxsvc-')); services = [] })
afterEach(async () => {
  for (const s of services) await s.disconnect(false).catch(() => undefined)
  await d.close()
  await rm(dir, { recursive: true, force: true })
})

const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: `pw-${name}` }, createdAt: 1, updatedAt: 1 })
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out: ' + what); await new Promise((r) => setTimeout(r, 25)) }
}
const driveNames = () => d.control.files().map((f) => f.name).sort()

async function setup(name: string, opts: { vault?: boolean; key?: boolean; host?: Partial<DriveHost>; keep?: { vaultFile: string; settingsFile: string } } = {}) {
  const vaultFile = opts.keep?.vaultFile ?? join(dir, `${name}-vault.json`)
  const settingsFile = opts.keep?.settingsFile ?? join(dir, `${name}-drive.json`)
  const store = new VaultStore(vaultFile, { kdf: FAST })
  if (opts.vault) await store.create(PASS)
  const opened: string[] = []
  const statuses: DriveStatus[] = []
  const service = new DriveSyncService({
    settingsFile,
    openExternal: async (url) => { opened.push(url) }, // the person reads the code off the page and pastes it
    emitStatus: (s) => statuses.push(s),
    allowInsecureHttp: true,
    dropboxEndpoints: { authEndpoint: d.authEndpoint, tokenEndpoint: d.tokenEndpoint, apiUrl: d.baseUrl, contentUrl: d.baseUrl },
    intervalMs: 60_000, debounceMs: 30,
    ...opts.host
  }, store)
  services.push(service)
  await service.init()
  if (opts.key) expect(await service.setDropboxKey(d.appKey)).toEqual({ ok: true })
  return { store, service, opened, statuses, vaultFile, settingsFile }
}
type S = Awaited<ReturnType<typeof setup>>
/** Both steps of signing in, the way the person does them. */
async function signIn(s: S) {
  const r = await s.service.connect('dropbox')
  if (!r.ok) return r
  const code = await d.browser(s.opened.at(-1)!)
  return s.service.submitDropboxCode(code ?? 'no-code-shown')
}

describe('configuration', () => {
  it('cannot sign in until an app key is provided, and validates what is entered', async () => {
    const s = await setup('a', { vault: true })
    expect(await s.service.connect('dropbox')).toMatchObject({ ok: false, error: expect.stringMatching(/app key/) })
    expect((await s.service.status()).dropboxConfigured).toBe(false)
    for (const bad of ['', '  ', 'has space', 'x'.repeat(100), 5, null]) expect((await s.service.setDropboxKey(bad)).ok).toBe(false)
    expect(s.opened).toEqual([])
  })
  it('is remembered across restarts and sits alongside the Google client in one settings file', async () => {
    const s = await setup('a', { vault: true, key: true })
    await s.service.setClient({ clientId: 'g.apps.googleusercontent.com' })
    const again = await setup('a', { keep: { vaultFile: s.vaultFile, settingsFile: s.settingsFile } })
    expect(await again.service.status()).toMatchObject({ dropboxConfigured: true, configured: true })
    expect(JSON.parse(await readFile(s.settingsFile, 'utf8'))).toMatchObject({ clientId: 'g.apps.googleusercontent.com', dropboxAppKey: d.appKey })
  })
  it('uses the key shipped with the app, and prefers the one the user typed', async () => {
    const s = await setup('a', { vault: true, host: { defaultDropboxAppKey: d.appKey } })
    expect(await s.service.status()).toMatchObject({ dropboxConfigured: true, builtInDropbox: true })
    expect(await signIn(s)).toEqual({ ok: true })
    await s.service.disconnect(false)
    await s.service.setDropboxKey('mineownkey123')
    expect(await s.service.status()).toMatchObject({ builtInDropbox: false })
  })
})

describe('signing in and syncing', () => {
  it('two steps: the consent page opens, then the pasted code finishes it and sync starts', async () => {
    const s = await setup('a', { vault: true, key: true })
    await hosts(s.store).put(host('one'))
    expect(await s.service.connect('dropbox')).toEqual({ ok: true })
    expect(await s.service.status()).toMatchObject({ phase: 'connecting', awaitingCode: true })
    const url = new URL(s.opened[0]!)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const code = await d.browser(s.opened[0]!)
    expect(await s.service.submitDropboxCode(code)).toEqual({ ok: true })
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'first sync')
    expect(await s.service.status()).toMatchObject({ phase: 'idle', provider: 'dropbox', awaitingCode: false, email: 'dbx-user@example.com', name: 'Dbx dbx-user' })
    expect(driveNames()).toEqual([META_FILE, `mymius-device-${s.store.deviceId}.json`].sort())
    expect(JSON.stringify(d.control.files())).not.toMatch(/one\.example|pw-one|a decent passphrase/)
  })
  it('a wrong code says so and can be corrected on the same page; cancelling drops the attempt', async () => {
    const s = await setup('a', { vault: true, key: true })
    await s.service.connect('dropbox')
    expect(await s.service.submitDropboxCode('this-is-not-the-code')).toMatchObject({ ok: false, error: expect.stringMatching(/Mã không đúng/) })
    expect(await s.service.submitDropboxCode(42)).toMatchObject({ ok: false })
    expect((await s.service.status()).awaitingCode).toBe(true)
    expect(await s.service.submitDropboxCode(await d.browser(s.opened[0]!))).toEqual({ ok: true })

    const t = await setup('t', { vault: true, key: true })
    await t.service.connect('dropbox')
    t.service.cancelConnect()
    expect(await t.service.status()).toMatchObject({ phase: 'not-connected', awaitingCode: false })
    expect(await t.service.submitDropboxCode('anything12345')).toMatchObject({ ok: false, error: expect.stringMatching(/Chưa bắt đầu/) })
  })
  it('a denied consent page yields no code, and nothing is stored', async () => {
    const s = await setup('a', { vault: true, key: true })
    d.control.denyNextConsent()
    await s.service.connect('dropbox')
    expect(await d.browser(s.opened[0]!)).toBeUndefined()
    expect(await s.service.submitDropboxCode('')).toMatchObject({ ok: false })
    expect(s.store.getLocal('drive-tokens')).toBeUndefined()
  })
  it('keeps the sign-in sealed with its provider, and resumes after a restart with no new sign-in', async () => {
    const s = await setup('a', { vault: true, key: true })
    await signIn(s)
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'sync')
    expect(JSON.parse(s.store.getLocal('drive-tokens')!)).toMatchObject({ provider: 'dropbox' })
    expect(await readFile(s.vaultFile, 'utf8')).not.toContain('dbrt-')
    const again = await setup('a', { keep: s })
    await again.store.unlock(PASS)
    await until(async () => (await again.service.status()).lastSyncAt !== undefined, 'resumed')
    expect(await again.service.status()).toMatchObject({ provider: 'dropbox', phase: 'idle' })
  })
  it('a second device restores the vault from Dropbox, unlocks with the passphrase, and then syncs both ways', async () => {
    const a = await setup('a', { vault: true, key: true })
    await hosts(a.store).put(host('from-a'))
    await signIn(a)
    await until(async () => (await a.service.status()).lastSyncAt !== undefined, 'a synced')
    const b = await setup('b', { key: true })
    expect(await signIn(b)).toEqual({ ok: true })
    expect(await b.store.state()).toBe('locked')
    await b.store.unlock(PASS)
    await until(() => names(b.store).includes('from-a'), 'host to arrive')
    await hosts(b.store).put(host('from-b'))
    await b.service.syncNow(); await a.service.syncNow()
    expect(names(a.store)).toEqual(['from-a', 'from-b'])
  })
  it('a new account with no vault stays signed in and syncs the vault created next', async () => {
    const s = await setup('a', { key: true })
    expect(await signIn(s)).toEqual({ ok: true })
    expect(driveNames()).toEqual([])
    await s.store.create(PASS)
    await until(() => driveNames().includes(META_FILE), 'vault to reach Dropbox')
  })
})

describe('trouble and leaving', () => {
  it('withdrawn access asks for a new sign-in, and signing in again fixes it without losing anything', async () => {
    const s = await setup('a', { vault: true, key: true })
    await hosts(s.store).put(host('keep'))
    await signIn(s)
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'sync')
    d.control.expireAccessTokens(); d.control.revokeAllGrants()
    expect(await s.service.syncNow()).toMatchObject({ ok: false })
    expect(await s.service.status()).toMatchObject({ phase: 'needs-auth', error: expect.stringMatching(/đăng nhập lại/) })
    expect(await signIn(s)).toEqual({ ok: true })
    await until(async () => (await s.service.status()).phase === 'idle', 'back to normal')
    expect(names(s.store)).toEqual(['keep'])
  })
  it('signing out can also erase what was synced, and revokes the token', async () => {
    const a = await setup('a', { vault: true, key: true })
    await signIn(a)
    await until(async () => driveNames().length === 2, 'files')
    expect(await a.service.disconnect(true)).toEqual({ ok: true })
    expect(driveNames()).toEqual([])
    expect(d.stats.revocations).toBe(1)
    expect(a.store.getLocal('drive-tokens')).toBeUndefined()
    expect(await a.service.status()).toMatchObject({ phase: 'not-connected' })
  })
  it('signing out works even when Dropbox no longer accepts us, and says what it could not do', async () => {
    const a = await setup('a', { vault: true, key: true })
    await signIn(a)
    await until(async () => driveNames().length === 2, 'files')
    d.control.expireAccessTokens(); d.control.revokeAllGrants()
    const r = await a.service.disconnect(true)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Đã đăng xuất trên máy này.*Dropbox/) })
    expect(await a.service.status()).toMatchObject({ phase: 'not-connected' })
  })
  it('a second sign-in while one is running, or while connected, is refused', async () => {
    const s = await setup('a', { vault: true, key: true })
    await s.service.connect('dropbox')
    expect(await s.service.connect('dropbox')).toMatchObject({ ok: false })
    await s.service.submitDropboxCode(await d.browser(s.opened[0]!))
    await until(async () => (await s.service.status()).phase === 'idle', 'connected')
    expect(await s.service.connect('dropbox')).toMatchObject({ ok: false, error: expect.stringMatching(/Đã kết nối/) })
    expect(await s.service.connect('carrier-pigeon')).toMatchObject({ ok: false })
  })
})
