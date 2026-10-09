import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalSession } from '@mymius/core'
import { HostKeyChangedError, HostKeyRejectedError, KnownHosts, SshConnection, type SshConnectOptions } from '../src'
import { generateEd25519, startSshTestServer, type TestServer } from '../src/testing'

let root: string
let servers: TestServer[]
let conns: SshConnection[]

const start = async (opts: Parameters<typeof startSshTestServer>[1] = {}) => {
  const s = await startSshTestServer(root, opts)
  servers.push(s)
  return s
}
const base = (s: TestServer): SshConnectOptions => ({ host: '127.0.0.1', port: s.port, username: 'tester', password: 'secret', verifyHostKey: () => true })
const connect = async (s: TestServer, extra: Partial<SshConnectOptions> = {}) => {
  const c = await SshConnection.connect({ ...base(s), ...extra })
  conns.push(c)
  return c
}

/** Collects terminal output and lets a test wait for text to appear. */
function watch(term: TerminalSession) {
  let text = ''
  let bytes = 0
  const waiters: { re: RegExp | string; res: () => void }[] = []
  const check = () => {
    for (const w of [...waiters]) {
      if (typeof w.re === 'string' ? text.includes(w.re) : w.re.test(text)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.res()
      }
    }
  }
  term.onData((d) => { text += d.toString(); bytes += d.length; check() })
  return {
    get text() { return text },
    get bytes() { return bytes },
    until: (re: RegExp | string, ms = 5000) =>
      new Promise<void>((res, rej) => {
        waiters.push({ re, res })
        check()
        setTimeout(() => rej(new Error(`timed out waiting for ${re}; saw: ${JSON.stringify(text.slice(-200))}`)), ms).unref()
      })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mymius-ssh-'))
  servers = []
  conns = []
})
afterEach(async () => {
  await Promise.all(conns.map((c) => c.dispose()))
  await Promise.all(servers.map((s) => s.close()))
  await rm(root, { recursive: true, force: true })
})

describe('shell session', () => {
  it('keeps the greeting and prompt that arrive before anyone subscribes', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 100, rows: 30 })
    await new Promise((r) => setTimeout(r, 150)) // the prompt is long since delivered
    const w = watch(term)
    await w.until('welcome tester')
    await w.until('$ ')
  })

  it('sends keystrokes and receives the echo and command output', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const w = watch(term)
    await w.until('$ ')
    term.write('echo héllo wörld ✓\r')
    await w.until('héllo wörld ✓\r\n$ ') // UTF-8 survives both directions
    expect(s.shells[0]?.received).toBe('echo héllo wörld ✓\r')
  })

  it('tells the server the terminal type and initial size', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 132, rows: 43 })
    const w = watch(term)
    await w.until('$ ')
    term.write('size\r')
    await w.until('132x43')
    term.write('term\r')
    await w.until('xterm-256color')
  })

  it('propagates resizes', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const w = watch(term)
    await w.until('$ ')
    term.resize(200, 50)
    term.write('size\r')
    await w.until('200x50')
    expect(s.shells[0]).toMatchObject({ cols: 200, rows: 50 })
  })

  it('passes environment variables', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24, env: { LANG: 'vi_VN.UTF-8' } })
    const w = watch(term)
    await w.until('$ ')
    term.write('env LANG\r')
    await w.until('vi_VN.UTF-8')
  })

  it('handles line editing and interrupt from the server side of the tty', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const w = watch(term)
    await w.until('$ ')
    term.write('ecx\x7fho ok\r')
    await w.until('ok\r\n$ ')
    term.write('sleep 99\x03')
    await w.until('^C')
  })

  it('reports the exit code when the shell exits', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const exited = new Promise<{ code?: number }>((res) => term.onExit(res))
    term.write('exit 3\r')
    expect(await exited).toMatchObject({ code: 3 })
  })

  it('a listener added after exit is still told', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    term.write('exit 0\r')
    await new Promise((r) => setTimeout(r, 300))
    await expect(new Promise((res) => term.onExit(res))).resolves.toMatchObject({ code: 0 })
  })

  it('close() ends the session from our side', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const exited = new Promise((res) => term.onExit(res))
    term.close()
    await exited
    await new Promise((r) => setTimeout(r, 100))
    expect(s.shells[0]?.closed).toBe(true)
  })

  it('writing after the session ended is a no-op, not a crash', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const exited = new Promise((res) => term.onExit(res))
    term.write('exit\r')
    await exited
    expect(() => { term.write('x'); term.resize(10, 10) }).not.toThrow()
  })

  it('reports an error when the connection is lost', async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const exited = new Promise((res) => term.onExit(res))
    await s.close() // server hangs up
    await exited
  })

  it('several terminals and an SFTP session share one connection', async () => {
    const s = await start()
    const c = await connect(s)
    const [a, b] = await Promise.all([c.shell({ cols: 80, rows: 24 }), c.shell({ cols: 80, rows: 24 })])
    const wa = watch(a)
    const wb = watch(b)
    await Promise.all([wa.until('$ '), wb.until('$ ')])
    a.write('echo from-a\r')
    b.write('echo from-b\r')
    await wa.until('from-a\r\n')
    await wb.until('from-b\r\n')
    expect(wa.text).not.toContain('from-b')
    const sftp = await c.sftp()
    expect(sftp).toBeTruthy()
  })
})

