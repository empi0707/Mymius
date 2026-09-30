import type { FileSystemProvider, FileVersion } from '@mymius/core'

export type EditState = 'opening' | 'synced' | 'uploading' | 'unsynced' | 'conflict' | 'error' | 'closed'

/** What the local save resulted in. */
export type SaveOutcome = 'unchanged' | 'uploaded' | 'recreated' | 'reloaded' | 'cancelled'

export type ConflictChoice = 'overwrite' | 'reload' | 'cancel'

export interface Baseline {
  /** What the server looked like when we last synced. */
  version: FileVersion
  hash: string
}

export interface ConflictContext {
  sessionId: string
  remotePath: string
  localPath: string
  /** modified: the server copy changed since we opened it. deleted: it no longer exists. */
  kind: 'modified' | 'deleted'
  baseline: Baseline
  /** Current server version; null when deleted. */
  remote: FileVersion | null
}

export interface FileWatcher {
  /** Resolves once changes are guaranteed to be seen. The editor is only launched after this. */
  ready?: Promise<void>
  close(): Promise<void>
}

export interface RemoteEditDeps {
  provider: FileSystemProvider
  remotePath: string
  /** Directory under which this session gets its own private folder. */
  workRoot: string
  /** Launch the user's editor on the local copy. */
  openInEditor(localPath: string): Promise<void>
  /**
   * Ask the user. For kind 'deleted', 'overwrite' means "recreate the file" and 'reload' is invalid.
   */
  resolveConflict(ctx: ConflictContext): Promise<ConflictChoice>
  /** Override how the local file is watched (tests, or a different watcher backend). */
  watch?: (localPath: string, onChange: () => void) => FileWatcher
  debounceMs?: number
  id?: string
}
