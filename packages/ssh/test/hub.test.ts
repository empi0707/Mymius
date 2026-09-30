import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalExit, TerminalSession } from '@mymius/core'
import { ConnectionPool, TerminalHub, connectionKey, parseOpenRequest, type SshConnection } from '../src'

class FakeSession implements TerminalSession {
  written: string[] = []
  sizes: [number, number][] = []
  paused = 0
  resumed = 0
  closed = 0
  private d: ((b: Buffer) => void)[] = []
  private e: ((i: TerminalExit) => void)[] = []
  write(x: string | Uint8Array) { this.written.push(String(x)) }
  resize(c: number, r: number) { this.sizes.push([c, r]) }
  pause() { this.paused++ }
  resume() { this.resumed++ }
  close() { this.closed++ }
  onData(l: (b: Buffer) => void) { this.d.push(l) }
  onExit(l: (i: TerminalExit) => void) { this.e.push(l) }
  emit(s: string | Buffer) { for (const l of this.d) l(Buffer.from(s)) }
  end(info: TerminalExit = {}) { for (const l of this.e) l(info) }
}

describe('TerminalHub', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const setup = (opts = {}) => {
    const log: string[] = []
    const hub = new TerminalHub({ data: (id, d) => log.push(`data:${d.toString()}`), exit: (id, i) => log.push(`exit:${i.code ?? '-'}`) }, opts)
    const s = new FakeSession()
    const disposed = vi.fn()
    const id = hub.add(s, disposed)
    return { hub, s, id, log, disposed }
  }

  it('batches output and delivers the final chunk BEFORE the exit event', () => {
    const { s, log } = setup()
    s.emit('a'); s.emit('b')
    s.emit('tail')
    s.end({ code: 0 }) // exit arrives while output is still queued
    expect(log).toEqual(['data:abtail', 'exit:0'])
  })

  it('forwards input and resize, ignoring malformed values from the UI', () => {
    const { hub, s, id } = setup()
    hub.write(id, 'ls\r')
    hub.write(id, 42); hub.write(id, { x: 1 }); hub.write(id, 'x'.repeat(2 * 1024 * 1024))
    hub.resize(id, 100, 40)
    hub.resize(id, 0, 40); hub.resize(id, 100.5, 40); hub.resize(id, 5000, 40); hub.resize(id, '80', 24); hub.resize(id, NaN, 24)
    expect(s.written).toEqual(['ls\r'])
    expect(s.sizes).toEqual([[100, 40]])
  })

  it('unknown ids are ignored', () => {
    const { hub } = setup()
    expect(() => { hub.write('nope', 'x'); hub.resize('nope', 1, 1); hub.ack('nope', 1); hub.close('nope') }).not.toThrow()
  })

  it('pauses the session while the UI has not acknowledged enough, and resumes on acks', () => {
    const { hub, s, id } = setup()
    s.emit(Buffer.alloc(600 * 1024)) // > high-water mark in one flush
    vi.advanceTimersByTime(20)
    expect(s.paused).toBe(1)
    hub.ack(id, 300 * 1024)
    expect(s.resumed).toBe(0)
    hub.ack(id, 300 * 1024)
    expect(s.resumed).toBe(1)
  })

  it('bad acks cannot un-pause or crash it', () => {
    const { hub, s, id } = setup()
    s.emit(Buffer.alloc(600 * 1024)); vi.advanceTimersByTime(20)
    hub.ack(id, -1); hub.ack(id, NaN); hub.ack(id, '999999' as never); hub.ack(id, Infinity)
    expect(s.resumed).toBe(0)
  })

  it('runs onDispose once when the session ends and forgets it', () => {
    const { hub, s, disposed } = setup()
    s.end(); s.end()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(hub.size).toBe(0)
  })

  it('close and closeAll close the underlying sessions', () => {
    const { hub, s, id } = setup()
    const s2 = new FakeSession(); hub.add(s2)
    hub.close(id)
    hub.closeAll()
    expect(s.closed).toBeGreaterThanOrEqual(1)
    expect(s2.closed).toBe(1)
  })

  it('refuses sessions past the cap and cleans up the rejected one', () => {
    const { hub } = setup({ maxSessions: 1 })
    const extra = new FakeSession()
    const dispose = vi.fn()
    expect(() => hub.add(extra, dispose)).toThrow(/Too many/)
    expect(extra.closed).toBe(1)
    expect(dispose).toHaveBeenCalled()
  })
})

