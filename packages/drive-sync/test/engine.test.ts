import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_PREFIX, VaultAuthError, VaultLockedError, VaultStore, parseHostProfile, type HostProfile
} from '@mymius/vault'
import {
  AuthSession, DriveClient, DriveSync, META_FILE, NoRemoteVaultError, authorize, deviceFileName, restoreVault,
  type OAuthConfig, type SyncState
} from '../src'
import { startFakeGoogle, type FakeGoogle } from '../src/testing'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let g: FakeGoogle
let oauth: OAuthConfig
let dir: string
const stopAtEnd: DriveSync[] = []

beforeEach(async () => {
  g = await startFakeGoogle()
  oauth = { clientId: g.clientId, clientSecret: g.clientSecret, authEndpoint: g.authEndpoint, tokenEndpoint: g.tokenEndpoint, revokeEndpoint: g.revokeEndpoint }
  dir = await mkdtemp(join(tmpdir(), 'mymius-engine-'))
})
afterEach(async () => {
  for (const s of stopAtEnd.splice(0)) s.stop()
  await g.close()
  await rm(dir, { recursive: true, force: true })
})

const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: `pw-${name}` }, createdAt: 1, updatedAt: 1 })
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()

interface Device {
  store: VaultStore
  drive: DriveClient
  sync: DriveSync
  state: { current: SyncState | undefined }
  auth: AuthSession
  clock: { t: number }
}

async function signIn(): Promise<{ drive: DriveClient; auth: AuthSession }> {
  const tokens = await authorize(oauth, { openBrowser: g.browser })
  const auth = new AuthSession(oauth, tokens)
  return { auth, drive: new DriveClient({ auth, baseUrl: g.baseUrl, sleep: async () => undefined, maxAttempts: 2 }) }
}

async function device(name: string, opts: { create?: boolean; restore?: boolean; intervalMs?: number; debounceMs?: number } = {}): Promise<Device> {
  const store = new VaultStore(join(dir, `${name}.json`), { kdf: FAST })
  const { drive, auth } = await signIn()
  if (opts.create) await store.create(PASS)
  if (opts.restore) { await restoreVault(drive, store); await store.unlock(PASS) }
  const state: { current: SyncState | undefined } = { current: undefined }
  const clock = { t: 1_000_000 }
  const sync = new DriveSync({
    store, drive,
    state: { load: () => state.current, save: async (s) => { state.current = structuredClone(s) } },
    now: () => clock.t,
    ...(opts.intervalMs ? { intervalMs: opts.intervalMs } : {}),
    ...(opts.debounceMs ? { debounceMs: opts.debounceMs } : {})
  })
  stopAtEnd.push(sync)
  return { store, drive, sync, state, auth, clock }
}

/** The first device with a vault, already published, and a second one restored from Drive. */
async function pair() {
  const a = await device('a', { create: true })
  await a.sync.syncNow()
  const b = await device('b', { restore: true })
  await b.sync.syncNow()
  return { a, b }
}
const downloads = () => g.stats.log.filter((l) => l.startsWith('GET') && /files\/[^/]+$/.test(l.split(' ')[1]!)).length
const listNames = () => g.control.files().map((f) => f.name).sort()

describe('the first device', () => {
  it('publishes the vault metadata and its own records, and nothing readable', async () => {
    const a = await device('a', { create: true })
    await hosts(a.store).put(host('prod-db-zeta'))
    const r = await a.sync.syncNow()
    expect(r).toMatchObject({ pushed: true, devices: 0, changedRecords: 0 })
    expect(listNames()).toEqual([META_FILE, deviceFileName(a.store.deviceId)].sort())
    const everything = JSON.stringify(g.control.files())
    for (const secret of ['prod-db-zeta', 'pw-prod-db-zeta', PASS, 'refresh']) expect(everything).not.toContain(secret)
    expect(a.sync.status).toMatchObject({ phase: 'idle', lastSyncAt: 1_000_000 })
  })

  it('when nothing changed a round is a single listing: no downloads, no uploads', async () => {
    const a = await device('a', { create: true })
    await hosts(a.store).put(host('one'))
    await a.sync.syncNow()
    g.stats.log.length = 0
    const r = await a.sync.syncNow()
    expect(r.pushed).toBe(false)
    expect(g.stats.log).toEqual(['GET /drive/v3/files'])
  })

  it('an empty vault syncs too', async () => {
    const a = await device('a', { create: true })
    expect(await a.sync.syncNow()).toMatchObject({ pushed: true })
    expect(listNames()).toHaveLength(2)
  })
})

