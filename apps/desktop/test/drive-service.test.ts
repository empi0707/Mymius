import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deviceFileName, META_FILE } from '@mymius/drive-sync'
import { startFakeGoogle, type FakeGoogle } from '@mymius/drive-sync/testing'
import { HOST_PREFIX, VaultStore, parseHostProfile, type HostProfile } from '@mymius/vault'
import type { DriveStatus } from '../src/shared/ipc'
import { DriveSyncService, type DriveHost } from '../src/main/drive-service'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let g: FakeGoogle
let dir: string
let services: DriveSyncService[]

beforeEach(async () => {
  g = await startFakeGoogle()
  dir = await mkdtemp(join(tmpdir(), 'mymius-dsvc-'))
  services = []
})
afterEach(async () => {
  for (const s of services) await s.disconnect(false).catch(() => undefined)
  await g.close()
  await rm(dir, { recursive: true, force: true })
})

const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: `pw-${name}` }, createdAt: 1, updatedAt: 1 })
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 25)) }
}

interface Setup { store: VaultStore; service: DriveSyncService; opened: string[]; statuses: DriveStatus[]; vaultFile: string; settingsFile: string }
async function setup(name: string, opts: { vault?: boolean; client?: boolean; host?: Partial<DriveHost>; keepFiles?: { vaultFile: string; settingsFile: string } } = {}): Promise<Setup> {
  const vaultFile = opts.keepFiles?.vaultFile ?? join(dir, `${name}-vault.json`)
  const settingsFile = opts.keepFiles?.settingsFile ?? join(dir, `${name}-drive.json`)
  const store = new VaultStore(vaultFile, { kdf: FAST })
  if (opts.vault) await store.create(PASS)
  const opened: string[] = []
  const statuses: DriveStatus[] = []
  const service = new DriveSyncService(
    {
      settingsFile,
      openExternal: async (url) => { opened.push(url); await g.browser(url) },
      emitStatus: (s) => statuses.push(s),
      allowInsecureHttp: true,
      endpoints: { authEndpoint: g.authEndpoint, tokenEndpoint: g.tokenEndpoint, revokeEndpoint: g.revokeEndpoint, baseUrl: g.baseUrl },
      intervalMs: 60_000,
      debounceMs: 30,
      ...opts.host
    },
    store
  )
  services.push(service)
  await service.init()
  if (opts.client) expect(await service.setClient({ clientId: g.clientId, clientSecret: g.clientSecret })).toEqual({ ok: true })
  return { store, service, opened, statuses, vaultFile, settingsFile }
}
const driveNames = () => g.control.files().map((f) => f.name).sort()

describe('configuration', () => {
  it('cannot connect until a client ID is provided', async () => {
    const s = await setup('a', { vault: true })
    expect(await s.service.connect()).toMatchObject({ ok: false, error: expect.stringMatching(/client ID/) })
    expect((await s.service.status()).configured).toBe(false)
    expect(s.opened).toEqual([])
  })

  it.each([[''], ['  '], ['has space'], ['x'.repeat(400)]])('rejects the client ID %j', async (id) => {
    const s = await setup('a', { vault: true })
    expect((await s.service.setClient({ clientId: id })).ok).toBe(false)
    expect((await s.service.setClient(null)).ok).toBe(false)
    expect((await s.service.status()).configured).toBe(false)
  })

  it('is remembered across restarts', async () => {
    const s = await setup('a', { vault: true, client: true })
    const again = await setup('a', { keepFiles: { vaultFile: s.vaultFile, settingsFile: s.settingsFile } })
    expect((await again.service.status()).configured).toBe(true)
  })
})

