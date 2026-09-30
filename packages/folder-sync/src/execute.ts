import { copyFile, runPool, type FileSystemProvider } from '@mymius/core'
import { depthOf, toAbs } from './paths'
import { TRASH_DIR, type Endpoint, type Side, type SyncAction, type SyncPlan } from './types'

export interface ExecuteOptions {
  concurrency?: number
  /** Report what would happen without touching anything. */
  dryRun?: boolean
  signal?: AbortSignal
  /** permanent: remove for good. trash-folder: move into <root>/.mymius-trash/<runId>/ (recoverable). */
  deleteMode?: 'permanent' | 'trash-folder'
  runId?: string
  onProgress?: (p: SyncProgress) => void
}

export interface SyncProgress {
  done: number
  total: number
  bytesCopied: number
  current?: SyncAction
}

export interface ActionResult {
  action: SyncAction
  ok: boolean
  error?: string
}

export interface SyncReport {
  results: ActionResult[]
  okCount: number
  failCount: number
  bytesCopied: number
  cancelled: boolean
}

/**
 * Runs a plan in dependency order: replace-deletes, folders, file copies (parallel), then deletes.
 * A failing action is recorded and the run continues; the report says what did not happen.
 */
export async function executePlan(
  plan: SyncPlan,
  left: Endpoint,
  right: Endpoint,
  opts: ExecuteOptions = {}
): Promise<SyncReport> {
  const ep = (side: Side): Endpoint => (side === 'left' ? left : right)
  const results: ActionResult[] = []
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, '-')
  const deleteMode = opts.deleteMode ?? 'trash-folder'
  const madeDirs = new Set<string>()
  let bytesCopied = 0
  let done = 0
  const total = plan.actions.length

  const tick = (action: SyncAction, ok: boolean, error?: string): void => {
    results.push({ action, ok, ...(error ? { error } : {}) })
    done++
    opts.onProgress?.({ done, total, bytesCopied, current: action })
  }

  const run = async (action: SyncAction): Promise<void> => {
    if (opts.dryRun) return tick(action, true)
    try {
      switch (action.op) {
        case 'mkdir': {
          const target = ep(action.side)
          await target.provider.mkdir(toAbs(target, action.rel), { recursive: true })
          break
        }
        case 'copy': {
          const src = ep(action.from)
          const dst = ep(action.from === 'left' ? 'right' : 'left')
          const dstAbs = toAbs(dst, action.rel)
          const parent = dst.provider.path.dirname(dstAbs)
          const key = `${dst === left ? 'L' : 'R'}:${parent}`
          if (!madeDirs.has(key)) {
            await dst.provider.mkdir(parent, { recursive: true })
            madeDirs.add(key)
          }
          let last = 0
          await copyFile(src.provider, toAbs(src, action.rel), dst.provider, dstAbs, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            onProgress: (n) => {
              bytesCopied += n - last
              last = n
            }
          })
          break
        }
        case 'delete': {
          const target = ep(action.side)
          await removeOrTrash(target, action.rel, deleteMode, runId)
          break
        }
      }
      tick(action, true)
    } catch (err) {
      tick(action, false, (err as Error).message)
    }
  }

  const pre = plan.actions.filter((a) => a.op === 'delete' && a.phase === 'pre')
  const mkdirs = plan.actions.filter((a) => a.op === 'mkdir')
  const copies = plan.actions.filter((a) => a.op === 'copy')
  const post = plan.actions.filter((a) => a.op === 'delete' && a.phase === 'post')
  const byDepth = (dir: 1 | -1) => (a: SyncAction, b: SyncAction) => dir * (depthOf(a.rel) - depthOf(b.rel))

  const concurrency = opts.concurrency ?? 4
  await runPool(pre.sort(byDepth(-1)), 1, run, opts.signal)
  await runPool(mkdirs.sort(byDepth(1)), concurrency, run, opts.signal)
  await runPool(copies, concurrency, run, opts.signal)
  await runPool(post.sort(byDepth(-1)), 1, run, opts.signal)

  const okCount = results.filter((r) => r.ok).length
  return {
    results,
    okCount,
    failCount: results.length - okCount,
    bytesCopied,
    cancelled: opts.signal?.aborted ?? false
  }
}

async function removeOrTrash(
  ep: Endpoint,
  rel: string,
  mode: 'permanent' | 'trash-folder',
  runId: string
): Promise<void> {
  const target = toAbs(ep, rel)
  const p: FileSystemProvider['path'] = ep.provider.path
  if (mode === 'permanent') {
    await ep.provider.remove(target, { recursive: true })
    return
  }
  const trashed = p.join(ep.root, TRASH_DIR, runId, ...rel.split('/'))
  await ep.provider.mkdir(p.dirname(trashed), { recursive: true })
  await ep.provider.rename(target, trashed, { overwrite: true })
}
