import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_PREFIX, KEY_PREFIX, MemorySecretStore, VaultAuthError, VaultCorruptError, VaultLockedError, VaultMismatchError,
  VaultStore, WeakPassphraseError, applyHostInput, parseHostProfile, parseKeyRecord, summarizeHost, wouldCreateJumpCycle,
  type HostInput, type HostProfile, type VaultStoreOptions
} from '../src'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'correct horse battery'
let dir: string
let file: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-vault-')); file = join(dir, 'vault.json') })
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

const store = (opts: VaultStoreOptions = {}, path = file) => new VaultStore(path, { kdf: FAST, ...opts })
const host = (over: Partial<HostProfile> = {}): HostProfile => ({
  name: 'prod-db-zeta', host: 'db.internal.example', port: 22, username: 'deploy-svc',
  auth: { type: 'password', password: 'hunter2-secret' }, createdAt: 1, updatedAt: 1, ...over
})
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)

describe('lifecycle', () => {
  it('uninitialized -> unlocked on create, locked in a fresh instance, unlocked by the passphrase', async () => {
    const a = store()
    expect(await a.state()).toBe('uninitialized')
    await a.create(PASS)
    expect(await a.state()).toBe('unlocked')
    const b = store()
    expect(await b.state()).toBe('locked')
    await b.unlock(PASS)
    expect(await b.state()).toBe('unlocked')
  })

  it('a wrong passphrase is refused and leaves it locked', async () => {
    await store().create(PASS)
    const b = store()
    await expect(b.unlock('not the passphrase')).rejects.toBeInstanceOf(VaultAuthError)
    expect(await b.state()).toBe('locked')
  })

  it('the recovery key opens it when the passphrase is forgotten', async () => {
    const { recoveryKey } = await store().create(PASS)
    const b = store()
    await b.unlockWithRecoveryKey(recoveryKey)
    expect(await b.state()).toBe('unlocked')
    await expect(store().unlockWithRecoveryKey('0'.repeat(64))).rejects.toBeInstanceOf(VaultAuthError)
  })

  it('refuses a short passphrase and creates nothing', async () => {
    await expect(store().create('short')).rejects.toBeInstanceOf(WeakPassphraseError)
    await expect(stat(file)).rejects.toThrow()
  })

  it('will not overwrite an existing vault', async () => {
    const a = store()
    await a.create(PASS)
    await expect(store().create('another long passphrase')).rejects.toThrow(/already exists/)
  })

  it('the vault file is private to the user', async () => {
    await store().create(PASS)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('emits state changes', async () => {
    const s = store(); const seen: string[] = []
    s.on('state', (x) => seen.push(x))
    await s.create(PASS); await s.lock(); await s.unlock(PASS)
    expect(seen).toEqual(['unlocked', 'locked', 'unlocked'])
  })
})

describe('data', () => {
  it('stores, lists, updates and deletes hosts, and it all survives a restart', async () => {
    const a = store(); await a.create(PASS)
    const id = await hosts(a).put(host())
    expect(id.startsWith(HOST_PREFIX)).toBe(true)
    await hosts(a).put(host({ name: 'renamed' }), id) // update keeps the id
    const id2 = await hosts(a).put(host({ name: 'second' }))
    await hosts(a).remove(id2)

    const b = store(); await b.unlock(PASS)
    expect(hosts(b).list().map((h) => [h.id, h.value.name])).toEqual([[id, 'renamed']])
    expect(hosts(b).get(id)?.auth).toEqual({ type: 'password', password: 'hunter2-secret' })
    expect(hosts(b).get(id2)).toBeUndefined()
  })

  it('nothing sensitive is readable in the file on disk', async () => {
    const a = store(); await a.create(PASS)
    await hosts(a).put(host({ notes: 'the crown jewels', group: 'ProdGroupX' }))
    await a.collection(KEY_PREFIX, parseKeyRecord).put({ name: 'my-laptop-key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA-SECRET-KEY-BODY\n-----END OPENSSH PRIVATE KEY-----', createdAt: 1 })
    const text = await readFile(file, 'utf8')
    for (const secret of ['prod-db-zeta', 'db.internal.example', 'deploy-svc', 'hunter2', 'crown jewels', 'ProdGroupX', 'my-laptop-key', 'SECRET-KEY-BODY', 'BEGIN OPENSSH', PASS]) {
      expect(text).not.toContain(secret)
    }
  })

  it('hosts and keys live in separate collections', async () => {
    const a = store(); await a.create(PASS)
    await hosts(a).put(host())
    expect(a.collection(KEY_PREFIX, parseKeyRecord).list()).toEqual([])
    await expect(hosts(a).put(host(), 'key:abc')).rejects.toThrow(/Wrong kind/)
  })

  it('refuses to store an invalid record', async () => {
    const a = store(); await a.create(PASS)
    await expect(hosts(a).put(host({ host: '-oProxyCommand=x' }))).rejects.toThrow()
    await expect(hosts(a).put(host({ port: 99999 }))).rejects.toThrow()
    expect(hosts(a).list()).toEqual([])
  })

  it('everything requires the vault to be unlocked', async () => {
    const a = store(); await a.create(PASS)
    await hosts(a).put(host())
    await a.lock()
    expect(() => hosts(a).list()).toThrow(VaultLockedError)
    expect(() => hosts(a).get('host:x')).toThrow(VaultLockedError)
    await expect(hosts(a).put(host())).rejects.toBeInstanceOf(VaultLockedError)
    await expect(hosts(a).remove('host:x')).rejects.toBeInstanceOf(VaultLockedError)
    await expect(a.changePassphrase('a whole new passphrase')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('20 concurrent writes are all kept', async () => {
    const a = store(); await a.create(PASS)
    await Promise.all(Array.from({ length: 20 }, (_, i) => hosts(a).put(host({ name: `h${i}` }))))
    const b = store(); await b.unlock(PASS)
    expect(hosts(b).list()).toHaveLength(20)
  })

  it('a tampered record is skipped, not fatal, and a payload moved to another id is rejected', async () => {
    const a = store(); await a.create(PASS)
    const good = await hosts(a).put(host({ name: 'good' }))
    const victim = await hosts(a).put(host({ name: 'victim' }))
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const g = raw.records.find((r: { id: string }) => r.id === good)
    const v = raw.records.find((r: { id: string }) => r.id === victim)
    v.payload = g.payload // copy one record's ciphertext onto another id
    await writeFile(file, JSON.stringify(raw))
    const b = store(); await b.unlock(PASS)
    expect(hosts(b).list().map((h) => h.value.name)).toEqual(['good'])
  })

  it('a record that decrypts but is not a valid host is skipped', async () => {
    const a = store(); await a.create(PASS)
    await a.collection(HOST_PREFIX, (x) => x).put({ nonsense: true })
    await hosts(a).put(host())
    expect(hosts(a).list()).toHaveLength(1)
  })

  it('changing the passphrase keeps all data and the recovery key', async () => {
    const a = store(); const { recoveryKey } = await a.create(PASS)
    await hosts(a).put(host())
    await a.changePassphrase('a brand new passphrase')
    const b = store()
    await expect(b.unlock(PASS)).rejects.toBeInstanceOf(VaultAuthError)
    await b.unlock('a brand new passphrase')
    expect(hosts(b).list()).toHaveLength(1)
    await expect(a.changePassphrase('short')).rejects.toBeInstanceOf(WeakPassphraseError)
    const c = store(); await c.unlockWithRecoveryKey(recoveryKey)
    expect(hosts(c).list()).toHaveLength(1)
  })
})

describe('damaged files', () => {
  it.each([
    ['not JSON', '{ nope'],
    ['unknown format', JSON.stringify({ format: 9 })],
    ['missing fields', JSON.stringify({ format: 1, deviceId: 'x' })],
    ['a bad record', JSON.stringify({ format: 1, deviceId: 'x', meta: { check: 'c' }, records: [{ id: 1 }] })]
  ])('%s: refuses to open and does not touch the file', async (_n, content) => {
    await writeFile(file, content)
    const s = store()
    await expect(s.state()).rejects.toBeInstanceOf(VaultCorruptError)
    await expect(s.create(PASS)).rejects.toBeInstanceOf(VaultCorruptError) // must not "start fresh" over it
    expect(await readFile(file, 'utf8')).toBe(content)
  })
})

describe('remember on this device', () => {
  it('a remembered vault opens without the passphrase in a new instance', async () => {
    const secrets = new MemorySecretStore()
    const a = store({ secrets }); await a.create(PASS, { remember: true })
    await hosts(a).put(host())
    const b = store({ secrets })
    expect(await b.state()).toBe('locked')
    expect(await b.tryAutoUnlock()).toBe(true)
    expect(hosts(b).list()).toHaveLength(1)
  })

  it('is off unless asked for, and unavailable without a keychain', async () => {
    const secrets = new MemorySecretStore()
    await store({ secrets }).create(PASS)
    expect(await store({ secrets }).tryAutoUnlock()).toBe(false)
    expect(store().canRemember).toBe(false)
    expect(await store().tryAutoUnlock()).toBe(false)
  })

  it('locking forgets the device, so the passphrase is needed again', async () => {
    const secrets = new MemorySecretStore()
    const a = store({ secrets }); await a.create(PASS, { remember: true })
    await a.lock()
    expect(await store({ secrets }).tryAutoUnlock()).toBe(false)
  })

  it('a cached key that no longer fits (vault was replaced) is discarded, not trusted', async () => {
    const secrets = new MemorySecretStore()
    await store({ secrets }).create(PASS, { remember: true })
    await rm(file)
    await store({ secrets }).create('a different passphrase!') // new vault, new data key
    const b = store({ secrets })
    expect(await b.tryAutoUnlock()).toBe(false)
    expect(await secrets.get('vault-data-key')).toBeNull()
  })
})

describe('auto-lock', () => {
  it('locks after idling, and any use postpones it', async () => {
    vi.useFakeTimers()
    const s = store({ autoLockMs: 1000 }); await s.create(PASS)
    await vi.advanceTimersByTimeAsync(800)
    hosts(s).list() // activity
    await vi.advanceTimersByTimeAsync(800)
    expect(await s.state()).toBe('unlocked')
    await vi.advanceTimersByTimeAsync(400)
    expect(await s.state()).toBe('locked')
  })

  it('does not lock while the key is remembered on the device', async () => {
    vi.useFakeTimers()
    const s = store({ autoLockMs: 1000, secrets: new MemorySecretStore() }); await s.create(PASS, { remember: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await s.state()).toBe('unlocked')
  })
})

describe('syncing between devices', () => {
  const device = async (n: string) => store({}, join(dir, `${n}.json`))
  const setup = async () => {
    const a = await device('a'); await a.create(PASS)
    const id = await hosts(a).put(host({ name: 'shared' }))
    const b = await device('b')
    await b.bootstrap(a.snapshot())
    await b.unlock(PASS)
    return { a, b, id }
  }

  it('a second device bootstraps from the first and reads its data with the same passphrase', async () => {
    const { b } = await setup()
    expect(hosts(b).list().map((h) => h.value.name)).toEqual(['shared'])
  })

  it('changes flow both ways and converge', async () => {
    const { a, b, id } = await setup()
    await hosts(b).put(host({ name: 'from-b' }))
    await hosts(a).put(host({ name: 'from-a' }))
    expect(await a.applyRemote(b.snapshot())).toBeGreaterThan(0)
    expect(await b.applyRemote(a.snapshot())).toBeGreaterThan(0)
    const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()
    expect(names(a)).toEqual(['from-a', 'from-b', 'shared'])
    expect(names(b)).toEqual(names(a))
    expect(await a.applyRemote(b.snapshot())).toBe(0) // nothing new: idempotent
    void id
  })

  it('a deletion on one device removes the host on the other', async () => {
    const { a, b, id } = await setup()
    await hosts(a).remove(id)
    await b.applyRemote(a.snapshot())
    expect(hosts(b).list()).toEqual([])
  })

  it('the later edit of the same host wins on both', async () => {
    const { a, b, id } = await setup()
    await hosts(a).put(host({ name: 'edited on a' }), id)
    await new Promise((r) => setTimeout(r, 5))
    await hosts(b).put(host({ name: 'edited on b later' }), id)
    await a.applyRemote(b.snapshot()); await b.applyRemote(a.snapshot())
    expect(hosts(a).get(id)?.name).toBe('edited on b later')
    expect(hosts(b).get(id)?.name).toBe('edited on b later')
  })

  it('an edit made after receiving remote data is never overridden by it (clock catches up)', async () => {
    const { a, b, id } = await setup()
    await hosts(b).put(host({ name: 'b1' }), id)
    await a.applyRemote(b.snapshot())
    await hosts(a).put(host({ name: 'a-after-b' }), id)
    await b.applyRemote(a.snapshot())
    expect(hosts(b).get(id)?.name).toBe('a-after-b')
  })

  it('refuses records from a different vault, changing nothing', async () => {
    const { a } = await setup()
    const other = store({}, join(dir, 'other.json')); await other.create('some other passphrase')
    await hosts(other).put(host({ name: 'intruder' }))
    await expect(a.applyRemote(other.snapshot())).rejects.toBeInstanceOf(VaultMismatchError)
    expect(hosts(a).list().map((h) => h.value.name)).toEqual(['shared'])
  })

  it('bootstrap will not replace an existing vault', async () => {
    const { a, b } = await setup()
    await expect(b.bootstrap(a.snapshot())).rejects.toThrow(/already exists/)
  })
})

describe('host profiles', () => {
  const input = (over: Partial<HostInput> = {}): HostInput => ({ name: 'n', host: 'h.example', port: 22, username: 'u', auth: { type: 'password', password: 'pw' }, ...over })

  it('rejects malformed hosts', () => {
    for (const bad of [
      host({ host: '' }), host({ host: 'a b' }), host({ host: '-x' }), host({ port: 0 }), host({ port: 22.5 }),
      host({ username: '' }), host({ name: '' }), host({ notes: 'x'.repeat(6000) }), host({ group: 'a\nb' }),
      host({ auth: { type: 'telepathy' } as never }), host({ auth: { type: 'key', keyId: '' } })
    ]) expect(() => parseHostProfile(bad)).toThrow()
  })

  it('a blank name falls back to the host, and fields are trimmed', () => {
    expect(parseHostProfile({ ...host(), name: '   ', host: ' h.example ' }).name).toBe('h.example')
    expect(parseHostProfile({ ...host(), host: ' h.example ' }).host).toBe('h.example')
  })

  it('editing without retyping the password keeps the stored one', () => {
    const stored = parseHostProfile(host())
    const edited = applyHostInput(stored, input({ name: 'renamed', auth: { type: 'password' } }), 5)
    expect(edited.auth).toEqual({ type: 'password', password: 'hunter2-secret' })
    expect(edited.name).toBe('renamed')
    expect(edited.createdAt).toBe(stored.createdAt)
    expect(edited.updatedAt).toBe(5)
  })

  it('a new password replaces the old one; switching to password auth requires one', () => {
    const stored = parseHostProfile(host())
    expect(applyHostInput(stored, input({ auth: { type: 'password', password: 'new' } })).auth).toEqual({ type: 'password', password: 'new' })
    const agentHost = parseHostProfile(host({ auth: { type: 'agent' } }))
    expect(() => applyHostInput(agentHost, input({ auth: { type: 'password' } }))).toThrow(/password/i)
    expect(() => applyHostInput(undefined, input({ auth: { type: 'password', password: '' } }))).toThrow()
  })

  it('key-file passphrase: kept when omitted for the same file, dropped when the file changes or it is cleared', () => {
    const stored = parseHostProfile(host({ auth: { type: 'keyFile', path: '/k', passphrase: 'pp' } }))
    expect(applyHostInput(stored, input({ auth: { type: 'keyFile', path: '/k' } })).auth).toEqual({ type: 'keyFile', path: '/k', passphrase: 'pp' })
    expect(applyHostInput(stored, input({ auth: { type: 'keyFile', path: '/other' } })).auth).toEqual({ type: 'keyFile', path: '/other' })
    expect(applyHostInput(stored, input({ auth: { type: 'keyFile', path: '/k', passphrase: '' } })).auth).toEqual({ type: 'keyFile', path: '/k' })
  })

  it('the summary given to the UI carries no secret', () => {
    const json = JSON.stringify(summarizeHost('host:1', parseHostProfile(host({ auth: { type: 'keyFile', path: '/k', passphrase: 'pp-secret' } }))))
    expect(json).not.toContain('pp-secret')
    expect(JSON.stringify(summarizeHost('host:1', parseHostProfile(host())))).not.toContain('hunter2')
    expect(JSON.parse(json)).toMatchObject({ authType: 'keyFile', name: 'prod-db-zeta' })
  })

  it('detects jump-host loops', () => {
    const map: Record<string, string | undefined> = { a: 'b', b: 'c', c: undefined }
    const jumpOf = (id: string) => map[id]
    expect(wouldCreateJumpCycle(jumpOf, 'c', 'a')).toBe(true) // c -> a -> b -> c
    expect(wouldCreateJumpCycle(jumpOf, 'x', 'a')).toBe(false)
    expect(wouldCreateJumpCycle(jumpOf, 'a', 'a')).toBe(true)
    expect(wouldCreateJumpCycle(jumpOf, 'a', undefined)).toBe(false)
  })
})
