import type { FileSystemProvider, FileVersion } from './types'

export async function getVersion(
  provider: FileSystemProvider,
  path: string
): Promise<FileVersion | null> {
  const st = await provider.stat(path)
  if (!st) return null
  return { size: st.size, mtimeMs: st.mtimeMs }
}

/** Do two versions describe the same content? Unknown mtimes never match (caller should hash). */
export function sameVersion(a: FileVersion, b: FileVersion, toleranceMs = 0): boolean {
  if (a.etag !== undefined && b.etag !== undefined) return a.etag === b.etag
  if (a.size !== b.size) return false
  if (a.mtimeMs === null || b.mtimeMs === null) return false
  return Math.abs(a.mtimeMs - b.mtimeMs) <= toleranceMs
}

/** `expected === null` means "must not exist". */
export function versionMatches(
  expected: FileVersion | null,
  current: FileVersion | null,
  toleranceMs = 0
): boolean {
  if (expected === null || current === null) return expected === current
  return sameVersion(expected, current, toleranceMs)
}

/** Tolerance to use when comparing mtimes across two backends. */
export function mtimeTolerance(...resolutionsMs: number[]): number {
  return Math.max(1000, ...resolutionsMs)
}
