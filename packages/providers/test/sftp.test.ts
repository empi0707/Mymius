import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlreadyExistsError, ConflictError, NotFoundError, getVersion, hashFile, writeFileAtomic } from '@mymius/core'
import { SftpProvider, shellQuote, type SftpConnectOptions } from '../src'
import { generateEd25519, startSftpServer, type TestServer } from '@mymius/ssh/testing'

let root: string
let server: TestServer
let sftp: SftpProvider
const T0 = 1_700_000_000

const trust: Pick<SftpConnectOptions, 'verifyHostKey'> = { verifyHostKey: () => true }
const connect = (extra: Partial<SftpConnectOptions> = {}) =>
  SftpProvider.connect({ host: '127.0.0.1', port: server.port, username: 'tester', password: 'secret', ...trust, ...extra })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mymius-sftp-'))
  server = await startSftpServer(root)
  sftp = await connect()
})
afterEach(async () => {
  await sftp.dispose()
  await server.close()
  await rm(root, { recursive: true, force: true })
})

describe('connecting', () => {
  it('reports the host key fingerprint in OpenSSH format so the app can check known_hosts', async () => {
    let seen: string | undefined
    const p = await connect({ verifyHostKey: (i) => { seen = i.fingerprint; return true } })
    expect(seen).toBe(server.fingerprint)
    await p.dispose()
  })

  it('refuses to connect when the host key is rejected', async () => {
    await expect(connect({ verifyHostKey: () => false })).rejects.toThrow()
  })

  it('also rejects when the verifier throws or is async', async () => {
    await expect(connect({ verifyHostKey: async () => { throw new Error('boom') } })).rejects.toThrow()
    const p = await connect({ verifyHostKey: async () => true })
    await p.dispose()
  })

  it('rejects a wrong password without hanging', async () => {
    await expect(connect({ password: 'nope', readyTimeoutMs: 5000 })).rejects.toThrow()
  })

  it('authenticates with a private key', async () => {
    const keys = generateEd25519()
    const s2 = await startSftpServer(root, { authorizedKey: keys.public })
    const p = await SftpProvider.connect({ host: '127.0.0.1', port: s2.port, username: 'tester', privateKey: keys.private, ...trust })
    expect(await p.realpath('.')).toBe('/')
    await p.dispose()
    await s2.close()
  })

  it('notifies when the connection drops', async () => {
    const dropped = new Promise<void>((res) => sftp.onClose(() => res()))
    await server.close() // the server hangs up on us
    await dropped
    expect(sftp.closed).toBe(true)
  })
})

