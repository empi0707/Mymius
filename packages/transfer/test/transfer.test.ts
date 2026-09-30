import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalProvider } from '../../providers/src'
import { deletePaths, findConflicts, freeName, runTransfer, validateName, type TransferProgress } from '../src'

let root: string
let src: string
let dst: string
const local = new LocalProvider()
/** Same disk, but pretends to be another file system, so a move cannot be a plain rename. */
class OtherFs extends LocalProvider {
  override readonly id = 'other'
  failRead = new Set<string>()
  onRead?: (path: string) => void
  override createReadStream(path: string, opts?: Parameters<LocalProvider['createReadStream']>[1]) {
    if (this.failRead.has(path)) throw new Error('simulated read failure')
    this.onRead?.(path)
    return super.createReadStream(path, opts)
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mymius-xfer-'))
  src = join(root, 'src')
  dst = join(root, 'dst')
  await mkdir(src); await mkdir(dst)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel: string, content: string, mtime = 1_700_000_000) => {
  const p = join(src, ...rel.split('/'))
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, content)
  await utimes(p, mtime, mtime)
  return p
}
const tree = async (dir: string, base = dir): Promise<string[]> => {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    out.push(p.slice(base.length + 1).split('\\').join('/') + (e.isDirectory() ? '/' : ''))
    if (e.isDirectory()) out.push(...(await tree(p, base)))
  }
  return out.sort()
}

describe('copy', () => {
  it('copies files and whole folders, keeping modification times, and reports progress', async () => {
    const a = await put('a.txt', 'aaa', 1_600_000_000)
    const dir = join(src, 'proj')
    await put('proj/x.txt', 'xx')
    await put('proj/deep/y.txt', 'yyyy')
    await mkdir(join(src, 'proj/empty'))
    const seen: TransferProgress[] = []
    const r = await runTransfer({ src: local, srcPaths: [a, dir], dst: local, dstDir: dst }, { onProgress: (p) => seen.push(p) })
    expect(r.errors).toEqual([])
    expect(r).toMatchObject({ copied: 3, bytes: 9, skipped: 0, cancelled: false })
    expect(await tree(dst)).toEqual(['a.txt', 'proj/', 'proj/deep/', 'proj/deep/y.txt', 'proj/empty/', 'proj/x.txt'])
    expect((await stat(join(dst, 'a.txt'))).mtimeMs).toBe((await stat(a)).mtimeMs)
    const last = seen.at(-1)!
    expect(last).toMatchObject({ filesDone: 3, filesTotal: 3, bytesDone: 9, bytesTotal: 9 })
    expect(seen.every((p) => p.bytesDone <= p.bytesTotal)).toBe(true)
  })

  it('leaves the source untouched', async () => {
    const a = await put('a.txt', 'keep me')
    await runTransfer({ src: local, srcPaths: [a], dst: local, dstDir: dst })
    expect(await readFile(a, 'utf8')).toBe('keep me')
  })

  it('handles many files in parallel', async () => {
    for (let i = 0; i < 150; i++) await put(`many/f${i}.txt`, `content ${i}`)
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'many')], dst: local, dstDir: dst }, { concurrency: 8 })
    expect(r.copied).toBe(150)
    expect((await readdir(join(dst, 'many'))).length).toBe(150)
  })

  it('an empty selection does nothing', async () => {
    expect(await runTransfer({ src: local, srcPaths: [], dst: local, dstDir: dst })).toMatchObject({ copied: 0, errors: [] })
  })
})