describe('adding a second device', () => {
  it('restores from the metadata alone, then reads everything after unlocking', async () => {
    const a = await device('a', { create: true })
    await hosts(a.store).put(host('one')); await hosts(a.store).put(host('two'))
    await a.sync.syncNow()
    const b = await device('b', { restore: true })
    expect(names(b.store)).toEqual([]) // nothing yet: records are merged by the first sync
    const r = await b.sync.syncNow()
    expect(r.changedRecords).toBe(2)
    expect(names(b.store)).toEqual(['one', 'two'])
    expect(listNames()).toHaveLength(3) // meta + one file per device
  })

  it('a wrong passphrase does not get in, and nothing was merged', async () => {
    const a = await device('a', { create: true })
    await hosts(a.store).put(host('one'))
    await a.sync.syncNow()
    const b = await device('b', {})
    await restoreVault(b.drive, b.store)
    await expect(b.store.unlock('not the passphrase')).rejects.toBeInstanceOf(VaultAuthError)
    await expect(b.sync.syncNow()).rejects.toBeInstanceOf(VaultLockedError)
    expect(b.sync.status.phase).toBe('locked')
  })

  it('restoring is refused when the account has no vault, or the device already has one', async () => {
    const { drive } = await signIn()
    await expect(restoreVault(drive, new VaultStore(join(dir, 'x.json'), { kdf: FAST }))).rejects.toBeInstanceOf(NoRemoteVaultError)
    const a = await device('a', { create: true }); await a.sync.syncNow()
    await expect(restoreVault(a.drive, a.store)).rejects.toThrow(/đã tồn tại/)
  })

  it('a device that made its own vault first is not silently merged: the two vaults are kept apart', async () => {
    const a = await device('a', { create: true })
    await hosts(a.store).put(host('mine-on-a'))
    await a.sync.syncNow()
    const c = await device('c', { create: true }) // its own, unrelated vault
    await hosts(c.store).put(host('mine-on-c'))
    await expect(c.sync.syncNow()).rejects.toThrow()
    expect(c.sync.status.phase).toBe('error')
    expect(c.sync.status.error).toMatch(/different vault/)
    expect(names(c.store)).toEqual(['mine-on-c'])
    expect(names(a.store)).toEqual(['mine-on-a'])
  })
})

