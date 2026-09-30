import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_PREFIX, VaultStore, applyBundle, bundleMeta, parseBundle, parseHostProfile, type HostProfile } from '@mymius/vault'
import { AutoBackupService } from '../src/main/auto-backup-service'
import type { AutoBackupStatus } from '../src/shared/ipc'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-ab-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: 'pw-' + name }, createdAt: 1, updatedAt: 1 })
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out: ' + what); await new Promise((r) => setTimeout(r, 15)) }
}
const backups = async (d: string) => (await readdir(d).catch(() => [] as string[])).filter((n) => n.startsWith('mymius-backup-') && n.endsWith('.json')).sort()

async function setup(opts: { keep?: number; picked?: string } = {}) {
  const store = new VaultStore(join(dir, 'vault.json'), { kdf: FAST })
  await store.create(PASS)
  const statuses: AutoBackupStatus[] = []
  const backupDir = join(dir, 'backups')
  const svc = new AutoBackupService({ defaultDir: backupDir, pickDirectory: async () => opts.picked, emitStatus: (s) => statuses.push(s), debounceMs: 10, ...(opts.keep ? { keep: opts.keep } : {}) }, store)
  await svc.init()
  return { store, svc, backupDir, statuses }
}

describe('automatic backup when a host is added', () => {
  it('writes one backup per new host, and none for opening the vault or editing a host', async () => {
    const { store, svc, backupDir } = await setup()
    expect(await backups(backupDir)).toEqual([])
    const id = await hosts(store).put(host('one'))
    await until(async () => (await backups(backupDir)).length === 1, 'the first backup')
    await hosts(store).put({ ...host('one'), name: 'one-renamed' }, id) // an edit, not a new host
    await new Promise((r) => setTimeout(r, 150))
    expect(await backups(backupDir)).toHaveLength(1)
    await hosts(store).put(host('two'))
    await until(async () => (await backups(backupDir)).length === 2, 'the second backup')
    expect(svc.status()).toMatchObject({ enabled: true, dir: backupDir, customDir: false, lastBackupAt: expect.any(Number) })

    await store.lock(); await store.unlock(PASS) // reopening is not adding
    await new Promise((r) => setTimeout(r, 150))
    expect(await backups(backupDir)).toHaveLength(2)
  })

  it('the backup restores everything on a new device, and holds nothing readable', async () => {
    const { store, backupDir } = await setup()
    await hosts(store).put(host('prod'))
    await until(async () => (await backups(backupDir)).length === 1, 'a backup')
    const file = join(backupDir, (await backups(backupDir))[0]!)
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('pw-prod'); expect(raw).not.toContain('prod.example')
    expect((await stat(file)).mode & 0o077).toBe(0)
    const fresh = new VaultStore(join(dir, 'fresh.json'), { kdf: FAST })
    const bundle = parseBundle(raw)
    await fresh.bootstrap({ meta: bundleMeta(bundle), records: [] })
    await fresh.unlock(PASS)
    await applyBundle(fresh, bundle)
    expect(hosts(fresh).list().map((h) => h.value.name)).toEqual(['prod'])
  })

  it('can be turned off, and the choice is remembered', async () => {
    const { store, svc, backupDir } = await setup()
    expect(await svc.setEnabled(false)).toEqual({ ok: true })
    await hosts(store).put(host('quiet'))
    await new Promise((r) => setTimeout(r, 150))
    expect(await backups(backupDir)).toEqual([])
    await store.lock(); await store.unlock(PASS)
    expect(svc.status().enabled).toBe(false)
    await svc.setEnabled(true)
    await hosts(store).put(host('loud'))
    await until(async () => (await backups(backupDir)).length === 1, 'a backup once turned on again')
  })

  it('keeps only the newest ones and never touches other files', async () => {
    const { store, backupDir } = await setup({ keep: 3 })
    await svc_touch(backupDir)
    for (let i = 0; i < 6; i++) { await hosts(store).put(host('h' + i)); await until(async () => (await backups(backupDir)).length >= Math.min(i + 1, 3), 'a backup'); await new Promise((r) => setTimeout(r, 1100)) }
    await until(async () => (await backups(backupDir)).length === 3, 'pruning')
    expect(await readdir(backupDir)).toContain('my-own-notes.json')
  }, 20000)

  it('goes to the folder the person chose, and back to the default', async () => {
    const chosen = join(dir, 'elsewhere')
    const { store, svc, backupDir } = await setup({ picked: chosen })
    expect(await svc.chooseFolder()).toEqual({ ok: true })
    expect(svc.status()).toMatchObject({ dir: chosen, customDir: true })
    await hosts(store).put(host('a'))
    await until(async () => (await backups(chosen)).length === 1, 'a backup in the chosen folder')
    await store.lock(); await store.unlock(PASS)
    expect(svc.status().dir).toBe(chosen)
    await svc.resetFolder()
    expect(svc.status()).toMatchObject({ dir: backupDir, customDir: false })
  })

  it('cancelling the folder picker changes nothing; a locked vault is refused', async () => {
    const { store, svc } = await setup()
    expect(await svc.chooseFolder()).toEqual({ ok: false, error: '' })
    await store.lock()
    expect(await svc.setEnabled(false)).toMatchObject({ ok: false })
    expect(await svc.backupNow()).toMatchObject({ ok: false })
  })

  it('reports a folder it cannot write to, and recovers when it can', async () => {
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'a file, not a folder')
    const { store, svc } = await setup({ picked: blocked })
    await svc.chooseFolder()
    await hosts(store).put(host('x'))
    await until(() => svc.status().error !== undefined, 'the problem to be reported')
    expect(svc.status().error).toMatch(/sao lưu/)
    await svc.resetFolder()
    expect(await svc.backupNow()).toEqual({ ok: true })
    expect(svc.status().error).toBeUndefined()
  })

  it('a host that arrives from another device also counts', async () => {
    const { store, backupDir } = await setup()
    const other = new VaultStore(join(dir, 'other.json'), { kdf: FAST })
    await other.bootstrap({ meta: store.snapshot().meta, records: [] }); await other.unlock(PASS)
    await hosts(other).put(host('from-other'))
    await store.applyDeviceFile(JSON.stringify(other.buildDeviceFile()))
    await until(async () => (await backups(backupDir)).length === 1, 'a backup for the arrived host')
  })
})

async function svc_touch(d: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'my-own-notes.json'), '{}')
}
