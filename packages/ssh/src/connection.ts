import type { Duplex } from 'node:stream'
import { Client, type ClientChannel, type ConnectConfig, type HostFingerprintVerifier, type SFTPWrapper } from 'ssh2'
import { HostKeyRejectedError } from './errors'
import { ShellSession } from './shell'
import { call, toOpenSshFingerprint } from './util'

export interface HostKeyInfo {
  host: string
  port: number
  /** As printed by OpenSSH: "SHA256:" + unpadded base64. Compare against known_hosts. */
  fingerprint: string
}

export interface SshConnectOptions {
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
   * Return true to continue (known host, or the user accepted it). Return false or throw to abort;
   * a thrown error is what connect() rejects with.
   */
  verifyHostKey: (info: HostKeyInfo) => boolean | Promise<boolean>
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  /** An already-open stream to tunnel through. Prefer `jump`. */
  sock?: Duplex
  /** Connect through this host first (ProxyJump / bastion). It may itself have a `jump`. */
  jump?: SshConnectOptions
  /** Override negotiation, e.g. to enable legacy algorithms an old server still requires. */
  algorithms?: ConnectConfig['algorithms']
}

export interface ShellOptions {
  cols: number
  rows: number
  term?: string
  /** Sent as SSH env requests; servers only honour names they list in AcceptEnv. */
  env?: Record<string, string>
}

/**
 * One authenticated SSH connection. Terminal shells, SFTP and command execution are all channels on
 * it, so opening a file pane next to a terminal on the same host costs no extra login.
 */
export class SshConnection {
  private closedFlag = false
  private closeListeners: ((err?: Error) => void)[] = []
  private lastError: Error | undefined

  private constructor(
    private readonly client: Client,
    readonly info: { host: string; port: number; username: string },
    private readonly jumpConnection?: SshConnection
  ) {
    client.on('error', (e: Error) => { this.lastError = e })
    client.on('close', () => {
      this.closedFlag = true
      for (const l of this.closeListeners) l(this.lastError)
    })
    // Dropping the bastion drops the tunnel, and with it this connection.
    jumpConnection?.onClose(() => client.end())
  }

  static async connect(opts: SshConnectOptions): Promise<SshConnection> {
    const port = opts.port ?? 22
    let jump: SshConnection | undefined
    let sock = opts.sock
    if (opts.jump) {
      jump = await SshConnection.connect(opts.jump)
      try {
        sock = await jump.forwardOut(opts.host, port)
      } catch (err) {
        await jump.dispose()
        throw err
      }
    }

    const client = new Client()
    // Whatever made the host check fail is more useful than ssh2's generic "handshake failed".
    let hostKeyProblem: Error | undefined
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
          ...(sock ? { sock } : {}),
          ...(opts.algorithms ? { algorithms: opts.algorithms } : {}),
          tryKeyboard: Boolean(opts.keyboardInteractive),
          readyTimeout: opts.readyTimeoutMs ?? 20_000,
          keepaliveInterval: opts.keepaliveIntervalMs ?? 15_000,
          hostHash: 'sha256',
          // ssh2 waits for verify() when this returns undefined; @types/ssh2 wrongly says it returns boolean.
          hostVerifier: ((hex: string, verify: (ok: boolean) => void): void => {
            const fingerprint = toOpenSshFingerprint(hex)
            Promise.resolve(opts.verifyHostKey({ host: opts.host, port, fingerprint })).then(
              (ok) => {
                if (!ok) hostKeyProblem = new HostKeyRejectedError(opts.host, port, fingerprint)
                verify(ok)
              },
              (err: Error) => {
                hostKeyProblem = err
                verify(false)
              }
            )
          }) as unknown as HostFingerprintVerifier
        })
      })
    } catch (err) {
      client.end()
      await jump?.dispose()
      throw hostKeyProblem ?? err
    }
    // Shell and SFTP traffic is many small packets; with Nagle each round trip can stall ~40 ms.
    client.setNoDelay(true)
    return new SshConnection(client, { host: opts.host, port, username: opts.username }, jump)
  }

  get closed(): boolean {
    return this.closedFlag
  }

  /** Called when the connection ends (with the error, if it failed). Reconnecting is the caller's job. */
  onClose(listener: (err?: Error) => void): void {
    if (this.closedFlag) return listener(this.lastError)
    this.closeListeners.push(listener)
  }

  sftp(): Promise<SFTPWrapper> {
    return call<SFTPWrapper>((cb) => this.client.sftp(cb))
  }

  async shell(opts: ShellOptions): Promise<ShellSession> {
    const channel = await call<ClientChannel>((cb) =>
      this.client.shell(
        { term: opts.term ?? 'xterm-256color', cols: opts.cols, rows: opts.rows, height: 0, width: 0 },
        { ...(opts.env ? { env: opts.env } : {}) },
        cb
      )
    )
    return new ShellSession(channel)
  }

  exec(command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Remote command timed out: ${command}`)), timeoutMs)
      this.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          return reject(err)
        }
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

  /** A TCP stream to host:port as seen from the server. Basis of jump hosts and port forwarding. */
  forwardOut(host: string, port: number): Promise<Duplex> {
    return call<Duplex>((cb) => this.client.forwardOut('127.0.0.1', 0, host, port, cb))
  }

  async dispose(): Promise<void> {
    if (!this.closedFlag) {
      await new Promise<void>((resolve) => {
        this.client.once('close', () => resolve())
        this.client.end()
      })
    }
    await this.jumpConnection?.dispose()
  }
}