describe('keeping two devices in step', () => {
  it('a change on one reaches the other, and back', async () => {
    const { a, b } = await pair()
    await hosts(a.store).put(host('from-a'))
    await a.sync.syncNow(); await b.sync.syncNow()
    expect(names(b.store)).toEqual(['from-a'])
    await hosts(b.store).put(host('from-b'))
    await b.sync.syncNow(); await a.sync.syncNow()
    expect(names(a.store)).toEqual(['from-a', 'from-b'])
    expect(names(b.store)).toEqual(names(a.store))
  })

  it('a deletion propagates', async () => {
    const { a, b } = await pair()
    const id = await hosts(a.store).put(host('doomed'))
    await a.sync.syncNow(); await b.sync.syncNow()
    expect(names(b.store)).toEqual(['doomed'])
    await hosts(a.store).remove(id)
    await a.sync.syncNow(); await b.sync.syncNow()
    expect(names(b.store)).toEqual([])
  })

  it('edits to the same host on both devices converge on the later one', async () => {
    const { a, b } = await pair()
    const id = await hosts(a.store).put(host('shared'))
    await a.sync.syncNow(); await b.sync.syncNow()
    await hosts(a.store).put(host('a-edit'), id)
    await new Promise((r) => setTimeout(r, 5))
    await hosts(b.store).put(host('b-edit-later'), id)
    await a.sync.syncNow(); await b.sync.syncNow(); await a.sync.syncNow()
    expect(names(a.store)).toEqual(['b-edit-later'])
    expect(names(b.store)).toEqual(['b-edit-later'])
  })

  it('offline edits on both sides merge without losing either', async () => {
    const { a, b } = await pair()
    for (let i = 0; i < 5; i++) await hosts(a.store).put(host(`a${i}`))
    for (let i = 0; i < 5; i++) await hosts(b.store).put(host(`b${i}`))
    await a.sync.syncNow(); await b.sync.syncNow(); await a.sync.syncNow()
    expect(names(a.store)).toHaveLength(10)
    expect(names(b.store)).toEqual(names(a.store))
  })

  it('each device writes only its own file: there is never anything to overwrite', async () => {
    const { a, b } = await pair()
    await hosts(a.store).put(host('x')); await hosts(b.store).put(host('y'))
    await a.sync.syncNow(); await b.sync.syncNow(); await a.sync.syncNow(); await b.sync.syncNow()
    const updates = g.stats.log.filter((l) => l.startsWith('PATCH'))
    const files = g.control.files()
    expect(files.map((f) => f.name).sort()).toEqual([META_FILE, deviceFileName(a.store.deviceId), deviceFileName(b.store.deviceId)].sort())
    expect(updates.length).toBeGreaterThan(0)
  })

  it('only files that changed are downloaded', async () => {
    const { a, b } = await pair()
    await hosts(a.store).put(host('one'))
    await a.sync.syncNow()
    const before = downloads()
    await b.sync.syncNow() // a's file changed: one download
    expect(downloads() - before).toBe(1)
    const mid = downloads()
    await b.sync.syncNow(); await b.sync.syncNow() // nothing changed
    expect(downloads()).toBe(mid)
  })

  it('a device that restarts remembers what it has seen', async () => {
    const { a, b } = await pair()
    await hosts(a.store).put(host('one'))
    await a.sync.syncNow(); await b.sync.syncNow()
    const b2 = new DriveSync({ store: b.store, drive: b.drive, state: { load: () => b.state.current, save: async (s) => { b.state.current = s } } })
    const before = downloads()
    await b2.syncNow()
    expect(downloads()).toBe(before)
  })

  it('a new passphrase set on one device is adopted by the others', async () => {
    const { a, b } = await pair()
    await a.store.changePassphrase('a completely new passphrase')
    await a.sync.syncNow(); await b.sync.syncNow()
    expect(b.store.metaRev).toBe(2)
    const restarted = new VaultStore(join(dir, 'b.json'), { kdf: FAST })
    await expect(restarted.unlock(PASS)).rejects.toBeInstanceOf(VaultAuthError)
    await restarted.unlock('a completely new passphrase')
  })

  it('a thousand-host vault syncs in one go', async () => {
    const { a, b } = await pair()
    for (let i = 0; i < 300; i++) await hosts(a.store).put(host(`h${i}`))
    await a.sync.syncNow(); await b.sync.syncNow()
    expect(names(b.store)).toHaveLength(300)
  }, 60_000)
})

describe('files Drive should not be trusted with', () => {
  it('a device file changed by someone with access to the storage is refused, and the rest carries on', async () => {
    const { a, b } = await pair()
    const id = await hosts(a.store).put(host('precious'))
    await a.sync.syncNow(); await b.sync.syncNow()
    const c = await device('c', { restore: true })
    // The attacker rewrites a's published file to erase the host.
    const aFile = g.control.files().find((f) => f.name === deviceFileName(a.store.deviceId))!
    const forged = JSON.parse(aFile.text)
    const rec = forged.records.find((r: { id: string }) => r.id === id)
    rec.deleted = true; rec.payload = null; rec.hlc = '999999999999999-99999-evil'
    g.control.write(aFile.name, JSON.stringify(forged))
    const r = await c.sync.syncNow()
    expect(r.ignored).toEqual([`${aFile.name}: tampered`])
    // The forged file gave c nothing, and erased nothing: b had already merged a's records and published
    // them too, so every device publishing its whole state makes a single forged file harmless.
    expect(names(c.store)).toEqual(['precious'])
    await b.sync.syncNow()
    expect(names(b.store)).toEqual(['precious'])
    expect(names(a.store)).toEqual(['precious'])
    expect(c.sync.status.ignored).toEqual([`${aFile.name}: tampered`])
  })

  it('a rejected file is not downloaded again until it changes', async () => {
    const { a, b } = await pair()
    await hosts(a.store).put(host('x')); await a.sync.syncNow()
    const f = g.control.files().find((x) => x.name === deviceFileName(a.store.deviceId))!
    g.control.write(f.name, f.text.replace('"records":[', '"records":[{"id":"host:evil","hlc":"1","deleted":false,"payload":"x"},'))
    await b.sync.syncNow()
    const before = downloads()
    await b.sync.syncNow(); await b.sync.syncNow()
    expect(downloads()).toBe(before)
  })

  it.each([
    ['garbage', '<html>not json</html>'],
    ['an array', '[]'],
    ['the wrong shape', JSON.stringify({ format: 1, deviceId: 'abcd', updatedAt: 1, records: 'nope', mac: 'x' })]
  ])('%s in place of a device file is ignored', async (_n, content) => {
    const { a } = await pair()
    g.control.write(deviceFileName('deadbeef'), content)
    const r = await a.sync.syncNow()
    expect(r.ignored).toHaveLength(1)
    expect(a.sync.status.phase).toBe('idle')
  })

  it('files that are not ours are left alone', async () => {
    const { a } = await pair()
    g.control.write('somebody-elses-notes.txt', 'hello')
    const r = await a.sync.syncNow()
    expect(r.ignored).toEqual([])
    expect(listNames()).toContain('somebody-elses-notes.txt')
  })

  it('forged vault metadata is refused; sync halts, the local vault is untouched and still opens', async () => {
    const { a, b } = await pair()
    const meta = g.control.files().find((f) => f.name === META_FILE)!
    const forged = JSON.parse(meta.text)
    forged.meta.wrappedByPassphrase = forged.meta.wrappedByRecovery // would lock everyone out
    forged.meta.rev = 50
    g.control.write(META_FILE, JSON.stringify(forged))
    await expect(b.sync.syncNow()).rejects.toThrow()
    expect(b.sync.status).toMatchObject({ phase: 'error' })
    expect(b.sync.status.error).toMatch(/integrity/)
    expect(b.store.metaRev).toBe(1)
    await new VaultStore(join(dir, 'b.json'), { kdf: FAST }).unlock(PASS)
    // Repairing the file by hand (or from another device) lets a manual sync recover.
    g.control.write(META_FILE, JSON.stringify(a.store.buildMetaFile()))
    await b.sync.syncNow()
    expect(b.sync.status.phase).toBe('idle')
  })
})

