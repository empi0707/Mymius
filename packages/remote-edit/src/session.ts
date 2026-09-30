import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {
  ConflictError,
  copyFile,
  getVersion,
  hashFile,
  mtimeTolerance,
  sameVersion,
  writeFileAtomic,
  type FileVersion
} from '@mymius/core'
import { LocalProvider } from '@mymius/providers'
import { sanitizeFileName } from '@mymius/platform'
import type { Baseline, ConflictContext, EditState, FileWatcher, RemoteEditDeps, SaveOutcome } from './types'
import { watchFile } from './watch'

const MAX_ATTEMPTS = 3

/**
 * One remote file being edited locally. Downloads it, watches the local copy, and on every save
 * uploads it back - unless the server copy changed in the meantime, in which case the user decides.
 *
 * Events: 'state' (EditState), 'outcome' (SaveOutcome), 'error' (Error).
 */
export class RemoteEditSession extends EventEmitter {
  readonly id: string
  state: EditState = 'opening'
  localPath = ''
  remotePath: string

  private readonly local = new LocalProvider()
  private readonly dir: string
  private baseline!: Baseline
  private lastUploadedHash = ''
  private dismissed: { localHash: string; remote: FileVersion | null } | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private watcher: FileWatcher | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: RemoteEditDeps) {
    super()
    this.id = deps.id ?? randomBytes(6).toString('hex')
    this.remotePath = deps.remotePath
    this.dir = path.join(deps.workRoot, this.id)
  }

  private get tolerance(): number {
    return mtimeTolerance(this.deps.provider.capabilities.mtimeResolutionMs)
  }

  private setState(s: EditState): void {
    this.state = s
    this.emit('state', s)
  }

  async open(): Promise<void> {
    const { provider } = this.deps
    // Edit the real file, not a symlink pointing at it: rename-over would otherwise replace the link.
    this.remotePath = await provider.realpath(this.deps.remotePath).catch(() => this.deps.remotePath)

    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    this.localPath = path.join(this.dir, sanitizeFileName(provider.path.basename(this.remotePath)))
    const version = await copyFile(provider, this.remotePath, this.local, this.localPath)
    await this.local.chmod(this.localPath, 0o600)

    const hash = await hashFile(this.local, this.localPath)
    this.baseline = { version: await this.freshVersion(version), hash }
    this.lastUploadedHash = hash

    this.watcher = (this.deps.watch ?? watchFile)(this.localPath, () => this.schedule())
    await this.watcher.ready // a save made before the watcher is armed would be lost
    this.setState('synced')
    await this.deps.openInEditor(this.localPath)
  }

  /** The version to remember: what the server reports now, not what we inferred while downloading. */
  private async freshVersion(fallback: FileVersion): Promise<FileVersion> {
    return (await getVersion(this.deps.provider, this.remotePath)) ?? fallback
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.waitUntilStable()
        .then(() => this.handleLocalChange())
        .catch((err: Error) => this.emit('error', err))
    }, this.deps.debounceMs ?? 400)
  }

  /** Editors may still be flushing when the first event fires; wait for size/mtime to settle. */
  private async waitUntilStable(): Promise<void> {
    let prev = ''
    for (let i = 0; i < 8; i++) {
      const st = await this.local.stat(this.localPath)
      const sig = st ? `${st.size}:${st.mtimeMs}` : 'gone'
      if (sig === prev) return
      prev = sig
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  /** Process a local save. Saves are serialised so two quick saves never race each other. */
  handleLocalChange(): Promise<SaveOutcome> {
    const run = this.queue.then(() => this.processSave())
    this.queue = run.catch(() => undefined)
    return run
  }

  private async processSave(): Promise<SaveOutcome> {
    if (this.state === 'closed') return 'unchanged'
    try {
      const outcome = await this.save()
      this.emit('outcome', outcome)
      return outcome
    } catch (err) {
      this.setState('error')
      this.emit('error', err)
      throw err
    }
  }

  private async save(): Promise<SaveOutcome> {
    // Snapshot first so the bytes we hash are exactly the bytes we upload, even if the editor saves again mid-upload.
    const snapshot = path.join(this.dir, `.upload-${randomBytes(4).toString('hex')}`)
    await fs.copyFile(this.localPath, snapshot)
    try {
      const localHash = await hashFile(this.local, snapshot)
      if (localHash === this.lastUploadedHash) {
        if (this.state !== 'synced') this.setState('synced')
        return 'unchanged'
      }
      this.setState('uploading')

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const check = await this.detect()
        const expect: FileVersion | null = check.kind === 'deleted' ? null : check.remote
        let recreated = false

        if (check.kind !== 'none') {
          if (this.isDismissed(localHash, check.remote)) return this.giveUp()
          this.setState('conflict')
          const choice = await this.deps.resolveConflict(this.context(check.kind, check.remote))
          if (choice === 'cancel' || (choice === 'reload' && check.kind === 'deleted')) {
            this.dismissed = { localHash, remote: check.remote }
            return this.giveUp()
          }
          if (choice === 'reload') return await this.reloadFromRemote()
          recreated = check.kind === 'deleted'
          this.setState('uploading')
        }

        try {
          const version = await writeFileAtomic(this.deps.provider, this.remotePath, this.local.createReadStream(snapshot), {
            expect
          })
          this.baseline = { version, hash: localHash }
          this.lastUploadedHash = localHash
          this.dismissed = undefined
          this.setState('synced')
          return recreated ? 'recreated' : 'uploaded'
        } catch (err) {
          // Changed under us between the check and the rename: loop, re-detect and ask again.
          if (!(err instanceof ConflictError)) throw err
        }
      }
      throw new Error('File trên server liên tục thay đổi; đã bỏ cuộc sau nhiều lần thử')
    } finally {
      await fs.rm(snapshot, { force: true })
    }
  }

  private giveUp(): SaveOutcome {
    this.setState('unsynced')
    return 'cancelled'
  }

  private isDismissed(localHash: string, remote: FileVersion | null): boolean {
    const d = this.dismissed
    if (!d || d.localHash !== localHash) return false
    if (d.remote === null || remote === null) return d.remote === remote
    return sameVersion(d.remote, remote, this.tolerance)
  }

  private context(kind: ConflictContext['kind'], remote: FileVersion | null): ConflictContext {
    return {
      sessionId: this.id,
      remotePath: this.remotePath,
      localPath: this.localPath,
      kind,
      baseline: this.baseline,
      remote
    }
  }

  /**
   * Has the server copy changed since the baseline? A changed mtime alone is not proof
   * (e.g. `touch`), so confirm by content before bothering the user.
   */
  private async detect(): Promise<
    { kind: 'none'; remote: FileVersion } | { kind: 'modified'; remote: FileVersion } | { kind: 'deleted'; remote: null }
  > {
    const { provider } = this.deps
    const current = await getVersion(provider, this.remotePath)
    if (!current) return { kind: 'deleted', remote: null }
    if (sameVersion(current, this.baseline.version, this.tolerance)) return { kind: 'none', remote: current }
    if ((await hashFile(provider, this.remotePath)) === this.baseline.hash) {
      this.baseline = { ...this.baseline, version: current }
      return { kind: 'none', remote: current }
    }
    return { kind: 'modified', remote: current }
  }

  /** Keep the user's edits in a side file, then replace the local copy with the server's. */
  private async reloadFromRemote(): Promise<SaveOutcome> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const { name, ext } = path.parse(this.localPath)
    await fs.copyFile(this.localPath, path.join(this.dir, `${name}.local-${stamp}${ext}`))

    const version = await copyFile(this.deps.provider, this.remotePath, this.local, this.localPath)
    await this.local.chmod(this.localPath, 0o600)
    const hash = await hashFile(this.local, this.localPath)
    this.baseline = { version, hash }
    this.lastUploadedHash = hash
    this.dismissed = undefined
    this.setState('synced')
    return 'reloaded'
  }

  /** Stop watching. Keeps the folder if there is unsynced work, unless `discard` is set. */
  async close(opts: { discard?: boolean } = {}): Promise<{ kept: boolean; dir: string }> {
    if (this.timer) clearTimeout(this.timer)
    await this.watcher?.close()
    await this.queue
    const pending = this.state === 'unsynced' || this.state === 'error'
    const kept = pending && !opts.discard
    if (!kept) await fs.rm(this.dir, { recursive: true, force: true })
    this.setState('closed')
    return { kept, dir: this.dir }
  }
}
