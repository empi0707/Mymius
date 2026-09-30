import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, copyFile, getVersion, writeFileAtomic } from '../src'
import { LocalProvider } from '../../providers/src'

let dir: string
const fsx = new LocalProvider()
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-core-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('writeFileAtomic', () => {
  it('replaces the target and leaves no temp files', async () => {
    const f = join(dir, 'a.txt')
    await writeFile(f, 'old')
    await writeFileAtomic(fsx, f, Readable.from(['new content']))
    expect(await readFile(f, 'utf8')).toBe('new content')
    expect(await readdir(dir)).toEqual(['a.txt'])
  })

  it('throws ConflictError and keeps the original when the target changed', async () => {
    const f = join(dir, 'a.txt')
    await writeFile(f, 'v1')
    const seen = await getVersion(fsx, f)
    await writeFile(f, 'someone else wrote this')
    await utimes(f, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    await expect(writeFileAtomic(fsx, f, Readable.from(['mine']), { expect: seen })).rejects.toBeInstanceOf(ConflictError)
    expect(await readFile(f, 'utf8')).toBe('someone else wrote this')
    expect(await readdir(dir)).toEqual(['a.txt'])
  })

  it('expect:null refuses to overwrite an existing file', async () => {
    const f = join(dir, 'a.txt')
    await writeFile(f, 'x')
    await expect(writeFileAtomic(fsx, f, Readable.from(['y']), { expect: null })).rejects.toBeInstanceOf(ConflictError)
  })

  it.skipIf(process.platform === 'win32')('keeps the mode of the replaced file', async () => {
    const f = join(dir, 'run.sh')
    await writeFile(f, 'old', { mode: 0o750 })
    await writeFileAtomic(fsx, f, Readable.from(['new']))
    expect((await stat(f)).mode & 0o777).toBe(0o750)
  })
})

describe('copyFile', () => {
  it('preserves mtime so the next comparison sees the files as equal', async () => {
    const a = join(dir, 'a'), b = join(dir, 'b')
    await writeFile(a, 'data')
    const t = new Date('2024-01-02T03:04:05Z')
    await utimes(a, t, t)
    await copyFile(fsx, a, fsx, b)
    expect((await stat(b)).mtimeMs).toBe((await stat(a)).mtimeMs)
    expect(await readFile(b, 'utf8')).toBe('data')
  })
})
