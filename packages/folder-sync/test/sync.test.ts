import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPlan, compareFolders, executePlan, itemDirections, type DiffStatus } from '../src'
import { makeFixture, put, type Fixture } from './helpers'

let fx: Fixture
beforeEach(async () => { fx = await makeFixture() })
afterEach(async () => { await fx.cleanup() })

const statusOf = async () => {
  const { items } = await compareFolders(fx.left, fx.right)
  return Object.fromEntries(items.map((i) => [i.rel, i.status])) as Record<string, DiffStatus>
}

describe('compareFolders', () => {
  it('classifies every kind of difference', async () => {
    await put(fx.left.root, 'same.txt', 'abc')
    await put(fx.right.root, 'same.txt', 'abc')
    await put(fx.left.root, 'only-left.txt', 'l')
    await put(fx.right.root, 'only-right.txt', 'r')
    await put(fx.left.root, 'newer-left.txt', 'v2', 1_700_001_000)
    await put(fx.right.root, 'newer-left.txt', 'v1', 1_700_000_000)
    await put(fx.left.root, 'newer-right.txt', 'v1', 1_700_000_000)
    await put(fx.right.root, 'newer-right.txt', 'v2', 1_700_001_000)
    await put(fx.left.root, 'diff.txt', 'short', 1_700_000_000)
    await put(fx.right.root, 'diff.txt', 'much longer', 1_700_000_000)
    await put(fx.left.root, 'mismatch', 'file')
    await mkdir(join(fx.right.root, 'mismatch'))
    expect(await statusOf()).toEqual({
      'same.txt': 'same',
      'only-left.txt': 'left-only',
      'only-right.txt': 'right-only',
      'newer-left.txt': 'left-newer',
      'newer-right.txt': 'right-newer',
      'diff.txt': 'different',
      mismatch: 'type-mismatch'
    })
  })

  it('treats sub-second mtime jitter as equal (SFTP/FAT precision)', async () => {
    await put(fx.left.root, 'a.txt', 'x', 1_700_000_000)
    await put(fx.right.root, 'a.txt', 'x', 1_700_000_000.4)
    expect((await statusOf())['a.txt']).toBe('same')
  })

  it('hash mode sees through a differing mtime', async () => {
    await put(fx.left.root, 'a.txt', 'same bytes', 1_700_000_000)
    await put(fx.right.root, 'a.txt', 'same bytes', 1_700_009_000)
    expect((await statusOf())['a.txt']).toBe('right-newer') // quick mode trusts mtime
    const { items } = await compareFolders(fx.left, fx.right, { compare: 'hash' })
    expect(items[0]?.status).toBe('same')
  })

  it('honours ignore patterns and never lists the trash folder', async () => {
    await put(fx.left.root, 'src/a.ts', '1')
    await put(fx.left.root, 'node_modules/x/index.js', '2')
    await put(fx.left.root, '.DS_Store', '3')
    await put(fx.left.root, '.mymius-trash/run/old', '4')
    const { items } = await compareFolders(fx.left, fx.right, { ignore: ['node_modules'] })
    expect(items.map((i) => i.rel)).toEqual(['src', 'src/a.ts'])
  })
})

describe('buildPlan', () => {
  beforeEach(async () => {
    await put(fx.left.root, 'new.txt', 'n')
    await put(fx.left.root, 'newer.txt', 'v2', 1_700_001_000)
    await put(fx.right.root, 'newer.txt', 'v1', 1_700_000_000)
    await put(fx.right.root, 'extra.txt', 'e')
    await put(fx.left.root, 'conflict.txt', 'aa', 1_700_000_000)
    await put(fx.right.root, 'conflict.txt', 'bbbb', 1_700_000_000)
  })

  it('mirror-ltr copies and keeps extras unless deleteExtras', async () => {
    const { items } = await compareFolders(fx.left, fx.right)
    const keep = buildPlan(items, { mode: 'mirror-ltr' })
    expect(keep.actions.map((a) => `${a.op}:${a.rel}`).sort()).toEqual(['copy:conflict.txt', 'copy:new.txt', 'copy:newer.txt'])
    expect(keep.skipped.find((s) => s.rel === 'extra.txt')?.reason).toBe('extra-kept')
    const wipe = buildPlan(items, { mode: 'mirror-ltr', deleteExtras: true })
    expect(wipe.actions).toContainEqual({ op: 'delete', side: 'right', rel: 'extra.txt', kind: 'file', phase: 'post' })
  })

  it('two-way sends files toward the side that lacks them or is older, and flags conflicts', async () => {
    const { items } = await compareFolders(fx.left, fx.right)
    const plan = buildPlan(items, { mode: 'two-way' })
    const dirOf = (rel: string) => {
      const a = plan.actions.find((x) => x.rel === rel)
      return a?.op === 'copy' ? a.from : a?.op
    }
    expect(dirOf('new.txt')).toBe('left')
    expect(dirOf('newer.txt')).toBe('left')
    expect(dirOf('extra.txt')).toBe('right')
    expect(dirOf('conflict.txt')).toBeUndefined()
    expect(plan.summary.conflicts).toBe(1)
  })

  it('user overrides win and are reflected in itemDirections', async () => {
    const { items } = await compareFolders(fx.left, fx.right)
    const overrides = new Map([['conflict.txt', 'rtl' as const], ['new.txt', 'skip' as const]])
    const plan = buildPlan(items, { mode: 'two-way', overrides })
    expect(plan.actions).toContainEqual({ op: 'copy', from: 'right', rel: 'conflict.txt', size: 4 })
    expect(plan.actions.some((a) => a.rel === 'new.txt')).toBe(false)
    expect(itemDirections(items, { mode: 'two-way', overrides }).get('new.txt')).toBe('skip')
  })

  it('does not emit child deletes under a directory that is being deleted', async () => {
    await put(fx.right.root, 'gone/deep/f.txt', 'x')
    const { items } = await compareFolders(fx.left, fx.right)
    const plan = buildPlan(items, { mode: 'mirror-ltr', deleteExtras: true })
    const dels = plan.actions.filter((a) => a.op === 'delete').map((a) => a.rel)
    expect(dels).toContain('gone')
    expect(dels).not.toContain('gone/deep')
    expect(dels).not.toContain('gone/deep/f.txt')
  })
})

