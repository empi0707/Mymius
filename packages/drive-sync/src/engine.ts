import { EventEmitter } from 'node:events'
import { SyncFormatError, VaultLockedError, VaultMismatchError, parseMetaFile, type VaultStore } from '@mymius/vault'
import { fingerprint, type DriveClient, type DriveFile } from './drive'
import { AuthRevokedError, DriveNotFoundError, DriveQuotaError } from './errors'

/** Where vault data lives in the hidden app folder. */
export const META_FILE = 'mymius-vault.json'
export const deviceFileName = (deviceId: string): string => `mymius-device-${deviceId}.json`
const DEVICE_FILE = /^mymius-device-([0-9a-f]{4,32})\.json$/
const MAX_FILE_BYTES = 20 * 1024 * 1024

/** What this device remembers between runs, so it only downloads what changed. */
export interface SyncState {
  /** File id -> fingerprint last seen. */
  seen: Record<string, string>
  ownHash?: string
  metaRev?: number
  lastSyncAt?: number
}

export interface StateStorage {
  load(): SyncState | undefined
  save(state: SyncState): Promise<void>
}

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'locked' | 'error' | 'needs-auth'

export interface SyncStatus {
  phase: SyncPhase
  lastSyncAt?: number
  error?: string
  /** When the next automatic retry happens, if one is planned. */
  retryAt?: number
  /** Other devices seen in the cloud. */
  devices: number
  /** Files that were skipped because they failed validation (with the reason). */
  ignored: string[]
}

export interface SyncReport {
  changedRecords: number
  pushed: boolean
  devices: number
  ignored: string[]
}

export interface DriveSyncDeps {
  store: VaultStore
  drive: DriveClient
  state: StateStorage
  now?: () => number
  /** How often to look for changes made on other devices. */
  intervalMs?: number
  /** How long to wait after a local edit before publishing, so a burst of edits is one upload. */
  debounceMs?: number
}

const MISMATCH = 'Google Drive holds a different vault than the one on this device. Nothing was changed on either side.'
const TAMPERED = 'The vault data in Google Drive failed its integrity check, so it was not used. Nothing was changed on this device.'

/**
 * Keeps this device's vault and Google Drive in step. Each device writes only its own file (so devices
 * never overwrite each other) and merges everyone else's into its local vault.
 *
 * The local vault is the source of truth. A file missing from Drive is not a deletion: deletions travel
 * as tombstones inside the records, which are merged by their clock stamps.
 */
export class DriveSync extends EventEmitter {
  private current: SyncStatus = { phase: 'off', devices: 0, ignored: [] }
  private running: Promise<SyncReport> | undefined
  private rerun = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private started = false
  private halted = false
  private failures = 0
  private blockedUntil = 0
  private readonly now: () => number
  private readonly onChanged = (): void => { if (!this.running) this.requestSync(this.deps.debounceMs ?? 3000) }
  private readonly onState = (s: string): void => {
    if (!this.started) return
    if (s === 'unlocked') this.requestSync(0)
    else this.set({ phase: 'locked' })
  }

  constructor(private readonly deps: DriveSyncDeps) {
    super()
    this.now = deps.now ?? Date.now
  }

  get status(): SyncStatus {
    return this.current
  }

  private set(p: Partial<SyncStatus>): void {
    this.current = { ...this.current, ...p }
    this.emit('status', this.current)
  }

  // ---- scheduling ----------------------------------------------------------------------------------

  /** Begin syncing in the background: on unlock, after local changes, and on a timer. */
  start(): void {
    if (this.started) return
    this.started = true
    this.halted = false
    this.deps.store.on('changed', this.onChanged)
    this.deps.store.on('state', this.onState)
    this.poll = setInterval(() => this.requestSync(0), this.deps.intervalMs ?? 60_000)
    this.poll.unref?.()
    this.set({ phase: 'idle' })
    this.requestSync(0)
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    if (this.poll) clearInterval(this.poll)
    this.timer = this.poll = undefined
    this.deps.store.off('changed', this.onChanged)
    this.deps.store.off('state', this.onState)
    this.set({ phase: 'off' })
  }

  /** Ask for a sync soon. Automatic requests wait out a back-off or a halt; syncNow() does not. */
  requestSync(delayMs = 0): void {
    if (!this.started || this.halted) return
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(delayMs, this.blockedUntil - this.now())
    this.timer = setTimeout(() => { this.timer = undefined; void this.syncNow().catch(() => undefined) }, wait)
    this.timer.unref?.()
  }

  // ---- one round -----------------------------------------------------------------------------------

