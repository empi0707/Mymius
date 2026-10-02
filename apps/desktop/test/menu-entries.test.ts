import { describe, expect, it } from 'vitest'
import { buildMenu, type MenuEntry } from '../src/renderer/src/files/menu'

const actions = (m: MenuEntry[]) => m.flatMap((e) => (e.separator ? [] : [e.action]))
const item = (m: MenuEntry[], a: string) => m.find((e) => !e.separator && e.action === a) as Extract<MenuEntry, { action: string }>

describe('right-click menu of a file pane', () => {
  it('on an item in a server pane offers Download, copy/move, rename, delete', () => {
    const m = buildMenu({ onItems: true, count: 1, remote: true, hasTarget: true })
    expect(actions(m)).toEqual(['open', 'download', 'copy', 'move', 'rename', 'copyPath', 'delete', 'newFolder', 'refresh'])
    expect(item(m, 'download').label).toBe('Download…')
    expect(item(m, 'delete').danger).toBe(true)
  })

  it('has no Download for the local disk', () => {
    expect(actions(buildMenu({ onItems: true, count: 1, remote: false, hasTarget: true }))).not.toContain('download')
  })

  it('with several items: counts them, and Open / Rename are off', () => {
    const m = buildMenu({ onItems: true, count: 3, remote: true, hasTarget: true })
    expect(item(m, 'download').label).toBe('Download 3 items…')
    expect(item(m, 'delete').label).toBe('Delete 3 items')
    expect(item(m, 'open').disabled).toBe(true)
    expect(item(m, 'rename').disabled).toBe(true)
    expect(item(m, 'copyPath').label).toBe('Copy paths')
  })

  it('cannot copy or move while the other pane is not connected', () => {
    const m = buildMenu({ onItems: true, count: 1, remote: false, hasTarget: false })
    expect(item(m, 'copy').disabled).toBe(true)
    expect(item(m, 'move').disabled).toBe(true)
  })

  it('on the empty space: New folder, Refresh, Select all only', () => {
    expect(actions(buildMenu({ onItems: false, count: 0, remote: true, hasTarget: true }))).toEqual(['newFolder', 'refresh', 'selectAll'])
  })
})