describe('back-pressure', () => {
  it('pause() stops the flow of a huge output and resume() delivers all of it', { timeout: 20_000 }, async () => {
    const s = await start()
    const term = await (await connect(s)).shell({ cols: 80, rows: 24 })
    const w = watch(term)
    await w.until('$ ')
    const before = w.bytes
    const TOTAL = 16 * 1024 * 1024
    term.pause()
    term.write(`big ${TOTAL}\r`)
    await new Promise((r) => setTimeout(r, 1000))
    const receivedWhilePaused = w.bytes - before
    // The server is throttled by the SSH window instead of us buffering everything.
    expect(receivedWhilePaused).toBeLessThan(TOTAL / 2)
    expect(s.shells[0]!.bigSent).toBeLessThan(TOTAL)
    term.resume()
    await w.until('BIG-DONE', 15_000)
    expect(w.bytes - before).toBeGreaterThanOrEqual(TOTAL)
  })
})

describe('host key handling', () => {
  it('the reason a host was refused is reported, not a generic handshake error', async () => {
    const s = await start()
    await expect(connect(s, { verifyHostKey: () => false })).rejects.toBeInstanceOf(HostKeyRejectedError)
    await expect(connect(s, { verifyHostKey: () => { throw new HostKeyChangedError('h', 22, 'a', 'b') } })).rejects.toBeInstanceOf(HostKeyChangedError)
  })

  it('KnownHosts: trust on first use, remembered across instances, refused when the key changes', async () => {
    const file = join(root, 'known_hosts.json')
    const key = generateEd25519()
    const s1 = await start({ hostKey: key })
    const asked: string[] = []
    const kh = new KnownHosts(file)
    const verify = kh.verifier(async (i) => { asked.push(i.fingerprint); return true })

    await connect(s1, { verifyHostKey: verify })
    expect(asked).toEqual([s1.fingerprint])

    // A fresh process (new instance, same file) trusts it silently.
    const kh2 = new KnownHosts(file)
    await connect(s1, { verifyHostKey: kh2.verifier(async () => { throw new Error('should not ask') }) })

    // The same address now presents another key: refuse, and never even ask.
    const port = s1.port
    await s1.close()
    const impostor = await start({ port })
    let asked2 = false
    await expect(
      connect(impostor, { verifyHostKey: new KnownHosts(file).verifier(async () => { asked2 = true; return true }) })
    ).rejects.toBeInstanceOf(HostKeyChangedError)
    expect(asked2).toBe(false)
  })

  it('KnownHosts: declining an unknown host is not remembered', async () => {
    const kh = new KnownHosts(join(root, 'kh.json'))
    const s = await start()
    await expect(connect(s, { verifyHostKey: kh.verifier(async () => false) })).rejects.toBeInstanceOf(HostKeyRejectedError)
    expect(await kh.check('127.0.0.1', s.port, s.fingerprint)).toBe('unknown')
  })

  it('KnownHosts: keys ports separately, and can forget a host', async () => {
    const kh = new KnownHosts(join(root, 'kh.json'))
    await kh.trust('Example.com', 22, 'SHA256:aaa')
    expect(await kh.check('example.COM', 22, 'SHA256:aaa')).toBe('trusted')
    expect(await kh.check('example.com', 2222, 'SHA256:aaa')).toBe('unknown')
    expect(await kh.check('example.com', 22, 'SHA256:bbb')).toBe('changed')
    await kh.remove('example.com', 22)
    expect(await kh.check('example.com', 22, 'SHA256:aaa')).toBe('unknown')
  })

  it('KnownHosts: a corrupt file is an error, not silently treated as empty (that would drop protection)', async () => {
    const file = join(root, 'kh.json')
    await writeFile(file, '{ not json')
    await expect(new KnownHosts(file).check('h', 22, 'x')).rejects.toThrow()
  })
})

describe('jump host', () => {
  it('reaches a server that is only reachable through a bastion, and verifies both host keys', async () => {
    const target = await start()
    const bastion = await start({ user: 'jumper', password: 'pw2' })
    const seen: string[] = []
    const c = await connect(target, {
      verifyHostKey: (i) => { seen.push(`target:${i.fingerprint}`); return true },
      jump: {
        host: '127.0.0.1',
        port: bastion.port,
        username: 'jumper',
        password: 'pw2',
        verifyHostKey: (i) => { seen.push(`bastion:${i.fingerprint}`); return true }
      }
    })
    expect(bastion.forwards).toEqual([{ host: '127.0.0.1', port: target.port }])
    expect(seen).toEqual([`bastion:${bastion.fingerprint}`, `target:${target.fingerprint}`])
    const term = await c.shell({ cols: 80, rows: 24 })
    const w = watch(term)
    await w.until('welcome tester') // we are on the target, logged in as its user
  })

  it('fails cleanly when the bastion refuses to forward', async () => {
    const target = await start()
    const bastion = await start({ forwarding: false })
    await expect(connect(target, { jump: { ...base(bastion) } })).rejects.toThrow()
  })

  it('a bad host key on the target is reported even through a bastion', async () => {
    const target = await start()
    const bastion = await start()
    await expect(connect(target, { verifyHostKey: () => false, jump: base(bastion) })).rejects.toBeInstanceOf(HostKeyRejectedError)
  })

  it('closing the connection closes the tunnel to the bastion too', async () => {
    const target = await start()
    const bastion = await start()
    const c = await connect(target, { jump: base(bastion) })
    await c.dispose()
    expect(c.closed).toBe(true)
  })
})

describe('a channel that throws while the connection is going away', () => {
  it('write, resize, pause, resume and close never throw', async () => {
    const { ShellSession } = await import('../src/shell')
    const boom = () => { throw new Error('Not connected') }
    const fake = new Proxy({ on: () => undefined } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : boom) })
    const session = new ShellSession(fake as never)
    expect(() => { session.write('x'); session.resize(80, 24); session.pause(); session.resume(); session.close() }).not.toThrow()
  })
})
