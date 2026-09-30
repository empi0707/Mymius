import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { utils } from 'ssh2'
import { VaultStore } from '@mymius/vault'
import { generateEd25519 } from '@mymius/ssh/testing'
import { VaultService, type Result } from '../src/main/vault-service'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let dir: string
let agent: string | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-vs-')); agent = '/tmp/agent.sock' })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const make = async (unlock = true) => {
  const store = new VaultStore(join(dir, 'vault.json'), { kdf: FAST })
  const svc = new VaultService(store, { readTextFile: (p) => readFile(p, 'utf8'), agentSocket: () => agent })
  if (unlock) await svc.create(PASS, false)
  return svc
}
const ok = <T extends object>(r: Result<T>): Extract<Result<T>, { ok: true }> => {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`)
  return r
}
const err = (r: Result<object>): string => {
  if (r.ok) throw new Error('expected a failure')
  return r.error
}
const base = { name: 'web', host: 'web.example', port: 22, username: 'deploy' }
const pw = (password?: string) => ({ ...base, auth: { type: 'password' as const, ...(password !== undefined ? { password } : {}) } })
const keyFile = async (name = 'id_test') => {
  const p = join(dir, name)
  await writeFile(p, generateEd25519().private)
  return p
}

describe('hosts', () => {
  it('saves a host; the UI list carries no secret; the main process can still resolve the password', async () => {
    const svc = await make()
    const { id } = ok(await svc.saveHost(undefined, pw('hunter2-secret')))
    const listed = ok(svc.listHosts()).hosts
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('hunter2')
    expect(listed[0]).toMatchObject({ id, name: 'web', authType: 'password' })
    expect((await svc.lookup.resolve(id)).auth).toEqual({ type: 'password', password: 'hunter2-secret' })
  })

  it('editing without retyping the password keeps it', async () => {
    const svc = await make()
    const { id } = ok(await svc.saveHost(undefined, pw('keep-me')))
    ok(await svc.saveHost(id, { ...pw(), name: 'renamed', port: 2200 }))
    const r = await svc.lookup.resolve(id)
    expect(r).toMatchObject({ name: 'renamed', port: 2200, auth: { password: 'keep-me' } })
  })

  it('rejects invalid input without throwing', async () => {
    const svc = await make()
    for (const bad of [null, 'x', 42, {}, { ...base, auth: undefined }, { ...pw('x'), host: '-oProxyCommand=evil' }, { ...pw('x'), port: 70000 }]) {
      expect(err(await svc.saveHost(undefined, bad))).toBeTruthy()
    }
    for (const badId of [42, 'key:abc', {}]) expect(err(await svc.saveHost(badId, pw('x')))).toBeTruthy()
    expect(err(await svc.saveHost('host:00000000-0000-0000-0000-000000000000', pw('x')))).toMatch(/không còn tồn tại/)
    expect(ok(svc.listHosts()).hosts).toEqual([])
  })

  it('jump hosts: must exist, cannot loop, and cannot be deleted while in use', async () => {
    const svc = await make()
    const a = ok(await svc.saveHost(undefined, { ...pw('a'), name: 'a' })).id
    const b = ok(await svc.saveHost(undefined, { ...pw('b'), name: 'b', jumpHostId: a })).id
    expect(err(await svc.saveHost(undefined, { ...pw('c'), jumpHostId: 'host:nope' }))).toMatch(/không còn tồn tại/)
    expect(err(await svc.saveHost(a, { ...pw(), name: 'a', jumpHostId: b }))).toMatch(/vòng lặp/)
    expect(err(await svc.saveHost(a, { ...pw(), name: 'a', jumpHostId: a }))).toMatch(/vòng lặp/)
    expect(err(await svc.deleteHost(a))).toMatch(/Đang được dùng làm jump host bởi: b/)
    ok(await svc.deleteHost(b))
    ok(await svc.deleteHost(a))
    expect(ok(svc.listHosts()).hosts).toEqual([])
  })

  it('a key-file host reads the file when connecting, not when saving', async () => {
    const svc = await make()
    const path = join(dir, 'later')
    const { id } = ok(await svc.saveHost(undefined, { ...base, auth: { type: 'keyFile', path, passphrase: 'pp' } }))
    await expect(svc.lookup.resolve(id)).rejects.toThrow(/Không đọc được file khóa/)
    const k = generateEd25519().private
    await writeFile(path, k)
    expect((await svc.lookup.resolve(id)).auth).toEqual({ type: 'key', privateKey: k, passphrase: 'pp' })
  })

  it('ssh-agent hosts need an agent to be running', async () => {
    const svc = await make()
    const { id } = ok(await svc.saveHost(undefined, { ...base, auth: { type: 'agent' } }))
    expect((await svc.lookup.resolve(id)).auth).toEqual({ type: 'agent', socket: '/tmp/agent.sock' })
    agent = undefined
    await expect(svc.lookup.resolve(id)).rejects.toThrow(/Không tìm thấy ssh-agent/)
  })

  it('resolving an unknown or foreign id fails cleanly', async () => {
    const svc = await make()
    await expect(svc.lookup.resolve('host:gone')).rejects.toThrow(/không còn tồn tại/)
    await expect(svc.lookup.resolve('key:whatever')).rejects.toThrow()
  })
})

describe('keys', () => {
  it('imports a key file into the vault; the UI sees a name and fingerprint, never the key', async () => {
    const svc = await make()
    const { key } = ok(await svc.importKey(await keyFile(), 'laptop', ''))
    expect(key).toMatchObject({ name: 'laptop', hasPassphrase: false })
    expect(key.fingerprint).toMatch(/^SHA256:/)
    const json = JSON.stringify(ok(svc.listKeys()))
    expect(json).not.toContain('PRIVATE KEY')
    expect(json).not.toContain('AAAA')
  })

  it('a host that uses a vault key gets the key material at connect time, and the key stays while in use', async () => {
    const svc = await make()
    const path = await keyFile()
    const keyText = await readFile(path, 'utf8')
    const { key } = ok(await svc.importKey(path, 'k', ''))
    const { id } = ok(await svc.saveHost(undefined, { ...base, auth: { type: 'key', keyId: key.id } }))
    expect((await svc.lookup.resolve(id)).auth).toEqual({ type: 'key', privateKey: keyText })
    expect(ok(svc.listHosts()).hosts[0]).toMatchObject({ authType: 'key', keyName: 'k' })
    expect(err(await svc.deleteKey(key.id))).toMatch(/Vẫn đang được dùng bởi: web/)
    ok(await svc.deleteHost(id))
    ok(await svc.deleteKey(key.id))
    expect(ok(svc.listKeys()).keys).toEqual([])
  })

  it('refuses to save a host that points at a key that does not exist', async () => {
    const svc = await make()
    expect(err(await svc.saveHost(undefined, { ...base, auth: { type: 'key', keyId: 'key:nope' } }))).toMatch(/không còn tồn tại/)
  })

  it('an encrypted key needs its passphrase, is checked immediately, and the passphrase is stored with it', async () => {
    const svc = await make()
    let k: { private: string } | undefined
    for (let i = 0; i < 20 && !k; i++) {
      const c = utils.generateKeyPairSync('ed25519', { passphrase: 'open-sesame', cipher: 'aes256-ctr', rounds: 16 })
      if (!(utils.parseKey(c.private, 'open-sesame') instanceof Error)) k = c
    }
    const p = join(dir, 'enc'); await writeFile(p, k!.private)
    expect(err(await svc.importKey(p, 'enc', ''))).toMatch(/passphrase/i)
    expect(err(await svc.importKey(p, 'enc', 'wrong'))).toMatch(/Sai passphrase/)
    const { key } = ok(await svc.importKey(p, 'enc', 'open-sesame'))
    expect(key.hasPassphrase).toBe(true)
    expect(JSON.stringify(ok(svc.listKeys()))).not.toContain('open-sesame')
    const { id } = ok(await svc.saveHost(undefined, { ...base, auth: { type: 'key', keyId: key.id } }))
    expect((await svc.lookup.resolve(id)).auth).toMatchObject({ type: 'key', passphrase: 'open-sesame' })
  })

  it('rejects things that are not private keys, and unreadable paths', async () => {
    const svc = await make()
    const junk = join(dir, 'junk'); await writeFile(junk, 'this is a secret note, not a key')
    const pub = join(dir, 'pub'); await writeFile(pub, generateEd25519().public)
    expect(err(await svc.importKey(junk, 'x', ''))).toMatch(/không phải file khóa riêng tư hợp lệ/)
    expect(err(await svc.importKey(pub, 'x', ''))).toMatch(/khóa công khai/)
    expect(err(await svc.importKey(join(dir, 'missing'), 'x', ''))).toMatch(/Không đọc được/)
    expect(err(await svc.importKey(42, 'x', ''))).toBeTruthy()
    expect(err(await svc.importKey('', 'x', ''))).toBeTruthy()
    expect(ok(svc.listKeys()).keys).toEqual([])
  })

  it('an error from a bad file never echoes the file\'s content back', async () => {
    const svc = await make()
    const junk = join(dir, 'junk'); await writeFile(junk, 'TOP-SECRET-CONTENT-12345')
    expect(err(await svc.importKey(junk, 'x', ''))).not.toContain('TOP-SECRET')
  })

  it('defaults the name to the file name', async () => {
    const svc = await make()
    expect(ok(await svc.importKey(await keyFile('my_key'), '  ', '')).key.name).toBe('my_key')
  })
})

describe('locked and damaged', () => {
  it('everything says the vault is locked; the state is reported; secrets are not reachable', async () => {
    const svc = await make()
    const { id } = ok(await svc.saveHost(undefined, pw('x')))
    await svc.lock()
    expect((await svc.status()).state).toBe('locked')
    expect(err(svc.listHosts())).toMatch(/đang khóa/)
    expect(err(svc.listKeys())).toMatch(/đang khóa/)
    expect(err(await svc.saveHost(undefined, pw('x')))).toMatch(/đang khóa/)
    expect(err(await svc.deleteHost(id))).toMatch(/đang khóa/)
    await expect(svc.lookup.resolve(id)).rejects.toThrow(/đang khóa/)
  })

  it('unlock: wrong passphrase, right passphrase, recovery key, and a non-string is refused', async () => {
    const svc = await make()
    await svc.lock()
    expect(err(await svc.unlock('nope nope nope', false))).toBe('Sai passphrase')
    expect(err(await svc.unlock(123, false))).toBeTruthy()
    ok(await svc.unlock(PASS, false))
    expect((await svc.status()).state).toBe('unlocked')
  })

  it('recovery key opens it', async () => {
    const store = new VaultStore(join(dir, 'v2.json'), { kdf: FAST })
    const svc = new VaultService(store, { readTextFile: async () => '', agentSocket: () => undefined })
    const { recoveryKey } = ok(await svc.create(PASS, false))
    await svc.lock()
    expect(err(await svc.unlockWithRecovery('0'.repeat(64), false))).toBe('Sai passphrase')
    ok(await svc.unlockWithRecovery(recoveryKey, false))
  })

  it('a weak passphrase is explained', async () => {
    const svc = await make(false)
    expect(err(await svc.create('short', false))).toMatch(/ít nhất 10/)
    expect((await svc.status()).state).toBe('uninitialized')
  })

  it('a damaged vault file is reported, not overwritten', async () => {
    await writeFile(join(dir, 'vault.json'), '{ broken')
    const svc = await make(false)
    const st = await svc.status()
    expect(st.state).toBe('damaged')
    expect(st.error).toMatch(/hỏng/)
    expect(err(await svc.create(PASS, false))).toMatch(/hỏng/)
    expect(await readFile(join(dir, 'vault.json'), 'utf8')).toBe('{ broken')
  })
})
