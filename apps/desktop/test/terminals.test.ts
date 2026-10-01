import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VaultStore } from '@mymius/vault'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import type { HostKeyInfo } from '@mymius/ssh'
import type { TerminalDataEvent, TerminalExitEvent } from '../src/shared/ipc'
import { ConnectionBroker } from '../src/main/connections'
import { TerminalService } from '../src/main/terminals'
import { VaultService, type Result } from '../src/main/vault-service'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
let dir: string
let servers: TestServer[]
let svc: VaultService
let terminals: TerminalService
let asked: HostKeyInfo[]
let trust: boolean
let output: Map<string, string>
let exits: TerminalExitEvent[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mymius-term-'))
  servers = []
  asked = []
  trust = true
  output = new Map()
  exits = []
  const store = new VaultStore(join(dir, 'vault.json'), { kdf: FAST })
  svc = new VaultService(store, { readTextFile: async () => '', agentSocket: () => undefined })
  await svc.create('a decent passphrase', false)
  const broker = new ConnectionBroker(
    { knownHostsFile: join(dir, 'known_hosts.json'), confirmHostKey: async (info) => { asked.push(info); return trust } },
    svc.lookup
  )
  terminals = new TerminalService(
    {
      sendData: (_t, e: TerminalDataEvent) => output.set(e.id, (output.get(e.id) ?? '') + Buffer.from(e.data).toString()),
      sendExit: (_t, e) => exits.push(e)
    },
    broker,
    svc.lookup
  )
})
afterEach(async () => {
  terminals.closeAll()
  await Promise.all(servers.map((s) => s.close()))
  await rm(dir, { recursive: true, force: true })
})

