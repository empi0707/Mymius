/** Close Tab from the real application menu closes the tab in front, not the window. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import * as H from './helpers'

let app: ElectronApplication
let page: Page
let server: TestServer
let tmp: string

const closeTabFromMenu = () => app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.getMenuItemById('close-tab')!.click() })
const tabs = () => page.$$eval('.tab[role=tab]', (els) => els.map((e) => e.textContent))

async function connect(): Promise<void> {
  await page.click('button[aria-label="New connection"]')
  await page.fill('input[name=host]', '127.0.0.1')
  await page.fill('input[name=port]', String(server.port))
  await page.fill('input[name=username]', 'tester')
  await page.fill('input[name=password]', 'secret')
  await page.click('button[type=submit]')
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-'))
  server = await startSshTestServer(tmp)
  ;({ app, page } = await H.launch(join(tmp, 'profile')))
  await H.goTo(page, 'Terminals')
  await page.waitForSelector('form.form input[name=host]')
  await connect()
  await H.waitForText(page, 't1', 'welcome tester')
  await connect()
  await H.waitForText(page, 't2', 'welcome tester')
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await server?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('Close Tab menu item', () => {
  it('does not bind Ctrl/Cmd+W to closing the window', async () => {
    const accelerators = await app.evaluate(({ Menu }) => {
      const out: Record<string, string> = {}
      const walk = (items: Electron.MenuItem[]): void => { for (const i of items) { if (i.accelerator) out[i.id || i.label] = String(i.accelerator); if (i.submenu) walk(i.submenu.items) } }
      walk(Menu.getApplicationMenu()!.items)
      return out
    })
    const expected = process.platform === 'darwin' ? 'Cmd+W' : 'Ctrl+Shift+W'
    expect(accelerators['close-tab']).toBe(expected)
    expect(Object.values(accelerators).filter((a) => /^(Ctrl|Cmd|CmdOrCtrl|Command|Control)\+W$/.test(a)).length).toBe(process.platform === 'darwin' ? 1 : 0)
  })

  it('closes only the tab in front and leaves the window and the other tab alone', async () => {
    expect(await tabs()).toHaveLength(2)
    await closeTabFromMenu()
    await expect.poll(tabs).toHaveLength(1)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await H.screen(page, 't1')).toContain('welcome tester') // the first tab is still there and alive
    expect(server.connectionCount()).toBe(1) // the closed tab's connection went with it
  })

  it('does nothing while another section is showing', async () => {
    await H.goTo(page, 'Files')
    await closeTabFromMenu()
    await page.waitForTimeout(300)
    await H.goTo(page, 'Terminals')
    expect(await tabs()).toHaveLength(1)
  })
})
