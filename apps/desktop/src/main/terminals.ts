import { readFile } from 'node:fs/promises'
import { defaultSshAgent } from '@mymius/platform'
import {
  ConnectionPool,
  KnownHosts,
  SshConnection,
  TerminalHub,
  chainKey,
  chainToOptions,
  parseOpenRequest,
  resolveChain,
  type HostKeyInfo,
  type HostLookup,
  type ResolvedHost
} from '@mymius/ssh'
import type { OpenTerminalResult, TerminalDataEvent, TerminalExitEvent } from '../shared/ipc'
import { expandHome } from './vault-service'

/** What the terminal service needs from Electron, so it can be exercised without it. */
export interface TerminalHost {
  knownHostsFile: string
  /** Ask the user whether to trust a host seen for the first time. */
  confirmHostKey(info: HostKeyInfo): Promise<boolean>
  sendData(target: number, e: TerminalDataEvent): void
  sendExit(target: number, e: TerminalExitEvent): void
}

async function hopFromRequest(raw: unknown): Promise<{ hop: ResolvedHost; cols: number; rows: number }> {
  const req = parseOpenRequest(raw)
  const base = { id: 'adhoc', name: req.host, host: req.host, port: req.port, username: req.username }
  switch (req.auth.type) {
    case 'password':
      return { hop: { ...base, auth: { type: 'password', password: req.auth.password } }, cols: req.cols, rows: req.rows }
    case 'key': {
      const keyPath = req.auth.keyPath
      const privateKey = await readFile(expandHome(keyPath), 'utf8').catch(() => { throw new Error(`Cannot read the key file ${keyPath}`) })
      return { hop: { ...base, auth: { type: 'key', privateKey, ...(req.auth.passphrase ? { passphrase: req.auth.passphrase } : {}) } }, cols: req.cols, rows: req.rows }
    }
    case 'agent': {
      const socket = defaultSshAgent()
      if (!socket) throw new Error('No ssh-agent found (SSH_AUTH_SOCK is not set)')
      return { hop: { ...base, auth: { type: 'agent', socket } }, cols: req.cols, rows: req.rows }
    }
  }
}

function size(raw: unknown): { cols: number; rows: number } {
  const r = (raw ?? {}) as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000
  if (!ok(r.cols) || !ok(r.rows)) throw new Error('Invalid terminal size')
  return { cols: r.cols, rows: r.rows }
}

/** Connects the UI's terminal tabs to SSH: validation, host key policy, connection sharing, output. */
export class TerminalService {
  private readonly pool = new ConnectionPool()
  private readonly knownHosts: KnownHosts
  private readonly hub: TerminalHub
  /** Which window (webContents id) owns each session, so output goes to the right place. */
  private readonly owners = new Map<string, number>()

  constructor(private readonly host: TerminalHost, private readonly saved: HostLookup) {
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

  /** Open a terminal for a saved host (`{ hostId, cols, rows }`) or an ad-hoc one (`OpenTerminalRequest`). */
  async open(owner: number, raw: unknown): Promise<OpenTerminalResult> {
    try {
      const r = (raw ?? {}) as Record<string, unknown>
      let chain: ResolvedHost[]
      let dims: { cols: number; rows: number }
      if (typeof r.hostId === 'string') {
        dims = size(raw)
        chain = await resolveChain(r.hostId, this.saved)
      } else {
        const adhoc = await hopFromRequest(raw)
        dims = { cols: adhoc.cols, rows: adhoc.rows }
        chain = [adhoc.hop]
      }
      const key = chainKey(chain)
      const verify = this.knownHosts.verifier((info) => this.host.confirmHostKey(info))
      const connection = await this.pool.acquire(key, () => SshConnection.connect(chainToOptions(chain, () => verify)))
      try {
        const session = await connection.shell(dims)
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
