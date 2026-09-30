import { posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  AlreadyExistsError,
  NotFoundError,
  type EntryKind,
  type FileEntry,
  type FileSystemProvider,
  type PathApi,
  type ProviderCapabilities,
  type ReadOptions,
  type WriteOptions
} from '@mymius/core'
import { SshConnection, shellQuote, type SshConnectOptions } from '@mymius/ssh'
import type { SFTPWrapper } from 'ssh2'

const STATUS_NO_SUCH_FILE = 2

/** Kept for callers written before the connection logic moved to @mymius/ssh. */
export type SftpConnectOptions = SshConnectOptions

function kindOf(mode: number): EntryKind {
  switch (mode & 0o170000) {
    case 0o040000: return 'directory'
    case 0o100000: return 'file'
    case 0o120000: return 'symlink'
    default: return 'other'
  }
}

function call<T>(fn: (cb: (err: Error | null | undefined, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      fn((err, result) => (err ? reject(err) : resolve(result)))
    } catch (err) {
      reject(err)
    }
  })
}

function isNoSuchFile(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === STATUS_NO_SUCH_FILE
}

/** A remote file system over SFTP (SSH). Paths are POSIX. Retains one SSH connection. */
export class SftpProvider implements FileSystemProvider {
  readonly kind = 'sftp'
  readonly path: PathApi = posix
  capabilities: ProviderCapabilities = {
    atomicRename: false,
    setMtime: true,
    chmod: true,
    remoteHash: false,
    mtimeResolutionMs: 1000, // SFTP v3 carries whole seconds
    symlinks: true
  }
  readonly id: string
  private hashCommand: string | null = null

  private constructor(
    private readonly conn: SshConnection,
    private readonly sftp: SFTPWrapper,
    private readonly ownsConnection: boolean
  ) {
    this.id = `sftp:${conn.info.username}@${conn.info.host}:${conn.info.port}`
  }

  /** Open a dedicated connection. Disposing the provider closes it. */
  static async connect(opts: SshConnectOptions): Promise<SftpProvider> {
    return SftpProvider.fromConnection(await SshConnection.connect(opts), { ownsConnection: true })
  }

  /**
   * Use an SSH connection that already exists (e.g. the one a terminal tab is using), so a file pane
   * next to a terminal does not log in again. The connection stays open when the provider is disposed
   * unless `ownsConnection` is set.
   */
  static async fromConnection(conn: SshConnection, opts: { ownsConnection?: boolean } = {}): Promise<SftpProvider> {
    const sftp = await conn.sftp()
    const provider = new SftpProvider(conn, sftp, opts.ownsConnection ?? false)
    try {
      await provider.probe()
    } catch (err) {
      await provider.dispose()
      throw err
    }
    return provider
  }

  /** Learn what this server supports. Failures just mean "not available". */
  private async probe(): Promise<void> {
    const ext = (this.sftp as unknown as { _extensions?: Record<string, string> })._extensions
    this.capabilities = { ...this.capabilities, atomicRename: ext?.['posix-rename@openssh.com'] === '1' }
    try {
      // Server-side hashing needs an exec channel, which SFTP-only accounts do not have.
      const r = await this.exec('command -v sha256sum >/dev/null 2>&1 && echo sha256sum || { command -v shasum >/dev/null 2>&1 && echo shasum; }')
      const found = r.stdout.trim()
      if (r.code === 0 && found === 'sha256sum') this.hashCommand = 'sha256sum --'
      else if (r.code === 0 && found === 'shasum') this.hashCommand = 'shasum -a 256 --'
    } catch {
      this.hashCommand = null
    }
    this.capabilities = { ...this.capabilities, remoteHash: this.hashCommand !== null }
  }

  get closed(): boolean {
    return this.conn.closed
  }

  /** Called when the connection ends. Reconnecting is the caller's job. */
  onClose(listener: (err?: Error) => void): void {
    this.conn.onClose(listener)
  }

  async homeDir(): Promise<string> {
    return this.realpath('.')
  }

  exec(command: string, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.conn.exec(command, timeoutMs)
  }