describe('listing and stat', () => {
  it('lists entries without . and .., with kinds, sizes and whole-second mtimes', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    await utimes(join(root, 'a.txt'), T0 + 0.7, T0 + 0.7)
    await mkdir(join(root, 'dir'))
    const list = await sftp.list('/')
    expect(list.map((e) => [e.name, e.kind, e.size])).toEqual([['a.txt', 'file', 5], ['dir', 'directory', list[1]!.size]])
    expect(list[0]?.mtimeMs).toBe(T0 * 1000)
    expect(list[0]?.path).toBe('/a.txt')
  })

  it('stat returns null for a missing path and the entry otherwise', async () => {
    await writeFile(join(root, 'f'), 'xyz')
    expect(await sftp.stat('/missing')).toBeNull()
    expect(await sftp.stat('/f')).toMatchObject({ kind: 'file', size: 3, name: 'f' })
  })

  it('listing a missing directory is a NotFoundError', async () => {
    await expect(sftp.list('/nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it.skipIf(process.platform === 'win32')('reports symlinks as symlinks and realpath resolves them', async () => {
    await writeFile(join(root, 'real.txt'), 'x')
    await symlink('real.txt', join(root, 'link.txt'))
    expect((await sftp.stat('/link.txt'))?.kind).toBe('symlink')
    expect(await sftp.realpath('/link.txt')).toBe('/real.txt')
  })
})

describe('reading and writing', () => {
  // Also a performance guard: without TCP_NODELAY this took ~3 s per MB and would time out.
  it('round-trips a multi-megabyte file byte for byte, quickly', { timeout: 10_000 }, async () => {
    const data = randomBytes(8 * 1024 * 1024 + 123)
    await pipeline(Readable.from([data]), sftp.createWriteStream('/big.bin'))
    expect((await readFile(join(root, 'big.bin'))).equals(data)).toBe(true)
    const chunks: Buffer[] = []
    for await (const c of sftp.createReadStream('/big.bin')) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).equals(data)).toBe(true)
  })

  it('reads a byte range', async () => {
    await writeFile(join(root, 'r.txt'), '0123456789')
    const chunks: Buffer[] = []
    for await (const c of sftp.createReadStream('/r.txt', { start: 3, end: 6 })) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('3456')
  })

  it('resumes a partial upload at an offset', async () => {
    await writeFile(join(root, 'p.bin'), 'AAAA')
    await pipeline(Readable.from([Buffer.from('BBBB')]), sftp.createWriteStream('/p.bin', { start: 4 }))
    expect(await readFile(join(root, 'p.bin'), 'utf8')).toBe('AAAABBBB')
  })

  it('reading a missing file errors instead of hanging', async () => {
    const drain = new Writable({ write: (_c, _e, cb) => cb() })
    await expect(pipeline(sftp.createReadStream('/nope'), drain)).rejects.toThrow()
  })
})

describe('directories', () => {
  it('mkdir recursive creates only what is missing and tolerates existing dirs', async () => {
    await mkdir(join(root, 'a'))
    await sftp.mkdir('/a/b/c/d', { recursive: true })
    expect((await stat(join(root, 'a/b/c/d'))).isDirectory()).toBe(true)
    await sftp.mkdir('/a/b/c/d', { recursive: true })
  })

  it('mkdir over an existing file fails', async () => {
    await writeFile(join(root, 'f'), '')
    await expect(sftp.mkdir('/f/x', { recursive: true })).rejects.toThrow()
  })

  it('remove: files, recursive directories, and missing paths (no error)', async () => {
    await mkdir(join(root, 'd/e'), { recursive: true })
    await writeFile(join(root, 'd/e/f.txt'), 'x')
    await writeFile(join(root, 'top.txt'), 'x')
    await sftp.remove('/top.txt')
    await sftp.remove('/d', { recursive: true })
    await sftp.remove('/never-existed')
    expect(await readdir(root)).toEqual([])
  })

  it('remove without recursive refuses a non-empty directory', async () => {
    await mkdir(join(root, 'd'))
    await writeFile(join(root, 'd/f'), 'x')
    await expect(sftp.remove('/d')).rejects.toThrow()
    expect(await readdir(join(root, 'd'))).toEqual(['f'])
  })
})

describe('rename', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'src.txt'), 'new')
    await writeFile(join(root, 'dst.txt'), 'old')
  })

  it('refuses to replace by default', async () => {
    await expect(sftp.rename('/src.txt', '/dst.txt')).rejects.toBeInstanceOf(AlreadyExistsError)
    expect(await readFile(join(root, 'dst.txt'), 'utf8')).toBe('old')
  })

  it('renames to a free name', async () => {
    await sftp.rename('/src.txt', '/free.txt')
    expect(await readFile(join(root, 'free.txt'), 'utf8')).toBe('new')
  })

  it('overwrite without the OpenSSH extension falls back to remove + rename and says it is not atomic', async () => {
    expect(sftp.capabilities.atomicRename).toBe(false)
    await sftp.rename('/src.txt', '/dst.txt', { overwrite: true })
    expect(await readFile(join(root, 'dst.txt'), 'utf8')).toBe('new')
    expect(server.extended).toEqual([])
  })

  it('overwrite uses posix-rename when the server advertises it', async () => {
    ;(sftp as unknown as { sftp: { _extensions: Record<string, string> } }).sftp._extensions['posix-rename@openssh.com'] = '1'
    await (sftp as unknown as { probe(): Promise<void> }).probe()
    expect(sftp.capabilities.atomicRename).toBe(true)
    await sftp.rename('/src.txt', '/dst.txt', { overwrite: true })
    expect(server.extended).toEqual(['posix-rename@openssh.com'])
    expect(await readFile(join(root, 'dst.txt'), 'utf8')).toBe('new')
  })
})