describe('name conflicts', () => {
  beforeEach(async () => {
    await put('a.txt', 'NEW')
    await writeFile(join(dst, 'a.txt'), 'OLD')
  })

  it('findConflicts lists the names that already exist', async () => {
    await put('b.txt', 'b')
    expect(await findConflicts({ src: local, srcPaths: [join(src, 'a.txt'), join(src, 'b.txt')], dst: local, dstDir: dst })).toEqual(['a.txt'])
  })

  it('skip keeps the existing file', async () => {
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'a.txt')], dst: local, dstDir: dst, policy: 'skip' })
    expect(r.skipped).toBe(1)
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('OLD')
  })

  it('overwrite replaces it', async () => {
    await runTransfer({ src: local, srcPaths: [join(src, 'a.txt')], dst: local, dstDir: dst, policy: 'overwrite' })
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('NEW')
  })

  it('keep-both adds a numbered copy and touches nothing else', async () => {
    await runTransfer({ src: local, srcPaths: [join(src, 'a.txt')], dst: local, dstDir: dst, policy: 'keep-both' })
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('OLD')
    expect(await readFile(join(dst, 'a (2).txt'), 'utf8')).toBe('NEW')
    await runTransfer({ src: local, srcPaths: [join(src, 'a.txt')], dst: local, dstDir: dst, policy: 'keep-both' })
    expect(await readFile(join(dst, 'a (3).txt'), 'utf8')).toBe('NEW')
  })

  it('overwrite merges into an existing folder instead of replacing it', async () => {
    await put('d/new.txt', 'n'); await put('d/both.txt', 'src')
    await mkdir(join(dst, 'd')); await writeFile(join(dst, 'd/old.txt'), 'o'); await writeFile(join(dst, 'd/both.txt'), 'dst')
    await runTransfer({ src: local, srcPaths: [join(src, 'd')], dst: local, dstDir: dst, policy: 'overwrite' })
    expect(await tree(join(dst, 'd'))).toEqual(['both.txt', 'new.txt', 'old.txt'])
    expect(await readFile(join(dst, 'd/both.txt'), 'utf8')).toBe('src')
  })

  it('a file cannot replace a folder, or the reverse: reported, nothing lost', async () => {
    await put('thing', 'I am a file')
    await mkdir(join(dst, 'thing')); await writeFile(join(dst, 'thing/keep.txt'), 'k')
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'thing')], dst: local, dstDir: dst, policy: 'overwrite' })
    expect(r.errors[0]?.message).toMatch(/folder with that name/)
    expect(await readFile(join(dst, 'thing/keep.txt'), 'utf8')).toBe('k')
  })

  it('freeName finds the first unused number and keeps the extension', async () => {
    await writeFile(join(dst, 'a (2).txt'), '')
    expect(await freeName(local, dst, 'a.txt')).toBe('a (3).txt')
    expect(await freeName(local, dst, 'noext')).toBe('noext (2)')
  })
})

describe('safety', () => {
  it('refuses to copy a folder into itself or its own subfolder', async () => {
    await put('p/f.txt', 'x'); await mkdir(join(src, 'p/sub'))
    for (const into of [join(src, 'p'), join(src, 'p/sub')]) {
      const r = await runTransfer({ src: local, srcPaths: [join(src, 'p')], dst: local, dstDir: into })
      expect(r.errors[0]?.message).toMatch(/into itself/)
      expect(r.copied).toBe(0)
    }
    expect(await tree(join(src, 'p'))).toEqual(['f.txt', 'sub/'])
  })

  it('a sibling whose name merely starts the same is not "inside"', async () => {
    await put('proj/f.txt', 'x'); await mkdir(join(src, 'proj-backup'))
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'proj')], dst: local, dstDir: join(src, 'proj-backup') })
    expect(r.errors).toEqual([])
    expect(r.copied).toBe(1)
  })

  it('reports a source that vanished, and carries on with the rest', async () => {
    const ok = await put('ok.txt', 'ok')
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'gone.txt'), ok], dst: local, dstDir: dst })
    expect(r.errors).toEqual([{ path: join(src, 'gone.txt'), message: 'No longer exists' }])
    expect(r.copied).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('links are reported, never followed', async () => {
    await put('real.txt', 'r')
    await symlink(join(src, 'real.txt'), join(src, 'link.txt'))
    await put('dir/inside.txt', 'i')
    await symlink(join(src, 'real.txt'), join(src, 'dir/nested-link'))
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'link.txt'), join(src, 'dir')], dst: local, dstDir: dst })
    expect(r.ignored.sort()).toEqual([join(src, 'dir/nested-link'), join(src, 'link.txt')].sort())
    expect(await tree(dst)).toEqual(['dir/', 'dir/inside.txt'])
  })

  it('cancelling stops promptly, reports it, and leaves no temp files behind', async () => {
    for (let i = 0; i < 40; i++) await put(`c/f${i}.txt`, 'x'.repeat(1000))
    const slow = new OtherFs()
    const ac = new AbortController()
    let reads = 0
    slow.onRead = () => { if (++reads === 3) ac.abort() }
    const r = await runTransfer({ src: slow, srcPaths: [join(src, 'c')], dst: local, dstDir: dst }, { signal: ac.signal, concurrency: 1 })
    expect(r.cancelled).toBe(true)
    expect(r.copied).toBeLessThan(40)
    const leftovers = (await tree(dst)).filter((n) => n.includes('.mymius-') || n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('move', () => {
  it('on the same file system it is a rename: instant, and the source is gone', async () => {
    const dir = join(src, 'big'); await put('big/f.txt', 'data')
    const before = (await stat(join(dir, 'f.txt'))).ino
    const r = await runTransfer({ src: local, srcPaths: [dir], dst: local, dstDir: dst, move: true })
    expect(r).toMatchObject({ renamed: 1, copied: 0, errors: [] })
    await expect(stat(dir)).rejects.toThrow()
    expect((await stat(join(dst, 'big/f.txt'))).ino).toBe(before) // same file, not a copy
  })

  it('between different file systems it copies, then removes the source', async () => {
    const a = await put('a.txt', 'A'); const d = await put('d/x.txt', 'X')
    void d
    const r = await runTransfer({ src: new OtherFs(), srcPaths: [a, join(src, 'd')], dst: local, dstDir: dst, move: true })
    expect(r).toMatchObject({ copied: 2, renamed: 0, errors: [] })
    expect(await tree(src)).toEqual([])
    expect(await tree(dst)).toEqual(['a.txt', 'd/', 'd/x.txt'])
  })

  it('a source that did not fully arrive is NOT deleted', async () => {
    await put('d/good.txt', 'g'); const bad = await put('d/bad.txt', 'b'); const fine = await put('fine.txt', 'f')
    const fs = new OtherFs()
    fs.failRead.add(bad)
    const r = await runTransfer({ src: fs, srcPaths: [join(src, 'd'), fine], dst: local, dstDir: dst, move: true })
    expect(r.errors.map((e) => e.path)).toEqual([bad])
    expect(await tree(src)).toEqual(['d/', 'd/bad.txt', 'd/good.txt']) // d kept whole; fine.txt (fully copied) removed
    expect(await readFile(join(dst, 'fine.txt'), 'utf8')).toBe('f')
  })

  it('a move that hits a name conflict falls back to copying and honours the policy', async () => {
    await put('a.txt', 'NEW'); await writeFile(join(dst, 'a.txt'), 'OLD')
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'a.txt')], dst: local, dstDir: dst, move: true, policy: 'overwrite' })
    expect(r.errors).toEqual([])
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('NEW')
    await expect(stat(join(src, 'a.txt'))).rejects.toThrow()
  })

  it('moving with "skip" leaves both files alone', async () => {
    await put('a.txt', 'NEW'); await writeFile(join(dst, 'a.txt'), 'OLD')
    const r = await runTransfer({ src: local, srcPaths: [join(src, 'a.txt')], dst: local, dstDir: dst, move: true, policy: 'skip' })
    expect(r.skipped).toBe(1)
    expect(await readFile(join(src, 'a.txt'), 'utf8')).toBe('NEW')
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('OLD')
  })
})

