import { homedir } from 'node:os'
import path from 'node:path'
import { inspectPrivateKey, type HostLookup, type ResolvedHost } from '@mymius/ssh'
import {
  HOST_PREFIX,
  KEY_PREFIX,
  VaultAuthError,
  VaultCorruptError,
  VaultLockedError,
  VaultStore,
  WeakPassphraseError,
  applyHostInput,
  parseHostProfile,
  parseKeyRecord,
  summarizeHost,
  summarizeKey,
  wouldCreateJumpCycle,
  type HostSummary,
  type KeySummary
} from '@mymius/vault'

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string }

export interface VaultStatus {
  /** "damaged": the file exists but cannot be read; it is left untouched and `error` says why. */
  state: 'uninitialized' | 'locked' | 'unlocked' | 'damaged'
  error?: string
  /** This machine has an OS keychain that may hold the key ("remember on this device"). */
  canRemember: boolean
  remembered: boolean
}

export interface VaultServiceDeps {
  readTextFile(path: string): Promise<string>
  /** Where the system ssh-agent listens, if anywhere. */
  agentSocket(): string | undefined
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(homedir(), p.slice(1)) : p
}

function friendly(err: unknown): string {
  if (err instanceof VaultAuthError) return 'Wrong passphrase'
  if (err instanceof VaultLockedError) return 'The vault is locked'
  if (err instanceof WeakPassphraseError || err instanceof VaultCorruptError) return err.message
  return err instanceof Error ? err.message : String(err)
}

async function attempt<T extends object>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, ...(await fn()) }
  } catch (err) {
    return { ok: false, error: friendly(err) }
  }
}

/**
 * What the UI is allowed to do with the vault. It never returns a password, passphrase or key:
 * hosts and keys go out as redacted summaries, and secrets only flow in. Connecting to a saved host
 * happens by id, with the credentials resolved here, inside the main process.
 */
export class VaultService {
  private readonly hosts
  private readonly keys

  constructor(readonly store: VaultStore, private readonly deps: VaultServiceDeps) {
    this.hosts = store.collection(HOST_PREFIX, parseHostProfile)
    this.keys = store.collection(KEY_PREFIX, parseKeyRecord)
  }

  async status(): Promise<VaultStatus> {
    try {
      return { state: await this.store.state(), canRemember: this.store.canRemember, remembered: await this.store.remembered() }
    } catch (err) {
      return { state: 'damaged', error: friendly(err), canRemember: false, remembered: false }
    }
  }

  create(passphrase: unknown, remember: unknown): Promise<Result<{ recoveryKey: string }>> {
    return attempt(() => this.store.create(str(passphrase), { remember: remember === true }))
  }
  unlock(passphrase: unknown, remember: unknown): Promise<Result> {
    return attempt(async () => { await this.store.unlock(str(passphrase), { remember: remember === true }); return {} })
  }
  unlockWithRecovery(key: unknown, remember: unknown): Promise<Result> {
    return attempt(async () => { await this.store.unlockWithRecoveryKey(str(key), { remember: remember === true }); return {} })
  }
  lock(): Promise<void> {
    return this.store.lock()
  }
  changePassphrase(newPassphrase: unknown): Promise<Result> {
    return attempt(async () => { await this.store.changePassphrase(str(newPassphrase)); return {} })
  }

  // ---- hosts -------------------------------------------------------------------------------------

  listHosts(): Result<{ hosts: HostSummary[] }> {
    try {
      const keyNames = new Map(this.keys.list().map((k) => [k.id, k.value.name]))
      const hosts = this.hosts.list().map(({ id, value }) =>
        summarizeHost(id, value, value.auth.type === 'key' ? keyNames.get(value.auth.keyId) ?? '(deleted key)' : undefined)
      )
      return { ok: true, hosts: hosts.sort((a, b) => a.name.localeCompare(b.name)) }
    } catch (err) {
      return { ok: false, error: friendly(err) }
    }
  }

  saveHost(id: unknown, input: unknown): Promise<Result<{ id: string }>> {
    return attempt(async () => {
      if (id !== undefined && (typeof id !== 'string' || !id.startsWith(HOST_PREFIX))) throw new Error('Invalid host')
      const existing = id ? this.hosts.get(id) : undefined
      if (id && !existing) throw new Error('That host no longer exists')
      const profile = applyHostInput(existing, input)

      if (profile.jumpHostId !== undefined) {
        if (!this.hosts.get(profile.jumpHostId)) throw new Error('The chosen jump host no longer exists')
        const jumpOf = (h: string) => this.hosts.get(h)?.jumpHostId
        if (wouldCreateJumpCycle(jumpOf, id ?? '(new)', profile.jumpHostId)) throw new Error('That jump host would make a loop')
      }
      if (profile.auth.type === 'key' && !this.keys.get(profile.auth.keyId)) throw new Error('The chosen key no longer exists')
      return { id: await this.hosts.put(profile, id) }
    })
  }