describe('attributes', () => {
  it('setTimes stores whole seconds (floor) and chmod applies', async () => {
    await writeFile(join(root, 'f'), 'x')
    await sftp.setTimes('/f', (T0 + 0.9) * 1000)
    expect((await sftp.stat('/f'))?.mtimeMs).toBe(T0 * 1000)
    if (process.platform !== 'win32') {
      await sftp.chmod('/f', 0o600)
      expect(((await sftp.stat('/f'))?.mode ?? 0) & 0o777).toBe(0o600)
    }
  })
})

describe('server-side hashing', () => {
  it('is detected, quotes hostile paths safely, and matches the local hash', async () => {
    expect(sftp.capabilities.remoteHash).toBe(true)
    const name = `it's a $(touch pwned); "file".txt`
    await writeFile(join(root, name), 'content')
    const remote = await sftp.hash('/' + name, 'sha256')
    expect(remote).toBe((await import('node:crypto')).createHash('sha256').update('content').digest('hex'))
    expect(await readdir(root)).not.toContain('pwned')
    expect(server.commands.at(-1)).toBe(`sha256sum -- ${shellQuote('/' + name)}`)
  })

  it('hashFile from core uses it instead of downloading', async () => {
    await writeFile(join(root, 'h'), 'abc')
    const before = server.commands.length
    await hashFile(sftp, '/h')
    expect(server.commands.length).toBe(before + 1)
  })

  it('SFTP-only accounts (no exec): capability off, hashFile still works by streaming', async () => {
    const s2 = await startSftpServer(root, { exec: false })
    const p = await SftpProvider.connect({ host: '127.0.0.1', port: s2.port, username: 'tester', password: 'secret', ...trust })
    expect(p.capabilities.remoteHash).toBe(false)
    await writeFile(join(root, 'h'), 'abc')
    expect(await hashFile(p, '/h')).toBe(await hashFile(sftp, '/h'))
    await p.dispose()
    await s2.close()
  })
})

describe('shellQuote', () => {
  it.each([['plain', "'plain'"], ["it's", `'it'\\''s'`], ['a b;c$d', "'a b;c$d'"], ['', "''"]])('%s', (i, o) => expect(shellQuote(i)).toBe(o))
})

describe('core helpers over SFTP', () => {
  it('writeFileAtomic replaces content, keeps no temp files, and returns the new version', async () => {
    await writeFile(join(root, 'a.conf'), 'v1')
    const v = await writeFileAtomic(sftp, '/a.conf', Readable.from(['version two']))
    expect(v.size).toBe(11)
    expect(await readFile(join(root, 'a.conf'), 'utf8')).toBe('version two')
    expect(await readdir(root)).toEqual(['a.conf'])
  })

  it('writeFileAtomic detects a concurrent change and leaves the original alone', async () => {
    await writeFile(join(root, 'a.conf'), 'v1')
    await utimes(join(root, 'a.conf'), T0, T0)
    const seen = await getVersion(sftp, '/a.conf')
    await writeFile(join(root, 'a.conf'), 'changed by someone else')
    await utimes(join(root, 'a.conf'), T0 + 100, T0 + 100)
    await expect(writeFileAtomic(sftp, '/a.conf', Readable.from(['mine']), { expect: seen })).rejects.toBeInstanceOf(ConflictError)
    expect(await readFile(join(root, 'a.conf'), 'utf8')).toBe('changed by someone else')
    expect(await readdir(root)).toEqual(['a.conf'])
  })
})
