import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import path from 'node:path'
import type { FileEntry, FileSystemProvider } from '@mymius/core'
import { buildPlan, compareFolders, executePlan, itemDirections, type DiffItem, type Direction, type Endpoint, type SyncPlan } from '@mymius/folder-sync'
import { LocalProvider, SftpProvider } from '@mymius/providers'
import { RemoteEditManager, type ConflictChoice, type ConflictContext, type EditState } from '@mymius/remote-edit'
import type { HostLookup } from '@mymius/ssh'
import { deletePaths, findConflicts, runTransfer, validateName } from '@mymius/transfer'
import type {
  AppChoice, ConflictPolicy, EditInfo, FsCrumb, FsEntry, FsEntryKind, FsListing, FsPlace, FsSessionInfo, JobIssue, JobState,
  OpenOutcome, Result, SyncCompareRequest, SyncCompareResult, SyncDirection, SyncMode, SyncPlanRequest, SyncPreview, TransferRequest
} from '../shared/ipc'
import type { ConnectionBroker, Lease } from './connections'
import { parseOpenOptions, type Decision } from './open-with'

export interface FilesHost {
  home: string
  /** Where copies of remote files being edited are kept. */
  workRoot: string
  /** Move to the system trash (recoverable). Used for local deletes. */
  trashItem(path: string): Promise<void>
  openLocal(path: string): Promise<void>
  /** Which program opens which kind of file (saved choices), and starting one. */
  openWith: {
    decide(fileName: string, mode: 'open' | 'edit' | 'with'): Decision
    remember(fileName: string, how: 'none' | 'ext' | 'all', app: AppChoice): Promise<void>
    launch(path: string, app: AppChoice): Promise<void>
  }
  /** A remote file being edited changed on the server too: ask the user what to do. */
  confirmEditConflict(ctx: ConflictContext): Promise<ConflictChoice>
  emitJob(owner: number, job: JobState): void
  emitEdit(owner: number, e: EditInfo): void
}

export const LOCAL_SESSION = 'local'
const MAX_ENTRIES = 20_000
const MAX_SYNC_ITEMS = 50_000
const MAX_PATHS = 5_000
const MAX_PATH_LENGTH = 4096

interface Session {
  info: FsSessionInfo
  provider: FileSystemProvider
  owner: number | null // null: shared by every window (the local disk)
  lease?: Lease
}

interface Job {
  state: JobState
  owner: number
  abort: AbortController
  lastEmit: number
}

interface Comparison {
  owner: number
  items: DiffItem[]
  left: Endpoint
  right: Endpoint
}

interface EditRecord {
  owner: number
  name: string
  remotePath: string
  hostLabel: string
  provider: SftpProvider
  lease: Lease
}

/** Turn what providers throw into a sentence a person can act on. */
export function friendlyError(err: unknown): string {
  const e = err as { code?: unknown; message?: string } | null
  switch (e?.code) {
    case 'ENOENT': case 2: return 'Không tìm thấy'
    case 'EACCES': case 'EPERM': case 3: return 'Không có quyền truy cập'
    case 'ENOTDIR': return 'Không phải thư mục'
    case 'EEXIST': return 'Đã tồn tại'
    case 'ENOSPC': return 'Thiết bị đã hết dung lượng'
  }
  return e?.message || String(err)
}

async function attempt<T extends object>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, ...(await fn()) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

function checkPath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH || p.includes('\0')) throw new Error('Đường dẫn không hợp lệ')
  return p
}

function checkPaths(ps: unknown): string[] {
  if (!Array.isArray(ps) || ps.length === 0 || ps.length > MAX_PATHS) throw new Error('Chưa chọn gì')
  return ps.map(checkPath)
}

const MODES: readonly SyncMode[] = ['mirror-ltr', 'mirror-rtl', 'two-way']
const DIRECTIONS: readonly SyncDirection[] = ['ltr', 'rtl', 'skip']
const POLICIES: readonly ConflictPolicy[] = ['overwrite', 'skip', 'keep-both']

function crumbsOf(p: FileSystemProvider['path'], dir: string): FsCrumb[] {
  const crumbs: FsCrumb[] = []
  for (let cur = dir; ; ) {
    const parent = p.dirname(cur)
    crumbs.unshift({ name: parent === cur ? cur : p.basename(cur), path: cur })
    if (parent === cur) break
    cur = parent
  }
  return crumbs
}

