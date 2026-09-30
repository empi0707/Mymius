import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_PREFIX, MAX_SYNC_FILE_BYTES, SyncFormatError, VaultAuthError, VaultLockedError, VaultMismatchError, VaultStore,
  canonicalize, parseHostProfile, recordsFingerprint, type HostProfile
} from '../src'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-sf-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const store = (name: string) => new VaultStore(join(dir, `${name}.json`), { kdf: FAST })
const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: 'pw-' + name }, createdAt: 1, updatedAt: 1 })
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()

/** Two devices of one user: A creates the vault, B is set up from A's metadata (as a restore from the cloud does). */
async function twoDevices() {
  const a = store('a'); await a.create(PASS)
  const b = store('b')
  await b.bootstrap({ meta: a.snapshot().meta, records: [] })
  await b.unlock(PASS)
  return { a, b }
}
const tamper = (text: string, edit: (f: Record<string, any>) => void): string => {
  const f = JSON.parse(text) as Record<string, any>
  edit(f)
  return JSON.stringify(f)
}

describe('canonicalize', () => {
  it('does not depend on key order or undefined fields', () => {
    expect(canonicalize({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalize({ a: [{ x: 1, y: 2 }], b: 1, c: undefined }))
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }))
  })
})

describe('device files', () => {
  it('carry everything a device knows, and another device can apply them', async () => {
    const { a, b } = await twoDevices()
    await hosts(a).put(host('one')); await hosts(a).put(host('two'))
    const text = JSON.stringify(a.buildDeviceFile())
    expect(await b.applyDeviceFile(text)).toBe(2)
    expect(names(b)).toEqual(['one', 'two'])
    expect(await b.applyDeviceFile(text)).toBe(0) // applying again changes nothing
  })

  it('a device ignores its own file coming back', async () => {
    const { a } = await twoDevices()
    await hosts(a).put(host('one'))
    expect(await a.applyDeviceFile(JSON.stringify(a.buildDeviceFile()))).toBe(0)
  })

  it('what is published reveals no host details', async () => {
    const { a } = await twoDevices()
    await hosts(a).put(host('secret-name'))
    const text = JSON.stringify(a.buildDeviceFile())
    for (const s of ['secret-name', 'pw-secret-name', 'secret-name.example', PASS]) expect(text).not.toContain(s)
  })

  it('the fingerprint changes with the records and not with the clock', async () => {
    const { a } = await twoDevices()
    await hosts(a).put(host('one'))
    const f1 = a.recordsFingerprint()
    expect(a.buildDeviceFile(1).mac).toBe(a.buildDeviceFile(999_999).mac)
    expect(a.recordsFingerprint()).toBe(f1)
    await hosts(a).put(host('two'))
    expect(a.recordsFingerprint()).not.toBe(f1)
    expect(recordsFingerprint([])).toMatch(/^[0-9a-f]{64}$/)
  })

  describe('an attacker with write access to the cloud storage but no vault key', () => {
    it('cannot delete a host by forging a tombstone', async () => {
      const { a, b } = await twoDevices()
      const id = await hosts(a).put(host('precious'))
      await b.applyDeviceFile(JSON.stringify(a.buildDeviceFile()))
      const forged = tamper(JSON.stringify(a.buildDeviceFile()), (f) => {
        const r = f.records.find((x: { id: string }) => x.id === id)
        r.deleted = true; r.payload = null; r.hlc = '999999999999999-99999-evil'
      })
      await expect(b.applyDeviceFile(forged)).rejects.toMatchObject({ name: 'SyncFormatError', reason: 'tampered' })
      expect(names(b)).toEqual(['precious'])
    })

    it.each([
      ['a changed payload', (f: any) => { f.records[0].payload = f.records[0].payload.replace(/.$/, 'A') }],
      ['a changed record id', (f: any) => { f.records[0].id = 'host:00000000-0000-0000-0000-000000000000' }],
      ['a flipped tombstone flag and nothing else', (f: any) => { f.records[0].deleted = true }],
      ['a bumped clock stamp', (f: any) => { f.records[0].hlc = '999999999999999-00000-x' }],
      ['an added record', (f: any) => { f.records.push({ id: 'host:new', hlc: '0', deleted: false, payload: 'v1.a.b.c' }) }],
      ['a removed record', (f: any) => { f.records.pop() }],
      ['another device id', (f: any) => { f.deviceId = 'deadbeef' }],
      ['a stripped MAC', (f: any) => { f.mac = '' }],
      ['a MAC from another file', (f: any) => { f.mac = '0'.repeat(64) }]
    ])('cannot slip in %s', async (_n, edit) => {
      const { a, b } = await twoDevices()
      await hosts(a).put(host('one')); await hosts(a).put(host('two'))
      const forged = tamper(JSON.stringify(a.buildDeviceFile()), edit)
      await expect(b.applyDeviceFile(forged)).rejects.toBeInstanceOf(SyncFormatError)
      expect(names(b)).toEqual([])
    })

    it('a file made with a different vault key is refused', async () => {
      const { b } = await twoDevices()
      const other = store('other'); await other.create('some other passphrase')
      await hosts(other).put(host('intruder'))
      await expect(b.applyDeviceFile(JSON.stringify(other.buildDeviceFile()))).rejects.toMatchObject({ reason: 'tampered' })
    })
  })

  it.each([
    ['not JSON', '{ nope', 'invalid'],
    ['an array', '[]', 'invalid'],
    ['the wrong format number', JSON.stringify({ format: 2 }), 'invalid'],
    ['missing fields', JSON.stringify({ format: 1, deviceId: 'abcd1234' }), 'invalid'],
    ['a bad device id', JSON.stringify({ format: 1, deviceId: '../../x', updatedAt: 1, records: [], mac: 'aa' }), 'invalid'],
    ['a malformed record', JSON.stringify({ format: 1, deviceId: 'abcd1234', updatedAt: 1, records: [{ id: 1 }], mac: 'aa' }), 'invalid']
  ])('%s is refused as invalid', async (_n, text, reason) => {
    const { b } = await twoDevices()
    await expect(b.applyDeviceFile(text)).rejects.toMatchObject({ name: 'SyncFormatError', reason })
  })

  it('an oversized file is refused before it is parsed', async () => {
    const { b } = await twoDevices()
    await expect(b.applyDeviceFile('x'.repeat(MAX_SYNC_FILE_BYTES + 1))).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('needs the vault to be unlocked', async () => {
    const { a, b } = await twoDevices()
    const text = JSON.stringify(a.buildDeviceFile())
    await b.lock()
    await expect(b.applyDeviceFile(text)).rejects.toBeInstanceOf(VaultLockedError)
    expect(() => b.buildDeviceFile()).toThrow(VaultLockedError)
  })
})

describe('vault metadata files', () => {
  it('a new passphrase on one device reaches the other; the new one works and the old one does not', async () => {
    const { a, b } = await twoDevices()
    await a.changePassphrase('a completely new passphrase')
    expect(a.metaRev).toBe(2)
    expect(await b.applyMetaFile(JSON.stringify(a.buildMetaFile()))).toBe('adopted')
    expect(b.metaRev).toBe(2)
    const restarted = new VaultStore(join(dir, 'b.json'), { kdf: FAST })
    await expect(restarted.unlock(PASS)).rejects.toBeInstanceOf(VaultAuthError)
    await restarted.unlock('a completely new passphrase')
  })

  it('reports same / local-newer, so the caller knows whether to upload', async () => {
    const { a, b } = await twoDevices()
    const text = JSON.stringify(a.buildMetaFile())
    expect(await b.applyMetaFile(text)).toBe('same')
    await b.changePassphrase('another new passphrase')
    expect(await b.applyMetaFile(text)).toBe('local-newer')
  })

  it('cannot be replaced by a forged copy that keeps the valid check but swaps the key wrapping', async () => {
    const { a, b } = await twoDevices()
    const other = store('other'); await other.create('attacker passphrase')
    const forged = tamper(JSON.stringify(a.buildMetaFile()), (f) => {
      f.meta.wrappedByPassphrase = other.snapshot().meta.wrappedByPassphrase // would lock the user out
      f.meta.rev = 99
    })
    await expect(b.applyMetaFile(forged)).rejects.toMatchObject({ reason: 'tampered' })
    expect(b.metaRev).toBe(1)
    await new VaultStore(join(dir, 'b.json'), { kdf: FAST }).unlock(PASS) // still opens with the real passphrase
  })

  it('metadata of a different vault is reported as a different vault, not as tampering', async () => {
    const { b } = await twoDevices()
    const other = store('other'); await other.create('some other passphrase')
    await expect(b.applyMetaFile(JSON.stringify(other.buildMetaFile()))).rejects.toBeInstanceOf(VaultMismatchError)
  })

  it('a device with no vault can be set up from the metadata alone, and only reads records after it unlocks', async () => {
    const a = store('a'); await a.create(PASS)
    await hosts(a).put(host('one'))
    const b = store('b')
    await b.bootstrap({ meta: a.snapshot().meta, records: [] })
    expect(await b.state()).toBe('locked')
    await expect(new VaultStore(join(dir, 'b.json'), { kdf: FAST }).unlock('wrong one')).rejects.toBeInstanceOf(VaultAuthError)
    await b.unlock(PASS)
    expect(names(b)).toEqual([])
    await b.applyDeviceFile(JSON.stringify(a.buildDeviceFile()))
    expect(names(b)).toEqual(['one'])
    expect(b.deviceId).not.toBe(a.deviceId)
  })

  it('a vault file from before revisions existed loads as revision 1', async () => {
    const a = store('a'); await a.create(PASS)
    const path = join(dir, 'a.json')
    const raw = JSON.parse(await readFile(path, 'utf8'))
    delete raw.meta.rev
    await writeFile(path, JSON.stringify(raw))
    const reopened = new VaultStore(path, { kdf: FAST }); await reopened.unlock(PASS)
    expect(reopened.metaRev).toBe(1)
  })

  it('applyRemote-style mismatch is still detected for bootstrap-less merges', async () => {
    const { a } = await twoDevices()
    const other = store('other'); await other.create('some other passphrase')
    await expect(a.applyRemote(other.snapshot())).rejects.toBeInstanceOf(VaultMismatchError)
  })
})

describe('the device-local area', () => {
  it('keeps values sealed on disk, across restarts, readable only when unlocked', async () => {
    const a = store('a'); await a.create(PASS)
    await a.setLocal('drive-token', 'refresh-token-abc123')
    expect(a.getLocal('drive-token')).toBe('refresh-token-abc123')
    expect(await readFile(join(dir, 'a.json'), 'utf8')).not.toContain('refresh-token-abc123')
    const b = new VaultStore(join(dir, 'a.json'), { kdf: FAST })
    await b.unlock(PASS)
    expect(b.getLocal('drive-token')).toBe('refresh-token-abc123')
    expect(b.getLocal('missing')).toBeUndefined()
    await b.lock()
    expect(() => b.getLocal('drive-token')).toThrow(VaultLockedError)
    await expect(b.setLocal('x', 'y')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('never leaves the device: not in snapshots or published files, and does not trigger a sync', async () => {
    const { a, b } = await twoDevices()
    let changed = 0
    a.on('changed', () => changed++)
    await a.setLocal('drive-token', 'refresh-token-abc123')
    await a.deleteLocal('nothing-here')
    expect(changed).toBe(0)
    expect(JSON.stringify(a.snapshot())).not.toContain('local')
    expect(JSON.stringify(a.buildDeviceFile())).not.toContain('refresh-token')
    await b.applyDeviceFile(JSON.stringify(a.buildDeviceFile()))
    expect(b.getLocal('drive-token')).toBeUndefined()
  })

  it('can be deleted, and a value cannot be moved to another name', async () => {
    const a = store('a'); await a.create(PASS)
    await a.setLocal('one', 'secret-one'); await a.setLocal('two', 'secret-two')
    const path = join(dir, 'a.json')
    const raw = JSON.parse(await readFile(path, 'utf8'))
    raw.local.two = raw.local.one // copy one sealed value over another
    await writeFile(path, JSON.stringify(raw))
    const b = new VaultStore(path, { kdf: FAST }); await b.unlock(PASS)
    expect(b.getLocal('two')).toBeUndefined()
    await b.deleteLocal('one')
    expect(b.getLocal('one')).toBeUndefined()
  })
})
