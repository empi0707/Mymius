import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
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
import { Client, type ConnectConfig, type HostFingerprintVerifier, type SFTPWrapper } from 'ssh2'

const STATUS_NO_SUCH_FILE = 2

export interface HostKeyInfo {
  host: string
  port: number
  /** As printed by OpenSSH: "SHA256:" + unpadded base64. Compare against known_hosts. */
  fingerprint: string
}

export interface SftpConnectOptions {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string | Buffer
  passphrase?: string
  /** ssh-agent socket path, 'pageant', or a Windows named pipe. See defaultSshAgent() in @mymius/platform. */
  agent?: string
  /** Answer keyboard-interactive prompts (2FA, one-time codes). Enables that auth method. */
  keyboardInteractive?: (prompts: { prompt: string; echo: boolean }[]) => Promise<string[]>
  /**
   * Required: there is deliberately no default that trusts unknown hosts.
   * Return true to continue (known host, or the user accepted it), false to abort.
   */
  verifyHostKey: (info: HostKeyInfo) => boolean | Promise<boolean>
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  /** An already-open stream to tunnel through (ProxyJump / bastion). */
  sock?: Duplex
  /** Override negotiation, e.g. to enable legacy algorithms an old server still requires, or to pick a faster cipher. */
  algorithms?: ConnectConfig['algorithms']
}

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

/** Quote for a POSIX shell: everything literal, including spaces, `$`, `;` and quotes. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function toOpenSshFingerprint(hexSha256: string): string {
  return 'SHA256:' + Buffer.from(hexSha256, 'hex').toString('base64').replace(/=+$/, '')
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
  private closedFlag = false
  private closeListeners: ((err?: Error) => void)[] = []
  private lastError: Error | undefined

  private constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    private readonly hostInfo: { host: string; port: number; username: string }
  ) {
    this.id = `sftp:${hostInfo.username}@${hostInfo.host}:${hostInfo.port}`
    client.on('error', (e: Error) => { this.lastError = e })
    client.on('close', () => {
      this.closedFlag = true
      for (const l of this.closeListeners) l(this.lastError)
    })
  }

  static async connect(opts: SftpConnectOptions): Promise<SftpProvider> {
    const port = opts.port ?? 22
    const client = new Client()
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve)
        client.once('error', reject)
        client.once('close', () => reject(new Error('Connection closed before it was established')))
        if (opts.keyboardInteractive) {
          const answer = opts.keyboardInteractive
          client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
            answer(prompts.map((p) => ({ prompt: p.prompt, echo: p.echo ?? false }))).then(finish, () => finish([]))
          })
        }
        client.connect({
          host: opts.host,
          port,
          username: opts.username,
          ...(opts.password !== undefined ? { password: opts.password } : {}),
          ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
          ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          ...(opts.sock ? { sock: opts.sock } : {}),
          ...(opts.algorithms ? { algorithms: opts.algorithms } : {}),
          tryKeyboard: Boolean(opts.keyboardInteractive),
          readyTimeout: opts.readyTimeoutMs ?? 20_000,
          keepaliveInterval: opts.keepaliveIntervalMs ?? 15_000,
          hostHash: 'sha256',
          // ssh2 waits for verify() when this returns undefined; @types/ssh2 wrongly says it returns boolean.
          hostVerifier: ((hex: string, verify: (ok: boolean) => void): void => {
            Promise.resolve(opts.verifyHostKey({ host: opts.host, port, fingerprint: toOpenSshFingerprint(hex) })).then(
              verify,
              () => verify(false)
            )
          }) as unknown as HostFingerprintVerifier
        })
      })
      // SFTP is many small request/response pairs; with Nagle + delayed ACKs each one can stall ~40 ms.
      client.setNoDelay(true)
      const sftp = await call<SFTPWrapper>((cb) => client.sftp(cb))
      const provider = new SftpProvider(client, sftp, { host: opts.host, port, username: opts.username })
      await provider.probe()
      return provider
    } catch (err) {
      client.end()
      throw err
    }
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
    return this.closedFlag
  }

  /** Called when the connection drops (with the error, if it was one). Reconnecting is the caller's job. */
  onClose(listener: (err?: Error) => void): void {
    this.closeListeners.push(listener)
  }

  async homeDir(): Promise<string> {
    return this.realpath('.')
  }

  exec(command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Remote command timed out: ${command}`)), timeoutMs)
      this.client.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err) }
        let stdout = ''
        let stderr = ''
        stream.on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        stream.on('close', (code: number | null) => {
          clearTimeout(timer)
          resolve({ code: code ?? -1, stdout, stderr })
        })
      })
    })
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
        if (st.kind !== 'directory') throw new Error(`Not a directory: ${cur}`)
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
    if (!this.hashCommand) throw new Error('Server-side hashing is not available on this server')
    const r = await this.exec(`${this.hashCommand} ${shellQuote(path)}`)
    const hex = r.stdout.trim().split(/\s+/)[0] ?? ''
    if (r.code !== 0 || !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Remote hash failed: ${r.stderr.trim() || `exit ${r.code}`}`)
    return hex
  }

  async dispose(): Promise<void> {
    if (this.closedFlag) return
    await new Promise<void>((resolve) => {
      this.client.once('close', () => resolve())
      this.client.end()
    })
  }
}

function rethrowMissing(path: string): (err: unknown) => never {
  return (err) => {
    if (isNoSuchFile(err)) throw new NotFoundError(path)
    throw err
  }
}

/** Used by tests to compute the fingerprint of a known key. */
export function fingerprintOfPublicKey(publicKeyBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '')
}