/**
 * Everything the file manager panes do, for the main process: browsing local disk and saved SFTP
 * hosts, copy/move/delete jobs with progress and cancel, folder sync, and editing remote files with
 * automatic upload. It hands the UI only plain data and never a path it did not validate.
 */
export class FilesService {
  private readonly sessions = new Map<string, Session>()
  private readonly jobs = new Map<string, Job>()
  private readonly finished: JobState[] = []
  private readonly comparisons = new Map<string, Comparison>()
  private readonly edits = new RemoteEditManager()
  private readonly editRecords = new Map<string, EditRecord>()
  private readonly local = new LocalProvider()

  constructor(
    private readonly host: FilesHost,
    private readonly broker: ConnectionBroker,
    private readonly saved: HostLookup
  ) {
    this.sessions.set(LOCAL_SESSION, {
      info: { id: LOCAL_SESSION, label: 'This computer', kind: 'local', home: host.home, sep: path.sep as '/' | '\\' },
      provider: this.local,
      owner: null
    })
  }

  // ---- sessions ----------------------------------------------------------------------------------

  private session(owner: number, id: unknown): Session {
    const s = typeof id === 'string' ? this.sessions.get(id) : undefined
    if (!s || (s.owner !== null && s.owner !== owner)) throw new Error('Kết nối đó không còn mở nữa')
    if (s.provider instanceof SftpProvider && s.provider.closed) {
      throw new Error('Đã mất kết nối. Hãy chọn lại host để kết nối lại.')
    }
    return s
  }

