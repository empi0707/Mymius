import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_SYNC_FILE_BYTES, SyncFormatError, VaultMismatchError, applyBundle, buildBundle, bundleMeta, ownFingerprint, parseBundle,
  type Bundle, type VaultStore
} from '@mymius/vault'
import type { FileSyncStatus, Result } from '../shared/ipc'

export interface FileSyncHost {
  /** Ask the person for a path with a native dialog. Undefined when they cancel. */
  pick(kind: 'open' | 'save', suggestedName?: string): Promise<string | undefined>
  emitStatus(status: FileSyncStatus): void
  intervalMs?: number
  debounceMs?: number
}

const LINK = 'file-sync-link'
const SUGGESTED = 'mymius-sync.json'

const friendly = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function explain(err: unknown): string {
  if (err instanceof VaultMismatchError) return 'File đó thuộc về một vault khác nên đã được để yên.'
  if (err instanceof SyncFormatError) {
    return err.reason === 'tampered' ? 'File đó không qua được kiểm tra toàn vẹn (đã bị sửa hoặc hỏng) nên đã được để yên.'
      : err.reason === 'too-large' ? 'File đó quá lớn để là file đồng bộ của Mymius.'
      : 'Đây không phải file đồng bộ của Mymius.'
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'Không tìm thấy file.'
  if (code === 'EACCES' || code === 'EPERM') return 'Ứng dụng không được phép dùng file đó.'
  return friendly(err)
}

/** Identifies one particular version of the file: replacing it by rename gives it a new inode even within one timestamp tick. */
const stampOf = (st: { mtimeMs: number; size: number; ino: number }): string => `${st.mtimeMs}:${st.size}:${st.ino}`

/** Read a bundle; undefined when there is no file yet. Refuses anything too large before reading it. */
async function readBundle(file: string): Promise<{ bundle: Bundle; stamp: string } | undefined> {
  let st
  try { st = await stat(file) } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err }
  if (st.size > MAX_SYNC_FILE_BYTES) throw new SyncFormatError('too-large', 'The file is too large')
  return { bundle: parseBundle(await readFile(file, 'utf8')), stamp: stampOf(st) }
}

async function writeAtomic(file: string, text: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  // Stamp what we wrote, not whatever is in the place afterwards: another device may replace the file in between.
  const st = await stat(tmp)
  await rename(tmp, file)
  return stampOf(st)
}

/**
 * Keeps the vault in step with one JSON file that the person chose, which can live anywhere: a folder that
 * iCloud Drive, Dropbox, OneDrive or Syncthing already syncs, a NAS, a USB stick. Also makes one-off backups
 * and restores from them. No account or sign-in is involved. The file holds only ciphertext and MACs.
 */
export class FileSyncService {
  private linked: string | undefined
  private phase: FileSyncStatus['phase'] = 'off'
  private lastSyncAt: number | undefined
  private lastError: string | undefined
  private devices = 0
  private halted = false
  private stamp: string | undefined
  private running: Promise<void> | undefined
  private again = false
  private timer: NodeJS.Timeout | undefined
  private poll: NodeJS.Timeout | undefined
  private lastFingerprint: string | undefined
  /** A file picked while there was no vault: its metadata set the vault up, its records merge after unlock. */
  private pendingRestore: { file: string; keep: boolean } | undefined

  constructor(private readonly host: FileSyncHost, private readonly store: VaultStore) {}

  async init(): Promise<void> {
    this.store.on('state', (s: string) => {
      if (s === 'unlocked') void this.onUnlocked()
      else this.stop()
    })
    this.store.on('changed', () => this.request(this.host.debounceMs ?? 1500))
    if ((await this.store.state().catch(() => 'damaged')) === 'unlocked') await this.onUnlocked()
    this.publish()
  }

  status(): FileSyncStatus {
    return {
      phase: this.phase,
      ...(this.linked ? { path: this.linked } : {}),
      ...(this.pendingRestore?.keep ? { path: this.pendingRestore.file } : {}),
      ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      devices: this.devices
    }
  }

