import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { defaultSshAgent } from '@mymius/platform'
import {
  ConnectionPool,
  KnownHosts,
  SshConnection,
  TerminalHub,
  connectionKey,
  parseOpenRequest,
  type HostKeyInfo,
  type OpenRequest,
  type SshConnectOptions
} from '@mymius/ssh'
import type { OpenTerminalResult, TerminalDataEvent, TerminalExitEvent } from '../shared/ipc'

/** What the terminal service needs from Electron, so it can be exercised without it. */
export interface TerminalHost {
  knownHostsFile: string
  /** Ask the user whether to trust a host seen for the first time. */
  confirmHostKey(info: HostKeyInfo): Promise<boolean>
  sendData(target: number, e: TerminalDataEvent): void
  sendExit(target: number, e: TerminalExitEvent): void
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(homedir(), p.slice(1)) : p
}

async function toConnectOptions(req: OpenRequest, verify: SshConnectOptions['verifyHostKey']): Promise<SshConnectOptions> {
  const base = { host: req.host, port: req.port, username: req.username, verifyHostKey: verify }
  switch (req.auth.type) {
    case 'password':
      return { ...base, password: req.auth.password }
    case 'key': {
      const privateKey = await readFile(expandHome(req.auth.keyPath)).catch(() => {
        throw new Error(`Cannot read the key file ${req.auth.type === 'key' ? req.auth.keyPath : ''}`)
      })
      return { ...base, privateKey, ...(req.auth.passphrase ? { passphrase: req.auth.passphrase } : {}) }
    }
    case 'agent': {
      const agent = defaultSshAgent()
      if (!agent) throw new Error('No ssh-agent found (SSH_AUTH_SOCK is not set)')
      return { ...base, agent }
    }
  }
}

/** Connects the UI's terminal tabs to SSH: validation, host key policy, connection sharing, output. */
export class TerminalService {
  private readonly pool = new ConnectionPool()
  private readonly knownHosts: KnownHosts
  private readonly hub: TerminalHub
  /** Which window (webContents id) owns each session, so output goes to the right place. */
  private readonly owners = new Map<string, number>()

  constructor(private readonly host: TerminalHost) {
    this.knownHosts = new KnownHosts(host.knownHostsFile)
    this.hub = new TerminalHub({
      data: (id, data) => {
        const owner = this.owners.get(id)
        if (owner !== undefined) host.sendData(owner, { id, data: new Uint8Array(data) })
      },
      exit: (id, info) => {
        const owner = this.owners.get(id)
        this.owners.delete(id)
        if (owner === undefined) return
        host.sendExit(owner, {
          id,
          ...(info.code !== undefined ? { code: info.code } : {}),
          ...(info.signal ? { signal: info.signal } : {}),
          ...(info.error ? { error: info.error.message } : {})
        })
      }
    })
  }

  async open(owner: number, raw: unknown): Promise<OpenTerminalResult> {
    try {
      const req = parseOpenRequest(raw)
      const key = connectionKey(req)
      const verify = this.knownHosts.verifier((info) => this.host.confirmHostKey(info))
      const connection = await this.pool.acquire(key, async () =>
        SshConnection.connect(await toConnectOptions(req, verify))
      )
      try {
        const session = await connection.shell({ cols: req.cols, rows: req.rows })
        const id = this.hub.add(session, () => void this.pool.release(key, connection))
        this.owners.set(id, owner)
        return { ok: true, id }
      } catch (err) {
        await this.pool.release(key, connection)
        throw err
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  private owned(owner: number, id: unknown): id is string {
    return typeof id === 'string' && this.owners.get(id) === owner
  }

  write(owner: number, id: unknown, data: unknown): void {
    if (this.owned(owner, id)) this.hub.write(id, data)
  }
  resize(owner: number, id: unknown, cols: unknown, rows: unknown): void {
    if (this.owned(owner, id)) this.hub.resize(id, cols, rows)
  }
  ack(owner: number, id: unknown, bytes: unknown): void {
    if (this.owned(owner, id)) this.hub.ack(id, bytes)
  }
  close(owner: number, id: unknown): void {
    if (this.owned(owner, id)) this.hub.close(id)
  }

  /** A window went away: end its terminals. */
  closeOwnedBy(owner: number): void {
    for (const [id, o] of this.owners) if (o === owner) this.hub.close(id)
  }

  closeAll(): void {
    this.hub.closeAll()
  }
}
