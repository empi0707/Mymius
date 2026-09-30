import type { FsEntry } from '../../../shared/ipc'

/**
 * The entries of one folder that a search shows. Matching is on the name only, ignoring letter case and accents' case,
 * anywhere in the name. Looking for ".env" means the person wants hidden files, so a search that starts with a dot
 * includes them even when hidden files are otherwise off.
 */
export function searchEntries(entries: readonly FsEntry[], query: string, showHidden: boolean): { shown: FsEntry[]; total: number } {
  const needle = query.trim().toLowerCase()
  const includeHidden = showHidden || needle.startsWith('.')
  const visible = includeHidden ? [...entries] : entries.filter((e) => !e.name.startsWith('.'))
  return { shown: needle ? visible.filter((e) => e.name.toLowerCase().includes(needle)) : visible, total: visible.length }
}
