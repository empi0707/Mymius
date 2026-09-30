import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_PREFIX, MAX_BUNDLE_DEVICES, SyncFormatError, VaultMismatchError, VaultStore,
  applyBundle, buildBundle, bundleMeta, ownFingerprint, parseBundle, parseHostProfile, type HostProfile
} from '../src'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-bd-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const store = (name: string) => new VaultStore(join(dir, `${name}.json`), { kdf: FAST })
const host = (name: string): HostProfile => ({ name, host: `${name}.example`, port: 22, username: 'u', auth: { type: 'password', password: 'pw-' + name }, createdAt: 1, updatedAt: 1 })
const hosts = (s: VaultStore) => s.collection(HOST_PREFIX, parseHostProfile)
const names = (s: VaultStore) => hosts(s).list().map((h) => h.value.name).sort()
const text = (b: unknown) => JSON.stringify(b)

async function pair() {
  const a = store('a'); await a.create(PASS)
  const b = store('b')
  await b.bootstrap({ meta: a.snapshot().meta, records: [] })
  await b.unlock(PASS)
  return { a, b }
}

describe('sync bundle', () => {
  it('carries hosts between two devices, in both directions, through one file', async () => {
    const { a, b } = await pair()
    await hosts(a).put(host('from-a'))
    let file = buildBundle(a)
    await applyBundle(b, parseBundle(text(file)))
    expect(names(b)).toEqual(['from-a'])
    await hosts(b).put(host('from-b'))
    file = buildBundle(b, parseBundle(text(file)))
    expect(file.devices).toHaveLength(2)
    await applyBundle(a, parseBundle(text(file)))
    expect(names(a)).toEqual(['from-a', 'from-b'])
  })

  it('writing keeps what other devices put there', async () => {
    const { a, b } = await pair()
    await hosts(b).put(host('b-only'))
    const fromB = buildBundle(b)
    const merged = buildBundle(a, fromB) // a writes without having merged b
    expect(merged.devices.map((d) => d.deviceId).sort()).toEqual([a.deviceId, b.deviceId].sort())
  })

  it('a device restored from a file gets the vault from its metadata, then merges the rest once unlocked', async () => {
    const a = store('a'); await a.create(PASS)
    await hosts(a).put(host('kept'))
    const file = parseBundle(text(buildBundle(a)))
    const fresh = store('fresh')
    await fresh.bootstrap({ meta: bundleMeta(file), records: [] })
    await expect(fresh.unlock('wrong passphrase!')).rejects.toThrow()
    await fresh.unlock(PASS)
    const r = await applyBundle(fresh, file)
    expect(r).toMatchObject({ devices: 1, ignored: 0 })
    expect(names(fresh)).toEqual(['kept'])
  })

  it('refuses another vault, and a forged copy is skipped and not carried forward', async () => {
    const { a, b } = await pair()
    const other = store('other'); await other.create(PASS)
    await hosts(other).put(host('not-yours'))
    await expect(applyBundle(a, parseBundle(text(buildBundle(other))))).rejects.toBeInstanceOf(VaultMismatchError)

    await hosts(b).put(host('real'))
    const file = buildBundle(b)
    const forged = structuredClone(file)
    forged.devices[0]!.records[0]!.deleted = true // flip a flag without the key
    const r = await applyBundle(a, parseBundle(text(forged)))
    expect(r).toMatchObject({ ignored: 1, changed: 0 })
    expect(names(a)).toEqual([])
    expect(buildBundle(a, forged).devices.map((d) => d.deviceId)).toEqual([a.deviceId])
  })

  it('a tampered metadata block is refused', async () => {
    const { a, b } = await pair()
    const file = buildBundle(b)
    file.meta.meta.rev = 99
    await expect(applyBundle(a, parseBundle(text(file)))).rejects.toBeInstanceOf(SyncFormatError)
  })

  it('rejects things that are not sync files', () => {
    for (const bad of ['', '[]', '{}', 'not json', text({ kind: 'other', version: 1 }), text({ kind: 'mymius-sync-bundle', version: 2 })]) {
      expect(() => parseBundle(bad)).toThrow(SyncFormatError)
    }
  })

  it('reports whether its own entry is current, and keeps only a few other devices', async () => {
    const { a } = await pair()
    const file = buildBundle(a)
    expect(ownFingerprint(file, a.deviceId)).toBe(a.recordsFingerprint())
    await hosts(a).put(host('x'))
    expect(ownFingerprint(file, a.deviceId)).not.toBe(a.recordsFingerprint())
    const crowd = buildBundle(a)
    const peers = Array.from({ length: MAX_BUNDLE_DEVICES + 5 }, async (_, i) => {
      const p = store('p' + i)
      await p.bootstrap({ meta: a.snapshot().meta, records: [] }); await p.unlock(PASS)
      return p.buildDeviceFile(1000 + i)
    })
    crowd.devices.push(...(await Promise.all(peers)))
    expect(buildBundle(a, crowd).devices).toHaveLength(1 + MAX_BUNDLE_DEVICES)
  })
})
