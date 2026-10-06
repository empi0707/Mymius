/**
 * Choosing the program a file opens with, in the real app: a server .html file is edited in the chosen program
 * (not the browser), the choice is remembered per type, "Edit" and "Open with…" are in the right-click menu, and
 * Settings can forget a choice.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import * as H from './helpers'

const PASS = 'correct horse battery staple'
let tmp: string
let home: string
let remote: string
let log: string
let editor: string
let server: TestServer
let app: ElectronApplication
let page: Page

const pane = (i: 0 | 1) => page.locator(`[data-testid=pane-${i}]`)
const row = (i: 0 | 1, name: string): Locator => pane(i).locator(`[role=option][data-name="${name}"]`)
const dialog = () => page.locator('[role=dialog]')
const launches = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
const waitLaunches = (n: number) => expect.poll(async () => (await launches()).length, { timeout: 10_000 }).toBe(n)
const remoteText = (name: string) => readFile(join(remote, name), 'utf8')
const waitRemote = async (name: string, content: string) => {
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    if ((await remoteText(name).catch(() => '')) === content) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${name} never became ${JSON.stringify(content)}`)
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-openwith-'))
  home = join(tmp, 'home'); remote = join(tmp, 'remote'); log = join(tmp, 'launches.txt')
  await mkdir(home); await mkdir(remote)
  // A stand-in editor: records the file it was asked to open.
  editor = join(tmp, 'my-editor.sh')
  await writeFile(editor, `#!/bin/sh\necho "$1" >> "${log}"\n`)
  await chmod(editor, 0o755)
  await writeFile(join(home, 'local.txt'), 'x')
  await writeFile(join(remote, 'index.html'), '<p>one</p>')
  await writeFile(join(remote, 'other.html'), '<p>two</p>')
  await writeFile(join(remote, 'notes.txt'), 'plain notes')
  server = await startSshTestServer(remote, { password: 'pw-ow' })
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home }))
  await H.createVault(page, PASS)
  await H.addPasswordHost(page, { name: 'box', port: server.port, username: 'tester', password: 'pw-ow' })
  await H.goTo(page, 'Files')
  await page.waitForSelector('[data-testid=pane-0] [role=option]')
  await pane(1).locator('select').selectOption({ label: 'box' })
  await row(1, 'index.html').waitFor()
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await server?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('opening a server file with a chosen program', () => {
  it('double-clicking an .html file asks which program to use instead of sending it to the browser', async () => {
    await row(1, 'index.html').dblclick()
    await dialog().waitFor()
    expect(await dialog().textContent()).toContain('index.html')
    expect(await H.openedByApp(app)).toEqual([]) // the system default (the browser) was not used
    expect(await launches()).toEqual([])
  })

  it('opens it in the chosen program and remembers it for .html files', async () => {
    await H.answerFilePicker(app, editor)
    await page.click('[role=dialog] button:has-text("Choose application…")')
    await page.waitForFunction(() => document.querySelector('[data-testid=openwith-app]')?.textContent === 'my-editor.sh')
    expect(await page.isChecked('[role=dialog] label:has-text("Luôn dùng cho file .html") input')).toBe(true) // the default
    await page.click('[role=dialog] button.primary')
    await waitLaunches(1)
    const local = (await launches())[0]!
    expect(local).toMatch(/index\.html$/)
    expect(await readFile(local, 'utf8')).toBe('<p>one</p>')
    expect(await H.openedByApp(app)).toEqual([])
    // It is a normal edit session: saving uploads.
    await page.locator('[data-testid="edit-index.html"]').waitFor()
    await writeFile(local, '<p>edited</p>')
    await waitRemote('index.html', '<p>edited</p>')
  })

  it('the next .html file opens straight away in the same program; other types still ask', async () => {
    await row(1, 'other.html').dblclick()
    await waitLaunches(2)
    expect(await dialog().count()).toBe(0)
    await row(1, 'notes.txt').dblclick()
    await dialog().waitFor()
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
    expect(await launches()).toHaveLength(2) // cancelled: nothing started
  })

  it('the right-click menu has Edit and Open with…, and Edit uses the saved program', async () => {
    await row(1, 'other.html').click({ button: 'right' })
    const items = await page.locator('[data-testid=context-menu] [role=menuitem] span:first-child').allTextContents()
    expect(items).toContain('Edit')
    expect(items).toContain('Open with…')
    await page.click('[data-testid=context-menu] [role=menuitem]:has-text("Edit")')
    await waitLaunches(3)
    expect(await dialog().count()).toBe(0)
  })

  it('Edit and Open with… are off for a folder', async () => {
    await pane(0).locator('.rows').click({ button: 'right', position: { x: 60, y: 200 } })
    await page.keyboard.press('Escape')
    await mkdir(join(remote, 'dir'))
    await page.click('[aria-label=Refresh] >> nth=1')
    await row(1, 'dir').click({ button: 'right' })
    expect(await page.locator('[data-testid=context-menu] [role=menuitem]:has-text("Edit")').isDisabled()).toBe(true)
    expect(await page.locator('[data-testid=context-menu] [role=menuitem]:has-text("Open with…")').isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
  })

  it('F4 edits the file under the cursor', async () => {
    await row(1, 'other.html').click()
    await page.keyboard.press('F4')
    await waitLaunches(4)
  })

  it('Open with… always asks, even when a program is saved', async () => {
    await row(1, 'index.html').click({ button: 'right' })
    await page.click('[data-testid=context-menu] [role=menuitem]:has-text("Open with…")')
    await dialog().waitFor()
    await H.answerFilePicker(app, editor)
    await page.click('[role=dialog] button:has-text("Choose application…")')
    await page.click('[role=dialog] label:has-text("Chỉ lần này") input')
    await page.click('[role=dialog] button.primary')
    await waitLaunches(5)
  })

  it('Settings lists the saved program for .html, and forgetting it makes the app ask again', async () => {
    await H.goTo(page, 'Settings')
    const card = page.locator('[data-testid=openwith-card]')
    await card.waitFor()
    expect(await card.locator('[data-testid=assoc]').allTextContents()).toEqual([expect.stringContaining('.html')])
    await card.locator('button[aria-label="Forget .html"]').click()
    await expect.poll(() => card.locator('[data-testid=assoc]').count()).toBe(0)
    await H.goTo(page, 'Files')
    await row(1, 'index.html').dblclick()
    await dialog().waitFor()
    await page.keyboard.press('Escape')
  })
})
