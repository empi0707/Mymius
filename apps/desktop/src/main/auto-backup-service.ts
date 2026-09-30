import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HOST_PREFIX, buildBundle, type VaultStore } from '@mymius/vault'
import type { AutoBackupStatus, Result } from '../shared/ipc'

export interface AutoBackupHost {
  /** Where backups go unless the person picked a folder. */
  defaultDir: string
  /** Ask for a folder with a native dialog. Undefined when they cancel. */
  pickDirectory(): Promise<string | undefined>
  emitStatus(status: AutoBackupStatus): void
  /** How many backups to keep; older ones are removed. */
  keep?: number
  debounceMs?: number
}

const CONFIG = 'auto-backup'
const NAME = /^mymius-backup-\d{8}-\d{6}(-[0-9a-f]{4})?\.json$/
const friendly = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'Ứng dụng không có quyền ghi vào thư mục này.'
  if (code === 'ENOSPC') return 'Ổ đĩa đã đầy.'
  return err instanceof Error ? err.message : String(err)
}
const stamp = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Writes an encrypted copy of the vault (the same .json a manual backup makes) each time a new host appears,
 * whether it was added here or arrived from another device. On by default, into a folder inside the app's
 * data, so a mistaken delete or a bad edit can always be undone. Old copies are pruned.
 */
export class AutoBackupService {
  private enabled = true
  private dir: string | undefined
  private lastBackupAt: number | undefined
  private lastFile: string | undefined
  private lastError: string | undefined
  /** Host ids seen so far; undefined until the vault is open (opening it is not "adding a host"). */
  private known: Set<string> | undefined
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> = Promise.resolve()

  constructor(private readonly host: AutoBackupHost, private readonly store: VaultStore) {}

  async init(): Promise<void> {
    this.store.on('state', (s: string) => {
      if (s === 'unlocked') this.onUnlocked()
      else { this.known = undefined; clearTimeout(this.timer) }
      this.publish()
    })
    this.store.on('changed', () => this.onChanged())
    if ((await this.store.state().catch(() => 'damaged')) === 'unlocked') this.onUnlocked()
  }

  private hostIds(): Set<string> {
    return new Set(this.store.collection(HOST_PREFIX, (v) => v).list().map((h) => h.id))
  }

  private onUnlocked(): void {
    try {
      const saved = JSON.parse(this.store.getLocal(CONFIG) ?? 'null') as { enabled?: unknown; dir?: unknown } | null
      this.enabled = saved?.enabled !== false
      this.dir = typeof saved?.dir === 'string' && saved.dir ? saved.dir : undefined
    } catch {
      this.enabled = true; this.dir = undefined
    }
    this.known = this.hostIds()
  }

  private onChanged(): void {
    if (!this.known) return
    const now = this.hostIds()
    const added = [...now].some((id) => !this.known!.has(id))
    this.known = now
    if (!added || !this.enabled) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.backup().catch(() => undefined) }, this.host.debounceMs ?? 1000)
    this.timer.unref?.()
  }

  private get folder(): string {
    return this.dir ?? this.host.defaultDir
  }

  status(): AutoBackupStatus {
    return {
      enabled: this.enabled,
      dir: this.folder,
      customDir: this.dir !== undefined,
      ...(this.lastBackupAt ? { lastBackupAt: this.lastBackupAt } : {}),
      ...(this.lastFile ? { lastFile: this.lastFile } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  private publish(): void {
    this.host.emitStatus(this.status())
  }

  private async save(): Promise<void> {
    await this.store.setLocal(CONFIG, JSON.stringify({ enabled: this.enabled, ...(this.dir ? { dir: this.dir } : {}) }))
  }

  private async requireOpen(): Promise<Result | undefined> {
    return (await this.store.state().catch(() => undefined)) === 'unlocked' ? undefined : { ok: false, error: 'Hãy mở khóa vault trước.' }
  }

  async setEnabled(value: unknown): Promise<Result> {
    const locked = await this.requireOpen(); if (locked) return locked
    this.enabled = value === true
    await this.save()
    this.publish()
    return { ok: true }
  }

  async chooseFolder(): Promise<Result> {
    const locked = await this.requireOpen(); if (locked) return locked
    const picked = await this.host.pickDirectory()
    if (!picked) return { ok: false, error: '' }
    this.dir = picked
    this.lastError = undefined
    await this.save()
    this.publish()
    return { ok: true }
  }

  async resetFolder(): Promise<Result> {
    const locked = await this.requireOpen(); if (locked) return locked
    this.dir = undefined
    await this.save()
    this.publish()
    return { ok: true }
  }

  /** Make a backup now. Also what runs after a host is added. Runs are queued, never concurrent. */
  backupNow(): Promise<Result> {
    const run = this.running.then(() => this.write())
    this.running = run.then(() => undefined, () => undefined)
    return run
  }

  private async backup(): Promise<void> {
    await this.backupNow()
  }

  private async write(): Promise<Result> {
    const locked = await this.requireOpen(); if (locked) return locked
    const dir = this.folder
    try {
      await mkdir(dir, { recursive: true })
      const name = `mymius-backup-${stamp(new Date())}-${randomBytes(2).toString('hex')}.json`
      const file = path.join(dir, name)
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(buildBundle(this.store), null, 2), { mode: 0o600 })
      await rename(tmp, file)
      this.lastBackupAt = Date.now(); this.lastFile = file; this.lastError = undefined
      await this.prune(dir)
      this.publish()
      return { ok: true }
    } catch (err) {
      this.lastError = `Không thể sao lưu tự động: ${friendly(err)}`
      this.publish()
      return { ok: false, error: this.lastError }
    }
  }

  /** Only files this feature made are ever removed, oldest first. */
  private async prune(dir: string): Promise<void> {
    const keep = this.host.keep ?? 20
    try {
      const mine = (await readdir(dir)).filter((n) => NAME.test(n)).sort() // the timestamp sorts oldest first
      for (const old of mine.slice(0, Math.max(0, mine.length - keep))) await unlink(path.join(dir, old)).catch(() => undefined)
    } catch { /* pruning is best effort */ }
  }
}
