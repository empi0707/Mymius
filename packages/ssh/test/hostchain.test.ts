import { utils } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { chainKey, chainToOptions, inspectPrivateKey, resolveChain, MAX_JUMP_HOPS, type HostLookup, type ResolvedHost } from '../src'
import { generateEd25519 } from '../src/testing'

const host = (id: string, over: Partial<ResolvedHost> = {}): ResolvedHost => ({
  id, name: id, host: `${id}.example`, port: 22, username: 'u', auth: { type: 'password', password: `pw-${id}` }, ...over
})
const lookupOf = (hosts: ResolvedHost[]): HostLookup => ({
  resolve: async (id) => {
    const h = hosts.find((x) => x.id === id)
    if (!h) throw new Error(`Host ${id} no longer exists`)
    return h
  }
})

describe('resolveChain', () => {
  it('a host without a jump is a chain of one', async () => {
    expect((await resolveChain('a', lookupOf([host('a')]))).map((h) => h.id)).toEqual(['a'])
  })

  it('orders hops outermost first, target last', async () => {
    const hosts = [host('target', { jumpHostId: 'inner' }), host('inner', { jumpHostId: 'outer' }), host('outer')]
    expect((await resolveChain('target', lookupOf(hosts))).map((h) => h.id)).toEqual(['outer', 'inner', 'target'])
  })

  it('names the loop instead of hanging', async () => {
    const hosts = [host('a', { jumpHostId: 'b' }), host('b', { jumpHostId: 'c' }), host('c', { jumpHostId: 'a' })]
    await expect(resolveChain('a', lookupOf(hosts))).rejects.toThrow(/loop: a → b → c → a/)
    await expect(resolveChain('x', lookupOf([host('x', { jumpHostId: 'x' })]))).rejects.toThrow(/loop/)
  })

  it('caps the depth', async () => {
    const n = MAX_JUMP_HOPS + 3
    const hosts = Array.from({ length: n }, (_, i) => host(`h${i}`, i < n - 1 ? { jumpHostId: `h${i + 1}` } : {}))
    await expect(resolveChain('h0', lookupOf(hosts))).rejects.toThrow(/Too many jump hosts/)
  })

  it('a missing jump host is reported with the lookup\'s own message', async () => {
    await expect(resolveChain('a', lookupOf([host('a', { jumpHostId: 'gone' })]))).rejects.toThrow('Host gone no longer exists')
  })
})

describe('chainToOptions', () => {
  const verify = () => () => true
  it('nests each hop inside the next and maps every auth type', () => {
    const chain = [
      host('bastion', { auth: { type: 'agent', socket: '/tmp/agent' } }),
      host('mid', { auth: { type: 'key', privateKey: 'KEYTEXT', passphrase: 'pp' } }),
      host('target', { port: 2222 })
    ]
    const o = chainToOptions(chain, verify)
    expect(o).toMatchObject({ host: 'target.example', port: 2222, password: 'pw-target' })
    expect(o.jump).toMatchObject({ host: 'mid.example', privateKey: 'KEYTEXT', passphrase: 'pp' })
    expect(o.jump?.jump).toMatchObject({ host: 'bastion.example', agent: '/tmp/agent' })
    expect(o.jump?.jump?.jump).toBeUndefined()
  })

  it('asks for a verifier per hop, so every host key is checked', () => {
    const asked: string[] = []
    chainToOptions([host('a'), host('b')], (hop) => { asked.push(hop.id); return () => true })
    expect(asked.sort()).toEqual(['a', 'b'])
  })

  it('refuses an empty chain', () => {
    expect(() => chainToOptions([], verify)).toThrow()
  })
})

describe('chainKey', () => {
  it('is equal only for the same hops with the same credentials', () => {
    const a = [host('t')]
    expect(chainKey(a)).toBe(chainKey([host('t')]))
    expect(chainKey(a)).not.toBe(chainKey([host('t', { auth: { type: 'password', password: 'other' } })]))
    expect(chainKey(a)).not.toBe(chainKey([host('j'), host('t')]))
    expect(chainKey([host('j'), host('t')])).not.toBe(chainKey([host('j', { auth: { type: 'password', password: 'x' } }), host('t')]))
    expect(chainKey(a)).not.toContain('pw-t')
  })
})

describe('inspectPrivateKey', () => {
  it('accepts an unencrypted key and reports its type and fingerprint', () => {
    const k = generateEd25519()
    const info = inspectPrivateKey(k.private)
    expect(info).toMatchObject({ type: 'ssh-ed25519', encrypted: false })
    expect(info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it('an encrypted key needs its passphrase, and a wrong one is caught', () => {
    let k: { private: string; public: string } | undefined
    for (let i = 0; i < 20 && !k; i++) {
      const c = utils.generateKeyPairSync('ed25519', { passphrase: 'right-pass', cipher: 'aes256-ctr', rounds: 16 })
      if (!(utils.parseKey(c.private, 'right-pass') instanceof Error)) k = c
    }
    expect(() => inspectPrivateKey(k!.private)).toThrow(/passphrase/i)
    expect(() => inspectPrivateKey(k!.private, 'wrong')).toThrow(/Sai passphrase/)
    expect(inspectPrivateKey(k!.private, 'right-pass')).toMatchObject({ encrypted: true, type: 'ssh-ed25519' })
  })

  it('rejects public keys, garbage and oversized input with clear messages', () => {
    expect(() => inspectPrivateKey(generateEd25519().public)).toThrow(/khóa công khai/)
    expect(() => inspectPrivateKey('hello world')).toThrow(/không phải file khóa riêng tư hợp lệ/)
    expect(() => inspectPrivateKey('')).toThrow()
    expect(() => inspectPrivateKey('x'.repeat(70 * 1024))).toThrow(/quá lớn/)
  })
})
