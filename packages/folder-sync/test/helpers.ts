import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LocalProvider } from '../../providers/src'
import type { Endpoint } from '../src'

export interface Fixture {
  left: Endpoint
  right: Endpoint
  root: string
  cleanup(): Promise<void>
}

export async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'mymius-sync-'))
  const provider = new LocalProvider()
  const left = { provider, root: join(root, 'left') }
  const right = { provider, root: join(root, 'right') }
  await mkdir(left.root)
  await mkdir(right.root)
  return { left, right, root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Write a file with an explicit mtime (seconds since epoch) so tests never race the clock. */
export async function put(root: string, rel: string, content: string, mtimeSec = 1_700_000_000): Promise<void> {
  const abs = join(root, ...rel.split('/'))
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
  await utimes(abs, mtimeSec, mtimeSec)
}
