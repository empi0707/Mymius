import { describe, expect, it } from 'vitest'
import { searchEntries } from '../src/renderer/src/files/search'
import type { FsEntry } from '../src/shared/ipc'

const e = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({ name, path: '/x/' + name, kind, size: 1, mtimeMs: 1 }) as FsEntry
const entries = [e('Report.PDF'), e('notes.txt'), e('src', 'directory'), e('Source code', 'directory'), e('.env'), e('.gitignore'), e('résumé.docx')]
const names = (r: { shown: FsEntry[] }) => r.shown.map((x) => x.name)

describe('searching one folder', () => {
  it('without a query shows everything except hidden files, and counts what could be shown', () => {
    const r = searchEntries(entries, '', false)
    expect(names(r)).toEqual(['Report.PDF', 'notes.txt', 'src', 'Source code', 'résumé.docx'])
    expect(r.total).toBe(5)
    expect(searchEntries(entries, '   ', false).shown).toHaveLength(5)
  })
  it('matches anywhere in the name, in any letter case, for files and folders alike', () => {
    expect(names(searchEntries(entries, 'SRC', false))).toEqual(['src'])
    expect(names(searchEntries(entries, 'sour', false))).toEqual(['Source code'])
    expect(names(searchEntries(entries, 'port', false))).toEqual(['Report.PDF'])
    expect(names(searchEntries(entries, 'o', false))).toEqual(['Report.PDF', 'notes.txt', 'Source code', 'résumé.docx'])
    expect(names(searchEntries(entries, ' notes ', false))).toEqual(['notes.txt']) // surrounding spaces do not count
    expect(names(searchEntries(entries, 'é', false))).toEqual(['résumé.docx'])
  })
  it('finds nothing when nothing matches, and never treats the query as a pattern', () => {
    expect(searchEntries(entries, 'zzz', false).shown).toEqual([])
    expect(searchEntries(entries, '.*', false).shown).toEqual([])
    expect(searchEntries(entries, '[', false).shown).toEqual([])
    expect(searchEntries(entries, 'zzz', false).total).toBe(5)
  })
  it('hidden files stay out unless asked for, or unless the search starts with a dot', () => {
    expect(names(searchEntries(entries, 'env', false))).toEqual([])
    expect(names(searchEntries(entries, '.env', false))).toEqual(['.env'])
    expect(names(searchEntries(entries, '.', false))).toEqual(['Report.PDF', 'notes.txt', '.env', '.gitignore', 'résumé.docx'])
    expect(names(searchEntries(entries, 'env', true))).toEqual(['.env'])
  })
})
