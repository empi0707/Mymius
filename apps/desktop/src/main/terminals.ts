import { readFile } from 'node:fs/promises'
import { defaultSshAgent } from '@mymius/platform'
import { HISTORY_SCRIPT, TerminalHub, parseHistory, parseOpenRequest, resolveChain, shellQuote, type HostLookup, type ResolvedHost, type SshConnection } from '@mymius/ssh'
import type { HistoryResult, OpenTerminalResult, TerminalDataEvent, TerminalExitEvent } from '../shared/ipc'
import type { ConnectionBroker } from './connections'
import { expandHome } from './vault-service'

/** Where terminal output goes. */
export interface TerminalOutput {
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
      const privateKey = await readFile(expandHome(keyPath), 'utf8').catch(() => { throw new Error(`Không đọc được file khóa ${keyPath}`) })
      return { hop: { ...base, auth: { type: 'key', privateKey, ...(req.auth.passphrase ? { passphrase: req.auth.passphrase } : {}) } }, cols: req.cols, rows: req.rows }
    }
    case 'agent': {
      const socket = defaultSshAgent()
      if (!socket) throw new Error('Không tìm thấy ssh-agent (chưa đặt SSH_AUTH_SOCK)')
      return { hop: { ...base, auth: { type: 'agent', socket } }, cols: req.cols, rows: req.rows }
    }
  }
}

function size(raw: unknown): { cols: number; rows: number } {
  const r = (raw ?? {}) as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000
  if (!ok(r.cols) || !ok(r.rows)) throw new Error('Kích thước terminal không hợp lệ')
  return { cols: r.cols, rows: r.rows }
}

/** Connects the UI's terminal tabs to SSH: validation, connection sharing, output. */
export class TerminalService {
  private readonly hub: TerminalHub
  /** Which window (webContents id) owns each session, so output goes to the right place. */
  private readonly owners = new Map<string, number>()
  /** The connection each session runs on (its own, see ConnectionBroker), used to read the host's shell history. */
  private readonly connections = new Map<string, SshConnection>()

  constructor(private readonly out: TerminalOutput, private readonly broker: ConnectionBroker, private readonly saved: HostLookup) {
    this.hub = new TerminalHub({
      data: (id, data) => {
        const owner = this.owners.get(id)
        if (owner !== undefined) out.sendData(owner, { id, data: new Uint8Array(data) })
      },
      exit: (id, info) => {
        const owner = this.owners.get(id)
        this.owners.delete(id)
        this.connections.delete(id)
        if (owner === undefined) return
        out.sendExit(owner, {
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
      const lease = await this.broker.acquireChain(chain, { dedicated: true })
      try {
        const session = await lease.connection.shell(dims)
        const id = this.hub.add(session, () => void lease.release())
        this.owners.set(id, owner)
        this.connections.set(id, lease.connection)
        return { ok: true, id }
      } catch (err) {
        await lease.release()
        throw err
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /** Recent commands from the history files of the account this terminal is logged in as. Read-only, nothing is stored. */
  async history(owner: number, id: unknown): Promise<HistoryResult> {
    const conn = this.owned(owner, id) ? this.connections.get(id) : undefined
    if (!conn || conn.closed) return { ok: false, error: 'Phiên terminal không còn kết nối' }
    try {
      const r = await conn.exec(`sh -c ${shellQuote(HISTORY_SCRIPT)}`, 10_000)
      if (r.code !== 0 && !r.stdout) return { ok: false, error: r.stderr.trim().slice(0, 200) || 'Không đọc được lịch sử lệnh' }
      return { ok: true, entries: parseHistory(r.stdout) }
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
