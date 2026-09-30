import { runPool, type FileEntry, type FileSystemProvider } from '@mymius/core'
import picomatch from 'picomatch'
import { DEFAULT_IGNORE, TRASH_DIR } from './types'

export interface ScanOptions {
  ignore?: string[]
  signal?: AbortSignal
  concurrency?: number
  onProgress?: (entriesSeen: number) => void
}

export interface ScanResult {
  /** Keyed by '/'-separated path relative to the root. */
  entries: Map<string, FileEntry>
  errors: { path: string; error: Error }[]
}

/** Recursively list `root`. Unreadable directories are reported, not fatal. */
export async function scanTree(
  provider: FileSystemProvider,
  root: string,
  opts: ScanOptions = {}
): Promise<ScanResult> {
  const isIgnored = picomatch([...DEFAULT_IGNORE, ...(opts.ignore ?? [])], { dot: true, basename: true })
  const entries = new Map<string, FileEntry>()
  const errors: ScanResult['errors'] = []

  let level: { abs: string; rel: string }[] = [{ abs: root, rel: '' }]
  while (level.length > 0) {
    if (opts.signal?.aborted) break
    const next: { abs: string; rel: string }[] = []
    await runPool(
      level,
      opts.concurrency ?? 4,
      async (dir) => {
        let children: FileEntry[]
        try {
          children = await provider.list(dir.abs)
        } catch (error) {
          errors.push({ path: dir.abs, error: error as Error })
          return
        }
        for (const child of children) {
          const rel = dir.rel === '' ? child.name : `${dir.rel}/${child.name}`
          if (child.name === TRASH_DIR || isIgnored(rel)) continue
          entries.set(rel, child)
          if (child.kind === 'directory') next.push({ abs: child.path, rel })
        }
        opts.onProgress?.(entries.size)
      },
      opts.signal
    )
    level = next
  }
  return { entries, errors }
}
