import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_PREFIX, VaultStore, parseHostProfile, type HostProfile } from '@mymius/vault'
import { FileSyncService } from '../src/main/file-sync-service'
import type { FileSyncStatus } from '../src/shared/ipc'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let dir: string
let services: FileSyncService[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-fs-')); services = [] })
afterEach(async () => { for (const s of services) await s.unlink().catch(() => undefined); await rm(dir, { recursive: true, force: true }) })

const err = (r: { ok: boolean; error?: string }): string | undefined => (r.ok ? undefined : r.error)
const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: 'pw-' + name }, createdAt: 1, updatedAt: 1 })
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out: ' + what); await new Promise((r) => setTimeout(r, 20)) }
}

async function device(name: string, opts: { vault?: boolean; pick?: () => string | undefined } = {}) {
  const store = new VaultStore(join(dir, `${name}.json`), { kdf: FAST })
  if (opts.vault) await store.create(PASS)
  const statuses: FileSyncStatus[] = []
  const ctl = { path: opts.pick?.() as string | undefined }
  const service = new FileSyncService({ pick: async () => ctl.path, emitStatus: (s) => statuses.push(s), intervalMs: 60, debounceMs: 20 }, store)
  services.push(service)
  await service.init()
  return { store, service, statuses, ctl }
}

describe('backup and restore', () => {
  it('exports a file that holds no readable secret, and restores it on a new device', async () => {
    const a = await device('a', { vault: true })
    await hosts(a.store).put(host('prod'))
    a.ctl.path = join(dir, 'backup.json')
    expect(await a.service.exportBackup()).toEqual({ ok: true })
    const raw = await readFile(a.ctl.path, 'utf8')
    expect(JSON.parse(raw).kind).toBe('mymius-sync-bundle')
    expect(raw).not.toContain('pw-prod')
    expect(raw).not.toContain('prod.example')
    expect(((await stat(a.ctl.path)).mode & 0o077)).toBe(0)

    const b = await device('b')
    b.ctl.path = a.ctl.path
    expect(await b.service.importBackup()).toEqual({ ok: true })
    expect(await b.store.state()).toBe('locked')
    await b.store.unlock(PASS)
    await until(() => names(b.store).includes('prod'), 'the backup to be merged after unlocking')
    expect(await b.service.status()).toMatchObject({ phase: 'off' }) // a restore is not a link
    expect(await readFile(a.ctl.path, 'utf8')).toBe(raw) // and the backup file is left exactly as it was
  })

  it('restoring by linking merges the records as soon as the vault is unlocked, and keeps syncing', async () => {
    const a = await device('a', { vault: true })
    await hosts(a.store).put(host('prod'))
    a.ctl.path = join(dir, 'shared.json')
    expect(await a.service.link('create')).toEqual({ ok: true })

    const b = await device('b')
    b.ctl.path = a.ctl.path
    expect(await b.service.link('existing')).toEqual({ ok: true })
    expect((await b.service.status()).phase).toBe('locked')
    await b.store.unlock(PASS)
    await until(() => names(b.store).includes('prod'), 'the host to arrive')

    await hosts(b.store).put(host('from-b'))
    await until(() => names(a.store).includes('from-b'), 'b -> a')
    await hosts(a.store).put(host('from-a'))
    await until(() => names(b.store).includes('from-a'), 'a -> b').catch((e) => { console.log('DBG2', JSON.stringify([a.service.status(), b.service.status(), names(a.store), names(b.store)])); throw e })
    expect(names(a.store)).toEqual(['from-a', 'from-b', 'prod'])
  })

  it('an unlocked vault can merge a backup once, but not one from another vault', async () => {
    const a = await device('a', { vault: true })
    await hosts(a.store).put(host('one'))
    a.ctl.path = join(dir, 'a.json')
    await a.service.exportBackup()
    const b = await device('b', { vault: true })
    b.ctl.path = a.ctl.path
    expect(err(await b.service.importBackup())).toMatch(/different vault/)
    expect(names(b.store)).toEqual([])
  })

  it('cancelling a dialog is not an error, and locked vaults are refused', async () => {
    const a = await device('a', { vault: true })
    a.ctl.path = undefined
    expect(await a.service.exportBackup()).toEqual({ ok: false, error: '' })
    expect(await a.service.link('create')).toEqual({ ok: false, error: '' })
    await a.store.lock()
    expect(err(await a.service.exportBackup())).toMatch(/Unlock/)
  })

  it('files that are not sync files are refused with a plain message', async () => {
    const a = await device('a', { vault: true })
    for (const [content, re] of [['not json', /not a Mymius sync file/], ['{"kind":"x"}', /not a Mymius sync file/]] as const) {
      const p = join(dir, 'bad.json'); await writeFile(p, content)
      a.ctl.path = p
      expect(err(await a.service.importBackup())).toMatch(re)
      expect(err(await a.service.link('existing'))).toMatch(re)
    }
    a.ctl.path = join(dir, 'missing.json')
    expect(err(await a.service.link('existing'))).toMatch(/could not be found/)
  })
})

