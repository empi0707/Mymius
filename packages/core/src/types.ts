import type path from 'node:path'

type PlatformPath = typeof path.posix
import type { Readable, Writable } from 'node:stream'

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface FileEntry {
  name: string
  path: string
  kind: EntryKind
  size: number
  /** Milliseconds since epoch; null when the backend cannot report it (e.g. FTP without MDTM). */
  mtimeMs: number | null
  /** Permission bits (0o777 mask) when known. */
  mode?: number
}

/** Identity of a file's content as far as the backend can tell cheaply. */
export interface FileVersion {
  size: number
  mtimeMs: number | null
  etag?: string
}

/** The subset of node:path a provider needs. Local uses the native flavour, remotes use posix. */
export type PathApi = Pick<
  PlatformPath,
  'sep' | 'join' | 'dirname' | 'basename' | 'relative' | 'isAbsolute' | 'extname'
>

export interface ProviderCapabilities {
  /** rename() can replace an existing file in one step. */
  atomicRename: boolean
  setMtime: boolean
  chmod: boolean
  /** hash() is implemented server-side (cheaper than downloading). */
  remoteHash: boolean
  /** Granularity of stored mtimes, used to pick a comparison tolerance. */
  mtimeResolutionMs: number
  symlinks: boolean
}

export interface WriteOptions {
  /** Byte offset to start writing at (resume). */
  start?: number
  mode?: number
}

export interface ReadOptions {
  start?: number
  end?: number
}

/**
 * The one abstraction the file manager, folder sync and remote edit are built on.
 * Implementations: local disk, SFTP, FTP, S3, WebDAV, ...
 */
export interface FileSystemProvider {
  readonly id: string
  readonly kind: string
  readonly path: PathApi
  readonly capabilities: ProviderCapabilities

  list(dir: string): Promise<FileEntry[]>
  /** Returns null when the path does not exist. Does not follow symlinks. */
  stat(path: string): Promise<FileEntry | null>
  realpath(path: string): Promise<string>
  createReadStream(path: string, opts?: ReadOptions): Readable
  createWriteStream(path: string, opts?: WriteOptions): Writable
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string, opts?: { overwrite?: boolean }): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>
  setTimes(path: string, mtimeMs: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  /** Optional server-side hash (e.g. sha256sum over SSH exec). */
  hash?(path: string, algorithm: 'sha256'): Promise<string>
  dispose(): Promise<void>
}
