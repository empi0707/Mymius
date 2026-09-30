/**
 * The point of FileSystemProvider: Folder Sync and Remote Edit, written against the interface only,
 * work unchanged when one side is a real SFTP connection.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPlan, compareFolders, executePlan } from '../../folder-sync/src'
import { RemoteEditSession, type ConflictChoice } from '../../remote-edit/src'
import { LocalProvider, SftpProvider } from '../src'
import { startSftpServer, type TestServer } from '@mymius/ssh/testing'

let base: string
let serverRoot: string
let localRoot: string
let server: TestServer
let sftp: SftpProvider
const local = new LocalProvider()

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mymius-int-'))
  serverRoot = join(base, 'server')
  localRoot = join(base, 'local')
  await mkdir(serverRoot)
  await mkdir(localRoot)
  server = await startSftpServer(serverRoot)
  sftp = await SftpProvider.connect({ host: '127.0.0.1', port: server.port, username: 'tester', password: 'secret', verifyHostKey: () => true })
})
afterEach(async () => {
  await sftp.dispose()
  await server.close()
  await rm(base, { recursive: true, force: true })
})

const put = async (root: string, rel: string, content: string, mtime = 1_700_000_000) => {
  const abs = join(root, ...rel.split('/'))
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
  await utimes(abs, mtime, mtime)
}

describe('Folder Sync: local <-> SFTP', () => {
  it('mirrors a local tree to the server and a second compare is clean', async () => {
    await put(localRoot, 'a/b/deep.txt', 'deep')
    await put(localRoot, 'top.txt', 'top')
    await mkdir(join(localRoot, 'empty'))
    await put(serverRoot, 'stale.txt', 'stale')

    const L = { provider: local, root: localRoot }
    const R = { provider: sftp, root: '/' }
    const { items } = await compareFolders(L, R)
    const report = await executePlan(buildPlan(items, { mode: 'mirror-ltr', deleteExtras: true }), L, R)

    expect(report.failCount).toBe(0)
    expect(await readFile(join(serverRoot, 'a/b/deep.txt'), 'utf8')).toBe('deep')
    expect((await readdir(serverRoot)).sort()).toEqual(['.mymius-trash', 'a', 'empty', 'top.txt'])
    // mtimes went through SFTP's whole-second precision and must still compare equal
    expect((await compareFolders(L, R)).items.every((i) => i.status === 'same')).toBe(true)
  })

  it('two-way sync between server and disk, in one run', async () => {
    await put(localRoot, 'from-local.txt', 'L')
    await put(serverRoot, 'from-server.txt', 'S')
    const L = { provider: local, root: localRoot }
    const R = { provider: sftp, root: '/' }
    const { items } = await compareFolders(L, R)
    await executePlan(buildPlan(items, { mode: 'two-way' }), L, R)
    expect((await readdir(localRoot)).sort()).toEqual(['from-local.txt', 'from-server.txt'])
    expect((await readdir(serverRoot)).sort()).toEqual(['from-local.txt', 'from-server.txt'])
  })

  it('sub-second mtime differences are not reported as changes', async () => {
    await put(localRoot, 'f.txt', 'same', 1_700_000_000.8) // local has ms, server keeps whole seconds
    await put(serverRoot, 'f.txt', 'same', 1_700_000_000)
    const { items } = await compareFolders({ provider: local, root: localRoot }, { provider: sftp, root: '/' })
    expect(items[0]?.status).toBe('same')
  })

  it('hash compare resolves "newer" files whose content is identical, using server-side hashing', async () => {
    await put(localRoot, 'f.txt', 'identical', 1_700_000_000)
    await put(serverRoot, 'f.txt', 'identical', 1_700_009_000)
    const L = { provider: local, root: localRoot }
    const R = { provider: sftp, root: '/' }
    expect((await compareFolders(L, R)).items[0]?.status).toBe('right-newer')
    const before = server.commands.length
    expect((await compareFolders(L, R, { compare: 'hash' })).items[0]?.status).toBe('same')
    expect(server.commands.length).toBe(before + 1) // hashed on the server, not downloaded
  })
})

describe('Remote Edit over SFTP', () => {
  let work: string
  beforeEach(async () => {
    work = join(base, 'work')
    await put(serverRoot, 'etc/app.conf', 'listen 80;\n')
  })

  const open = async (choice: ConflictChoice = 'cancel') => {
    const asked: string[] = []
    const s = new RemoteEditSession({
      provider: sftp,
      remotePath: '/etc/app.conf',
      workRoot: work,
      openInEditor: async () => {},
      watch: () => ({ close: async () => {} }),
      resolveConflict: async (c) => { asked.push(c.kind); return choice }
    })
    await s.open()
    return { s, asked }
  }
  const save = async (s: RemoteEditSession, text: string) => {
    await writeFile(s.localPath, text)
    return s.handleLocalChange()
  }

  it('downloads, uploads on save, and leaves nothing behind on the server', async () => {
    const { s, asked } = await open()
    expect(await readFile(s.localPath, 'utf8')).toBe('listen 80;\n')
    expect(await save(s, 'listen 8080;\n')).toBe('uploaded')
    expect(await readFile(join(serverRoot, 'etc/app.conf'), 'utf8')).toBe('listen 8080;\n')
    expect(await readdir(join(serverRoot, 'etc'))).toEqual(['app.conf'])
    expect(asked).toEqual([])
    expect(await save(s, 'listen 9090;\n')).toBe('uploaded') // baseline refreshed after the first upload
  })

  it('a server-side change is caught; overwrite replaces it, reload keeps my edits aside', async () => {
    const a = await open('overwrite')
    await put(serverRoot, 'etc/app.conf', 'someone else\n', 1_700_005_000)
    expect(await save(a.s, 'mine\n')).toBe('uploaded')
    expect(a.asked).toEqual(['modified'])
    expect(await readFile(join(serverRoot, 'etc/app.conf'), 'utf8')).toBe('mine\n')

    const b = await open('reload')
    await put(serverRoot, 'etc/app.conf', 'another change\n', 1_700_006_000)
    expect(await save(b.s, 'my precious edits\n')).toBe('reloaded')
    expect(await readFile(b.s.localPath, 'utf8')).toBe('another change\n')
    const aside = (await readdir(join(work, b.s.id))).find((n) => n.includes('.local-'))!
    expect(await readFile(join(work, b.s.id, aside), 'utf8')).toBe('my precious edits\n')
  })

  it('a touch on the server (new mtime, same bytes) is not a conflict', async () => {
    const { s, asked } = await open()
    await utimes(join(serverRoot, 'etc/app.conf'), 1_700_090_000, 1_700_090_000)
    expect(await save(s, 'mine\n')).toBe('uploaded')
    expect(asked).toEqual([])
  })

  it('works through the fallback rename (server without posix-rename), and preserves permissions', async () => {
    if (process.platform !== 'win32') await (await import('node:fs/promises')).chmod(join(serverRoot, 'etc/app.conf'), 0o640)
    const { s } = await open()
    expect(sftp.capabilities.atomicRename).toBe(false)
    await save(s, 'x\n')
    if (process.platform !== 'win32') {
      expect(((await sftp.stat('/etc/app.conf'))?.mode ?? 0) & 0o777).toBe(0o640)
    }
  })
})
