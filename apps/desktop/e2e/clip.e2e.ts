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
    // a.txt is already in that folder: the usual "already exists" question comes up, as with any other copy
    await page.locator('[role=dialog] button:has-text("Replace")').click({ timeout: 10_000 })
    await expect.poll(async () => (await names(1)), { timeout: 15000 }).toContain('a.txt')
    expect(await readFile(join(homeDir, 'dest', 'a.txt'), 'utf8')).toBe('AAA')
  })
})

describe('programs that use the clipboard or the mouse (Claude Code, tmux, vim)', () => {
  const term = () => page.locator('[data-testid=t1]')
  // Focus without clicking: a click would be reported to the program while the mouse is captured.
  const typeLine = async (cmd: string) => { await page.focus('[data-testid=t1] textarea'); await page.keyboard.type(cmd); await page.keyboard.press('Enter') }

  it('a program can put text on the clipboard (OSC 52), which is how Claude Code copies', async () => {
    await H.goTo(page, 'Terminals')
    await page.click('[data-testid=t1]')
    await writeClip('before')
    await typeLine(`printf '\\033]52;c;%s\\a' "$(printf 'from-osc52 \\342\\234\\223' | base64)"`)
    await expect.poll(readClip, { timeout: 5000 }).toBe('from-osc52 ✓')
  })

  it('a program cannot READ the clipboard through OSC 52', async () => {
    await writeClip('top-secret-clipboard')
    await typeLine(`printf '\\033]52;c;?\\a'; sleep 0.5; echo done-reading`)
    const text = await H.waitForText(page, 't1', 'done-reading')
    expect(text).not.toContain(Buffer.from('top-secret-clipboard').toString('base64'))
  })

  it('with the mouse captured by a program: left clicks reach it, a right click opens our menu instead', async () => {
    await typeLine(`printf '\\033[?1000h\\033[?1006h'; cat -v`)
    await page.waitForTimeout(500)
    await term().click({ position: { x: 200, y: 120 } })
    await H.waitForText(page, 't1', /\^\[\[<0;\d+;\d+M/) // the program saw the click
    await term().click({ position: { x: 220, y: 140 }, button: 'right' })
    await page.locator('[data-testid=context-menu]').waitFor()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    expect(await H.screen(page, 't1')).not.toMatch(/\^\[\[<2;\d+;\d+M/) // the right click was NOT sent to it
  })

  it('Shift + drag still selects text (Option + drag on macOS), so it can be copied', async () => {
    await page.keyboard.press('Control+c') // end cat; the mouse stays captured until the program resets it
    await typeLine(`printf '\\033[?1000h\\033[?1006h'; echo SELECT-THIS-TEXT; cat -v`)
    await H.waitForText(page, 't1', /\nSELECT-THIS-TEXT\n/)
    const geo = await page.evaluate(() => {
      const t = (window as any).__mymiusTerminals.t1
      const b = t.buffer.active
      let row = -1
      for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '') === 'SELECT-THIS-TEXT') row = i
      const screen = document.querySelector('[data-testid=t1] .xterm-screen')!.getBoundingClientRect()
      return { row: row - b.baseY, x: screen.left, y: screen.top, cw: screen.width / t.cols, ch: screen.height / t.rows }
    })
    const y = geo.y + (geo.row + 0.5) * geo.ch
    await page.keyboard.down('Shift')
    await page.mouse.move(geo.x + 1, y)
    await page.mouse.down()
    await page.mouse.move(geo.x + geo.cw * 16, y, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    const sel = await page.evaluate(() => (window as any).__mymiusTerminals.t1.getSelection())
    expect(sel).toContain('SELECT-THIS')
    await page.evaluate(() => (window as any).__mymiusTerminals.t1.clearSelection()) // with a selection Ctrl+C means "copy"
    await page.keyboard.press('Control+c')
    await expect.poll(async () => (await H.screen(page, 't1')).trimEnd().endsWith('local$'), { timeout: 10_000 }).toBe(true)
    await typeLine(`printf '\\033[?1000l\\033[?1006l'; echo MOUSE-OFF`)
    await H.waitForText(page, 't1', /\nMOUSE-OFF\n/)
  })
})

describe('pasting once', () => {
  it('a paste that reaches the terminal two ways at once (the key handler and the Edit menu, as Cmd+V does on macOS) lands once', async () => {
    await H.goTo(page, 'Terminals')
    await page.click('[data-testid=t1]')
    await page.keyboard.press('Control+u')
    await writeClip('DOUBLE')
    // The key goes through our handler while the menu's own Paste fires at the same moment.
    await Promise.all([page.keyboard.press('Control+Shift+V'), wc('paste')])
    await page.waitForTimeout(600)
    const text = await H.screen(page, 't1')
    expect(text).toMatch(/local\$ DOUBLE\s*$/m)
    expect(text).not.toContain('DOUBLEDOUBLE')
    await page.keyboard.press('Control+u')
  })

  it('and two real pastes of the same text a moment apart both go through', async () => {
    await writeClip('X')
    await wc('paste')
    await page.waitForTimeout(500)
    await wc('paste')
    await H.waitForText(page, 't1', /local\$ XX\s*$/m)
    await page.keyboard.press('Control+u')
  })
})
