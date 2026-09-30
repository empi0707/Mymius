import type { EditInfo, JobState } from '../../../shared/ipc'

/** Something the app is busy with that the person may be waiting for. `progress` is 0..1 when it is known. */
export interface Activity {
  id: string
  label: string
  progress?: number
}

const scopes = new Map<string, Activity[]>()
const listeners = new Set<() => void>()
let snapshot: Activity[] = []

export const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const getSnapshot = (): Activity[] => snapshot

/** Replace everything one part of the app reports (its "scope") in one go. An empty list clears it. */
export function setActivities(scope: string, list: Activity[]): void {
  const before = scopes.get(scope)
  if (list.length === 0 ? before === undefined : before !== undefined && same(before, list)) return
  if (list.length === 0) scopes.delete(scope)
  else scopes.set(scope, list)
  snapshot = [...scopes.values()].flat()
  for (const l of listeners) l()
}

function same(a: Activity[], b: Activity[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.label === b[i]!.label && x.progress === b[i]!.progress)
}

/** One line for the bar: the first thing, plus how many others. Determinate only when a single job has a known progress. */
export function summarize(list: Activity[]): { label: string; progress?: number } | null {
  if (list.length === 0) return null
  const first = list[0]!
  const label = list.length === 1 ? first.label : `${first.label} (+${list.length - 1})`
  return list.length === 1 && first.progress !== undefined ? { label, progress: clamp(first.progress) } : { label }
}

const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** What the file manager is waiting for: a server connection, a running transfer, a remote file being opened or uploaded. */
export function filesActivities(input: {
  connecting: { side: number; host?: string }[]
  jobs: Pick<JobState, 'id' | 'label' | 'state' | 'filesDone' | 'filesTotal' | 'bytesDone' | 'bytesTotal'>[]
  edits: Pick<EditInfo, 'id' | 'name' | 'state'>[]
}): Activity[] {
  const out: Activity[] = []
  for (const c of input.connecting) out.push({ id: `connect:${c.side}`, label: c.host ? `Đang kết nối ${c.host}…` : 'Đang kết nối máy chủ…' })
  for (const j of input.jobs) {
    if (j.state !== 'running') continue
    const progress = j.bytesTotal > 0 ? j.bytesDone / j.bytesTotal : j.filesTotal > 0 ? j.filesDone / j.filesTotal : undefined
    out.push({ id: `job:${j.id}`, label: j.label, ...(progress !== undefined ? { progress } : {}) })
  }
  for (const e of input.edits) {
    if (e.state === 'opening') out.push({ id: `edit:${e.id}`, label: `Đang mở ${e.name}…` })
    else if (e.state === 'uploading') out.push({ id: `edit:${e.id}`, label: `Đang tải lên ${e.name}…` })
  }
  return out
}

