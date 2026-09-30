import { createReadStream, createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import nodePath from 'node:path'
import {
  AlreadyExistsError,
  runPool,
  type EntryKind,
  type FileEntry,
  type FileSystemProvider,
  type PathApi,
  type ProviderCapabilities,
  type ReadOptions,
  type WriteOptions
} from '@mymius/core'
import type { Readable, Writable } from 'node:stream'

function kindOf(st: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (st.isDirectory()) return 'directory'
  if (st.isFile()) return 'file'
  if (st.isSymbolicLink()) return 'symlink'
  return 'other'
}

/** The machine's own disk. Uses the native path flavour (posix on macOS/Linux, win32 on Windows). */
export class LocalProvider implements FileSystemProvider {
  readonly id: string = 'local'
  readonly kind = 'local'
  readonly path: PathApi = nodePath
  readonly capabilities: ProviderCapabilities = {
    atomicRename: true,
    setMtime: true,
    chmod: process.platform !== 'win32',
    remoteHash: false,
    mtimeResolutionMs: 1,
    symlinks: true
  }

  async list(dir: string): Promise<FileEntry[]> {
    const names = await fs.readdir(dir)
    const out: FileEntry[] = []
    await runPool(names, 16, async (name) => {
      const entry = await this.stat(nodePath.join(dir, name))
      if (entry) out.push(entry) // entry vanished between readdir and lstat: skip
    })
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async stat(path: string): Promise<FileEntry | null> {
    try {
      const st = await fs.lstat(path)
      return {
        name: nodePath.basename(path),
        path,
        kind: kindOf(st),
        size: st.size,
        mtimeMs: st.mtimeMs,
        mode: st.mode & 0o777
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  realpath(path: string): Promise<string> {
    return fs.realpath(path)
  }

  createReadStream(path: string, opts: ReadOptions = {}): Readable {
    return createReadStream(path, opts)
  }

  createWriteStream(path: string, opts: WriteOptions = {}): Writable {
    return createWriteStream(path, {
      flags: opts.start ? 'r+' : 'w',
      ...(opts.start ? { start: opts.start } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {})
    })
  }

  async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await fs.mkdir(path, { recursive: opts.recursive ?? false })
  }

  async rename(from: string, to: string, opts: { overwrite?: boolean } = {}): Promise<void> {
    if (!opts.overwrite && (await this.stat(to))) throw new AlreadyExistsError(to)
    await fs.rename(from, to)
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await fs.rm(path, { recursive: opts.recursive ?? false, force: true })
  }

  async setTimes(path: string, mtimeMs: number): Promise<void> {
    const t = mtimeMs / 1000
    await fs.utimes(path, t, t)
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (process.platform === 'win32') return
    await fs.chmod(path, mode)
  }

  async dispose(): Promise<void> {}
}
