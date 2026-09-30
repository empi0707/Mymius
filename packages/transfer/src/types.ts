import type { FileSystemProvider } from '@mymius/core'

/** What to do when something with the same name already exists at the destination. */
export type ConflictPolicy = 'overwrite' | 'skip' | 'keep-both'

export interface TransferRequest {
  src: FileSystemProvider
  srcPaths: readonly string[]
  dst: FileSystemProvider
  dstDir: string
  policy?: ConflictPolicy
  /** Remove the sources once they are safely at the destination. */
  move?: boolean
}

export interface TransferProgress {
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  /** The file being copied right now. */
  current?: string
}

export interface TransferIssue {
  path: string
  message: string
}

export interface TransferResult {
  /** Files copied. */
  copied: number
  /** Top-level items moved by renaming (no data copied). */
  renamed: number
  skipped: number
  bytes: number
  errors: TransferIssue[]
  /** Sources that were not copied because they are links or special files. */
  ignored: string[]
  cancelled: boolean
}

export interface TransferOptions {
  signal?: AbortSignal
  onProgress?: (p: TransferProgress) => void
  concurrency?: number
}
