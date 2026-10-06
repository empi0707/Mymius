/**
 * The right-click menu of the file panes in the real app: the usual file-manager commands, and Download for
 * files and folders that are on a server.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
let downloads: string
let server: TestServer
let app: ElectronApplication
let page: Page

const pane = (i: 0 | 1) => page.locator(`[data-testid=pane-${i}]`)
const row = (i: 0 | 1, name: string): Locator => pane(i).locator(`[role=option][data-name="${name}"]`)
const names = async (i: 0 | 1): Promise<string[]> => pane(i).locator('[role=option]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name ?? ''))
const menu = () => page.locator('[data-testid=context-menu]')
const choose = (label: string | RegExp) => menu().locator('[role=menuitem]', { hasText: label }).click()
const rightClick = (i: 0 | 1, name: string) => row(i, name).click({ button: 'right' })
const itemsInMenu = () => menu().locator('[role=menuitem]').evaluateAll((els) => els.map((e) => (e.querySelector('span')?.textContent ?? '')))
const waitJob = async () => {
  const job = page.locator('[data-testid^=job-].done, [data-testid^=job-].failed').first()
  await job.waitFor({ timeout: 20_000 })
  return (await job.textContent()) ?? ''
}
const dismissJobs = async () => { for (const b of await page.locator('[data-testid^=job-] button:has-text("Dismiss")').all()) await b.click() }

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-ctx-'))
  home = join(tmp, 'home'); remote = join(tmp, 'remote'); downloads = join(tmp, 'downloads')
  await mkdir(home); await mkdir(remote); await mkdir(downloads)
  await writeFile(join(home, 'local.txt'), 'local file')
  await writeFile(join(home, 'other.txt'), 'other')
  await mkdir(join(remote, 'logs'))
  await writeFile(join(remote, 'logs', 'a.log'), 'line a')
  await writeFile(join(remote, 'logs', 'b.log'), 'line b')
  await writeFile(join(remote, 'app.conf'), 'listen 80;\n')
  await writeFile(join(remote, 'notes.txt'), 'remote notes')
  server = await startSshTestServer(remote, { password: 'pw-ctx' })
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home }))
  await H.createVault(page, PASS)
  await H.addPasswordHost(page, { name: 'box', port: server.port, username: 'tester', password: 'pw-ctx' })
  await H.goTo(page, 'Files')
  await page.waitForSelector('[data-testid=pane-0] [role=option]')
  await pane(1).locator('select').selectOption({ label: 'box' })
  await row(1, 'notes.txt').waitFor()
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await server?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('right-click menu', () => {
  it('opens on a file, selects it, and closes with Escape or a click elsewhere', async () => {
    await rightClick(0, 'local.txt')
    await menu().waitFor()
    expect(await row(0, 'local.txt').getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('Escape')
    await menu().waitFor({ state: 'detached' })
    await rightClick(0, 'local.txt')
    await menu().waitFor()
    await pane(0).locator('.pane-top').click()
    await menu().waitFor({ state: 'detached' })
  })

  it('has Download for server items only', async () => {
    await rightClick(0, 'local.txt')
    expect(await itemsInMenu()).not.toContain('Download…')
    await page.keyboard.press('Escape')
    await rightClick(1, 'notes.txt')
    expect(await itemsInMenu()).toEqual(['Open', 'Edit', 'Open with…', 'Download…', 'Copy to other pane', 'Move to other pane', 'Rename', 'Copy path', 'Delete', 'New folder', 'Refresh'])
    await page.keyboard.press('Escape')
  })

  it('Download of a file saves it into the folder chosen in the dialog', async () => {
    await H.answerFilePicker(app, downloads)
    await rightClick(1, 'notes.txt')
    await choose('Download…')
    expect(await waitJob()).toBeTruthy()
    expect(await readFile(join(downloads, 'notes.txt'), 'utf8')).toBe('remote notes')
    await dismissJobs()
  })

  it('Download of a folder and a file together keeps the folder structure', async () => {
    await row(1, 'logs').click()
    await row(1, 'app.conf').click({ modifiers: ['Control'] })
    await rightClick(1, 'logs')
    expect(await itemsInMenu()).toContain('Download 2 items…')
    await choose('Download 2 items…')
    await waitJob()
    expect((await readdir(join(downloads, 'logs'))).sort()).toEqual(['a.log', 'b.log'])
    expect(await readFile(join(downloads, 'logs', 'b.log'), 'utf8')).toBe('line b')
    expect(await readFile(join(downloads, 'app.conf'), 'utf8')).toBe('listen 80;\n')
    await dismissJobs()
  })

  it('cancelling the folder dialog downloads nothing', async () => {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as never })
    const before = (await readdir(downloads)).length
    await rightClick(1, 'notes.txt')
    await choose('Download…')
    await page.waitForTimeout(500)
    expect((await readdir(downloads)).length).toBe(before)
    expect(await page.locator('[data-testid^=job-]').count()).toBe(0)
  })

  it('Copy to other pane works from the menu (local → server)', async () => {
    await rightClick(0, 'other.txt')
    await choose('Copy to other pane')
    await waitJob()
    expect(await readFile(join(remote, 'other.txt'), 'utf8')).toBe('other')
    await dismissJobs()
    await expect.poll(() => names(1)).toContain('other.txt')
  })

  it('Rename from the menu', async () => {
    await rightClick(0, 'other.txt')
    await choose('Rename')
    await page.fill('input[aria-label=Name]', 'renamed.txt')
    await page.click('button:has-text("Rename") >> nth=-1')
    await expect.poll(() => names(0)).toContain('renamed.txt')
    expect(await names(0)).not.toContain('other.txt')
  })

  it('New folder and Refresh from the empty space of a pane', async () => {
    await pane(0).locator('.rows').click({ button: 'right', position: { x: 60, y: 200 } })
    expect(await itemsInMenu()).toEqual(['New folder', 'Refresh', 'Select all'])
    await choose('New folder')
    await page.fill('input[aria-label=Name]', 'made-here')
    await page.click('button:has-text("Create")')
    await expect.poll(() => names(0)).toContain('made-here')
    await pane(0).locator('.rows').click({ button: 'right', position: { x: 60, y: 200 } })
    await choose('Select all')
    expect(await pane(0).locator('[role=option][aria-selected=true]').count()).toBe((await names(0)).length)
  })

  it('Delete from the menu asks first, and removes a server item', async () => {
    await rightClick(1, 'other.txt')
    await choose('Delete')
    await page.waitForSelector('button:has-text("Delete permanently")')
    await page.click('button:has-text("Delete permanently")')
    await expect.poll(() => names(1)).not.toContain('other.txt')
  })

  it('the keyboard opens it too: the menu key on the cursor row', async () => {
    await row(1, 'notes.txt').click()
    await page.keyboard.press('ContextMenu')
    await menu().waitFor()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await menu().waitFor({ state: 'detached' })
  })
})
