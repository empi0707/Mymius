import { hashFile, mtimeTolerance, type FileEntry } from '@mymius/core'
import { scanTree, type ScanOptions } from './scan'
import { toAbs } from './paths'
import type { DiffItem, DiffStatus, Endpoint } from './types'

export interface DiffOptions extends ScanOptions {
  /** quick: size + mtime. hash: when sizes match, compare content hashes instead of trusting mtime. */
  compare?: 'quick' | 'hash'
  mtimeToleranceMs?: number
}

export interface DiffResult {
  items: DiffItem[]
  scanErrors: { side: 'left' | 'right'; path: string; error: Error }[]
}

export async function compareFolders(
  left: Endpoint,
  right: Endpoint,
  opts: DiffOptions = {}
): Promise<DiffResult> {
  const [l, r] = await Promise.all([
    scanTree(left.provider, left.root, opts),
    scanTree(right.provider, right.root, opts)
  ])
  const tolerance =
    opts.mtimeToleranceMs ??
    mtimeTolerance(left.provider.capabilities.mtimeResolutionMs, right.provider.capabilities.mtimeResolutionMs)

  const rels = [...new Set([...l.entries.keys(), ...r.entries.keys()])].sort()
  const items: DiffItem[] = []
  for (const rel of rels) {
    const le = l.entries.get(rel)
    const re = r.entries.get(rel)
    const status = await classify(le, re, tolerance, opts.compare === 'hash', async () => {
      const [a, b] = await Promise.all([
        hashFile(left.provider, toAbs(left, rel)),
        hashFile(right.provider, toAbs(right, rel))
      ])
      return a === b
    })
    items.push({ rel, status, ...(le ? { left: le } : {}), ...(re ? { right: re } : {}) })
  }

  return {
    items,
    scanErrors: [
      ...l.errors.map((e) => ({ side: 'left' as const, ...e })),
      ...r.errors.map((e) => ({ side: 'right' as const, ...e }))
    ]
  }
}

async function classify(
  l: FileEntry | undefined,
  r: FileEntry | undefined,
  toleranceMs: number,
  byHash: boolean,
  contentEqual: () => Promise<boolean>
): Promise<DiffStatus> {
  if (!l) return 'right-only'
  if (!r) return 'left-only'
  if (l.kind !== r.kind) return 'type-mismatch'
  if (l.kind !== 'file') return 'same' // directories match by existence; symlinks are handled at plan time

  const sizeEqual = l.size === r.size
  const mtimeKnown = l.mtimeMs !== null && r.mtimeMs !== null
  const delta = mtimeKnown ? (l.mtimeMs as number) - (r.mtimeMs as number) : 0
  const mtimeEqual = mtimeKnown && Math.abs(delta) <= toleranceMs

  if (sizeEqual && mtimeEqual) return 'same'
  if (sizeEqual && (byHash || !mtimeKnown) && (await contentEqual())) return 'same'
  if (!mtimeKnown || mtimeEqual) return 'different'
  return delta > 0 ? 'left-newer' : 'right-newer'
}
