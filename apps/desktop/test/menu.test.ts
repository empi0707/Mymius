import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { menuTemplate } from '../src/main/menu'

const items = (t: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  t.flatMap((m) => [m, ...(Array.isArray(m.submenu) ? items(m.submenu) : [])])
const accel = (mac: boolean) => items(menuTemplate(mac, () => undefined)).flatMap((i) => (i.accelerator ? [String(i.accelerator)] : []))

describe('application menu', () => {
  it('macOS: Cmd+W closes the tab, the window needs Shift+Cmd+W, and nothing else takes Cmd+W', () => {
    const t = items(menuTemplate(true, () => undefined))
    expect(t.find((i) => i.id === 'close-tab')!.accelerator).toBe('Cmd+W')
    expect(t.find((i) => i.id === 'close-window')).toMatchObject({ role: 'close', accelerator: 'Shift+Cmd+W' })
    expect(accel(true).filter((a) => a === 'Cmd+W' || a === 'CmdOrCtrl+W')).toEqual(['Cmd+W'])
  })

  it('Windows/Linux: Ctrl+W is left to the terminal; Ctrl+Shift+W closes the tab', () => {
    const t = items(menuTemplate(false, () => undefined))
    expect(t.find((i) => i.id === 'close-tab')!.accelerator).toBe('Ctrl+Shift+W')
    expect(accel(false)).not.toContain('Ctrl+W')
    expect(accel(false)).not.toContain('CmdOrCtrl+W')
  })

  it('runs the handler when Close Tab is chosen', () => {
    let n = 0
    const item = items(menuTemplate(true, () => { n++ })).find((i) => i.id === 'close-tab')!
    ;(item.click as () => void)()
    expect(n).toBe(1)
  })
})