const serve = async (opts: Parameters<typeof startSshTestServer>[1] = {}) => {
  const s = await startSshTestServer(dir, opts)
  servers.push(s)
  return s
}
const saveHost = async (s: TestServer, over: Record<string, unknown> = {}) => {
  const r = await svc.saveHost(undefined, { name: 'h', host: '127.0.0.1', port: s.port, username: 'tester', auth: { type: 'password', password: 'secret' }, ...over })
  if (!r.ok) throw new Error(r.error)
  return r.id
}
const until = async (fn: () => boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
const open = (hostId: string, owner = 1) => terminals.open(owner, { hostId, cols: 100, rows: 30 })
const okId = (r: Awaited<ReturnType<typeof open>>): string => {
  if (!r.ok) throw new Error(r.error)
  return r.id
}
const errOf = (r: Awaited<ReturnType<typeof open>>): string => {
  if (r.ok) throw new Error('expected failure')
  return r.error
}

describe('opening a saved host', () => {
  it('connects by id using the stored credentials, and the shell works', async () => {
    const s = await serve()
    const id = okId(await open(await saveHost(s)))
    await until(() => (output.get(id) ?? '').includes('welcome tester'), 'greeting')
    terminals.write(1, id, 'echo via saved host\r')
    await until(() => (output.get(id) ?? '').includes('via saved host\r\n'), 'echo')
    expect(s.shells[0]).toMatchObject({ cols: 100, rows: 30 })
  })

  it('delivers a long multi-line MOTD sent as the shell opens, in full and in order', async () => {
    const motd = Array.from({ length: 40 }, (_, i) => `motd line ${i}`).join('\r\n') + '\r\nLast login: now\r\n'
    const s = await serve({ greeting: motd })
    const id = okId(await open(await saveHost(s)))
    await until(() => (output.get(id) ?? '').includes('welcome tester'), 'greeting')
    expect(output.get(id)).toContain(motd)
  })

  it('a wrong stored password is reported, not silently accepted', async () => {
    const s = await serve()
    const good = await saveHost(s)
    const bad = await saveHost(s, { name: 'bad', auth: { type: 'password', password: 'wrong' } })
    okId(await open(good))
    expect(errOf(await open(bad))).toMatch(/authentication/i) // must not ride on the first host's login
  })

  it('each tab gets its own connection, so every tab sees the server MOTD (sshd prints it once per connection)', async () => {
    const s = await serve()
    const h = await saveHost(s)
    okId(await open(h)); okId(await open(h))
    expect(s.shells).toHaveLength(2)
    expect(s.connectionCount()).toBe(2)
    expect(asked).toHaveLength(1) // the host key is still only asked about once
  })

  it('goes through a saved jump host and asks about both host keys', async () => {
    const target = await serve()
    const bastion = await serve({ user: 'jumper', password: 'jp' })
    const jump = await saveHost(bastion, { name: 'bastion', username: 'jumper', auth: { type: 'password', password: 'jp' } })
    const id = okId(await open(await saveHost(target, { name: 'inner', jumpHostId: jump })))
    await until(() => (output.get(id) ?? '').includes('welcome tester'), 'greeting via bastion')
    expect(bastion.forwards).toEqual([{ host: '127.0.0.1', port: target.port }])
    expect(asked.map((a) => a.fingerprint).sort()).toEqual([bastion.fingerprint, target.fingerprint].sort())
  })

  it('declining an unknown host key stops the connection', async () => {
    const s = await serve()
    trust = false
    expect(errOf(await open(await saveHost(s)))).toMatch(/chưa được tin cậy/)
    expect(s.shells).toHaveLength(0)
  })

  it('a locked vault cannot be used to connect', async () => {
    const s = await serve()
    const h = await saveHost(s)
    await svc.lock()
    expect(errOf(await open(h))).toMatch(/đang khóa/)
    expect(s.connectionCount()).toBe(0)
  })

  it('a deleted host, a bad id and a bad size are refused cleanly', async () => {
    const s = await serve()
    const h = await saveHost(s)
    await svc.deleteHost(h)
    expect(errOf(await open(h))).toMatch(/không còn tồn tại/)
    expect(errOf(await open('host:nope'))).toBeTruthy()
    expect(errOf(await terminals.open(1, { hostId: h, cols: 0, rows: 30 }))).toMatch(/Kích thước/)
    expect(errOf(await terminals.open(1, { hostId: 42, cols: 80, rows: 24 }))).toBeTruthy()
  })

  it('a jump-host loop that slipped in through data is reported instead of hanging', async () => {
    const s = await serve()
    const a = await saveHost(s, { name: 'a' })
    const b = await saveHost(s, { name: 'b', jumpHostId: a })
    // Bypass the service's own loop check to simulate a synced record that creates a cycle.
    const hosts = svc.store.collection('host:', (x) => x as never)
    const stored = hosts.get(a) as unknown as Record<string, unknown>
    await hosts.put({ ...stored, jumpHostId: b } as never, a)
    expect(errOf(await open(b))).toMatch(/loop/)
  })
})

describe('ad-hoc connections still work', () => {
  it('typed-in credentials connect, and nothing is saved to the vault', async () => {
    const s = await serve()
    const r = await terminals.open(1, { host: '127.0.0.1', port: s.port, username: 'tester', auth: { type: 'password', password: 'secret' }, cols: 80, rows: 24 })
    const id = okId(r)
    await until(() => (output.get(id) ?? '').includes('welcome'), 'greeting')
    expect((svc.listHosts() as Extract<Result<{ hosts: unknown[] }>, { ok: true }>).hosts).toEqual([])
  })

  it('malformed requests are rejected', async () => {
    for (const bad of [null, {}, { host: '-x', port: 22, username: 'u', auth: { type: 'agent' }, cols: 80, rows: 24 }]) {
      expect(errOf(await terminals.open(1, bad))).toBeTruthy()
    }
  })
})

describe('window ownership', () => {
  it('a window can only drive its own sessions', async () => {
    const s = await serve()
    const id = okId(await open(await saveHost(s), 1))
    await until(() => (output.get(id) ?? '').includes('$ '), 'prompt')
    terminals.write(2, id, 'echo intruder\r')
    terminals.resize(2, id, 10, 10)
    terminals.close(2, id)
    await new Promise((r) => setTimeout(r, 300))
    expect(s.shells[0]!.received).not.toContain('intruder')
    expect(s.shells[0]).toMatchObject({ cols: 100, rows: 30 })
    expect(exits).toEqual([])
    terminals.close(1, id)
    await until(() => exits.length === 1, 'exit after owner closes')
  })

  it('closeOwnedBy ends that window\'s terminals only', async () => {
    const s = await serve()
    const h = await saveHost(s)
    const a = okId(await open(h, 1)); const b = okId(await open(h, 2))
    terminals.closeOwnedBy(1)
    await until(() => exits.some((e) => e.id === a), 'window 1 session closed')
    expect(exits.some((e) => e.id === b)).toBe(false)
  })
})