  /** Pull other devices' changes, then publish ours. Runs one at a time; a request during a run reruns after. */
  syncNow(): Promise<SyncReport> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = undefined
      if (this.rerun) { this.rerun = false; this.requestSync(0) }
    })
    return this.running
  }

  private async run(): Promise<SyncReport> {
    const { store } = this.deps
    if ((await store.state()) !== 'unlocked') {
      this.set({ phase: 'locked' })
      throw new VaultLockedError()
    }
    this.set({ phase: 'syncing' })
    try {
      const report = await this.round()
      this.failures = 0
      this.halted = false
      this.blockedUntil = 0
      this.set({ phase: 'idle', lastSyncAt: this.now(), devices: report.devices, ignored: report.ignored })
      this.current = { ...this.current }
      delete this.current.error
      delete this.current.retryAt
      this.emit('status', this.current)
      return report
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof AuthRevokedError) {
      this.halted = true
      return this.set({ phase: 'needs-auth', error: message })
    }
    if (err instanceof VaultLockedError) return this.set({ phase: 'locked' })
    if (err instanceof VaultMismatchError) { this.halted = true; return this.set({ phase: 'error', error: MISMATCH }) }
    if (err instanceof SyncFormatError) { this.halted = true; return this.set({ phase: 'error', error: TAMPERED }) }
    // Everything else may pass: back off and try again on our own, up to every five minutes (hourly if Drive is full).
    this.failures++
    const delay = err instanceof DriveQuotaError ? 3_600_000 : Math.min(300_000, 5_000 * 2 ** (this.failures - 1))
    this.blockedUntil = this.now() + delay
    this.set({ phase: 'error', error: message, retryAt: this.blockedUntil })
    this.requestSync(delay)
  }

  private async round(): Promise<SyncReport> {
    const { store, drive } = this.deps
    const state: SyncState = this.deps.state.load() ?? { seen: {} }
    state.seen ??= {}
    const files = await drive.list()
    const ignored: string[] = []
    let changedRecords = 0

    // 1. The vault's own metadata (passphrase wrapping): adopt a newer copy, publish ours if it is newer.
    const metaFile = files.find((f) => f.name === META_FILE)
    if (!metaFile) {
      const made = await drive.create(META_FILE, JSON.stringify(store.buildMetaFile()))
      state.seen[made.id] = fingerprint(made)
      state.metaRev = store.metaRev
    } else if (state.seen[metaFile.id] !== fingerprint(metaFile)) {
      const result = await store.applyMetaFile(await drive.download(metaFile.id))
      state.seen[metaFile.id] = fingerprint(metaFile)
      if (result === 'local-newer') await this.publishMeta(metaFile.id, state)
      else state.metaRev = store.metaRev
    } else if (store.metaRev > (state.metaRev ?? 0)) {
      await this.publishMeta(metaFile.id, state)
    }

    // 2. Every other device's file. One that is damaged or forged is skipped, never fatal.
    const ownName = deviceFileName(store.deviceId)
    const others = files.filter((f) => DEVICE_FILE.test(f.name) && f.name !== ownName)
    for (const f of others) {
      const fp = fingerprint(f)
      if (state.seen[f.id] === fp) continue
      if ((f.size ?? 0) > MAX_FILE_BYTES) {
        ignored.push(`${f.name}: too large`)
      } else {
        try {
          changedRecords += await store.applyDeviceFile(await drive.download(f.id))
        } catch (err) {
          if (!(err instanceof SyncFormatError)) throw err
          ignored.push(`${f.name}: ${err.reason}`)
        }
      }
      state.seen[f.id] = fp // remember even a rejected file, so it is not fetched again until it changes
    }

    // 3. Publish what we now know, if it differs from what we last published.
    const own = files.find((f) => f.name === ownName)
    const recordsNow = store.recordsFingerprint()
    let pushed = false
    if (!own || recordsNow !== state.ownHash) {
      const saved = await this.upload(own, ownName, JSON.stringify(store.buildDeviceFile(this.now())))
      state.seen[saved.id] = fingerprint(saved)
      state.ownHash = recordsNow
      pushed = true
    }

    state.lastSyncAt = this.now()
    await this.deps.state.save(state)
    return { changedRecords, pushed, devices: others.length, ignored }
  }

  private async publishMeta(fileId: string, state: SyncState): Promise<void> {
    const saved = await this.upload({ id: fileId }, META_FILE, JSON.stringify(this.deps.store.buildMetaFile()))
    state.seen[saved.id] = fingerprint(saved)
    state.metaRev = this.deps.store.metaRev
  }

  /** Update the file if it exists (recreating it if someone deleted it meanwhile), otherwise create it. */
  private async upload(existing: Pick<DriveFile, 'id'> | undefined, name: string, content: string): Promise<DriveFile> {
    const { drive } = this.deps
    if (existing) {
      try {
        return await drive.update(existing.id, content)
      } catch (err) {
        if (!(err instanceof DriveNotFoundError)) throw err
      }
    }
    return drive.create(name, content)
  }

  // ---- leaving -------------------------------------------------------------------------------------

  /** Remove this device's file from Drive. The other devices keep everything they merged from it. */
  async removeThisDevice(): Promise<void> {
    const name = deviceFileName(this.deps.store.deviceId)
    for (const f of await this.deps.drive.list()) if (f.name === name) await this.deps.drive.delete(f.id)
  }

  /** Delete everything this app stored in Drive: for every device. Irreversible. */
  async deleteAllRemote(): Promise<number> {
    let n = 0
    for (const f of await this.deps.drive.list()) {
      if (f.name === META_FILE || DEVICE_FILE.test(f.name)) { await this.deps.drive.delete(f.id); n++ }
    }
    return n
  }
}

/** There is nothing to restore: this Google account has no vault from this app. */
export class NoRemoteVaultError extends Error {
  constructor() {
    super('Không tìm thấy vault của ứng dụng này trong tài khoản Google đó')
    this.name = 'NoRemoteVaultError'
  }
}

/**
 * Set up an empty device from the vault in Drive: only the metadata is fetched, which is enough to unlock
 * it with the passphrase or recovery key. The records are merged by the first sync after unlocking, where
 * every file is checked against the vault key before anything is accepted.
 */
export async function restoreVault(drive: DriveClient, store: VaultStore): Promise<void> {
  const meta = (await drive.list()).find((f) => f.name === META_FILE)
  if (!meta) throw new NoRemoteVaultError()
  const parsed = parseMetaFile(await drive.download(meta.id)) // shape only: no key to check it with yet
  await store.bootstrap({ meta: parsed.meta, records: [] })
}
