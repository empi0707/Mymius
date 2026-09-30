import { randomBytes } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ConflictError, NotFoundError } from './errors'
import type { FileSystemProvider, FileVersion } from './types'
import { getVersion, mtimeTolerance, versionMatches } from './version'

export interface AtomicWriteOptions {
  /**
   * Optimistic concurrency check performed right before the final rename.
   * undefined: no check. null: target must not exist. FileVersion: target must still match.
   */
  expect?: FileVersion | null
  /** Mode for the new file. Defaults to the mode of the file being replaced. */
  mode?: number
  mtimeMs?: number
  signal?: AbortSignal
  onProgress?: (bytes: number) => void
}

/**
 * Write to a temp file next to the target, verify the target did not change, then rename over it.
 * The original is never touched if anything fails. Returns the version of the written file.
 */
export async function writeFileAtomic(
  dst: FileSystemProvider,
  path: string,
  source: Readable,
  opts: AtomicWriteOptions = {}
): Promise<FileVersion> {
  const p = dst.path
  const tmp = p.join(p.dirname(path), `.${p.basename(path)}.mymius-${randomBytes(4).toString('hex')}.tmp`)
  const existing = await dst.stat(path)
  const mode = opts.mode ?? existing?.mode

  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length
      opts.onProgress?.(written)
      cb(null, chunk)
    }
  })

  try {
    const out = dst.createWriteStream(tmp, mode === undefined ? {} : { mode })
    await pipeline(source, counter, out, opts.signal ? { signal: opts.signal } : {})
    if (mode !== undefined && dst.capabilities.chmod) await dst.chmod(tmp, mode)
    if (opts.mtimeMs !== undefined && dst.capabilities.setMtime) await dst.setTimes(tmp, opts.mtimeMs)
    if (opts.expect !== undefined) {
      const current = await getVersion(dst, path)
      if (!versionMatches(opts.expect, current, mtimeTolerance(dst.capabilities.mtimeResolutionMs))) {
        throw new ConflictError(current)
      }
    }
    await dst.rename(tmp, path, { overwrite: true })
  } catch (err) {
    await dst.remove(tmp).catch(() => undefined)
    throw err
  }

  const after = await getVersion(dst, path)
  if (!after) throw new NotFoundError(path)
  return after
}

export interface CopyOptions {
  preserveMtime?: boolean
  preserveMode?: boolean
  signal?: AbortSignal
  onProgress?: (bytes: number) => void
}

/** Copy a file between any two providers, atomically at the destination. */
export async function copyFile(
  src: FileSystemProvider,
  srcPath: string,
  dst: FileSystemProvider,
  dstPath: string,
  opts: CopyOptions = {}
): Promise<FileVersion> {
  const st = await src.stat(srcPath)
  if (!st) throw new NotFoundError(srcPath)
  const write: AtomicWriteOptions = {}
  if (opts.preserveMtime !== false && st.mtimeMs !== null) write.mtimeMs = st.mtimeMs
  if (opts.preserveMode && st.mode !== undefined) write.mode = st.mode
  if (opts.signal) write.signal = opts.signal
  if (opts.onProgress) write.onProgress = opts.onProgress
  return writeFileAtomic(dst, dstPath, src.createReadStream(srcPath), write)
}