describe('when the network or Google misbehaves', () => {
  it('a failure is reported, backed off, and cleared by the next good round; local data is untouched', async () => {
    const { a } = await pair()
    await hosts(a.store).put(host('offline-edit'))
    g.control.failNext(99, 503)
    await expect(a.sync.syncNow()).rejects.toThrow()
    expect(a.sync.status).toMatchObject({ phase: 'error', retryAt: 1_000_000 + 5_000 })
    expect(names(a.store)).toEqual(['offline-edit'])
    g.control.failNext(0, 503)
    await a.sync.syncNow()
    expect(a.sync.status.phase).toBe('idle')
    expect(a.sync.status.error).toBeUndefined()
    expect(a.sync.status.retryAt).toBeUndefined()
    expect(g.control.files().find((f) => f.name === deviceFileName(a.store.deviceId))!.text).toContain('records')
  })

  it('repeated failures wait longer each time, up to five minutes', async () => {
    const { a } = await pair()
    g.control.failNext(999, 503)
    const waits: number[] = []
    for (let i = 0; i < 9; i++) {
      await a.sync.syncNow().catch(() => undefined)
      waits.push(a.sync.status.retryAt! - a.clock.t)
    }
    expect(waits).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000])
  })

  it('withdrawn access asks the user to sign in again and stops trying on its own', async () => {
    const { a } = await pair()
    g.control.expireAccessTokens(); g.control.revokeAllGrants()
    await expect(a.sync.syncNow()).rejects.toThrow()
    expect(a.sync.status.phase).toBe('needs-auth')
    expect(a.sync.status.error).toMatch(/đăng nhập lại/)
    a.sync.start()
    await new Promise((r) => setTimeout(r, 100))
    const before = g.stats.driveRequests
    a.sync.requestSync(0)
    await new Promise((r) => setTimeout(r, 100))
    expect(g.stats.driveRequests).toBe(before) // halted until the user signs in again
  })

  it('a full Drive is explained, retried only hourly, and does not touch local data', async () => {
    const { a } = await pair()
    await hosts(a.store).put(host('new'))
    g.control.setQuotaFull(true)
    await expect(a.sync.syncNow()).rejects.toThrow(/đã đầy/)
    expect(a.sync.status).toMatchObject({ phase: 'error', retryAt: 1_000_000 + 3_600_000 })
    g.control.setQuotaFull(false)
    await a.sync.syncNow()
    expect(a.sync.status.phase).toBe('idle')
  })

  it('a locked vault waits instead of failing, and reports why', async () => {
    const { a } = await pair()
    await a.store.lock()
    await expect(a.sync.syncNow()).rejects.toBeInstanceOf(VaultLockedError)
    expect(a.sync.status.phase).toBe('locked')
  })

  it('a device file deleted from Drive is published again', async () => {
    const { a } = await pair()
    await hosts(a.store).put(host('one')); await a.sync.syncNow()
    g.control.remove(deviceFileName(a.store.deviceId))
    await a.sync.syncNow()
    expect(listNames()).toContain(deviceFileName(a.store.deviceId))
    expect(g.control.files().find((f) => f.name === deviceFileName(a.store.deviceId))!.text).toContain('records')
  })

  it('metadata deleted from Drive is published again, and local data is never removed because a remote file vanished', async () => {
    const { a, b } = await pair()
    await hosts(a.store).put(host('one')); await a.sync.syncNow(); await b.sync.syncNow()
    g.control.remove(META_FILE); g.control.remove(deviceFileName(a.store.deviceId))
    await b.sync.syncNow()
    expect(names(b.store)).toEqual(['one'])
    expect(listNames()).toContain(META_FILE)
  })

  it('simultaneous requests share one round, then one more if something came in meanwhile', async () => {
    const { a } = await pair()
    await hosts(a.store).put(host('one'))
    g.stats.log.length = 0
    const results = await Promise.all(Array.from({ length: 6 }, () => a.sync.syncNow()))
    expect(new Set(results).size).toBe(1)
    expect(g.stats.log.filter((l) => l === 'GET /drive/v3/files').length).toBeLessThanOrEqual(2)
  })
})

