/** Where dragged files come from, or go to: this computer, or one particular saved host. */
export interface DragEnd {
  kind: 'local' | 'sftp'
  hostId?: string | undefined
}

/**
 * What dropping does. Inside the same server (or on this computer) the files are MOVED; between different servers, or
 * between this computer and a server, they are COPIED. Holding Alt / Option while dropping always copies.
 */
export function dropMode(from: DragEnd, to: DragEnd, altKey = false): 'move' | 'copy' {
  if (altKey) return 'copy'
  const same = from.kind === 'local' ? to.kind === 'local' : to.kind === 'sftp' && Boolean(from.hostId) && from.hostId === to.hostId
  return same ? 'move' : 'copy'
}

/** The folder a path is in, for either kind of separator. */
export function parentOf(path: string, sep: '/' | '\\'): string {
  const i = path.lastIndexOf(sep)
  return i <= 0 ? sep : path.slice(0, i)
}

/** Moving files into the folder they are already in does nothing. */
export function isMoveIntoSameFolder(paths: readonly string[], targetDir: string, sep: '/' | '\\'): boolean {
  const norm = (p: string): string => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p)
  return paths.length > 0 && paths.every((p) => parentOf(norm(p), sep) === norm(targetDir))
}