describe('turning sync on', () => {
  it('signs in through the browser, then syncs; the vault is what gets published', async () => {
    const s = await setup('a', { vault: true, client: true })
    await hosts(s.store).put(host('one'))
    expect(await s.service.connect()).toEqual({ ok: true })
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'first sync')
    const st = await s.service.status()
    expect(st).toMatchObject({ configured: true, phase: 'idle', email: 'user@example.com', devices: 0 })
    expect(driveNames()).toEqual([META_FILE, deviceFileName(s.store.deviceId)].sort())
    expect(s.opened).toHaveLength(1)
    expect(new URL(s.opened[0]!).searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('keeps the sign-in inside the vault: sealed on disk, never in the status, never synced', async () => {
    const s = await setup('a', { vault: true, client: true })
    await s.service.connect()
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'first sync')
    const tokens = JSON.parse(s.store.getLocal('drive-tokens')!) as { refreshToken: string; accessToken: string }
    expect(tokens.refreshToken).toMatch(/^rt-/)
    const disk = await readFile(s.vaultFile, 'utf8')
    for (const secret of [tokens.refreshToken, tokens.accessToken]) expect(disk).not.toContain(secret)
    const shown = JSON.stringify(await s.service.status())
    for (const secret of [tokens.refreshToken, tokens.accessToken, g.clientSecret]) expect(shown).not.toContain(secret)
    expect(JSON.stringify(g.control.files())).not.toContain(tokens.refreshToken)
  })

  it('resumes on its own after the app restarts and the vault is unlocked, with no new sign-in', async () => {
    const s = await setup('a', { vault: true, client: true })
    await s.service.connect()
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'first sync')
    const opened = s.opened.length
    // "Restart": a fresh store and service over the same files.
    const again = await setup('a', { keepFiles: { vaultFile: s.vaultFile, settingsFile: s.settingsFile } })
    expect((await again.service.status()).phase).toBe('not-connected') // locked: nothing can run yet
    await again.store.unlock(PASS)
    await until(async () => (await again.service.status()).phase === 'idle', 'resumed')
    await hosts(again.store).put(host('typed-after-restart'))
    await until(() => g.control.files().some((f) => f.name === deviceFileName(again.store.deviceId) && f.version > 1), 'the edit to be published')
    expect(again.opened).toEqual([])
    expect(opened).toBe(1)
  })

  it('locking the vault pauses syncing; unlocking resumes it', async () => {
    const s = await setup('a', { vault: true, client: true })
    await s.service.connect()
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'first sync')
    await s.store.lock()
    expect((await s.service.status()).phase).toBe('not-connected')
    const before = g.stats.driveRequests
    await new Promise((r) => setTimeout(r, 200))
    expect(g.stats.driveRequests).toBe(before)
    await s.store.unlock(PASS)
    await until(async () => (await s.service.status()).phase === 'idle', 'resumed')
  })

  it('a refused consent screen is reported and leaves nothing behind', async () => {
    const s = await setup('a', { vault: true, client: true })
    g.control.denyNextConsent()
    expect(await s.service.connect()).toMatchObject({ ok: false, error: expect.stringMatching(/not granted/) })
    expect(s.store.getLocal('drive-tokens')).toBeUndefined()
    expect((await s.service.status())).toMatchObject({ phase: 'not-connected', error: expect.stringMatching(/not granted/) })
    expect(driveNames()).toEqual([])
  })

  it('the sign-in can be cancelled', async () => {
    const s = await setup('a', { vault: true, client: true })
    g.control.stallConsent(true)
    const p = s.service.connect()
    await until(() => s.opened.length === 1, 'browser opened')
    expect((await s.service.status()).phase).toBe('connecting')
    s.service.cancelConnect()
    expect(await p).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/) })
    expect((await s.service.status()).phase).toBe('not-connected')
  })

  it('refuses to open a sign-in page that is not HTTPS (unless the tests say otherwise)', async () => {
    const s = await setup('a', { vault: true, client: true, host: { allowInsecureHttp: false } })
    expect(await s.service.connect()).toMatchObject({ ok: false, error: expect.stringMatching(/HTTPS/) })
    expect(s.opened).toEqual([])
  })

  it('a second sign-in while one is running, or while connected, is refused', async () => {
    const s = await setup('a', { vault: true, client: true })
    await s.service.connect()
    expect(await s.service.connect()).toMatchObject({ ok: false, error: expect.stringMatching(/Already connected/) })
    expect((await s.service.setClient({ clientId: 'other' })).ok).toBe(false)
  })
})

describe('setting up a new device from Google Drive', () => {
  async function firstDeviceWithData() {
    const a = await setup('a', { vault: true, client: true })
    await hosts(a.store).put(host('from-device-a'))
    await a.service.connect()
    await until(async () => (await a.service.status()).lastSyncAt !== undefined, 'a synced')
    return a
  }

  it('restores the vault, asks for the passphrase, and then brings the hosts in', async () => {
    await firstDeviceWithData()
    const b = await setup('b', { client: true })
    expect(await b.store.state()).toBe('uninitialized')
    expect(await b.service.connect()).toEqual({ ok: true })
    expect(await b.store.state()).toBe('locked')
    await b.store.unlock(PASS)
    await until(() => names(b.store).includes('from-device-a'), 'hosts to arrive')
    expect(JSON.parse(b.store.getLocal('drive-tokens')!).refreshToken).toMatch(/^rt-/) // now stored, sealed
    expect((await b.service.status()).phase).toMatch(/idle|syncing/)
  })

  it('the restored device then syncs both ways', async () => {
    const a = await firstDeviceWithData()
    const b = await setup('b', { client: true })
    await b.service.connect(); await b.store.unlock(PASS)
    await until(() => names(b.store).includes('from-device-a'), 'hosts to arrive')
    await hosts(b.store).put(host('from-device-b'))
    await b.service.syncNow(); await a.service.syncNow()
    expect(names(a.store)).toEqual(['from-device-a', 'from-device-b'])
  })

  it('says so when the Google account has no vault, and leaves this device empty', async () => {
    const b = await setup('b', { client: true })
    expect(await b.service.connect()).toMatchObject({ ok: false, error: expect.stringMatching(/No vault from this app/) })
    expect(await b.store.state()).toBe('uninitialized')
    expect((await b.service.status()).phase).toBe('not-connected')
  })

  it('the wrong passphrase gets nowhere and nothing is stored', async () => {
    await firstDeviceWithData()
    const b = await setup('b', { client: true })
    await b.service.connect()
    await expect(b.store.unlock('not the passphrase')).rejects.toThrow()
    expect(await b.store.state()).toBe('locked')
    expect(b.store.metaRev).toBe(1) // nothing from Drive was merged
  })
})

