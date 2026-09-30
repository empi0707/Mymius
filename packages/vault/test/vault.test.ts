import { describe, expect, it } from 'vitest'
import {
  HybridClock, MemorySecretStore, VaultAuthError, changePassphrase, compactTombstones, createVault,
  mergeRecords, open, seal, unlockWithPassphrase, unlockWithRecoveryKey, type SyncRecord
} from '../src'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 } // tests only; real defaults are much stronger

describe('vault keys', () => {
  it('unlocks with the passphrase and with the recovery key', async () => {
    const v = await createVault('correct horse', FAST)
    expect((await unlockWithPassphrase(v.meta, 'correct horse')).equals(v.dataKey)).toBe(true)
    expect(unlockWithRecoveryKey(v.meta, v.recoveryKey).equals(v.dataKey)).toBe(true)
  })

  it('rejects a wrong passphrase and a malformed or wrong recovery key', async () => {
    const v = await createVault('correct horse', FAST)
    await expect(unlockWithPassphrase(v.meta, 'wrong')).rejects.toBeInstanceOf(VaultAuthError)
    expect(() => unlockWithRecoveryKey(v.meta, 'nope')).toThrow(VaultAuthError)
    expect(() => unlockWithRecoveryKey(v.meta, '00'.repeat(32))).toThrow(VaultAuthError)
  })

  it('changing the passphrase keeps the data key, so existing records stay readable', async () => {
    const v = await createVault('old', FAST)
    const sealed = seal(v.dataKey, 'ssh-private-key', 'host-1')
    const meta2 = await changePassphrase(v.meta, v.dataKey, 'new', FAST)
    await expect(unlockWithPassphrase(meta2, 'old')).rejects.toThrow()
    const key = await unlockWithPassphrase(meta2, 'new')
    expect(open(key, sealed, 'host-1').toString()).toBe('ssh-private-key')
    expect(unlockWithRecoveryKey(meta2, v.recoveryKey).equals(v.dataKey)).toBe(true)
  })

  it('metadata contains no plaintext key material', async () => {
    const v = await createVault('pw', FAST)
    const text = JSON.stringify(v.meta)
    expect(text).not.toContain(v.dataKey.toString('hex'))
    expect(text).not.toContain(v.dataKey.toString('base64'))
    expect(text).not.toContain(v.recoveryKey)
  })
})

describe('record encryption', () => {
  const key = Buffer.alloc(32, 7)
  it('round-trips and is non-deterministic', () => {
    const a = seal(key, 'secret', 'id1')
    expect(seal(key, 'secret', 'id1')).not.toBe(a)
    expect(open(key, a, 'id1').toString()).toBe('secret')
  })
  it('detects tampering, a wrong key, and ciphertext moved to another record id', () => {
    const a = seal(key, 'secret', 'id1')
    const parts = a.split('.')
    parts[3] = Buffer.from('xx').toString('base64url')
    expect(() => open(key, parts.join('.'), 'id1')).toThrow(VaultAuthError)
    expect(() => open(Buffer.alloc(32, 8), a, 'id1')).toThrow(VaultAuthError)
    expect(() => open(key, a, 'id2')).toThrow(VaultAuthError)
  })
})

describe('HybridClock', () => {
  it('is strictly increasing even when wall time stalls or goes backwards', () => {
    let t = 1_000
    const c = new HybridClock('a', () => t)
    const seen = [c.tick(), c.tick()]
    t = 500
    seen.push(c.tick())
    expect([...seen].sort()).toEqual(seen)
    expect(new Set(seen).size).toBe(3)
  })

  it('orders a local edit after a remote timestamp from a device with a faster clock', () => {
    const fast = new HybridClock('fast', () => 9_000)
    const slow = new HybridClock('slow', () => 1_000)
    const remote = fast.tick()
    slow.receive(remote)
    expect(slow.tick() > remote).toBe(true)
  })
})

describe('mergeRecords', () => {
  const rec = (id: string, hlc: string, payload: string | null, deleted = false): SyncRecord => ({ id, hlc, deleted, payload })
  const A = [rec('h1', '001', 'a1'), rec('h2', '005', 'a2')]
  const B = [rec('h1', '003', 'b1'), rec('h3', '002', 'b3'), rec('h2', '006', null, true)]

  it('newest change per id wins, deletions included', () => {
    const m = mergeRecords(A, B)
    expect(m.map((r) => [r.id, r.payload])).toEqual([['h1', 'b1'], ['h2', null], ['h3', 'b3']])
  })

  it('converges regardless of merge order and is idempotent', () => {
    const C = [rec('h1', '004', 'c1')]
    expect(mergeRecords(A, B, C)).toEqual(mergeRecords(C, B, A))
    expect(mergeRecords(mergeRecords(A, B), C)).toEqual(mergeRecords(A, mergeRecords(B, C)))
    expect(mergeRecords(A, A)).toEqual(mergeRecords(A))
  })

  it('drops only old tombstones', () => {
    const recs = [rec('old', '000000000001000-00000-x', null, true), rec('new', '000000000009000-00000-x', null, true), rec('live', '000000000001000-00000-x', 'p')]
    expect(compactTombstones(recs, 10_000, 5_000).map((r) => r.id)).toEqual(['new', 'live'])
  })
})

describe('MemorySecretStore', () => {
  it('stores and deletes', async () => {
    const s = new MemorySecretStore()
    await s.set('k', Buffer.from('v'))
    expect((await s.get('k'))?.toString()).toBe('v')
    await s.delete('k')
    expect(await s.get('k')).toBeNull()
  })
})