  private publish(): void {
    this.host.emitStatus(this.status())
  }

  private stop(): void {
    clearTimeout(this.timer); clearInterval(this.poll)
    this.timer = this.poll = undefined
    this.linked = undefined
    this.halted = false
    this.stamp = undefined
    this.lastFingerprint = undefined
    this.phase = this.pendingRestore?.keep ? 'locked' : 'off'
    this.publish()
  }

  private async onUnlocked(): Promise<void> {
    if (this.pendingRestore) {
      const { file, keep } = this.pendingRestore
      this.pendingRestore = undefined
      if (keep) {
        await this.store.setLocal(LINK, file)
        this.begin(file)
      } else {
        // A one-off restore: merge what the file holds, and leave it alone afterwards.
        try {
          const existing = await readBundle(file)
          if (existing) await applyBundle(this.store, existing.bundle)
          this.lastError = undefined
        } catch (err) {
          this.lastError = `Không gộp được backup: ${explain(err)}`
        }
        this.phase = 'off'
        this.publish()
      }
      return
    }
    const saved = this.store.getLocal(LINK)
    if (saved) this.begin(saved)
    else { this.phase = 'off'; this.publish() }
  }

  private begin(file: string): void {
    this.linked = file
    this.halted = false
    this.lastError = undefined
    this.phase = 'idle'
    clearInterval(this.poll)
    this.poll = setInterval(() => this.request(0), this.host.intervalMs ?? 15_000)
    this.poll.unref?.()
    this.request(0)
    this.publish()
  }

