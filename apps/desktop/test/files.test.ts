import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConflictChoice, ConflictContext } from '@mymius/remote-edit'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import { VaultStore } from '@mymius/vault'
import type { EditInfo, JobState, Result } from '../src/shared/ipc'
import { ConnectionBroker } from '../src/main/connections'
import { FilesService, LOCAL_SESSION, type FilesHost } from '../src/main/files'
import { OpenWithStore } from '../src/main/open-with'
import { VaultService } from '../src/main/vault-service'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const T0 = 1_700_000_000
let base: string
let home: string
let remote: string
let server: TestServer
let svc: VaultService
let files: FilesService
let hostId: string
let jobs: JobState[]
let edits: EditInfo[]
let opened: string[]
let launched: { app: string; file: string }[]
let openWith: OpenWithStore
let trashed: string[]
let conflictChoice: ConflictChoice
let conflicts: ConflictContext[]
const OWNER = 1

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mymius-files-'))
  home = join(base, 'home'); remote = join(base, 'remote')
  await mkdir(home); await mkdir(remote)
  jobs = []; edits = []; opened = []; launched = []; trashed = []; conflicts = []; conflictChoice = 'cancel'
  server = await startSshTestServer(remote, { password: 'secret' })
  svc = new VaultService(new VaultStore(join(base, 'vault.json'), { kdf: FAST }), { readTextFile: async () => '', agentSocket: () => undefined })
  await svc.create('a decent passphrase', false)
  const saved = await svc.saveHost(undefined, { name: 'box', host: '127.0.0.1', port: server.port, username: 'tester', auth: { type: 'password', password: 'secret' } })
  if (!saved.ok) throw new Error(saved.error)
  hostId = saved.id
  const broker = new ConnectionBroker({ knownHostsFile: join(base, 'known.json'), confirmHostKey: async () => true }, svc.lookup)
  openWith = new OpenWithStore(join(base, 'open-with.json'))
  const host: FilesHost = {
    home,
    workRoot: join(base, 'edit-cache'),
    trashItem: async (p) => { trashed.push(p); await rm(p, { recursive: true, force: true }) },
    openLocal: async (p) => { opened.push(p) },
    openWith: {
      decide: (name, mode) => openWith.decide(name, mode),
      remember: (name, how, app) => openWith.remember(name, how, app),
      launch: async (p, app) => { if (app.kind === 'app') launched.push({ app: app.path, file: p }); else opened.push(p) }
    },
    confirmEditConflict: async (ctx) => { conflicts.push(ctx); return conflictChoice },
    emitJob: (_o, j) => jobs.push(j),
    emitEdit: (_o, e) => edits.push(e)
  }
  files = new FilesService(host, broker, svc.lookup)
})
afterEach(async () => {
  await files.closeOwnedBy(OWNER)
  await server.close()
  await rm(base, { recursive: true, force: true })
})

