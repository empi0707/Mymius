import type { EntryKind, FileEntry, FileSystemProvider } from '@mymius/core'

export type Side = 'left' | 'right'
export type SyncMode = 'mirror-ltr' | 'mirror-rtl' | 'two-way'
/** ltr: make right match left. rtl: make left match right. */
export type Direction = 'ltr' | 'rtl' | 'skip'

export type DiffStatus =
  | 'same'
  | 'left-only'
  | 'right-only'
  | 'left-newer'
  | 'right-newer'
  /** Same mtime, different size: cannot tell which is right. */
  | 'different'
  /** A file on one side, a directory on the other. */
  | 'type-mismatch'

export interface DiffItem {
  /** Path relative to the root, always '/'-separated whatever the OS. */
  rel: string
  status: DiffStatus
  left?: FileEntry
  right?: FileEntry
}

export interface Endpoint {
  provider: FileSystemProvider
  root: string
}

export type SyncAction =
  | { op: 'mkdir'; side: Side; rel: string }
  | { op: 'copy'; from: Side; rel: string; size: number }
  | { op: 'delete'; side: Side; rel: string; kind: EntryKind; phase: 'pre' | 'post' }

export type SkipReason = 'same' | 'conflict' | 'type-mismatch' | 'unsupported' | 'extra-kept' | 'user'

export interface SkippedItem {
  rel: string
  status: DiffStatus
  reason: SkipReason
}

export interface SyncPlan {
  mode: SyncMode
  actions: SyncAction[]
  skipped: SkippedItem[]
  summary: { copies: number; mkdirs: number; deletes: number; bytes: number; conflicts: number }
}

export const TRASH_DIR = '.mymius-trash'
export const DEFAULT_IGNORE = ['.DS_Store', 'Thumbs.db', 'desktop.ini', TRASH_DIR]