  /** Ask for a round soon; rounds never overlap and a request during one runs one more afterwards. */
  private request(delayMs: number): void {
    if (!this.linked || this.halted) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.syncNow().catch(() => undefined) }, delayMs)
    this.timer.unref?.()
  }

  async syncNow(): Promise<Result> {
    if (!this.linked) return { ok: false, error: 'Chưa thiết lập file đồng bộ' }
    if (this.running) { this.again = true; await this.running; return this.result() }
    this.running = this.round().finally(() => { this.running = undefined })
    await this.running
    if (this.again) { this.again = false; this.running = this.round().finally(() => { this.running = undefined }); await this.running }
    return this.result()
  }

  private result(): Result {
    return this.lastError ? { ok: false, error: this.lastError } : { ok: true }
  }

  private async round(): Promise<void> {
    const file = this.linked
    if (!file || (await this.store.state()) !== 'unlocked') return
    this.phase = 'syncing'; this.publish()
    try {
      // Cheap check first: same file as we last saw and nothing new locally means there is nothing to do.
      let st
      try { st = await stat(file) } catch { st = undefined }
      const stamp = st ? stampOf(st) : undefined
      if (stamp && stamp === this.stamp && this.lastFingerprint === this.store.recordsFingerprint()) {
        this.phase = 'idle'; this.lastError = undefined; this.publish(); return
      }
      const existing = await readBundle(file)
      if (existing) {
        const r = await applyBundle(this.store, existing.bundle)
        this.devices = existing.bundle.devices.filter((d) => d.deviceId !== this.store.deviceId).length
        if (r.ignored) this.lastError = undefined
      }
      // Everything from here to building the file is synchronous, so `fp` is exactly what the file will hold. A
      // host added while the file is being written must not be mistaken for something already written.
      const fp = this.store.recordsFingerprint()
      const current = existing !== undefined && ownFingerprint(existing.bundle, this.store.deviceId) === fp &&
        existing.bundle.meta.meta.rev >= this.store.metaRev
      if (current) {
        this.stamp = existing.stamp
      } else {
        this.stamp = await writeAtomic(file, JSON.stringify(buildBundle(this.store, existing?.bundle), null, 2))
      }
      this.lastFingerprint = fp
      this.lastSyncAt = Date.now()
      this.lastError = undefined
      this.phase = 'idle'
    } catch (err) {
      this.lastError = explain(err)
      this.phase = 'error'
      // Wrong or damaged content will not fix itself and must never be overwritten; a missing folder or a busy file may.
      if (err instanceof VaultMismatchError || err instanceof SyncFormatError) this.halted = true
    }
    this.publish()
  }

  // ---- what the person can ask for ----------------------------------------------------------------

  /** A one-off copy of the vault as a .json file. It is encrypted, so it is safe to keep anywhere. */
  async exportBackup(): Promise<Result> {
    if ((await this.store.state()) !== 'unlocked') return { ok: false, error: 'Hãy mở khóa vault trước' }
    const file = await this.host.pick('save', SUGGESTED)
    if (!file) return { ok: false, error: '' }
    try {
      const existing = await readBundle(file).catch(() => undefined) // keep other devices' copies if it was a sync file
      await writeAtomic(file, JSON.stringify(buildBundle(this.store, existing?.bundle), null, 2))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: explain(err) }
    }
  }

  /**
   * Bring a backup or sync file in. On a device with no vault it sets the vault up from the file (then it needs
   * unlocking with the passphrase it was made with). On an unlocked vault it merges once.
   */
  async importBackup(): Promise<Result> {
    const state = await this.store.state().catch(() => undefined)
    if (!state) return { ok: false, error: 'File vault bị hỏng' }
    if (state === 'locked') return { ok: false, error: 'Hãy mở khóa vault trước' }
    const file = await this.host.pick('open')
    if (!file) return { ok: false, error: '' }
    try {
      const existing = await readBundle(file)
      if (!existing) return { ok: false, error: explain({ code: 'ENOENT' }) }
      if (state === 'uninitialized') {
        await this.store.bootstrap({ meta: bundleMeta(existing.bundle), records: [] })
        this.pendingRestore = { file, keep: false } // its records are merged once the vault is unlocked
        return { ok: true }
      }
      await applyBundle(this.store, existing.bundle)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: explain(err) }
    }
  }

  /**
   * Keep syncing with a file. `create` asks where to put a new one; otherwise an existing file is chosen. With
   * no vault yet, an existing file restores from it and syncing starts once the vault is unlocked.
   */
  async link(mode: 'create' | 'existing'): Promise<Result> {
    const state = await this.store.state().catch(() => undefined)
    if (!state) return { ok: false, error: 'File vault bị hỏng' }
    if (state === 'locked') return { ok: false, error: 'Hãy mở khóa vault trước' }
    if (mode === 'create' && state !== 'unlocked') return { ok: false, error: 'Hãy tạo vault trước' }
    if (this.linked) return { ok: false, error: 'Hãy dừng dùng file đồng bộ hiện tại trước' }
    const file = await this.host.pick(mode === 'create' ? 'save' : 'open', SUGGESTED)
    if (!file) return { ok: false, error: '' }
    try {
      const existing = await readBundle(file)
      if (mode === 'existing' && !existing) return { ok: false, error: explain({ code: 'ENOENT' }) }
      if (state === 'uninitialized') {
        await this.store.bootstrap({ meta: bundleMeta(existing!.bundle), records: [] })
        this.pendingRestore = { file, keep: true }
        this.phase = 'locked'
        this.publish()
        return { ok: true }
      }
      if (existing) await applyBundle(this.store, existing.bundle) // refuses another vault before anything is linked
      await this.store.setLocal(LINK, file)
      this.begin(file)
      const r = await this.syncNow()
      return r
    } catch (err) {
      return { ok: false, error: explain(err) }
    }
  }

  async unlink(): Promise<Result> {
    this.pendingRestore = undefined
    if ((await this.store.state()) === 'unlocked') await this.store.deleteLocal(LINK)
    this.stop()
    this.lastError = undefined
    this.lastSyncAt = undefined
    this.devices = 0
    this.phase = 'off'
    this.publish()
    return { ok: true }
  }
}