  async places(): Promise<Result<{ session: FsSessionInfo; places: FsPlace[] }>> {
    return attempt(async () => {
      const home = this.host.home
      const places: FsPlace[] = [{ name: 'Home', path: home }]
      for (const name of ['Desktop', 'Documents', 'Downloads']) {
        const p = path.join(home, name)
        if (await access(p).then(() => true, () => false)) places.push({ name, path: p })
      }
      if (process.platform === 'win32') {
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          const drive = `${letter}:\\`
          if (await access(drive).then(() => true, () => false)) places.push({ name: `${letter}:`, path: drive })
        }
      } else {
        places.push({ name: 'Computer', path: path.parse(home).root })
      }
      return { session: this.sessions.get(LOCAL_SESSION)!.info, places }
    })
  }

  connect(owner: number, hostId: unknown): Promise<Result<{ session: FsSessionInfo }>> {
    return attempt(async () => {
      if (typeof hostId !== 'string') throw new Error('Host không hợp lệ')
      const meta = await this.saved.resolve(hostId)
      const lease = await this.broker.acquireSaved(hostId)
      try {
        const provider = await SftpProvider.fromConnection(lease.connection)
        const info: FsSessionInfo = { id: randomUUID(), label: meta.name, kind: 'sftp', home: await provider.homeDir(), sep: '/', hostId }
        this.sessions.set(info.id, { info, provider, owner, lease })
        return { session: info }
      } catch (err) {
        await lease.release()
        throw err
      }
    })
  }

  async disconnect(owner: number, id: unknown): Promise<void> {
    if (typeof id !== 'string' || id === LOCAL_SESSION) return
    const s = this.sessions.get(id)
    if (!s || s.owner !== owner) return
    this.sessions.delete(id)
    await s.provider.dispose().catch(() => undefined)
    await s.lease?.release()
  }

  // ---- browsing ----------------------------------------------------------------------------------

  list(owner: number, sessionId: unknown, target?: unknown): Promise<Result<{ listing: FsListing }>> {
    return attempt(async () => {
      const s = this.session(owner, sessionId)
      const p = s.provider.path
      let dir = target === undefined || target === '' ? s.info.home : checkPath(target)
      if (!p.isAbsolute(dir)) dir = p.join(s.info.home, dir)
      dir = p.normalize(dir)
      // Follow a link to a folder so we list the folder, but show the path the user asked for.
      let st = await s.provider.stat(dir)
      if (!st) throw new Error('Không tìm thấy thư mục')
      if (st.kind === 'symlink') st = await this.followLink(s.provider, dir)
      if (!st || st.kind !== 'directory') throw new Error('Không phải thư mục')

      const raw = await s.provider.list(dir)
      const truncated = raw.length > MAX_ENTRIES
      const entries = await this.describe(s.provider, truncated ? raw.slice(0, MAX_ENTRIES) : raw)
      const parent = p.dirname(dir)
      return {
        listing: {
          sessionId: s.info.id,
          path: dir,
          parent: parent === dir ? null : parent,
          crumbs: crumbsOf(p, dir),
          entries,
          truncated
        }
      }
    })
  }

  private async followLink(provider: FileSystemProvider, link: string): Promise<FileEntry | null> {
    try {
      return await provider.stat(await provider.realpath(link))
    } catch {
      return null
    }
  }

  private async describe(provider: FileSystemProvider, raw: FileEntry[]): Promise<FsEntry[]> {
    const out: FsEntry[] = raw.map((e) => ({ name: e.name, path: e.path, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs }))
    // Links: find out what they point at, but never let a slow or broken one hold up the listing.
    const links = out.filter((e) => e.kind === 'symlink').slice(0, 500)
    await Promise.all(links.map(async (e) => {
      const target = await this.followLink(provider, e.path)
      e.targetKind = target ? target.kind : 'broken'
    }))
    return out
  }

  mkdir(owner: number, sessionId: unknown, dir: unknown, name: unknown): Promise<Result> {
    return attempt(async () => {
      const s = this.session(owner, sessionId)
      const bad = validateName(typeof name === 'string' ? name : '')
      if (bad) throw new Error(bad)
      const target = s.provider.path.join(checkPath(dir), name as string)
      if (await s.provider.stat(target)) throw new Error('Đã có mục khác trùng tên')
      await s.provider.mkdir(target)
      return {}
    })
  }

  rename(owner: number, sessionId: unknown, from: unknown, newName: unknown): Promise<Result> {
    return attempt(async () => {
      const s = this.session(owner, sessionId)
      const bad = validateName(typeof newName === 'string' ? newName : '')
      if (bad) throw new Error(bad)
      const source = checkPath(from)
      const target = s.provider.path.join(s.provider.path.dirname(source), newName as string)
      if (target === source) return {}
      if (await s.provider.stat(target)) throw new Error('Đã có mục khác trùng tên')
      await s.provider.rename(source, target, { overwrite: false })
      return {}
    })
  }

  // ---- jobs --------------------------------------------------------------------------------------

  private startJob(
    owner: number,
    kind: JobState['kind'],
    label: string,
    run: (ctx: { signal: AbortSignal; update(p: Partial<JobState>): void }) => Promise<{ summary: string; errors: JobIssue[]; cancelled: boolean }>
  ): string {
    const job: Job = {
      owner,
      abort: new AbortController(),
      lastEmit: 0,
      state: { id: randomUUID(), kind, label, state: 'running', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, errors: [] }
    }
    this.jobs.set(job.state.id, job)
    this.host.emitJob(owner, { ...job.state })

    const update = (p: Partial<JobState>): void => {
      Object.assign(job.state, p)
      const now = Date.now()
      if (now - job.lastEmit >= 100) {
        job.lastEmit = now
        this.host.emitJob(owner, { ...job.state })
      }
    }
    void run({ signal: job.abort.signal, update })
      .then((r) => {
        job.state.errors = r.errors.slice(0, 200)
        job.state.summary = r.summary
        job.state.state = r.cancelled ? 'cancelled' : 'done'
      })
      .catch((err) => {
        job.state.state = 'failed'
        job.state.summary = friendlyError(err)
      })
      .finally(() => {
        delete job.state.current
        this.jobs.delete(job.state.id)
        this.finished.unshift({ ...job.state })
        this.finished.length = Math.min(this.finished.length, 20)
        this.host.emitJob(owner, { ...job.state })
      })
    return job.state.id
  }

  cancel(owner: number, jobId: unknown): void {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined
    if (job && job.owner === owner) job.abort.abort()
  }

  listJobs(owner: number): JobState[] {
    return [...[...this.jobs.values()].filter((j) => j.owner === owner).map((j) => ({ ...j.state })), ...this.finished]
  }

  // ---- copy / move / delete ----------------------------------------------------------------------

  conflicts(owner: number, req: unknown): Promise<Result<{ names: string[] }>> {
    return attempt(async () => {
      const r = (req ?? {}) as Partial<TransferRequest>
      const from = this.session(owner, r.fromSession)
      const to = this.session(owner, r.toSession)
      const names = await findConflicts({ src: from.provider, srcPaths: checkPaths(r.paths), dst: to.provider, dstDir: checkPath(r.toDir) })
      return { names }
    })
  }

  transfer(owner: number, req: unknown): Promise<Result<{ jobId: string }>> {
    return attempt(async () => {
      const r = (req ?? {}) as Partial<TransferRequest>
      const from = this.session(owner, r.fromSession)
      const to = this.session(owner, r.toSession)
      const toDir = checkPath(r.toDir)
      const mode = r.mode === 'move' ? 'move' : 'copy'
      const policy = POLICIES.includes(r.policy as ConflictPolicy) ? (r.policy as ConflictPolicy) : 'skip'
      const dst = await to.provider.stat(toDir)
      if (!dst || dst.kind !== 'directory') throw new Error('Đích đến không phải là thư mục')

      let paths = checkPaths(r.paths)
      const sameFs = from.provider.id === to.provider.id && from.provider.kind === to.provider.kind
      // Moving something into the folder it is already in changes nothing.
      if (mode === 'move' && sameFs) paths = paths.filter((p) => from.provider.path.dirname(p) !== from.provider.path.normalize(toDir))
      if (paths.length === 0) return { jobId: this.startJob(owner, mode, 'Không có gì để làm', async () => ({ summary: 'Đã ở đúng chỗ', errors: [], cancelled: false })) }

      const label = `${mode === 'move' ? 'Đang chuyển' : 'Đang chép'} ${paths.length === 1 ? from.provider.path.basename(paths[0]!) : `${paths.length} mục`} tới ${to.info.label}`
      return {
        jobId: this.startJob(owner, mode, label, async ({ signal, update }) => {
          const res = await runTransfer(
            { src: from.provider, srcPaths: paths, dst: to.provider, dstDir: toDir, policy, move: mode === 'move' },
            { signal, onProgress: (p) => update({ ...p }) }
          )
          const parts = [`${res.copied} file đã ${mode === 'move' ? 'chuyển' : 'chép'}`]
          if (res.renamed) parts.push(`${res.renamed} mục đã chuyển`)
          if (res.skipped) parts.push(`${res.skipped} bỏ qua`)
          if (res.ignored.length) parts.push(`${res.ignored.length} liên kết bị bỏ qua`)
          if (res.errors.length) parts.push(`${res.errors.length} thất bại`)
          return { summary: parts.join(', '), errors: res.errors, cancelled: res.cancelled }
        })
      }
    })
  }

  delete(owner: number, sessionId: unknown, paths: unknown): Promise<Result<{ jobId: string }>> {
    return attempt(async () => {
      const s = this.session(owner, sessionId)
      const list = checkPaths(paths)
      // The local disk goes to the trash (undoable); a server has no trash, so that one is permanent.
      const trash = s.info.kind === 'local' ? { trash: (p: string) => this.host.trashItem(p) } : {}
      const jobId = this.startJob(owner, 'delete', `Deleting ${list.length === 1 ? s.provider.path.basename(list[0]!) : `${list.length} items`}`, async ({ signal, update }) => {
        update({ filesTotal: list.length })
        const r = await deletePaths(s.provider, list, { ...trash, signal })
        update({ filesDone: r.deleted })
        return {
          summary: `${r.deleted} đã xóa${s.info.kind === 'local' ? ' (đã chuyển vào thùng rác)' : ''}${r.errors.length ? `, ${r.errors.length} thất bại` : ''}`,
          errors: r.errors,
          cancelled: r.cancelled
        }
      })
      return { jobId }
    })
  }

  // ---- folder sync -------------------------------------------------------------------------------

  private async endpoint(owner: number, e: { sessionId: unknown; path: unknown }): Promise<Endpoint & { label: string }> {
    const s = this.session(owner, e.sessionId)
    const root = s.provider.path.normalize(checkPath(e.path))
    const st = await s.provider.stat(root)
    if (!st || st.kind !== 'directory') throw new Error(`${root} không phải là thư mục`)
    return { provider: s.provider, root, label: s.info.label }
  }

  syncCompare(owner: number, req: unknown): Promise<Result<SyncCompareResult>> {
    return attempt(async () => {
      const r = (req ?? {}) as Partial<SyncCompareRequest>
      const left = await this.endpoint(owner, { sessionId: r.left?.sessionId, path: r.left?.path })
      const right = await this.endpoint(owner, { sessionId: r.right?.sessionId, path: r.right?.path })
      if (left.provider.id === right.provider.id && left.provider.kind === right.provider.kind) {
        const p = left.provider.path
        const rel = p.relative(left.root, right.root)
        const inside = (x: string): boolean => x === '' || (!x.startsWith('..') && !p.isAbsolute(x))
        if (inside(rel) || inside(p.relative(right.root, left.root))) {
          throw new Error('Hai thư mục trùng nhau, hoặc một thư mục nằm trong thư mục kia. Hãy chọn hai thư mục tách biệt.')
        }
      }
      const ignore = Array.isArray(r.ignore) ? r.ignore.filter((x): x is string => typeof x === 'string' && x.length < 200).slice(0, 100) : []
      const diff = await compareFolders(left, right, { compare: r.compare === 'hash' ? 'hash' : 'quick', ignore })

      const id = randomUUID()
      this.comparisons.set(id, { owner, items: diff.items, left, right })
      while (this.comparisons.size > 8) this.comparisons.delete(this.comparisons.keys().next().value as string)
      const kindOf = (i: DiffItem): FsEntryKind => (i.left ?? i.right)!.kind
      return {
        compareId: id,
        items: diff.items.slice(0, MAX_SYNC_ITEMS).map((i) => ({
          rel: i.rel,
          status: i.status,
          kind: kindOf(i),
          ...(i.left ? { leftSize: i.left.size, leftMtimeMs: i.left.mtimeMs } : {}),
          ...(i.right ? { rightSize: i.right.size, rightMtimeMs: i.right.mtimeMs } : {})
        })),
        scanErrors: diff.scanErrors.map((e) => `${e.side}: ${e.path}: ${friendlyError(e.error)}`),
        truncated: diff.items.length > MAX_SYNC_ITEMS
      }
    })
  }

  private planFor(owner: number, req: unknown): { cmp: Comparison; plan: SyncPlan; mode: SyncMode; deleteExtras: boolean; overrides: Map<string, Direction> } {
    const r = (req ?? {}) as Partial<SyncPlanRequest>
    const cmp = typeof r.compareId === 'string' ? this.comparisons.get(r.compareId) : undefined
    if (!cmp || cmp.owner !== owner) throw new Error('Kết quả so sánh đã hết hạn. Hãy so sánh lại.')
    if (!MODES.includes(r.mode as SyncMode)) throw new Error('Hãy chọn cách đồng bộ')
    const overrides = new Map<string, Direction>()
    for (const [rel, dir] of Object.entries(r.overrides ?? {}).slice(0, MAX_SYNC_ITEMS)) {
      if (DIRECTIONS.includes(dir as SyncDirection)) overrides.set(rel, dir as Direction)
    }
    const mode = r.mode as SyncMode
    const deleteExtras = r.deleteExtras === true
    return { cmp, mode, deleteExtras, overrides, plan: buildPlan(cmp.items, { mode, deleteExtras, overrides }) }
  }

  syncPreview(owner: number, req: unknown): Promise<Result<{ preview: SyncPreview }>> {
    return attempt(async () => {
      const { cmp, plan, mode, deleteExtras, overrides } = this.planFor(owner, req)
      const directions: Record<string, SyncDirection> = {}
      for (const [rel, dir] of itemDirections(cmp.items, { mode, deleteExtras, overrides })) if (dir !== 'skip') directions[rel] = dir
      return { preview: { directions, summary: plan.summary } }
    })
  }

  syncRun(owner: number, req: unknown): Promise<Result<{ jobId: string }>> {
    return attempt(async () => {
      const { cmp, plan } = this.planFor(owner, req)
      if (plan.actions.length === 0) throw new Error('Không có gì để đồng bộ')
      const jobId = this.startJob(owner, 'sync', `Syncing ${cmp.left.root} and ${cmp.right.root}`, async ({ signal, update }) => {
        update({ filesTotal: plan.actions.length, bytesTotal: plan.summary.bytes })
        const report = await executePlan(plan, cmp.left, cmp.right, {
          signal,
          deleteMode: 'trash-folder', // deletions stay recoverable in .mymius-trash
          onProgress: (p) => update({ filesDone: p.done, bytesDone: p.bytesCopied, ...(p.current ? { current: p.current.rel } : {}) })
        })
        const errors = report.results.filter((x) => !x.ok).map((x) => ({ path: x.action.rel, message: x.error ?? 'Thất bại' }))
        return { summary: `${report.okCount}/${report.results.length} thay đổi đã áp dụng${errors.length ? `, ${errors.length} thất bại` : ''}`, errors, cancelled: report.cancelled }
      })
      return { jobId }
    })
  }

  // ---- opening files & remote editing ------------------------------------------------------------

  /**
   * Open a file. With no `options` it goes to the system's default program (the old behaviour). With them: the
   * program saved for this kind of file, or the one chosen now; when there is none, `how: 'ask'` tells the UI
   * to let the person pick. A server file is edited: it is downloaded, opened, and uploaded again on every save.
   */
  open(owner: number, sessionId: unknown, filePath: unknown, optionsRaw?: unknown): Promise<Result<OpenOutcome>> {
    return attempt(async () => {
      const s = this.session(owner, sessionId)
      const p = checkPath(filePath)
      const opts = optionsRaw === undefined ? undefined : parseOpenOptions(optionsRaw)
      const name = s.provider.path.basename(p)
      let app: AppChoice | undefined
      if (opts) {
        if (opts.app) {
          app = opts.app
        } else {
          const d = this.host.openWith.decide(name, opts.mode)
          if ('ask' in d) {
            const dot = name.lastIndexOf('.')
            return { how: 'ask' as const, name, ext: dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : '' }
          }
          app = d.use
        }
      }
      const launch = (file: string): Promise<void> => (app && app.kind === 'app' ? this.host.openWith.launch(file, app) : this.host.openLocal(file))
      if (s.info.kind === 'local') {
        await launch(p)
      } else {
        await this.editOpen(owner, s, p, launch)
      }
      // Only remember a choice that actually worked.
      if (opts?.app && opts.remember && opts.remember !== 'none') await this.host.openWith.remember(name, opts.remember, opts.app)
      return { how: s.info.kind === 'local' ? ('opened' as const) : ('editing' as const) }
    })
  }

  private async editOpen(owner: number, s: Session, remotePath: string, launch: (localPath: string) => Promise<void>): Promise<void> {
    if (!s.info.hostId) throw new Error('Không thể sửa ở đây')
    const st = await s.provider.stat(remotePath)
    if (!st || st.kind !== 'file') throw new Error('Chỉ có thể sửa file')
    if (st.size > 50 * 1024 * 1024) throw new Error('File lớn hơn 50 MB; hãy tải xuống thay vì sửa')

    // Its own connection lease, so closing the file pane does not cut off a file being edited.
    const lease = await this.broker.acquireSaved(s.info.hostId)
    let provider: SftpProvider | undefined
    try {
      provider = await SftpProvider.fromConnection(lease.connection)
      const session = await this.edits.open({
        provider,
        remotePath,
        workRoot: this.host.workRoot,
        openInEditor: launch,
        resolveConflict: (ctx) => this.host.confirmEditConflict(ctx)
      })
      const rec: EditRecord = { owner, name: s.provider.path.basename(remotePath), remotePath, hostLabel: s.info.label, provider, lease }
      this.editRecords.set(session.id, rec)
      const emit = (state: EditState, message?: string): void =>
        this.host.emitEdit(owner, { id: session.id, name: rec.name, remotePath, hostLabel: rec.hostLabel, state, ...(message ? { message } : {}) })
      session.on('state', (state: EditState) => emit(state))
      session.on('error', (err: Error) => emit('error', friendlyError(err)))
      emit(session.state)
    } catch (err) {
      await provider?.dispose().catch(() => undefined)
      await lease.release()
      throw err
    }
  }

  listEdits(owner: number): EditInfo[] {
    const out: EditInfo[] = []
    for (const [id, rec] of this.editRecords) {
      const session = this.edits.get(id)
      if (session && rec.owner === owner) out.push({ id, name: rec.name, remotePath: rec.remotePath, hostLabel: rec.hostLabel, state: session.state })
    }
    return out
  }

  async closeEdit(owner: number, id: unknown, discard: unknown): Promise<void> {
    const rec = typeof id === 'string' ? this.editRecords.get(id) : undefined
    if (!rec || rec.owner !== owner) return
    await this.edits.close(id as string, { discard: discard === true })
    this.editRecords.delete(id as string)
    await rec.provider.dispose().catch(() => undefined)
    await rec.lease.release()
    this.host.emitEdit(owner, { id: id as string, name: rec.name, remotePath: rec.remotePath, hostLabel: rec.hostLabel, state: 'closed' })
  }

  // ---- lifecycle ---------------------------------------------------------------------------------

  /** A window went away: stop its jobs, drop its connections and comparisons, end its edits. */
  async closeOwnedBy(owner: number): Promise<void> {
    for (const j of this.jobs.values()) if (j.owner === owner) j.abort.abort()
    for (const [id, c] of this.comparisons) if (c.owner === owner) this.comparisons.delete(id)
    for (const id of [...this.editRecords.keys()]) await this.closeEdit(owner, id, false)
    for (const [id, s] of [...this.sessions]) if (s.owner === owner) await this.disconnect(owner, id)
  }
}