describe('executePlan', () => {
  it('mirror makes the trees identical, and a second compare finds nothing to do', async () => {
    await put(fx.left.root, 'a/b/c.txt', 'deep')
    await put(fx.left.root, 'top.txt', 'top')
    await mkdir(join(fx.left.root, 'empty-dir'))
    await put(fx.right.root, 'stale.txt', 'stale')
    const { items } = await compareFolders(fx.left, fx.right)
    const report = await executePlan(buildPlan(items, { mode: 'mirror-ltr', deleteExtras: true }), fx.left, fx.right)
    expect(report.failCount).toBe(0)
    expect(await readFile(join(fx.right.root, 'a/b/c.txt'), 'utf8')).toBe('deep')
    expect((await stat(join(fx.right.root, 'empty-dir'))).isDirectory()).toBe(true)
    const after = await compareFolders(fx.left, fx.right)
    expect(after.items.every((i) => i.status === 'same')).toBe(true)
  })

  it('deleted files are recoverable from the trash folder by default', async () => {
    await put(fx.right.root, 'stale.txt', 'keep me safe')
    const { items } = await compareFolders(fx.left, fx.right)
    await executePlan(buildPlan(items, { mode: 'mirror-ltr', deleteExtras: true }), fx.left, fx.right, { runId: 'r1' })
    expect(await readdir(fx.right.root)).toEqual(['.mymius-trash'])
    expect(await readFile(join(fx.right.root, '.mymius-trash/r1/stale.txt'), 'utf8')).toBe('keep me safe')
  })

  it('dry run reports success but changes nothing', async () => {
    await put(fx.left.root, 'a.txt', 'a')
    const { items } = await compareFolders(fx.left, fx.right)
    const report = await executePlan(buildPlan(items, { mode: 'mirror-ltr' }), fx.left, fx.right, { dryRun: true })
    expect(report.okCount).toBe(1)
    expect(await readdir(fx.right.root)).toEqual([])
  })

  it('two-way merges both directions in one run', async () => {
    await put(fx.left.root, 'l.txt', 'L')
    await put(fx.right.root, 'r.txt', 'R')
    const { items } = await compareFolders(fx.left, fx.right)
    await executePlan(buildPlan(items, { mode: 'two-way' }), fx.left, fx.right)
    expect((await readdir(fx.left.root)).sort()).toEqual(['l.txt', 'r.txt'])
    expect((await readdir(fx.right.root)).sort()).toEqual(['l.txt', 'r.txt'])
  })

  it('replaces a directory with a file (type mismatch) when the user picks a direction', async () => {
    await put(fx.left.root, 'x', 'I am a file')
    await put(fx.right.root, 'x/inner.txt', 'inside')
    const { items } = await compareFolders(fx.left, fx.right)
    const plan = buildPlan(items, { mode: 'two-way', overrides: new Map([['x', 'ltr' as const]]) })
    const report = await executePlan(plan, fx.left, fx.right)
    expect(report.failCount).toBe(0)
    expect(await readFile(join(fx.right.root, 'x'), 'utf8')).toBe('I am a file')
  })

  it('a failing action is reported and the rest still run', async () => {
    await put(fx.left.root, 'ok.txt', 'ok')
    await put(fx.left.root, 'bad.txt', 'bad')
    const { items } = await compareFolders(fx.left, fx.right)
    const plan = buildPlan(items, { mode: 'mirror-ltr' })
    // Sabotage: the source disappears after planning.
    const { rm } = await import('node:fs/promises')
    await rm(join(fx.left.root, 'bad.txt'))
    const report = await executePlan(plan, fx.left, fx.right)
    expect(report.okCount).toBe(1)
    expect(report.failCount).toBe(1)
    expect(report.results.find((r) => !r.ok)?.action.rel).toBe('bad.txt')
  })
})
