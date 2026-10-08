import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as H from './helpers'

let tmp: string
let homeDir: string
let app: ElectronApplication
let page: Page
const readClip = () => app.evaluate(({ clipboard }) => clipboard.readText())
const writeClip = (t: string) => app.evaluate(({ clipboard }, x) => clipboard.writeText(x), t)
const wc = (m: 'copy' | 'paste' | 'cut' | 'selectAll') => app.evaluate(({ BrowserWindow }, mm) => { (BrowserWindow.getAllWindows()[0]!.webContents as unknown as Record<string, () => void>)[mm]!() }, m)

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-clip-'))
  const home = join(tmp, 'home'); await mkdir(home); await writeFile(join(home, '.bashrc'), "PS1='local$ '\n")
  await writeFile(join(home, 'a.txt'), 'AAA'); await writeFile(join(home, 'b.txt'), 'BBB'); await mkdir(join(home, 'dest'))
  homeDir = home
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home, SHELL: '/bin/bash', MYMIUS_E2E_NO_LOCAL_TERMINAL: '0' }))
  await H.goTo(page, 'Terminals')
  await H.waitForText(page, 't1', /local\$/)
})
afterAll(async () => { await app?.close().catch(() => undefined); await rm(tmp, { recursive: true, force: true }) })

describe('clipboard in the terminal', () => {
  it('copy: a mouse selection can be copied (what the Edit menu does on macOS)', async () => {
    await H.run(page, 't1', 'echo COPYME-123')
    await H.waitForText(page, 't1', /\nCOPYME-123\n/)
    await page.evaluate(() => { const t = (window as any).__mymiusTerminals.t1; t.selectAll() })
    await writeClip('before')
    await wc('copy')
    await expect.poll(readClip, { timeout: 5000 }).toContain('COPYME-123')
  })
  it('paste: webContents.paste() puts the clipboard on the prompt (what Cmd+V does on macOS)', async () => {
    await page.evaluate(() => { (window as any).__mymiusTerminals.t1.clearSelection() })
    await page.click('[data-testid=t1]')
    await writeClip('echo PASTED-$((20+22))')
    await wc('paste')
    await H.waitForText(page, 't1', /local\$ echo PASTED-\$\(\(20\+22\)\)/)
  })
  it('Ctrl+Shift+C and Ctrl+Shift+V (Windows/Linux)', async () => {
    await page.keyboard.press('Control+u')
    await page.evaluate(() => { const t = (window as any).__mymiusTerminals.t1; t.selectAll() })
    await writeClip('x')
    await page.keyboard.press('Control+Shift+C')
    await expect.poll(readClip, { timeout: 5000 }).toContain('COPYME-123')
    await page.evaluate(() => { (window as any).__mymiusTerminals.t1.clearSelection() })
    await writeClip('echo VIA-KEYS')
    await page.keyboard.press('Control+Shift+V')
    await H.waitForText(page, 't1', /local\$ echo VIA-KEYS/)
  })
})

describe('clipboard in text fields', () => {
  it('copy, cut and paste work in an input', async () => {
    await H.goTo(page, 'Files')
    await page.waitForSelector('[data-testid=pane-search]')
    await page.fill('[data-testid=pane-search]', 'hello world')
    await page.click('[data-testid=pane-search]')
    await wc('selectAll'); await wc('copy')
    await expect.poll(readClip, { timeout: 5000 }).toBe('hello world')
    await wc('cut')
    await expect.poll(() => page.inputValue('[data-testid=pane-search]'), { timeout: 5000 }).toBe('')
    await wc('paste')
    await expect.poll(() => page.inputValue('[data-testid=pane-search]'), { timeout: 5000 }).toBe('hello world')
    await page.fill('[data-testid=pane-search]', '')
  })
})