  deleteHost(id: unknown): Promise<Result> {
    return attempt(async () => {
      if (typeof id !== 'string' || !id.startsWith(HOST_PREFIX)) throw new Error('Invalid host')
      const users = this.hosts.list().filter((h) => h.value.jumpHostId === id).map((h) => h.value.name)
      if (users.length) throw new Error(`Used as a jump host by: ${users.join(', ')}`)
      await this.hosts.remove(id)
      return {}
    })
  }

  // ---- keys --------------------------------------------------------------------------------------

  listKeys(): Result<{ keys: KeySummary[] }> {
    try {
      const keys = this.keys.list().map((k) => summarizeKey(k.id, k.value)).sort((a, b) => a.name.localeCompare(b.name))
      return { ok: true, keys }
    } catch (err) {
      return { ok: false, error: friendly(err) }
    }
  }

  /** Read a key file from disk into the vault. The UI supplies only the path, never key text. */
  importKey(filePath: unknown, name: unknown, passphrase: unknown): Promise<Result<{ key: KeySummary }>> {
    return attempt(async () => {
      if (typeof filePath !== 'string' || !filePath) throw new Error('Choose a key file')
      const text = await this.deps.readTextFile(expandHome(filePath)).catch(() => { throw new Error('Cannot read that file') })
      const pass = typeof passphrase === 'string' && passphrase ? passphrase : undefined
      const info = inspectPrivateKey(text, pass) // throws a user-facing message if unusable
      const label = typeof name === 'string' && name.trim() ? name.trim() : path.basename(filePath)
      const record = parseKeyRecord({ name: label, privateKey: text, ...(pass ? { passphrase: pass } : {}), fingerprint: info.fingerprint, createdAt: Date.now() })
      const id = await this.keys.put(record)
      return { key: summarizeKey(id, record) }
    })
  }

  deleteKey(id: unknown): Promise<Result> {
    return attempt(async () => {
      if (typeof id !== 'string' || !id.startsWith(KEY_PREFIX)) throw new Error('Invalid key')
      const users = this.hosts.list().filter((h) => h.value.auth.type === 'key' && h.value.auth.keyId === id).map((h) => h.value.name)
      if (users.length) throw new Error(`Still used by: ${users.join(', ')}`)
      await this.keys.remove(id)
      return {}
    })
  }

  // ---- connecting --------------------------------------------------------------------------------

  /** Credentials for a saved host, for the main process only. */
  readonly lookup: HostLookup = {
    resolve: async (id): Promise<ResolvedHost> => {
      if (!id.startsWith(HOST_PREFIX)) throw new Error('Unknown host')
      const h = this.hosts.get(id)
      if (!h) throw new Error('That saved host no longer exists')
      const base = { id, name: h.name, host: h.host, port: h.port, username: h.username, ...(h.jumpHostId ? { jumpHostId: h.jumpHostId } : {}) }
      switch (h.auth.type) {
        case 'password':
          return { ...base, auth: { type: 'password', password: h.auth.password } }
        case 'key': {
          const key = this.keys.get(h.auth.keyId)
          if (!key) throw new Error(`The key used by "${h.name}" was deleted`)
          return { ...base, auth: { type: 'key', privateKey: key.privateKey, ...(key.passphrase ? { passphrase: key.passphrase } : {}) } }
        }
        case 'keyFile': {
          const { path: keyPath, passphrase } = h.auth
          const text = await this.deps.readTextFile(expandHome(keyPath)).catch(() => { throw new Error(`Cannot read the key file ${keyPath}`) })
          return { ...base, auth: { type: 'key', privateKey: text, ...(passphrase ? { passphrase } : {}) } }
        }
        case 'agent': {
          const socket = this.deps.agentSocket()
          if (!socket) throw new Error('No ssh-agent found (SSH_AUTH_SOCK is not set)')
          return { ...base, auth: { type: 'agent', socket } }
        }
      }
    }
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Invalid input')
  return v
}
