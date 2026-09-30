import { depthOf, isAncestor } from './paths'
import type { Direction, DiffItem, DiffStatus, Side, SkipReason, SkippedItem, SyncAction, SyncMode, SyncPlan } from './types'

export interface PlanOptions {
  mode: SyncMode
  /** Mirror modes: remove files that exist only on the destination. */
  deleteExtras?: boolean
  /** Per-item choice from the UI (the arrows the user clicked). Wins over the mode's default; a folder's choice covers its contents. */
  overrides?: ReadonlyMap<string, Direction>
}

interface Decision {
  dir: Direction
  reason?: SkipReason
}

function defaultDecision(status: DiffStatus, mode: SyncMode, deleteExtras: boolean): Decision {
  if (status === 'same') return { dir: 'skip', reason: 'same' }
  switch (mode) {
    case 'mirror-ltr':
      if (status === 'right-only') return deleteExtras ? { dir: 'ltr' } : { dir: 'skip', reason: 'extra-kept' }
      return { dir: 'ltr' }
    case 'mirror-rtl':
      if (status === 'left-only') return deleteExtras ? { dir: 'rtl' } : { dir: 'skip', reason: 'extra-kept' }
      return { dir: 'rtl' }
    case 'two-way':
      switch (status) {
        case 'left-only':
        case 'left-newer':
          return { dir: 'ltr' }
        case 'right-only':
        case 'right-newer':
          return { dir: 'rtl' }
        case 'type-mismatch':
          return { dir: 'skip', reason: 'type-mismatch' }
        default:
          return { dir: 'skip', reason: 'conflict' }
      }
  }
}

/** An explicit choice on an item, or inherited from the nearest ancestor folder that has one. */
function overrideFor(rel: string, overrides: ReadonlyMap<string, Direction> | undefined): Direction | undefined {
  if (!overrides || overrides.size === 0) return undefined
  for (let cur = rel; ; ) {
    const hit = overrides.get(cur)
    if (hit) return hit
    const slash = cur.lastIndexOf('/')
    if (slash < 0) return undefined
    cur = cur.slice(0, slash)
  }
}

/** The direction shown for each item (what the arrows in the UI should display). */
export function itemDirections(items: readonly DiffItem[], opts: PlanOptions): Map<string, Direction> {
  const out = new Map<string, Direction>()
  for (const item of items) {
    const forced = overrideFor(item.rel, opts.overrides)
    out.set(item.rel, forced ?? defaultDecision(item.status, opts.mode, opts.deleteExtras ?? false).dir)
  }
  return out
}

export function buildPlan(items: readonly DiffItem[], opts: PlanOptions): SyncPlan {
  const actions: SyncAction[] = []
  const skipped: SkippedItem[] = []

  for (const item of items) {
    const forced = overrideFor(item.rel, opts.overrides)
    const decision: Decision = forced
      ? { dir: forced, ...(forced === 'skip' ? { reason: 'user' as const } : {}) }
      : defaultDecision(item.status, opts.mode, opts.deleteExtras ?? false)

    if (decision.dir === 'skip') {
      skipped.push({ rel: item.rel, status: item.status, reason: decision.reason ?? 'user' })
      continue
    }
    const from: Side = decision.dir === 'ltr' ? 'left' : 'right'
    const to: Side = from === 'left' ? 'right' : 'left'
    const src = item[from]
    const dst = item[to]

    if (!src) {
      // Nothing on the source side: making the destination match means removing it.
      if (dst) actions.push({ op: 'delete', side: to, rel: item.rel, kind: dst.kind, phase: 'post' })
      continue
    }
    if (src.kind !== 'file' && src.kind !== 'directory') {
      skipped.push({ rel: item.rel, status: item.status, reason: 'unsupported' })
      continue
    }
    if (dst && dst.kind !== src.kind) {
      actions.push({ op: 'delete', side: to, rel: item.rel, kind: dst.kind, phase: 'pre' })
    }
    if (src.kind === 'directory') {
      if (!dst || dst.kind !== 'directory') actions.push({ op: 'mkdir', side: to, rel: item.rel })
    } else {
      actions.push({ op: 'copy', from, rel: item.rel, size: src.size })
    }
  }

  const pruned = pruneNestedDeletes(actions)
  return { mode: opts.mode, actions: pruned, skipped, summary: summarize(pruned, skipped) }
}

/** Deleting a directory already removes its children; drop the redundant child deletes. */
function pruneNestedDeletes(actions: SyncAction[]): SyncAction[] {
  const deletes = actions.filter((a): a is Extract<SyncAction, { op: 'delete' }> => a.op === 'delete')
  return actions.filter((a) => {
    if (a.op !== 'delete') return true
    return !deletes.some((d) => d !== a && d.side === a.side && isAncestor(d.rel, a.rel))
  })
}

function summarize(actions: SyncAction[], skipped: SkippedItem[]): SyncPlan['summary'] {
  let copies = 0
  let mkdirs = 0
  let deletes = 0
  let bytes = 0
  for (const a of actions) {
    if (a.op === 'copy') {
      copies++
      bytes += a.size
    } else if (a.op === 'mkdir') mkdirs++
    else deletes++
  }
  return { copies, mkdirs, deletes, bytes, conflicts: skipped.filter((s) => s.reason === 'conflict' || s.reason === 'type-mismatch').length }
}

export { depthOf }