  async list(dir: string): Promise<FileEntry[]> {
    const items = await call<{ filename: string; attrs: { mode: number; size: number; mtime: number } }[]>((cb) =>
      this.sftp.readdir(dir, cb as never)
    ).catch(rethrowMissing(dir))
    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => ({
        name: i.filename,
        path: posix.join(dir, i.filename),
        kind: kindOf(i.attrs.mode),
        size: i.attrs.size,
        mtimeMs: i.attrs.mtime * 1000,
        mode: i.attrs.mode & 0o777
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async stat(path: string): Promise<FileEntry | null> {
    try {
      const a = await call<{ mode: number; size: number; mtime: number }>((cb) => this.sftp.lstat(path, cb as never))
      return {
        name: posix.basename(path),
        path,
        kind: kindOf(a.mode),
        size: a.size,
        mtimeMs: a.mtime * 1000,
        mode: a.mode & 0o777
      }
    } catch (err) {
      if (isNoSuchFile(err)) return null
      throw err
    }
  }

  realpath(path: string): Promise<string> {
    return call<string>((cb) => this.sftp.realpath(path, cb)).catch(rethrowMissing(path))
  }

  createReadStream(path: string, opts: ReadOptions = {}): Readable {
    return this.sftp.createReadStream(path, {
      ...(opts.start !== undefined ? { start: opts.start } : {}),
      ...(opts.end !== undefined ? { end: opts.end } : {})
    })
  }

  createWriteStream(path: string, opts: WriteOptions = {}): Writable {
    return this.sftp.createWriteStream(path, {
      flags: opts.start ? 'r+' : 'w',
      ...(opts.start ? { start: opts.start } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {})
    })
  }

  async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    if (!opts.recursive) return this.mkdirOne(path)
    // Walk up to the nearest existing ancestor, then create downwards: one stat per missing level.
    const missing: string[] = []
    for (let cur = path; cur !== '/' && cur !== '.' && cur !== ''; cur = posix.dirname(cur)) {
      const st = await this.stat(cur)
      if (st) {
        if (st.kind !== 'directory') throw new Error(`Không phải thư mục: ${cur}`)
        break
      }
      missing.push(cur)
    }
    for (const dir of missing.reverse()) await this.mkdirOne(dir)
  }

  private async mkdirOne(path: string): Promise<void> {
    try {
      await call<void>((cb) => this.sftp.mkdir(path, cb as never))
    } catch (err) {
      // Servers answer a generic failure for "already exists"; a concurrent creator is fine.
      if ((await this.stat(path))?.kind === 'directory') return
      throw err
    }
  }

  async rename(from: string, to: string, opts: { overwrite?: boolean } = {}): Promise<void> {
    const target = await this.stat(to)
    if (target && !opts.overwrite) throw new AlreadyExistsError(to)
    if (!target) return call<void>((cb) => this.sftp.rename(from, to, cb as never))
    if (this.capabilities.atomicRename) {
      return call<void>((cb) => this.sftp.ext_openssh_rename(from, to, cb as never))
    }
    // SFTP v3 rename refuses to replace: without the OpenSSH extension the swap cannot be atomic.
    await this.remove(to)
    await call<void>((cb) => this.sftp.rename(from, to, cb as never))
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const st = await this.stat(path)
    if (!st) return
    if (st.kind !== 'directory') return call<void>((cb) => this.sftp.unlink(path, cb as never))
    if (opts.recursive) {
      for (const child of await this.list(path)) await this.remove(child.path, { recursive: true })
    }
    await call<void>((cb) => this.sftp.rmdir(path, cb as never))
  }

  setTimes(path: string, mtimeMs: number): Promise<void> {
    const sec = Math.floor(mtimeMs / 1000)
    return call<void>((cb) => this.sftp.utimes(path, sec, sec, cb as never))
  }

  chmod(path: string, mode: number): Promise<void> {
    return call<void>((cb) => this.sftp.chmod(path, mode, cb as never))
  }

  async hash(path: string, _algorithm: 'sha256'): Promise<string> {
    if (!this.hashCommand) throw new Error('Server này không hỗ trợ tính hash phía server')
    const r = await this.exec(`${this.hashCommand} ${shellQuote(path)}`)
    const hex = r.stdout.trim().split(/\s+/)[0] ?? ''
    if (r.code !== 0 || !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Remote hash failed: ${r.stderr.trim() || `exit ${r.code}`}`)
    return hex
  }

  async dispose(): Promise<void> {
    this.sftp.end()
    if (this.ownsConnection) await this.conn.dispose()
  }
}

function rethrowMissing(path: string): (err: unknown) => never {
  return (err) => {
    if (isNoSuchFile(err)) throw new NotFoundError(path)
    throw err
  }
}