describe('right-click menu in the terminal', () => {
  const menuItem = (label: string) => page.locator('[data-testid=context-menu] [role=menuitem]', { hasText: label })

  it('Paste and Copy from the menu', async () => {
    await H.goTo(page, 'Terminals')
    await page.click('[data-testid=t1]')
    await page.keyboard.press('Control+u')
    await writeClip('echo FROM-MENU')
    await page.click('[data-testid=t1]', { button: 'right' })
    await menuItem('Paste').click()
    await H.waitForText(page, 't1', /local\$ echo FROM-MENU/)
    await page.keyboard.press('Control+u')

    await page.evaluate(() => (window as any).__mymiusTerminals.t1.selectAll())
    await writeClip('x')
    await page.click('[data-testid=t1]', { button: 'right' })
    await menuItem('Copy').click()
    await expect.poll(readClip, { timeout: 5000 }).toContain('COPYME-123')
  })

  it('Copy is off when nothing is selected; Clear empties the screen', async () => {
    await page.evaluate(() => (window as any).__mymiusTerminals.t1.clearSelection())
    await page.click('[data-testid=t1]', { button: 'right' })
    expect(await menuItem('Copy').isDisabled()).toBe(true)
    await menuItem('Clear').click()
    await expect.poll(async () => (await H.screen(page, 't1')).includes('COPYME-123'), { timeout: 5000 }).toBe(false)
  })
})

describe('copy, cut and paste of files in the file manager', () => {
  const pane = (i: 0 | 1) => page.locator(`[data-testid=pane-${i}]`)
  const row = (i: 0 | 1, n: string) => pane(i).locator(`[role=option][data-name="${n}"]`)
  const names = (i: 0 | 1) => pane(i).locator('[role=option]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name))

  it('Copy then Paste (the Edit menu / Cmd+C, Cmd+V) puts a copy in the other folder and leaves the original', async () => {
    await H.goTo(page, 'Files')
    await pane(0).locator('[role=option]').first().waitFor()
    await row(1, 'dest').dblclick()
    await expect.poll(() => names(1)).toEqual([])
    await row(0, 'a.txt').click()
    await wc('copy')
    await expect.poll(readClip, { timeout: 5000 }).toBe(join(homeDir, 'a.txt')) // the path is on the system clipboard too
    await pane(1).click({ position: { x: 100, y: 200 } })
    await wc('paste')
    await expect.poll(() => names(1)).toEqual(['a.txt'])
    expect(await names(0)).toContain('a.txt')
  })

  it('Cut then Paste moves it', async () => {
    await row(0, 'b.txt').click()
    await wc('cut')
    await pane(1).click({ position: { x: 100, y: 200 } })
    await wc('paste')
    await expect.poll(() => names(1)).toEqual(['a.txt', 'b.txt'])
    await expect.poll(() => names(0)).not.toContain('b.txt')
  })

  it('a Paste after something else was copied does not use the stale file clipboard', async () => {
    await row(0, 'a.txt').click()
    await wc('copy')
    await expect.poll(readClip, { timeout: 5000 }).toBe(join(homeDir, 'a.txt')) // let the page's own clipboard write land first
    await writeClip('some other text')
    await pane(1).click({ position: { x: 100, y: 200 } })
    await wc('paste')
    await page.locator('.notice:has-text("không còn file nào để dán")').waitFor({ timeout: 10_000 })
  })

  it('the right-click menu has Copy / Cut / Paste for files', async () => {
    await row(0, 'a.txt').click({ button: 'right' })
    const items = await page.locator('[data-testid=context-menu] [role=menuitem] span:first-child').allTextContents()
    expect(items).toEqual(expect.arrayContaining(['Copy', 'Cut', 'Paste']))
    await page.locator('[data-testid=context-menu] [role=menuitem]:has(span:text-is("Copy"))').click()
    await row(1, 'a.txt').click({ button: 'right' })
    await page.locator('[data-testid=context-menu] [role=menuitem]:has(span:text-is("Paste"))').click()
    await expect.poll(async () => (await names(1)), { timeout: 15000 }).toContain('a.txt')
    expect(await readFile(join(homeDir, 'dest', 'a.txt'), 'utf8')).toBe('AAA')
  })
})