describe('when access is withdrawn', () => {
  it('asks the user to sign in again, and signing in again fixes it without losing anything', async () => {
    const s = await setup('a', { vault: true, client: true })
    await hosts(s.store).put(host('one'))
    await s.service.connect()
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'first sync')
    g.control.expireAccessTokens(); g.control.revokeAllGrants()
    expect(await s.service.syncNow()).toMatchObject({ ok: false })
    expect((await s.service.status())).toMatchObject({ phase: 'needs-auth', error: expect.stringMatching(/Sign in again/) })
    expect(names(s.store)).toEqual(['one'])

    expect(await s.service.connect()).toEqual({ ok: true })
    await until(async () => (await s.service.status()).phase === 'idle', 'back in sync')
    expect(JSON.parse(s.store.getLocal('drive-tokens')!).refreshToken).toMatch(/^rt-/)
  })
})

describe('turning sync off', () => {
  it('signs out: Google is told, the sign-in is forgotten, this device leaves Drive, the others keep the data', async () => {
    const a = await setup('a', { vault: true, client: true })
    await hosts(a.store).put(host('one'))
    await a.service.connect()
    await until(async () => (await a.service.status()).lastSyncAt !== undefined, 'first sync')
    const before = g.stats.driveRequests
    expect(await a.service.disconnect(false)).toEqual({ ok: true })
    expect(g.stats.revocations).toBe(1)
    expect(a.store.getLocal('drive-tokens')).toBeUndefined()
    expect(a.store.getLocal('drive-sync-state')).toBeUndefined()
    expect(driveNames()).toEqual([META_FILE]) // this device's file is gone; the shared metadata stays for the others
    expect((await a.service.status())).toMatchObject({ phase: 'not-connected', devices: 0 })
    expect(names(a.store)).toEqual(['one']) // local data untouched
    await hosts(a.store).put(host('after-disconnect'))
    await new Promise((r) => setTimeout(r, 250))
    expect(g.stats.driveRequests - before).toBeLessThanOrEqual(3) // only the sign-out itself, nothing background
  })

  it('can also erase the synced data from Google Drive', async () => {
    const a = await setup('a', { vault: true, client: true })
    await a.service.connect()
    await until(async () => (await a.service.status()).lastSyncAt !== undefined, 'first sync')
    g.control.write('someone-elses.txt', 'keep')
    expect(await a.service.disconnect(true)).toEqual({ ok: true })
    expect(driveNames()).toEqual(['someone-elses.txt'])
  })

  it('signing out on this computer works even when Google no longer accepts us, and says what it could not do', async () => {
    const a = await setup('a', { vault: true, client: true })
    await hosts(a.store).put(host('keep-me'))
    await a.service.connect()
    await until(async () => (await a.service.status()).lastSyncAt !== undefined, 'first sync')
    const remote = driveNames()
    g.control.expireAccessTokens(); g.control.revokeAllGrants()
    const r = await a.service.disconnect(true)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Signed out on this computer, but the synced data could not be erased/) })
    expect(await a.service.status()).toMatchObject({ phase: 'not-connected' })
    expect(a.store.getLocal('drive-tokens')).toBeUndefined()
    expect(names(a.store)).toEqual(['keep-me'])
    expect(driveNames()).toEqual(remote) // nothing was erased, and the user was told so
    expect(await a.service.disconnect(false)).toEqual({ ok: true })
  })

  it('disconnecting when never connected is harmless', async () => {
    const a = await setup('a', { vault: true, client: true })
    expect(await a.service.disconnect(false)).toEqual({ ok: true })
  })
})

describe('status updates', () => {
  it('are pushed as things happen, passing through "connecting"', async () => {
    const s = await setup('a', { vault: true, client: true })
    await s.service.connect()
    await until(async () => (await s.service.status()).lastSyncAt !== undefined, 'first sync')
    const phases = s.statuses.map((x) => x.phase)
    expect(phases).toContain('connecting')
    expect(phases.at(-1)).toBe('idle')
  })
})
