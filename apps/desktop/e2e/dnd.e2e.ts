/**
 * Dragging files between the panes in the real app. Inside one server (or on this computer) a drop MOVES the files and
 * the icon stays as it is; between different servers it COPIES and the icon gets a "+" at its bottom right.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import * as H from './helpers'

const PASS = 'correct horse battery staple'
let tmp: string
let home: string
let rootA: string
let rootB: string
let a: TestServer
let b: TestServer
let app: ElectronApplication
let page: Page

const pane = (i: 0 | 1) => page.locator(`[data-testid=pane-${i}]`)
const row = (i: 0 | 1, name: string): Locator => pane(i).locator(`[role=option][data-name="${name}"]`)
const names = (i: 0 | 1): Promise<string[]> => pane(i).locator('[role=option]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name ?? ''))
const pick = (i: 0 | 1, label: string) => pane(i).locator('select').selectOption({ label })
const exists = (p: string) => stat(p).then(() => true, () => false)
const refresh = async () => { for (const i of [0, 1] as const) await pane(i).locator('button[aria-label=Refresh]').click() }
const waitJobs = async () => { await page.locator('[data-testid^=job-].done').first().waitFor({ timeout: 20_000 }); for (const x of await page.locator('[data-testid^=job-] button:has-text("Dismiss")').all()) await x.click() }

/** Drag with the real mouse, stopping over the target so the icon can be looked at before the drop. */
async function drag(from: Locator, to: Locator, opts: { alt?: boolean; hold?: (ghost: Locator) => Promise<void> } = {}): Promise<void> {
  const f = (await from.boundingBox())!
  const t = (await to.boundingBox())!
  await page.mouse.move(f.x + 40, f.y + f.height / 2)
  await page.mouse.down()
  await page.mouse.move(f.x + 60, f.y + f.height / 2 + 8, { steps: 3 })
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.move(t.x + 60, t.y + Math.min(t.height / 2, 60), { steps: 12 })
  await page.mouse.move(t.x + 62, t.y + Math.min(t.height / 2, 60) + 2, { steps: 3 })
  if (opts.hold) await opts.hold(page.locator('[data-testid=drag-ghost]'))
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-dnd-'))
  home = join(tmp, 'home'); rootA = join(tmp, 'a'); rootB = join(tmp, 'b')
  await mkdir(join(home, 'dest'), { recursive: true })
  await writeFile(join(home, 'l1.txt'), 'L1'); await writeFile(join(home, 'l2.txt'), 'L2'); await writeFile(join(home, 'l3.txt'), 'L3')
  await mkdir(join(rootA, 'sub'), { recursive: true })
  await writeFile(join(rootA, 'a1.txt'), 'A1'); await writeFile(join(rootA, 'a2.txt'), 'A2'); await writeFile(join(rootA, 'a3.txt'), 'A3')
  await mkdir(rootB); await writeFile(join(rootB, 'b1.txt'), 'B1')
  a = await startSshTestServer(rootA, { password: 'pw-a' })
  b = await startSshTestServer(rootB, { password: 'pw-b' })
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home }))
  await H.createVault(page, PASS)
  await H.addPasswordHost(page, { name: 'alpha', port: a.port, username: 'tester', password: 'pw-a' })
  await H.addPasswordHost(page, { name: 'beta', port: b.port, username: 'tester', password: 'pw-b' })
  await H.goTo(page, 'Files')
  await page.waitForSelector('[data-testid=pane-0] [role=option]')
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await a?.close(); await b?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('between this computer and a server: copy, with a + on the icon', () => {
  it('shows the file icon with a + while over the other kind of source, and copies on drop', async () => {
    await pick(1, 'alpha')
    await expect.poll(() => names(1)).toContain('a1.txt')
    let seen = { mode: '', plus: 0 }
    await drag(row(0, 'l1.txt'), pane(1).locator('.rows'), {
      hold: async (ghost) => {
        await ghost.waitFor({ timeout: 5000 })
        await expect.poll(() => ghost.getAttribute('data-mode'), { timeout: 5000 }).toBe('copy')
        seen = { mode: (await ghost.getAttribute('data-mode'))!, plus: await ghost.locator('[data-testid=drag-plus]').count() }
      }
    })
    expect(seen).toEqual({ mode: 'copy', plus: 1 })
    await waitJobs()
    expect(await readFile(join(rootA, 'l1.txt'), 'utf8')).toBe('L1')
    expect(await exists(join(home, 'l1.txt'))).toBe(true) // the original stays
  })

  it('the icon has no + over its own kind of source, nor outside the panes', async () => {
    const own = pane(0).locator('.rows')
    const f = (await row(0, 'l2.txt').boundingBox())!
    // Over its own pane (this computer to this computer): no +.
    await page.mouse.move(f.x + 40, f.y + 10); await page.mouse.down(); await page.mouse.move(f.x + 70, f.y + 60, { steps: 6 })
    const ghost = page.locator('[data-testid=drag-ghost]')
    await ghost.waitFor()
    await expect.poll(() => ghost.getAttribute('data-mode')).toBe('move')
    expect(await ghost.locator('[data-testid=drag-plus]').count()).toBe(0)
    // Dropping back on its own folder does nothing.
    await page.mouse.up()
    await ghost.waitFor({ state: 'detached' })
    expect(await own.count()).toBe(1)
    expect(await page.locator('[data-testid^=job-]').count()).toBe(0)
    // Outside the panes (the toolbar): no +, and the drop is not accepted anywhere.
    await page.mouse.move(f.x + 40, f.y + 10); await page.mouse.down(); await page.mouse.move(f.x + 60, f.y + 50, { steps: 3 })
    await page.mouse.move(600, 25, { steps: 8 })
    await page.waitForTimeout(300)
    expect(await page.locator('[data-testid=drag-plus]').count()).toBe(0)
    await page.mouse.up()
    await ghost.waitFor({ state: 'detached' })
  })

  it('the icon follows the pointer from pane to pane: + only while over a different kind of source (events dispatched directly)', async () => {
    const result = await page.evaluate(async () => {
      const ghostMode = (): string | null => document.querySelector('[data-testid=drag-ghost]')?.getAttribute('data-mode') ?? null
      const dt = new DataTransfer()
      const rowEl = document.querySelector('[data-testid=pane-0] [role=option][data-name="l2.txt"]') as HTMLElement
      const rows0 = document.querySelector('[data-testid=pane-0] .rows') as HTMLElement
      const rows1 = document.querySelector('[data-testid=pane-1] .rows') as HTMLElement
      const fire = (el: Element, type: string, x: number, y: number) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
      const tick = () => new Promise((r) => setTimeout(r, 50))
      const out: Record<string, string | null> = {}
      fire(rowEl, 'dragstart', 100, 100); await tick()
      fire(rows0, 'dragover', 120, 200); await tick(); out.overOwn = ghostMode()
      fire(rows0, 'dragleave', 120, 200)
      fire(rows1, 'dragover', 900, 200); await tick(); out.overOther = ghostMode()
      await new Promise((r) => setTimeout(r, 300)) // the late "left pane 0" report must not undo it
      out.afterLateLeave = ghostMode()
      fire(rows0, 'dragover', 120, 200); await tick(); out.backOwn = ghostMode()
      fire(rowEl, 'dragend', 120, 200); await tick(); out.ended = ghostMode()
      return out
    })
    expect(result).toEqual({ overOwn: 'move', overOther: 'copy', afterLateLeave: 'copy', backOwn: 'move', ended: null })
  })
})

