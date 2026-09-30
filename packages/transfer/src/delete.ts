import type { FileSystemProvider } from '@mymius/core'
import type { TransferIssue } from './types'

export interface DeleteResult {
  deleted: number
  errors: TransferIssue[]
  cancelled: boolean
}

/**
 * Delete paths one by one; a failure on one does not stop the others.
 * `trash` (local disk only) moves things to the system trash so a mistake can be undone.
 */
export async function deletePaths(
  provider: FileSystemProvider,
  paths: readonly string[],
  opts: { trash?: (path: string) => Promise<void>; signal?: AbortSignal } = {}
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, errors: [], cancelled: false }
  for (const path of paths) {
    if (opts.signal?.aborted) { result.cancelled = true; break }
    try {
      if (opts.trash) await opts.trash(path)
      else await provider.remove(path, { recursive: true })
      result.deleted++
    } catch (err) {
      result.errors.push({ path, message: (err as Error).message })
    }
  }
  return result
}