describe('keeping in step with a file', () => {
  it('never overwrites a file that fails its integrity check, and says so', async () => {
    const a = await device('a', { vault: true })
    a.ctl.path = join(dir, 's.json')
    await a.service.link('create')
    const good = JSON.parse(await readFile(a.ctl.path, 'utf8'))
    good.meta.meta.rev = 42 // altered without the key
    const altered = JSON.stringify(good)
    await writeFile(a.ctl.path, altered)
    await hosts(a.store).put(host('x'))
    await until(async () => (await a.service.status()).phase === 'error', 'the problem to be noticed')
    expect((await a.service.status()).error).toMatch(/integrity/)
    expect(await readFile(a.ctl.path, 'utf8')).toBe(altered)
  })

  it('does not rewrite the file when nothing changed', async () => {
    const a = await device('a', { vault: true })
    a.ctl.path = join(dir, 's.json')
    await a.service.link('create')
    const before = (await stat(a.ctl.path)).mtimeMs
    await new Promise((r) => setTimeout(r, 400))
    expect((await stat(a.ctl.path)).mtimeMs).toBe(before)
  })

  it('a change made while another device rewrote the file is not lost', async () => {
    const a = await device('a', { vault: true })
    a.ctl.path = join(dir, 's.json')
    await a.service.link('create')
    const b = await device('b'); b.ctl.path = a.ctl.path
    await b.service.link('existing'); await b.store.unlock(PASS)
    await until(async () => (await b.service.status()).phase === 'idle' && (await b.service.status()).lastSyncAt !== undefined, 'b to settle')
    // both write at nearly the same moment
    await Promise.all([hosts(a.store).put(host('a1')), hosts(b.store).put(host('b1'))])
    await until(() => names(a.store).length === 2 && names(b.store).length === 2, 'both to converge').catch((e) => { console.log('DBG', JSON.stringify([a.service.status(), b.service.status(), names(a.store), names(b.store)])); throw e })
    expect(names(a.store)).toEqual(['a1', 'b1'])
  })

  it('locking pauses it, unlocking resumes it by itself, and unlinking forgets the file', async () => {
    const a = await device('a', { vault: true })
    a.ctl.path = join(dir, 's.json')
    await a.service.link('create')
    await a.store.lock()
    expect((await a.service.status()).phase).toBe('off')
    await a.store.unlock(PASS)
    await until(async () => (await a.service.status()).path === a.ctl.path, 'sync to resume')
    expect(await a.service.unlink()).toEqual({ ok: true })
    expect(await a.service.status()).toMatchObject({ phase: 'off' })
    await a.store.lock(); await a.store.unlock(PASS)
    expect((await a.service.status()).path).toBeUndefined()
  })

  it('a missing folder is a retryable problem, not a permanent one', async () => {
    const a = await device('a', { vault: true })
    a.ctl.path = join(dir, 'later', 's.json')
    expect(await a.service.link('create')).toEqual({ ok: true }) // creates the folder
    expect((await stat(a.ctl.path)).isFile()).toBe(true)
  })
})