describe('inside one server: move, icon unchanged', () => {
  it('this computer to this computer moves the file', async () => {
    await pick(1, 'Home')
    await expect.poll(() => names(1)).toContain('dest')
    await row(1, 'dest').dblclick()
    await expect.poll(() => names(1)).toEqual([])
    let mode = ''
    await drag(row(0, 'l2.txt'), pane(1).locator('.rows'), { hold: async (g) => { await g.waitFor(); mode = (await g.getAttribute('data-mode'))!; expect(await g.locator('[data-testid=drag-plus]').count()).toBe(0) } })
    expect(mode).toBe('move')
    await waitJobs()
    expect(await readFile(join(home, 'dest', 'l2.txt'), 'utf8')).toBe('L2')
    expect(await exists(join(home, 'l2.txt'))).toBe(false)
  })

  it('a server to the same server (the other pane) moves the file', async () => {
    await pick(0, 'alpha'); await pick(1, 'alpha')
    await expect.poll(() => names(0)).toContain('a1.txt')
    await expect.poll(() => names(1)).toContain('sub')
    let seen = { mode: '', plus: -1 }
    await drag(row(0, 'a1.txt'), row(1, 'sub'), { hold: async (g) => { await g.waitFor(); seen = { mode: (await g.getAttribute('data-mode'))!, plus: await g.locator('[data-testid=drag-plus]').count() } } })
    expect(seen).toEqual({ mode: 'move', plus: 0 })
    await waitJobs()
    expect(await readFile(join(rootA, 'sub', 'a1.txt'), 'utf8')).toBe('A1')
    expect(await exists(join(rootA, 'a1.txt'))).toBe(false)
  })

  it('holding Alt copies instead', async () => {
    await refresh()
    await drag(row(0, 'a2.txt'), row(1, 'sub'), { alt: true })
    await waitJobs()
    expect(await readFile(join(rootA, 'sub', 'a2.txt'), 'utf8')).toBe('A2')
    expect(await exists(join(rootA, 'a2.txt'))).toBe(true) // still there
  })

  it('dropping files on the folder they are already in does nothing', async () => {
    await refresh()
    await expect.poll(() => names(1)).toContain('a3.txt')
    await drag(row(0, 'a3.txt'), pane(1).locator('.rows'))
    await page.waitForTimeout(800)
    expect(await page.locator('[data-testid^=job-]').count()).toBe(0)
    expect(await exists(join(rootA, 'a3.txt'))).toBe(true)
  })
})

describe('between two different servers: copy, with a +', () => {
  it('alpha to beta copies and leaves the original', async () => {
    await pick(1, 'beta')
    await expect.poll(() => names(1)).toContain('b1.txt')
    let seen = { mode: '', plus: -1 }
    await drag(row(0, 'a3.txt'), pane(1).locator('.rows'), { hold: async (g) => { await g.waitFor(); seen = { mode: (await g.getAttribute('data-mode'))!, plus: await g.locator('[data-testid=drag-plus]').count() } } })
    expect(seen).toEqual({ mode: 'copy', plus: 1 })
    await waitJobs()
    expect(await readFile(join(rootB, 'a3.txt'), 'utf8')).toBe('A3')
    expect(await exists(join(rootA, 'a3.txt'))).toBe(true)
  })

  it('several files at once show their count on the icon', async () => {
    await refresh()
    await row(0, 'sub').click()
    await row(0, 'a2.txt').click({ modifiers: ['Control'] })
    let count = ''
    await drag(row(0, 'a2.txt'), pane(1).locator('.rows'), { hold: async (g) => { await g.waitFor(); count = (await g.locator('[data-testid=drag-count]').textContent()) ?? '' } })
    expect(count).toBe('2')
    await waitJobs()
  })
})
