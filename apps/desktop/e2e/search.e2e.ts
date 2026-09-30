import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as H from './helpers'

/** One search box in the toolbar, but each pane keeps its own search of its own folder. */
let tmp: string
let app: ElectronApplication
let page: Page
const pane = (i: 0 | 1) => page.locator(`[data-testid=pane-${i}]`)
const names = async (i: 0 | 1): Promise<string[]> => pane(i).locator('[role=option]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name ?? ''))
const row = (i: 0 | 1, name: string): Locator => pane(i).locator(`[role=option][data-name="${name}"]`)
const search = () => page.locator('[data-testid=pane-search]')
const filterBar = (i: 0 | 1) => page.locator(`[data-testid=pane-filter-${i}]`)
const ALL = ['docs', 'documents', 'Photo-2.png', 'notes.md', 'photo.jpg']

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-search-'))
  const home = join(tmp, 'home')
  await mkdir(join(home, 'docs'), { recursive: true })
  await mkdir(join(home, 'documents'), { recursive: true })
  for (const f of ['photo.jpg', 'Photo-2.png', 'notes.md', '.secret']) await writeFile(join(home, f), f)
  await writeFile(join(home, 'docs', 'inner.txt'), 'x')
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home }))
  await H.createVault(page, 'correct horse battery')
  await H.goTo(page, 'Files')
  await page.waitForSelector('[data-testid=pane-0] [role=option]')
  await page.waitForSelector('[data-testid=pane-1] [role=option]')
})
afterAll(async () => {
  await app?.close().catch(() => undefined)
  await rm(tmp, { recursive: true, force: true })
})

describe('the search box', () => {
  it('is a single input, and starts empty with everything listed in both panes', async () => {
    expect(await search().count()).toBe(1)
    expect(await search().inputValue()).toBe('')
    expect((await names(0)).sort()).toEqual([...ALL].sort())
    expect((await names(1)).sort()).toEqual([...ALL].sort())
    expect(await filterBar(0).count()).toBe(0)
  })

  it('filters files and folders of the active pane only, ignoring letter case', async () => {
    await row(0, 'notes.md').click() // pane 0 is the one being worked in
    await search().fill('PHOTO')
    await expect.poll(() => names(0).then((n) => n.sort())).toEqual(['Photo-2.png', 'photo.jpg'])
    expect((await names(1)).sort()).toEqual([...ALL].sort()) // the other pane is untouched
    expect(await filterBar(0).textContent()).toContain('2/5')
    expect(await filterBar(1).count()).toBe(0)
    await search().fill('doc')
    await expect.poll(() => names(0).then((n) => n.sort())).toEqual(['docs', 'documents'])
  })

  it('each pane keeps its own search: switching panes swaps the text in the same box', async () => {
    await row(1, 'notes.md').click() // now pane 1 is active
    await expect.poll(() => search().inputValue()).toBe('')
    expect(await search().getAttribute('placeholder')).toContain('right')
    await search().fill('notes')
    await expect.poll(() => names(1)).toEqual(['notes.md'])
    expect((await names(0)).sort()).toEqual(['docs', 'documents']) // pane 0 still has its own filter
    await page.screenshot({ path: process.env.E2E_SHOT_SEARCH ?? join(tmp, 'search.png') })

    await row(0, 'docs').click()
    await expect.poll(() => search().inputValue()).toBe('doc')
    expect(await search().getAttribute('placeholder')).toContain('left')
    await row(1, 'notes.md').click()
    await expect.poll(() => search().inputValue()).toBe('notes')
  })

  it('what is filtered out is no longer selected, so nothing invisible can be deleted or copied', async () => {
    await search().fill('')
    await expect.poll(async () => (await names(1)).length).toBe(5)
    await row(1, 'photo.jpg').click()
    await row(1, 'notes.md').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
    expect(await pane(1).locator('[role=option][aria-selected=true]').count()).toBe(2)
    await search().fill('notes')
    await expect.poll(() => pane(1).locator('[role=option][aria-selected=true]').count()).toBe(1)
    expect(await row(1, 'notes.md').getAttribute('aria-selected')).toBe('true')
  })

  it('typing in the box never triggers file shortcuts, and Escape or Enter hand the keyboard back to the pane', async () => {
    await search().focus()
    await page.keyboard.press('Delete')
    await page.keyboard.press('F8')
    expect(await page.locator('[role=dialog]').count()).toBe(0)
    await page.keyboard.press('Escape')
    expect(await search().inputValue()).toBe('')
    await expect.poll(() => names(1).then((n) => n.length)).toBe(5)
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('pane-1')
  })

  it('Ctrl/Cmd+F jumps to the box', async () => {
    await pane(1).focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('pane-search')
  })

  it('a search that starts with a dot also looks at hidden files; a plain one does not', async () => {
    await search().fill('secret')
    await expect.poll(() => names(1)).toEqual([])
    expect(await pane(1).textContent()).toContain('Không có mục nào khớp')
    await search().fill('.sec')
    await expect.poll(() => names(1)).toEqual(['.secret'])
  })

  it('the Clear button in the pane clears just that pane; opening a folder starts the search afresh', async () => {
    await row(0, 'docs').click()
    await search().fill('inn')
    await expect.poll(() => names(0)).toEqual([])
    await filterBar(1).locator('button:has-text("Clear")').click()
    expect(await filterBar(1).count()).toBe(0)
    expect(await filterBar(0).count()).toBe(1) // pane 0's own search is still there

    await filterBar(0).locator('button:has-text("Clear")').click() // (this also makes pane 0 the active one)
    expect(await filterBar(0).count()).toBe(0)
    await search().fill('doc')
    await expect.poll(() => names(0).then((n) => n.sort())).toEqual(['docs', 'documents'])
    await row(0, 'docs').dblclick()
    await expect.poll(() => names(0)).toEqual(['inner.txt']) // inside "docs", with no leftover filter
    expect(await search().inputValue()).toBe('')
    expect(await filterBar(0).count()).toBe(0)
  })
})