describe('running in the background', () => {
  const eventually = async (fn: () => boolean, what: string, ms = 8000) => {
    const end = Date.now() + ms
    while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)) }
  }

  it('publishes local edits by itself, and picks up other devices by polling', async () => {
    const a = await device('a', { create: true, intervalMs: 120, debounceMs: 30 })
    a.sync.start()
    await eventually(() => a.sync.status.lastSyncAt !== undefined, 'first sync')
    const b = await device('b', { restore: true, intervalMs: 120, debounceMs: 30 })
    b.sync.start()
    await hosts(a.store).put(host('typed-on-a'))
    await eventually(() => names(b.store).includes('typed-on-a'), 'b to receive a\'s edit')
    await hosts(b.store).put(host('typed-on-b'))
    await eventually(() => names(a.store).includes('typed-on-b'), 'a to receive b\'s edit')
  })

  it('a burst of edits becomes one upload', async () => {
    const a = await device('a', { create: true, intervalMs: 60_000, debounceMs: 80 })
    a.sync.start()
    await eventually(() => a.sync.status.lastSyncAt !== undefined, 'first sync')
    const before = g.stats.log.filter((l) => l.startsWith('PATCH')).length
    for (let i = 0; i < 10; i++) await hosts(a.store).put(host(`burst${i}`))
    await eventually(() => g.control.files().some((f) => f.text.includes('burst') || f.version > 1), 'the upload')
    await new Promise((r) => setTimeout(r, 300))
    expect(g.stats.log.filter((l) => l.startsWith('PATCH')).length - before).toBeLessThanOrEqual(2)
  })

  it('syncs as soon as the vault is unlocked', async () => {
    const a = await device('a', { create: true, intervalMs: 60_000, debounceMs: 30 })
    await hosts(a.store).put(host('one'))
    await a.store.lock()
    a.sync.start()
    expect(a.sync.status.phase).toBe('idle')
    await a.store.unlock(PASS)
    await eventually(() => a.sync.status.lastSyncAt !== undefined, 'sync after unlock')
    expect(listNames()).toContain(deviceFileName(a.store.deviceId))
  })

  it('stop() ends all background activity', async () => {
    const a = await device('a', { create: true, intervalMs: 50, debounceMs: 20 })
    a.sync.start()
    await eventually(() => a.sync.status.lastSyncAt !== undefined, 'first sync')
    a.sync.stop()
    expect(a.sync.status.phase).toBe('off')
    const before = g.stats.driveRequests
    await hosts(a.store).put(host('after-stop'))
    await new Promise((r) => setTimeout(r, 300))
    expect(g.stats.driveRequests).toBe(before)
  })
})

describe('leaving', () => {
  it('removing this device deletes only its own file; the others keep what they merged', async () => {
    const { a, b } = await pair()
    await hosts(a.store).put(host('one')); await a.sync.syncNow(); await b.sync.syncNow()
    await a.sync.removeThisDevice()
    expect(listNames()).toEqual([META_FILE, deviceFileName(b.store.deviceId)].sort())
    expect(names(b.store)).toEqual(['one'])
  })

  it('deleting everything removes every file this app wrote, and only those', async () => {
    const { a } = await pair()
    g.control.write('not-ours.txt', 'keep')
    expect(await a.sync.deleteAllRemote()).toBe(3)
    expect(listNames()).toEqual(['not-ours.txt'])
  })
})