const ok = <T extends object>(r: Result<T>): Extract<Result<T>, { ok: true }> => {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`)
  return r
}
const fail = (r: Result<object>): string => {
  if (r.ok) throw new Error('expected a failure')
  return r.error
}
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const finished = async (jobId: string): Promise<JobState> => {
  await until(() => jobs.some((j) => j.id === jobId && j.state !== 'running'), `job ${jobId}`)
  return jobs.filter((j) => j.id === jobId).at(-1)!
}
const connect = async (): Promise<string> => ok(await files.connect(OWNER, hostId)).session.id
const put = async (root: string, rel: string, content: string, mtime = T0) => {
  const p = join(root, ...rel.split('/'))
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, content)
  await utimes(p, mtime, mtime)
}

describe('places and browsing', () => {
  it('offers the home folder and the folders that exist', async () => {
    await mkdir(join(home, 'Documents'))
    const r = ok(await files.places())
    expect(r.session).toMatchObject({ id: LOCAL_SESSION, kind: 'local', home })
    expect(r.places.map((p) => p.name)).toEqual(expect.arrayContaining(['Home', 'Documents']))
    expect(r.places.map((p) => p.name)).not.toContain('Downloads')
  })

  it('lists a local folder with breadcrumbs and a parent', async () => {
    await put(home, 'a/b/f.txt', 'hello')
    const { listing } = ok(await files.list(OWNER, LOCAL_SESSION, join(home, 'a', 'b')))
    expect(listing.entries).toEqual([{ name: 'f.txt', path: join(home, 'a/b/f.txt'), kind: 'file', size: 5, mtimeMs: T0 * 1000 }])
    expect(listing.parent).toBe(join(home, 'a'))
    expect(listing.crumbs.at(-1)).toEqual({ name: 'b', path: join(home, 'a/b') })
    expect(listing.crumbs.length).toBeGreaterThan(2)
  })

  it('no path means home; a relative path is taken from home; ".." is normalised away', async () => {
    await put(home, 'x/f', '1')
    expect(ok(await files.list(OWNER, LOCAL_SESSION)).listing.path).toBe(home)
    expect(ok(await files.list(OWNER, LOCAL_SESSION, 'x')).listing.path).toBe(join(home, 'x'))
    expect(ok(await files.list(OWNER, LOCAL_SESSION, join(home, 'x', '..', 'x'))).listing.path).toBe(join(home, 'x'))
  })

  it('says what is wrong instead of throwing', async () => {
    await put(home, 'f.txt', 'x')
    expect(fail(await files.list(OWNER, LOCAL_SESSION, join(home, 'nope')))).toBe('Không tìm thấy thư mục')
    expect(fail(await files.list(OWNER, LOCAL_SESSION, join(home, 'f.txt')))).toBe('Không phải thư mục')
    expect(fail(await files.list(OWNER, 'no-such-session', home))).toMatch(/không còn mở/)
    expect(fail(await files.list(OWNER, LOCAL_SESSION, '\0bad'))).toBe('Đường dẫn không hợp lệ')
    expect(fail(await files.list(OWNER, LOCAL_SESSION, 42))).toBe('Đường dẫn không hợp lệ')
  })

  it.skipIf(process.platform === 'win32')('a link to a folder is listed as a link that can be opened; a broken one is marked', async () => {
    await mkdir(join(home, 'real'))
    await symlink(join(home, 'real'), join(home, 'to-dir'))
    await symlink(join(home, 'missing'), join(home, 'dangling'))
    const { listing } = ok(await files.list(OWNER, LOCAL_SESSION, home))
    const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]))
    expect(byName['to-dir']).toMatchObject({ kind: 'symlink', targetKind: 'directory' })
    expect(byName['dangling']).toMatchObject({ kind: 'symlink', targetKind: 'broken' })
    expect(ok(await files.list(OWNER, LOCAL_SESSION, join(home, 'to-dir'))).listing.entries).toEqual([])
  })

  it('browses a saved SFTP host, starting in its home', async () => {
    await put(remote, 'docs/readme.md', '# hi')
    const s = ok(await files.connect(OWNER, hostId)).session
    expect(s).toMatchObject({ kind: 'sftp', label: 'box', sep: '/', hostId })
    expect(s.home).toBe('/')
    const { listing } = ok(await files.list(OWNER, s.id, '/docs'))
    expect(listing.entries.map((e) => e.name)).toEqual(['readme.md'])
    expect(listing.crumbs.map((c) => c.name)).toEqual(['/', 'docs'])
    expect(listing.parent).toBe('/')
  })

  it('connecting to a host that does not exist, or with the vault locked, fails cleanly', async () => {
    expect(fail(await files.connect(OWNER, 'host:nope'))).toMatch(/không còn tồn tại/)
    expect(fail(await files.connect(OWNER, 42))).toBeTruthy()
    await svc.lock()
    expect(fail(await files.connect(OWNER, hostId))).toMatch(/đang khóa/)
  })

  it('another window cannot use my connection, and disconnecting really closes it', async () => {
    const sid = await connect()
    expect(fail(await files.list(2, sid, '/'))).toMatch(/không còn mở/)
    expect(server.connectionCount()).toBe(1)
    await files.disconnect(2, sid) // not the owner: ignored
    ok(await files.list(OWNER, sid, '/'))
    await files.disconnect(OWNER, sid)
    expect(fail(await files.list(OWNER, sid, '/'))).toMatch(/không còn mở/)
    await until(() => server.connectionCount() === 0, 'connection closed')
  })

  it('a dropped connection is reported with advice, not a stack trace', async () => {
    const sid = await connect()
    await server.close()
    await until(async () => !(await files.list(OWNER, sid, '/')).ok, 'error after drop')
    expect(fail(await files.list(OWNER, sid, '/'))).toMatch(/mất kết nối/)
  })
})

describe('making and renaming', () => {
  it('creates a folder and refuses bad or duplicate names', async () => {
    ok(await files.mkdir(OWNER, LOCAL_SESSION, home, 'New folder'))
    expect((await stat(join(home, 'New folder'))).isDirectory()).toBe(true)
    expect(fail(await files.mkdir(OWNER, LOCAL_SESSION, home, 'New folder'))).toMatch(/trùng tên/)
    for (const bad of ['', ' ', '..', 'a/b', 'a\\b']) expect(fail(await files.mkdir(OWNER, LOCAL_SESSION, home, bad))).toBeTruthy()
    expect(fail(await files.mkdir(OWNER, LOCAL_SESSION, home, 7))).toBeTruthy()
    expect(await readdir(home)).toEqual(['New folder'])
  })

  it('renames, but never onto something that exists, and never out of the folder', async () => {
    await put(home, 'a.txt', 'a'); await put(home, 'b.txt', 'b')
    ok(await files.rename(OWNER, LOCAL_SESSION, join(home, 'a.txt'), 'c.txt'))
    expect(fail(await files.rename(OWNER, LOCAL_SESSION, join(home, 'c.txt'), 'b.txt'))).toMatch(/trùng tên/)
    expect(fail(await files.rename(OWNER, LOCAL_SESSION, join(home, 'c.txt'), '../escape.txt'))).toBeTruthy()
    ok(await files.rename(OWNER, LOCAL_SESSION, join(home, 'c.txt'), 'c.txt')) // same name: nothing to do
    expect((await readdir(home)).sort()).toEqual(['b.txt', 'c.txt'])
  })

  it('works on the server too', async () => {
    const sid = await connect()
    ok(await files.mkdir(OWNER, sid, '/', 'made'))
    ok(await files.rename(OWNER, sid, '/made', 'renamed'))
    expect(await readdir(remote)).toEqual(['renamed'])
  })
})

describe('copy, move and delete jobs', () => {
  it('uploads a folder to the server and reports progress and a summary', async () => {
    await put(home, 'proj/a.txt', 'aaa'); await put(home, 'proj/sub/b.txt', 'bbbb')
    const sid = await connect()
    const { jobId } = ok(await files.transfer(OWNER, { fromSession: LOCAL_SESSION, paths: [join(home, 'proj')], toSession: sid, toDir: '/', mode: 'copy', policy: 'skip' }))
    const job = await finished(jobId)
    expect(job).toMatchObject({ state: 'done', kind: 'copy', filesDone: 2, filesTotal: 2, bytesDone: 7, bytesTotal: 7 })
    expect(job.summary).toBe('2 file đã chép')
    expect(job.errors).toEqual([])
    expect(await readFile(join(remote, 'proj/sub/b.txt'), 'utf8')).toBe('bbbb')
    expect((await stat(join(remote, 'proj/a.txt'))).mtimeMs).toBe(T0 * 1000) // times survive the trip
  })

  it('downloads, and copies between two servers-side folders', async () => {
    await put(remote, 'down.txt', 'from server'); await mkdir(join(remote, 'dest'))
    const sid = await connect()
    await finished(ok(await files.transfer(OWNER, { fromSession: sid, paths: ['/down.txt'], toSession: LOCAL_SESSION, toDir: home, mode: 'copy', policy: 'skip' })).jobId)
    expect(await readFile(join(home, 'down.txt'), 'utf8')).toBe('from server')
    const sid2 = await connect()
    await finished(ok(await files.transfer(OWNER, { fromSession: sid, paths: ['/down.txt'], toSession: sid2, toDir: '/dest', mode: 'copy', policy: 'skip' })).jobId)
    expect(await readFile(join(remote, 'dest/down.txt'), 'utf8')).toBe('from server')
  })

  it('asks about name conflicts first, then honours the choice', async () => {
    await put(home, 'a.txt', 'NEW'); await put(remote, 'a.txt', 'OLD')
    const sid = await connect()
    const req = { fromSession: LOCAL_SESSION, paths: [join(home, 'a.txt')], toSession: sid, toDir: '/' }
    expect(ok(await files.conflicts(OWNER, req)).names).toEqual(['a.txt'])
    await finished(ok(await files.transfer(OWNER, { ...req, mode: 'copy', policy: 'skip' })).jobId)
    expect(await readFile(join(remote, 'a.txt'), 'utf8')).toBe('OLD')
    await finished(ok(await files.transfer(OWNER, { ...req, mode: 'copy', policy: 'keep-both' })).jobId)
    expect(await readFile(join(remote, 'a (2).txt'), 'utf8')).toBe('NEW')
    await finished(ok(await files.transfer(OWNER, { ...req, mode: 'copy', policy: 'overwrite' })).jobId)
    expect(await readFile(join(remote, 'a.txt'), 'utf8')).toBe('NEW')
  })

  it('moving within one server is a rename; moving to the same folder does nothing', async () => {
    await put(remote, 'm.txt', 'm'); await mkdir(join(remote, 'to'))
    const sid = await connect()
    const before = (await stat(join(remote, 'm.txt'))).ino
    const job = await finished(ok(await files.transfer(OWNER, { fromSession: sid, paths: ['/m.txt'], toSession: sid, toDir: '/to', mode: 'move', policy: 'skip' })).jobId)
    expect(job.summary).toBe('0 file đã chuyển, 1 mục đã chuyển')
    expect((await stat(join(remote, 'to/m.txt'))).ino).toBe(before)
    const same = await finished(ok(await files.transfer(OWNER, { fromSession: sid, paths: ['/to/m.txt'], toSession: sid, toDir: '/to', mode: 'move', policy: 'skip' })).jobId)
    expect(same.summary).toBe('Đã ở đúng chỗ')
    expect(await readFile(join(remote, 'to/m.txt'), 'utf8')).toBe('m')
  })

  it('moving from disk to server copies, then removes the original', async () => {
    await put(home, 'mv.txt', 'moved')
    const sid = await connect()
    await finished(ok(await files.transfer(OWNER, { fromSession: LOCAL_SESSION, paths: [join(home, 'mv.txt')], toSession: sid, toDir: '/', mode: 'move', policy: 'skip' })).jobId)
    expect(await readFile(join(remote, 'mv.txt'), 'utf8')).toBe('moved')
    await expect(stat(join(home, 'mv.txt'))).rejects.toThrow()
  })

  it('validates what the UI sends', async () => {
    await put(home, 'f', 'x')
    const good = { fromSession: LOCAL_SESSION, paths: [join(home, 'f')], toSession: LOCAL_SESSION, toDir: home, mode: 'copy', policy: 'skip' }
    for (const bad of [null, {}, { ...good, paths: [] }, { ...good, paths: 'f' }, { ...good, paths: [7] }, { ...good, toDir: join(home, 'missing') }, { ...good, toDir: join(home, 'f') }, { ...good, fromSession: 'x' }]) {
      expect(fail(await files.transfer(OWNER, bad))).toBeTruthy()
    }
    expect(jobs).toEqual([])
  })

  it('errors on individual files are listed, and the job still finishes', async () => {
    await put(home, 'ok.txt', 'ok')
    const sid = await connect()
    const job = await finished(ok(await files.transfer(OWNER, { fromSession: LOCAL_SESSION, paths: [join(home, 'ok.txt'), join(home, 'gone.txt')], toSession: sid, toDir: '/', mode: 'copy', policy: 'skip' })).jobId)
    expect(job.state).toBe('done')
    expect(job.errors).toEqual([{ path: join(home, 'gone.txt'), message: 'No longer exists' }])
    expect(job.summary).toBe('1 file đã chép, 1 thất bại')
  })

  it('a job can be cancelled from the UI', async () => {
    for (let i = 0; i < 300; i++) await put(home, `many/f${i}.txt`, 'x'.repeat(2000))
    const sid = await connect()
    const { jobId } = ok(await files.transfer(OWNER, { fromSession: LOCAL_SESSION, paths: [join(home, 'many')], toSession: sid, toDir: '/', mode: 'copy', policy: 'skip' }))
    files.cancel(2, jobId) // someone else's window: ignored
    await until(() => jobs.some((j) => j.id === jobId && j.filesDone > 0), 'some progress')
    files.cancel(OWNER, jobId)
    const job = await finished(jobId)
    expect(job.state).toBe('cancelled')
    expect((await readdir(join(remote, 'many'))).filter((n) => n.includes('.mymius')).length).toBe(0)
  })

  it('deleting on disk uses the trash; deleting on a server is permanent', async () => {
    await put(home, 'local.txt', 'l'); await put(remote, 'remote.txt', 'r')
    const sid = await connect()
    const a = await finished(ok(await files.delete(OWNER, LOCAL_SESSION, [join(home, 'local.txt')])).jobId)
    expect(trashed).toEqual([join(home, 'local.txt')])
    expect(a.summary).toBe('1 đã xóa (đã chuyển vào thùng rác)')
    const b = await finished(ok(await files.delete(OWNER, sid, ['/remote.txt'])).jobId)
    expect(b.summary).toBe('1 đã xóa')
    expect(await readdir(remote)).toEqual([])
  })

  it('the job list has running and recently finished jobs, per window', async () => {
    await put(home, 'f', 'x')
    await finished(ok(await files.transfer(OWNER, { fromSession: LOCAL_SESSION, paths: [join(home, 'f')], toSession: LOCAL_SESSION, toDir: home, mode: 'copy', policy: 'keep-both' })).jobId)
    expect(files.listJobs(OWNER)).toHaveLength(1)
    expect(files.listJobs(2)).toEqual([...files.listJobs(2)]) // finished jobs are shared history, running ones are not
  })
})

describe('folder sync between two panes', () => {
  const compare = (over: Record<string, unknown> = {}) => ({
    left: { sessionId: LOCAL_SESSION, path: join(home, 'site') },
    right: { sessionId: '', path: '/site' },
    compare: 'quick',
    ignore: [],
    ...over
  })

  it('compares a disk folder with a server folder and syncs it, one direction', async () => {
    await put(home, 'site/index.html', 'v2', T0 + 5000); await put(home, 'site/new.css', 'css'); await put(home, 'site/img/a.png', 'png')
    await put(remote, 'site/index.html', 'v1', T0); await put(remote, 'site/old.txt', 'old')
    const sid = await connect()
    const cmp = ok(await files.syncCompare(OWNER, compare({ right: { sessionId: sid, path: '/site' } })))
    expect(Object.fromEntries(cmp.items.map((i) => [i.rel, i.status]))).toEqual({
      'index.html': 'left-newer', 'new.css': 'left-only', img: 'left-only', 'img/a.png': 'left-only', 'old.txt': 'right-only'
    })

    const req = { compareId: cmp.compareId, mode: 'mirror-ltr', deleteExtras: true, overrides: {} }
    const { preview } = ok(await files.syncPreview(OWNER, req))
    expect(preview.summary).toMatchObject({ copies: 3, mkdirs: 1, deletes: 1 })
    expect(preview.directions['index.html']).toBe('ltr')
    expect(preview.directions['old.txt']).toBe('ltr') // ltr on a right-only item means: remove it

    const job = await finished(ok(await files.syncRun(OWNER, req)).jobId)
    expect(job).toMatchObject({ kind: 'sync', state: 'done', errors: [] })
    expect(await readFile(join(remote, 'site/index.html'), 'utf8')).toBe('v2')
    expect(await readFile(join(remote, 'site/img/a.png'), 'utf8')).toBe('png')
    expect(await readdir(join(remote, 'site/.mymius-trash/' + (await readdir(join(remote, 'site/.mymius-trash')))[0]!))).toEqual(['old.txt']) // deleted, but recoverable
    // and afterwards the two sides agree
    const again = ok(await files.syncCompare(OWNER, compare({ right: { sessionId: sid, path: '/site' } })))
    expect(again.items.every((i) => i.status === 'same')).toBe(true)
  })

  it('two-way sync and per-item overrides from the UI', async () => {
    await put(home, 'site/l.txt', 'L'); await put(remote, 'site/r.txt', 'R')
    await put(home, 'site/both.txt', 'aa', T0); await put(remote, 'site/both.txt', 'bbbb', T0) // same time, different size: conflict
    const sid = await connect()
    const cmp = ok(await files.syncCompare(OWNER, compare({ right: { sessionId: sid, path: '/site' } })))
    const base = { compareId: cmp.compareId, mode: 'two-way', deleteExtras: false }
    expect(ok(await files.syncPreview(OWNER, { ...base, overrides: {} })).preview.summary.conflicts).toBe(1)
    const overrides = { 'both.txt': 'rtl', 'l.txt': 'skip' }
    await finished(ok(await files.syncRun(OWNER, { ...base, overrides })).jobId)
    expect(await readFile(home + '/site/both.txt', 'utf8')).toBe('bbbb') // the user chose the server's version
    expect(await readFile(join(home, 'site/r.txt'), 'utf8')).toBe('R')
    await expect(stat(join(remote, 'site/l.txt'))).rejects.toThrow() // skipped by the user
  })

  it('refuses folders that are the same or nested, and expired or foreign comparisons', async () => {
    await mkdir(join(home, 'site/inner'), { recursive: true })
    const cmp = (l: string, r: string) => files.syncCompare(OWNER, { left: { sessionId: LOCAL_SESSION, path: l }, right: { sessionId: LOCAL_SESSION, path: r }, compare: 'quick', ignore: [] })
    expect(fail(await cmp(join(home, 'site'), join(home, 'site')))).toMatch(/trùng nhau, hoặc một thư mục nằm trong/)
    expect(fail(await cmp(join(home, 'site'), join(home, 'site/inner')))).toMatch(/nằm trong/)
    expect(fail(await cmp(join(home, 'site/inner'), join(home, 'site')))).toMatch(/nằm trong/)
    expect(fail(await cmp(join(home, 'site'), join(home, 'nope')))).toMatch(/không phải là thư mục/)
    await mkdir(join(home, 'other'))
    const good = ok(await cmp(join(home, 'site'), join(home, 'other')))
    expect(fail(await files.syncPreview(2, { compareId: good.compareId, mode: 'two-way', deleteExtras: false, overrides: {} }))).toMatch(/hết hạn/)
    expect(fail(await files.syncPreview(OWNER, { compareId: 'nope', mode: 'two-way', deleteExtras: false, overrides: {} }))).toMatch(/hết hạn/)
    expect(fail(await files.syncPreview(OWNER, { compareId: good.compareId, mode: 'sideways', deleteExtras: false, overrides: {} }))).toMatch(/chọn cách đồng bộ/)
  })

  it('ignore patterns keep things out of the comparison; nothing to do is said plainly', async () => {
    await put(home, 'site/keep.txt', 'k'); await put(home, 'site/node_modules/x.js', 'x'); await mkdir(join(home, 'other'))
    const cmp = ok(await files.syncCompare(OWNER, { left: { sessionId: LOCAL_SESSION, path: join(home, 'site') }, right: { sessionId: LOCAL_SESSION, path: join(home, 'other') }, compare: 'quick', ignore: ['node_modules'] }))
    expect(cmp.items.map((i) => i.rel)).toEqual(['keep.txt'])
    await finished(ok(await files.syncRun(OWNER, { compareId: cmp.compareId, mode: 'mirror-ltr', deleteExtras: false, overrides: {} })).jobId)
    const again = ok(await files.syncCompare(OWNER, { left: { sessionId: LOCAL_SESSION, path: join(home, 'site') }, right: { sessionId: LOCAL_SESSION, path: join(home, 'other') }, compare: 'quick', ignore: ['node_modules'] }))
    expect(fail(await files.syncRun(OWNER, { compareId: again.compareId, mode: 'mirror-ltr', deleteExtras: false, overrides: {} }))).toBe('Không có gì để đồng bộ')
  })
})

describe('editing a remote file', () => {
  const waitRemote = (name: string, content: string) => until(async () => (await readFile(join(remote, name), 'utf8').catch(() => '')) === content, `${name} to become ${content}`, 12_000)
  const openEdit = async (name = 'app.conf', content = 'listen 80;\n') => {
    await put(remote, name, content)
    const sid = await connect()
    const r = ok(await files.open(OWNER, sid, '/' + name))
    expect(r.how).toBe('editing')
    const local = opened.at(-1)!
    return { sid, local }
  }

  it('opens a local copy in the editor and uploads it whenever it is saved', async () => {
    const { local } = await openEdit()
    expect(await readFile(local, 'utf8')).toBe('listen 80;\n')
    expect(files.listEdits(OWNER)).toMatchObject([{ name: 'app.conf', remotePath: '/app.conf', hostLabel: 'box', state: 'synced' }])
    await writeFile(local, 'listen 8080;\n')
    await waitRemote('app.conf', 'listen 8080;\n')
    await writeFile(local, 'listen 9090;\n')
    await waitRemote('app.conf', 'listen 9090;\n')
    expect(conflicts).toEqual([])
    expect(edits.some((e) => e.state === 'uploading')).toBe(true)
  })

  it('if the server copy changed meanwhile, asks first: overwrite', async () => {
    const { local } = await openEdit()
    await put(remote, 'app.conf', 'someone else\n', T0 + 9000)
    conflictChoice = 'overwrite'
    await writeFile(local, 'mine\n')
    await waitRemote('app.conf', 'mine\n')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ kind: 'modified', remotePath: '/app.conf' })
  })

  it('reload: the server version comes back and my edits are kept aside', async () => {
    const { local } = await openEdit()
    await put(remote, 'app.conf', 'someone else\n', T0 + 9000)
    conflictChoice = 'reload'
    await writeFile(local, 'my precious edits\n')
    await until(async () => (await readFile(local, 'utf8')) === 'someone else\n', 'local copy replaced')
    expect(await readFile(join(remote, 'app.conf'), 'utf8')).toBe('someone else\n')
    const aside = (await readdir(join(local, '..'))).find((n) => n.includes('.local-'))!
    expect(await readFile(join(local, '..', aside), 'utf8')).toBe('my precious edits\n')
  })

  it('cancel: nothing is uploaded, and the edit shows as not synced', async () => {
    const { local } = await openEdit()
    await put(remote, 'app.conf', 'someone else\n', T0 + 9000)
    conflictChoice = 'cancel'
    await writeFile(local, 'mine\n')
    await until(() => files.listEdits(OWNER)[0]?.state === 'unsynced', 'unsynced')
    expect(await readFile(join(remote, 'app.conf'), 'utf8')).toBe('someone else\n')
  })

  it('closing an unsynced edit keeps the file unless told to discard; a clean one is removed', async () => {
    const { local } = await openEdit()
    await put(remote, 'app.conf', 'other\n', T0 + 9000)
    await writeFile(local, 'unsaved to server\n')
    await until(() => files.listEdits(OWNER)[0]?.state === 'unsynced', 'unsynced')
    const id = files.listEdits(OWNER)[0]!.id
    await files.closeEdit(OWNER, id, false)
    expect(await readFile(local, 'utf8')).toBe('unsaved to server\n')
    expect(files.listEdits(OWNER)).toEqual([])
    expect(edits.at(-1)).toMatchObject({ id, state: 'closed' })

    const second = await openEdit('two.conf', '2\n')
    await files.closeEdit(OWNER, files.listEdits(OWNER)[0]!.id, false)
    await expect(stat(second.local)).rejects.toThrow()
  })

  it('refuses things that are not editable files, or are too big, and other windows cannot close mine', async () => {
    await mkdir(join(remote, 'dir'))
    const sid = await connect()
    expect(fail(await files.open(OWNER, sid, '/dir'))).toMatch(/Chỉ có thể sửa file/)
    expect(fail(await files.open(OWNER, sid, '/missing'))).toMatch(/Chỉ có thể sửa file/)
    await put(remote, 'f', 'x')
    ok(await files.open(OWNER, sid, '/f'))
    await files.closeEdit(2, files.listEdits(OWNER)[0]!.id, true)
    expect(files.listEdits(OWNER)).toHaveLength(1)
  })

  it('local files are simply opened with the system app', async () => {
    await put(home, 'note.txt', 'n')
    expect(ok(await files.open(OWNER, LOCAL_SESSION, join(home, 'note.txt'))).how).toBe('opened')
    expect(opened).toEqual([join(home, 'note.txt')])
  })

  it('the edit keeps working after its file pane disconnects', async () => {
    const { sid, local } = await openEdit()
    await files.disconnect(OWNER, sid)
    await writeFile(local, 'saved after disconnect\n')
    await waitRemote('app.conf', 'saved after disconnect\n')
  })
})

describe('choosing the program a file opens with', () => {
  const VSCODE = { kind: 'app' as const, path: '/opt/editor/bin/edit', name: 'Editor' }
  const waitRemote = (name: string, content: string) => until(async () => (await readFile(join(remote, name), 'utf8').catch(() => '')) === content, `${name} to become ${content}`, 12_000)

  it('asks which program to use when nothing is saved, for opening, editing and "open with"', async () => {
    await put(remote, 'index.html', '<p>hi</p>')
    const sid = await connect()
    for (const mode of ['open', 'edit', 'with'] as const) {
      const r = ok(await files.open(OWNER, sid, '/index.html', { mode }))
      expect(r).toMatchObject({ how: 'ask', name: 'index.html', ext: '.html' })
    }
    expect(opened).toEqual([])
    expect(files.listEdits(OWNER)).toEqual([])
  })

  it('opens the file in the chosen program, which edits the local copy that is uploaded on save', async () => {
    await put(remote, 'index.html', '<p>hi</p>')
    const sid = await connect()
    expect(ok(await files.open(OWNER, sid, '/index.html', { mode: 'edit', app: VSCODE })).how).toBe('editing')
    expect(launched).toHaveLength(1)
    expect(launched[0]!.app).toBe(VSCODE.path)
    expect(opened).toEqual([]) // not the system default (the browser)
    expect(await readFile(launched[0]!.file, 'utf8')).toBe('<p>hi</p>')
    await writeFile(launched[0]!.file, '<p>edited</p>')
    await waitRemote('index.html', '<p>edited</p>')
  })

  it('remembers a choice for the extension: the same type no longer asks, another type still does', async () => {
    await put(remote, 'a.html', 'a'); await put(remote, 'b.html', 'b'); await put(remote, 'c.txt', 'c')
    const sid = await connect()
    ok(await files.open(OWNER, sid, '/a.html', { mode: 'open', app: VSCODE, remember: 'ext' }))
    expect(ok(await files.open(OWNER, sid, '/b.html', { mode: 'open' })).how).toBe('editing')
    expect(launched.map((l) => l.app)).toEqual([VSCODE.path, VSCODE.path])
    expect(ok(await files.open(OWNER, sid, '/c.txt', { mode: 'open' })).how).toBe('ask')
    expect(openWith.list().map((a) => a.key)).toEqual(['.html'])
  })

  it('"for all files" covers every type, and an extension can override it', async () => {
    const OTHER = { kind: 'app' as const, path: '/opt/other/bin/view', name: 'Other' }
    await put(remote, 'a.html', 'a'); await put(remote, 'x.md', 'x')
    const sid = await connect()
    ok(await files.open(OWNER, sid, '/x.md', { mode: 'open', app: VSCODE, remember: 'all' }))
    ok(await files.open(OWNER, sid, '/a.html', { mode: 'open', app: OTHER, remember: 'ext' }))
    ok(await files.open(OWNER, sid, '/x.md', { mode: 'open' }))
    ok(await files.open(OWNER, sid, '/a.html', { mode: 'open' }))
    expect(launched.map((l) => l.app)).toEqual([VSCODE.path, OTHER.path, VSCODE.path, OTHER.path])
  })

  it('Edit never settles for "the system default"; Open can', async () => {
    await put(remote, 'a.html', 'a')
    const sid = await connect()
    ok(await files.open(OWNER, sid, '/a.html', { mode: 'open', app: { kind: 'system' }, remember: 'ext' }))
    expect(opened).toHaveLength(1) // opened with the system default, as chosen
    expect(ok(await files.open(OWNER, sid, '/a.html', { mode: 'open' })).how).toBe('editing') // saved choice used silently
    expect(ok(await files.open(OWNER, sid, '/a.html', { mode: 'edit' })).how).toBe('ask') // but editing wants a real program
    expect(fail(await files.open(OWNER, sid, '/a.html', { mode: 'edit', app: { kind: 'system' } }))).toMatch(/ứng dụng cụ thể/)
  })

  it('local files can be opened with a chosen program too, and a bad choice is rejected', async () => {
    await put(home, 'n.txt', 'n')
    expect(ok(await files.open(OWNER, LOCAL_SESSION, join(home, 'n.txt'), { mode: 'edit', app: VSCODE })).how).toBe('opened')
    expect(launched).toEqual([{ app: VSCODE.path, file: join(home, 'n.txt') }])
    expect(fail(await files.open(OWNER, LOCAL_SESSION, join(home, 'n.txt'), { mode: 'open', app: { kind: 'app', path: 'relative/editor' } as never }))).toMatch(/không hợp lệ/)
    expect(fail(await files.open(OWNER, LOCAL_SESSION, join(home, 'n.txt'), { mode: 'burn' } as never))).toMatch(/không hợp lệ/)
  })

  it('a saved choice can be removed, and survives a restart', async () => {
    await put(remote, 'a.html', 'a')
    const sid = await connect()
    ok(await files.open(OWNER, sid, '/a.html', { mode: 'open', app: VSCODE, remember: 'ext' }))
    const again = new OpenWithStore(join(base, 'open-with.json'))
    await again.load()
    expect(again.list()).toEqual([{ key: '.html', label: '.html', app: VSCODE }])
    await again.remove('.html')
    const third = new OpenWithStore(join(base, 'open-with.json'))
    await third.load()
    expect(third.list()).toEqual([])
  })
})

describe('window shutdown', () => {
  it('closing a window ends its connections, edits and running jobs', async () => {
    await put(remote, 'f', 'x')
    const sid = await connect()
    ok(await files.open(OWNER, sid, '/f'))
    await files.closeOwnedBy(OWNER)
    expect(files.listEdits(OWNER)).toEqual([])
    expect(fail(await files.list(OWNER, sid, '/'))).toMatch(/không còn mở/)
    await until(() => server.connectionCount() === 0, 'all connections closed')
  })
})