describe('delete', () => {
  it('removes files and folders, and one failure does not stop the rest', async () => {
    const a = await put('a.txt', 'a'); await put('d/x.txt', 'x')
    const r = await deletePaths(local, [join(src, 'nope-but-fine'), a, join(src, 'd')])
    expect(r.errors).toEqual([])
    expect(r.deleted).toBe(3)
    expect(await tree(src)).toEqual([])
  })

  it('uses the trash function when given, so nothing is destroyed', async () => {
    const a = await put('a.txt', 'a')
    const trashed: string[] = []
    const r = await deletePaths(local, [a], { trash: async (p) => { trashed.push(p) } })
    expect(trashed).toEqual([a])
    expect(r.deleted).toBe(1)
    expect(await readFile(a, 'utf8')).toBe('a') // the fake trash did not remove it: we did not delete behind its back
  })

  it('reports a failing item and continues', async () => {
    const a = await put('a.txt', 'a'); const b = await put('b.txt', 'b')
    const r = await deletePaths(local, [a, b], { trash: async (p) => { if (p === a) throw new Error('cannot trash') } })
    expect(r.errors).toEqual([{ path: a, message: 'cannot trash' }])
    expect(r.deleted).toBe(1)
  })

  it('honours cancellation', async () => {
    const a = await put('a.txt', 'a')
    const ac = new AbortController(); ac.abort()
    expect(await deletePaths(local, [a], { signal: ac.signal })).toMatchObject({ deleted: 0, cancelled: true })
  })
})

describe('validateName', () => {
  it.each([['ok.txt', null], ['', 'Enter a name'], ['  ', 'Enter a name'], ['.', 'not allowed'], ['..', 'not allowed'], ['a/b', 'slashes'], ['a\\b', 'slashes'], ['a\nb', 'slashes'], ['x'.repeat(256), 'too long']])('%j', (name, err) => {
    const got = validateName(name)
    if (err === null) expect(got).toBeNull()
    else expect(got).toContain(err)
  })
})