describe('parseOpenRequest', () => {
  const ok = { host: 'example.com', port: 22, username: 'root', auth: { type: 'password', password: 'x' }, cols: 80, rows: 24 }
  it('accepts a normal request and returns a clean copy', () => {
    const parsed = parseOpenRequest({ ...ok, host: '  Example.com ', extra: 'ignored' })
    expect(parsed).toEqual({ ...ok, host: 'Example.com' })
    expect(parsed).not.toHaveProperty('extra')
  })
  it('defaults the port', () => {
    expect(parseOpenRequest({ ...ok, port: undefined }).port).toBe(22)
  })
  it.each([
    ['not an object', null],
    ['empty host', { ...ok, host: '' }],
    ['host with a space', { ...ok, host: 'a b' }],
    ['host that looks like an option', { ...ok, host: '-oProxyCommand=evil' }],
    ['host with a newline', { ...ok, host: 'a\nb' }],
    ['port 0', { ...ok, port: 0 }],
    ['port 70000', { ...ok, port: 70000 }],
    ['fractional port', { ...ok, port: 22.5 }],
    ['string port', { ...ok, port: '22' }],
    ['no user', { ...ok, username: ' ' }],
    ['huge size', { ...ok, cols: 1e6 }],
    ['zero rows', { ...ok, rows: 0 }],
    ['unknown auth', { ...ok, auth: { type: 'telepathy' } }],
    ['password not a string', { ...ok, auth: { type: 'password', password: 1 } }],
    ['key without path', { ...ok, auth: { type: 'key', keyPath: '' } }]
  ])('rejects %s', (_n, input) => expect(() => parseOpenRequest(input)).toThrow())
  it('key and agent auth', () => {
    expect(parseOpenRequest({ ...ok, auth: { type: 'key', keyPath: '~/.ssh/id_ed25519', passphrase: '' } }).auth).toEqual({ type: 'key', keyPath: '~/.ssh/id_ed25519' })
    expect(parseOpenRequest({ ...ok, auth: { type: 'agent' } }).auth).toEqual({ type: 'agent' })
  })
  it('an empty password is allowed (some accounts have one) but a missing one is not', () => {
    expect(parseOpenRequest({ ...ok, auth: { type: 'password', password: '' } }).auth).toEqual({ type: 'password', password: '' })
  })
  describe('connectionKey', () => {
    const k = (over: Record<string, unknown> = {}) => connectionKey(parseOpenRequest({ ...ok, ...over }))
    it('is the same for the same host, user and credentials, whatever the host case', () => {
      expect(k({ host: 'Example.COM' })).toBe(k({ host: 'example.com' }))
    })
    it('differs when the password differs, so a wrong password cannot ride on another tab\'s login', () => {
      expect(k({ auth: { type: 'password', password: 'right' } })).not.toBe(k({ auth: { type: 'password', password: 'wrong' } }))
    })
    it('differs by user, port, host, key file and auth method', () => {
      const base = k()
      expect(k({ username: 'other' })).not.toBe(base)
      expect(k({ port: 2222 })).not.toBe(base)
      expect(k({ host: 'other.com' })).not.toBe(base)
      expect(k({ auth: { type: 'agent' } })).not.toBe(base)
      expect(k({ auth: { type: 'key', keyPath: '/a' } })).not.toBe(k({ auth: { type: 'key', keyPath: '/b' } }))
      expect(k({ auth: { type: 'key', keyPath: '/a', passphrase: 'x' } })).not.toBe(k({ auth: { type: 'key', keyPath: '/a' } }))
    })
    it('never contains the secret itself', () => {
      expect(k({ auth: { type: 'password', password: 'hunter2-secret' } })).not.toContain('hunter2')
    })
    it('cannot be confused by a secret that contains the separator', () => {
      expect(k({ auth: { type: 'key', keyPath: 'a', passphrase: 'b' } })).not.toBe(k({ auth: { type: 'key', keyPath: 'a\0b' } }))
    })
  })
})

describe('ConnectionPool', () => {
  const fakeConn = () => {
    const c = { closed: false, dispose: vi.fn(async () => { c.closed = true }) }
    return c as unknown as SshConnection & { dispose: ReturnType<typeof vi.fn> }
  }

  it('shares one connection per key and closes it after the last release', async () => {
    const pool = new ConnectionPool()
    const c = fakeConn()
    const connect = vi.fn(async () => c)
    const a = await pool.acquire('k', connect)
    const b = await pool.acquire('k', connect)
    expect(a).toBe(b)
    expect(connect).toHaveBeenCalledTimes(1)
    await pool.release('k', a)
    expect(c.dispose).not.toHaveBeenCalled()
    await pool.release('k', b)
    expect(c.dispose).toHaveBeenCalledTimes(1)
    expect(pool.size).toBe(0)
  })

  it('concurrent first acquires still connect only once', async () => {
    const pool = new ConnectionPool()
    const connect = vi.fn(async () => { await new Promise((r) => setTimeout(r, 10)); return fakeConn() })
    const [a, b] = await Promise.all([pool.acquire('k', connect), pool.acquire('k', connect)])
    expect(a).toBe(b)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('a dropped connection is replaced on the next acquire, and releasing the old one is harmless', async () => {
    const pool = new ConnectionPool()
    const first = fakeConn(); const second = fakeConn()
    const a = await pool.acquire('k', async () => first)
    ;(first as { closed: boolean }).closed = true
    const b = await pool.acquire('k', async () => second)
    expect(b).toBe(second)
    await pool.release('k', a) // stale
    expect(second.dispose).not.toHaveBeenCalled()
    await pool.release('k', b)
    expect(second.dispose).toHaveBeenCalledTimes(1)
  })

  it('a failed connect is not cached', async () => {
    const pool = new ConnectionPool()
    await expect(pool.acquire('k', async () => { throw new Error('refused') })).rejects.toThrow('refused')
    expect(pool.size).toBe(0)
    const c = fakeConn()
    expect(await pool.acquire('k', async () => c)).toBe(c)
  })
})
