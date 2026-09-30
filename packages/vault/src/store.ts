import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HybridClock } from './clock'
import { open, seal, type KdfTuning } from './crypto'
import { mergeRecords, type SyncRecord } from './merge'
import type { SecretStore } from './secret-store'
import {
  changePassphrase as rewrapPassphrase,
  createVault,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  verifyDataKey,
  type VaultMeta
} from './vault'

export type VaultState = 'uninitialized' | 'locked' | 'unlocked'

export const MIN_PASSPHRASE_LENGTH = 10
const REMEMBER_KEY = 'vault-data-key'

export class VaultCorruptError extends Error {
  constructor(detail: string) {
    super(`The vault file is damaged (${detail}). It has not been modified.`)
    this.name = 'VaultCorruptError'
  }
}
export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked')
    this.name = 'VaultLockedError'
  }
}
export class WeakPassphraseError extends Error {
  constructor() {
    super(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`)
    this.name = 'WeakPassphraseError'
  }
}
/** Records from another vault (different data key) were offered for merging. */
export class VaultMismatchError extends Error {
  constructor() {
    super('These records belong to a different vault')
    this.name = 'VaultMismatchError'
  }
}

interface VaultFile {
  format: 1
  deviceId: string
  meta: VaultMeta
  records: SyncRecord[]
}

export interface VaultStoreOptions {
  /** OS-keychain-backed store, used for "remember on this device". Optional. */
  secrets?: SecretStore
  /** Lock after this long without activity. Not applied while the key is remembered on the device. */
  autoLockMs?: number
  /** Test seam: lower the key-derivation cost. */
  kdf?: Partial<KdfTuning>
  now?: () => number
}

export interface Collection<T> {
  list(): { id: string; value: T }[]
  get(id: string): T | undefined
  /** Creates (no id) or replaces (id). Returns the record id. */
  put(value: T, id?: string): Promise<string>
  remove(id: string): Promise<void>
}

/**
 * The local encrypted database. One JSON file of sealed records; the data key lives only in memory
 * while unlocked. Records are sync-shaped (id, hybrid-clock stamp, tombstone) so that merging with
 * another device is a plain union. Nothing about a record - not its name, not its type beyond an id
 * prefix - is readable without the key.
 */
export class VaultStore extends EventEmitter {
  private file: VaultFile | undefined
  private dataKey: Buffer | undefined
  private clock: HybridClock | undefined
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => number

  constructor(
    private readonly path: string,
    private readonly opts: VaultStoreOptions = {}
  ) {
    super()
    this.now = opts.now ?? Date.now
  }

  // ---- state -------------------------------------------------------------------------------------

  async state(): Promise<VaultState> {
    await this.load()
    if (!this.file) return 'uninitialized'
    return this.dataKey ? 'unlocked' : 'locked'
  }

  /** Whether "remember on this device" is on right now. */
  async remembered(): Promise<boolean> {
    return Boolean(await this.opts.secrets?.get(REMEMBER_KEY))
  }

  get canRemember(): boolean {
    return this.opts.secrets !== undefined
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      throw err
    }
    this.file = parseVaultFile(text)
    this.loaded = true
  }

  private setKey(key: Buffer): void {
    this.dataKey = key
    const file = this.file!
    this.clock = new HybridClock(file.deviceId, this.now)
    for (const r of file.records) this.clock.receive(r.hlc)
    this.touch()
    this.emit('state', 'unlocked' satisfies VaultState)
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (!this.dataKey || !this.opts.autoLockMs) return
    this.idleTimer = setTimeout(() => {
      // A remembered key means "don't ask me on this device"; idling out would just re-open it.
      void this.remembered().then((r) => { if (!r) void this.lock() })
    }, this.opts.autoLockMs)
    this.idleTimer.unref?.()
  }

  // ---- lifecycle ---------------------------------------------------------------------------------

  /** Create a new vault. Returns the recovery key, which is shown once and never stored. */
  async create(passphrase: string, opts: { remember?: boolean } = {}): Promise<{ recoveryKey: string }> {
    await this.load()
    if (this.file) throw new Error('A vault already exists')
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new WeakPassphraseError()
    const created = await createVault(passphrase, this.opts.kdf)
    this.file = { format: 1, deviceId: randomBytes(6).toString('hex'), meta: created.meta, records: [] }
    await this.save()
    this.setKey(created.dataKey)
    if (opts.remember) await this.remember()
    return { recoveryKey: created.recoveryKey }
  }

  async unlock(passphrase: string, opts: { remember?: boolean } = {}): Promise<void> {
    await this.load()
    if (!this.file) throw new Error('There is no vault yet')
    if (this.dataKey) return
    this.setKey(await unlockWithPassphrase(this.file.meta, passphrase))
    if (opts.remember) await this.remember()
  }

  async unlockWithRecoveryKey(recoveryKey: string, opts: { remember?: boolean } = {}): Promise<void> {
    await this.load()
    if (!this.file) throw new Error('There is no vault yet')
    if (this.dataKey) return
    this.setKey(unlockWithRecoveryKey(this.file.meta, recoveryKey))
    if (opts.remember) await this.remember()
  }

  /**
   * Set this device up from another device's vault (its metadata and sealed records). The result is
   * locked: the same passphrase or recovery key opens it. Each device gets its own id for its clock.
   */
  async bootstrap(remote: { meta: VaultMeta; records: readonly SyncRecord[] }): Promise<void> {
    await this.load()
    if (this.file) throw new Error('A vault already exists')
    this.file = parseVaultFile(
      JSON.stringify({ format: 1, deviceId: randomBytes(6).toString('hex'), meta: remote.meta, records: remote.records })
    )
    await this.save()
  }

  /** Unlock from the key remembered on this device. False if there is none, or it no longer fits. */
  async tryAutoUnlock(): Promise<boolean> {
    await this.load()
    if (!this.file || this.dataKey || !this.opts.secrets) return this.dataKey !== undefined
    const cached = await this.opts.secrets.get(REMEMBER_KEY)
    if (!cached) return false
    if (!verifyDataKey(this.file.meta, cached)) {
      await this.opts.secrets.delete(REMEMBER_KEY) // stale (passphrase-independent, but vault was replaced)
      return false
    }
    this.setKey(Buffer.from(cached))
    return true
  }

  private async remember(): Promise<void> {
    if (!this.opts.secrets || !this.dataKey) return
    await this.opts.secrets.set(REMEMBER_KEY, this.dataKey)
  }

  /** Stop remembering the key on this device: the passphrase is needed again next time. */
  async forgetDevice(): Promise<void> {
    await this.opts.secrets?.delete(REMEMBER_KEY)
  }

  /** Lock now. Also forgets the device: locking means "ask me again". */
  async lock(): Promise<void> {
    await this.queue.catch(() => undefined)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    await this.forgetDevice()
    if (!this.dataKey) return
    this.dataKey.fill(0)
    this.dataKey = undefined
    this.clock = undefined
    this.emit('state', 'locked' satisfies VaultState)
  }

  async changePassphrase(newPassphrase: string): Promise<void> {
    const key = this.requireKey()
    if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) throw new WeakPassphraseError()
    const meta = await rewrapPassphrase(this.file!.meta, key, newPassphrase, this.opts.kdf)
    await this.mutate(() => { this.file!.meta = meta })
  }

  // ---- data --------------------------------------------------------------------------------------

  private requireKey(): Buffer {
    if (!this.dataKey || !this.file) throw new VaultLockedError()
    this.touch()
    return this.dataKey
  }

  /** A typed view over the records whose ids start with `prefix`. Values are validated on the way out. */
  collection<T>(prefix: string, parse: (raw: unknown) => T): Collection<T> {
    const decode = (rec: SyncRecord): T | undefined => {
      if (rec.deleted || rec.payload === null || !rec.id.startsWith(prefix)) return undefined
      try {
        return parse(JSON.parse(open(this.requireKey(), rec.payload, rec.id).toString('utf8')))
      } catch (err) {
        if (err instanceof VaultLockedError) throw err
        return undefined // unreadable or invalid record: skip it rather than fail the whole list
      }
    }
    return {
      list: () => {
        this.requireKey()
        const out: { id: string; value: T }[] = []
        for (const rec of this.file!.records) {
          const value = decode(rec)
          if (value !== undefined) out.push({ id: rec.id, value })
        }
        return out
      },
      get: (id) => {
        this.requireKey()
        const rec = this.file!.records.find((r) => r.id === id)
        return rec ? decode(rec) : undefined
      },
      put: async (value, id) => {
        const key = this.requireKey()
        if (id !== undefined && !id.startsWith(prefix)) throw new Error('Wrong kind of record')
        const recordId = id ?? `${prefix}${randomUUID()}`
        const payload = seal(key, JSON.stringify(parse(value)), recordId)
        await this.mutate(() => this.upsert({ id: recordId, hlc: this.clock!.tick(), deleted: false, payload }))
        return recordId
      },
      remove: async (id) => {
        this.requireKey()
        if (!id.startsWith(prefix)) throw new Error('Wrong kind of record')
        await this.mutate(() => this.upsert({ id, hlc: this.clock!.tick(), deleted: true, payload: null }))
      }
    }
  }

  private upsert(rec: SyncRecord): void {
    const records = this.file!.records
    const i = records.findIndex((r) => r.id === rec.id)
    if (i >= 0) records[i] = rec
    else records.push(rec)
  }

  // ---- sync (used by the Google Drive backend) ---------------------------------------------------

  /** Everything needed to replicate this vault elsewhere. All of it is ciphertext. */
  snapshot(): { meta: VaultMeta; records: SyncRecord[] } {
    if (!this.file) throw new Error('There is no vault yet')
    return { meta: structuredClone(this.file.meta), records: structuredClone(this.file.records) }
  }

  /**
   * Merge records from another device. They must have been sealed with our data key (checked through
   * the remote metadata), otherwise they would be undecryptable junk. Returns how many records changed.
   */
  async applyRemote(remote: { meta: VaultMeta; records: readonly SyncRecord[] }): Promise<number> {
    const key = this.requireKey()
    if (!verifyDataKey(remote.meta, key)) throw new VaultMismatchError()
    let changed = 0
    await this.mutate(() => {
      const before = new Map(this.file!.records.map((r) => [r.id, r.hlc]))
      const merged = mergeRecords(this.file!.records, remote.records)
      for (const r of merged) {
        if (before.get(r.id) !== r.hlc) changed++
        this.clock!.receive(r.hlc)
      }
      this.file!.records = merged
    })
    return changed
  }

  // ---- persistence -------------------------------------------------------------------------------

  private mutate(change: () => void): Promise<void> {
    const run = this.queue.then(async () => {
      change()
      await this.save()
      this.emit('changed')
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(this.file, null, 1) + '\n', { mode: 0o600 })
    await rename(tmp, this.path)
  }
}

function parseVaultFile(text: string): VaultFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VaultCorruptError('not valid JSON')
  }
  const f = raw as Partial<VaultFile> | null
  if (!f || f.format !== 1) throw new VaultCorruptError('unknown format')
  if (typeof f.deviceId !== 'string' || !f.meta || typeof f.meta.check !== 'string' || !Array.isArray(f.records)) {
    throw new VaultCorruptError('missing fields')
  }
  for (const r of f.records) {
    if (!r || typeof r.id !== 'string' || typeof r.hlc !== 'string' || typeof r.deleted !== 'boolean' || (r.payload !== null && typeof r.payload !== 'string')) {
      throw new VaultCorruptError('bad record')
    }
  }
  return f as VaultFile
}

