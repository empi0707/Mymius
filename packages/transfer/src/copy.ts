import { copyFile, runPool, type FileEntry, type FileSystemProvider } from '@mymius/core'
import { freeName } from './names'
import type { TransferOptions, TransferProgress, TransferRequest, TransferResult } from './types'

interface DirTask { dstPath: string }
interface FileTask { srcPath: string; dstPath: string; size: number; root: number }
interface Root {
  srcPath: string
  /** Files in this root that failed, so a move knows not to delete the source. */
  failed: number
}

const sameFileSystem = (a: FileSystemProvider, b: FileSystemProvider): boolean => a === b || (a.id === b.id && a.kind === b.kind)

function isInside(provider: FileSystemProvider, dir: string, maybeAncestor: string): boolean {
  const rel = provider.path.relative(maybeAncestor, dir)
  return rel === '' || (!rel.startsWith('..') && !provider.path.isAbsolute(rel))
}

/** Names in `dstDir` that already exist for any of the sources: the UI asks what to do about them. */
export async function findConflicts(req: Pick<TransferRequest, 'src' | 'srcPaths' | 'dst' | 'dstDir'>): Promise<string[]> {
  const found: string[] = []
  for (const srcPath of req.srcPaths) {
    const name = req.src.path.basename(srcPath)
    if (await req.dst.stat(req.dst.path.join(req.dstDir, name))) found.push(name)
  }
  return found
}

/**
 * Copy (or move) files and folders between any two providers.
 *
 * Nothing is ever half-written at a destination path (each file goes through a temp file). A move
 * removes a source only after everything in it arrived; anything that failed stays where it was.
 * Links and special files are reported, not followed.
 */
export async function runTransfer(req: TransferRequest, opts: TransferOptions = {}): Promise<TransferResult> {
  const { src, dst } = req
  const policy = req.policy ?? 'skip'
  const result: TransferResult = { copied: 0, renamed: 0, skipped: 0, bytes: 0, errors: [], ignored: [], cancelled: false }
  const roots: Root[] = []
  const dirs: DirTask[] = []
  const files: FileTask[] = []

  // 1. Work out what to do with each top-level source.
  for (const srcPath of req.srcPaths) {
    if (opts.signal?.aborted) break
    const st = await src.stat(srcPath)
    if (!st) { result.errors.push({ path: srcPath, message: 'No longer exists' }); continue }
    if (st.kind === 'symlink' || st.kind === 'other') { result.ignored.push(srcPath); continue }
    if (st.kind === 'directory' && sameFileSystem(src, dst) && isInside(dst, req.dstDir, srcPath)) {
      result.errors.push({ path: srcPath, message: 'A folder cannot be copied into itself' })
      continue
    }

    let name = src.path.basename(srcPath)
    let target = dst.path.join(req.dstDir, name)
    const existing = await dst.stat(target)
    if (existing) {
      if (policy === 'skip') { result.skipped++; continue }
      if (policy === 'keep-both') {
        name = await freeName(dst, req.dstDir, name)
        target = dst.path.join(req.dstDir, name)
      } else if ((existing.kind === 'directory') !== (st.kind === 'directory')) {
        result.errors.push({ path: srcPath, message: st.kind === 'directory' ? 'A file with that name already exists' : 'A folder with that name already exists' })
        continue
      }
    }
    // Same file system: a move is a rename, instant even for a huge folder. If the rename is refused
    // (e.g. another drive) fall through to copy + delete.
    if (req.move && sameFileSystem(src, dst) && !(await dst.stat(target))) {
      try {
        await src.rename(srcPath, target, { overwrite: false })
        result.renamed++
        continue
      } catch {
        /* copy instead */
      }
    }
    const rootIndex = roots.push({ srcPath, failed: 0 }) - 1
    if (st.kind === 'file') files.push({ srcPath, dstPath: target, size: st.size, root: rootIndex })
    else await walk(src, dst, srcPath, target, rootIndex, dirs, files, result, opts.signal)
  }

  const total: TransferProgress = {
    filesDone: 0,
    filesTotal: files.length,
    bytesDone: 0,
    bytesTotal: files.reduce((n, f) => n + f.size, 0)
  }
  const report = (current?: string): void => opts.onProgress?.({ ...total, ...(current ? { current } : {}) })
  report()

  // 2. Folders first (parents before children), then files in parallel.
  for (const d of dirs) {
    if (opts.signal?.aborted) break
    try {
      await dst.mkdir(d.dstPath, { recursive: true })
    } catch (err) {
      result.errors.push({ path: d.dstPath, message: (err as Error).message })
    }
  }

  await runPool(files, opts.concurrency ?? 4, async (f) => {
    let last = 0
    try {
      await copyFile(src, f.srcPath, dst, f.dstPath, {
        preserveMode: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onProgress: (n) => {
          total.bytesDone += n - last
          last = n
          report(f.srcPath)
        }
      })
      result.copied++
      result.bytes += f.size
    } catch (err) {
      total.bytesDone -= last
      if (opts.signal?.aborted) return
      roots[f.root]!.failed++
      result.errors.push({ path: f.srcPath, message: (err as Error).message })
    }
    total.filesDone++
    report(f.srcPath)
  }, opts.signal)

  result.cancelled = opts.signal?.aborted ?? false

  // 3. A move deletes only the sources that made it across completely.
  if (req.move && !result.cancelled) {
    for (const root of roots) {
      if (root.failed > 0) continue
      try {
        await src.remove(root.srcPath, { recursive: true })
      } catch (err) {
        result.errors.push({ path: root.srcPath, message: `Copied, but could not remove the original: ${(err as Error).message}` })
      }
    }
  }
  return result
}

async function walk(
  src: FileSystemProvider,
  dst: FileSystemProvider,
  srcDir: string,
  dstDir: string,
  root: number,
  dirs: DirTask[],
  files: FileTask[],
  result: TransferResult,
  signal?: AbortSignal
): Promise<void> {
  dirs.push({ dstPath: dstDir })
  let children: FileEntry[]
  try {
    children = await src.list(srcDir)
  } catch (err) {
    result.errors.push({ path: srcDir, message: (err as Error).message })
    return
  }
  for (const child of children) {
    if (signal?.aborted) return
    // The destination may use another path flavour (Windows disk -> SFTP), so join with its own rules.
    const to = dst.path.join(dstDir, child.name)
    if (child.kind === 'directory') await walk(src, dst, child.path, to, root, dirs, files, result, signal)
    else if (child.kind === 'file') files.push({ srcPath: child.path, dstPath: to, size: child.size, root })
    else result.ignored.push(child.path)
  }
}
