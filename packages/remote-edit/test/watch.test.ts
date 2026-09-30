import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalProvider } from '../../providers/src'
import { RemoteEditSession, type SaveOutcome } from '../src'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mymius-watch-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const nextOutcome = (s: RemoteEditSession) => new Promise<SaveOutcome>((res) => s.once('outcome', res))

async function open() {
  await mkdir(join(root, 'server'))
  await writeFile(join(root, 'server', 'f.txt'), 'v1')
  const s = new RemoteEditSession({
    provider: new LocalProvider(),
    remotePath: join(root, 'server', 'f.txt'),
    workRoot: join(root, 'work'),
    openInEditor: async () => {},
    resolveConflict: async () => 'cancel',
    debounceMs: 50
  })
  await s.open()
  return s
}

describe('real file watcher', () => {
  it('uploads after an in-place save', async () => {
    const s = await open()
    const done = nextOutcome(s)
    await writeFile(s.localPath, 'v2 in place')
    expect(await done).toBe('uploaded')
    expect(await readFile(join(root, 'server', 'f.txt'), 'utf8')).toBe('v2 in place')
    await s.close()
  })

  it('uploads after an atomic save (temp file renamed over the original), as most editors do', async () => {
    const s = await open()
    const done = nextOutcome(s)
    await writeFile(s.localPath + '.swp-tmp', 'v2 atomic')
    await rename(s.localPath + '.swp-tmp', s.localPath)
    expect(await done).toBe('uploaded')
    expect(await readFile(join(root, 'server', 'f.txt'), 'utf8')).toBe('v2 atomic')
    await s.close()
  })
})
