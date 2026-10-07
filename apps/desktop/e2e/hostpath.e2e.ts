/**
 * A host's default path, and connections that stay open while a pane looks at another source: going back to a
 * host is instant and lands in the folder it was left in.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
const crumbs = async (i: 0 | 1): Promise<string> => (await pane(i).locator('.crumb').allTextContents()).join('/')
const pick = (i: 0 | 1, label: string) => pane(i).locator('select').selectOption({ label })

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-hostpath-'))
  home = join(tmp, 'home'); rootA = join(tmp, 'a'); rootB = join(tmp, 'b')
  await mkdir(home)
  await mkdir(join(rootA, 'srv', 'www', 'static'), { recursive: true })
  await writeFile(join(rootA, 'srv', 'www', 'index.html'), 'x')
  await writeFile(join(rootA, 'srv', 'www', 'static', 'site.css'), 'c')
  await writeFile(join(rootA, 'top.txt'), 't')
  await mkdir(rootB); await writeFile(join(rootB, 'b-only.txt'), 'b')
  await writeFile(join(home, 'local.txt'), 'l')
  a = await startSshTestServer(rootA, { password: 'pw-a' })
  b = await startSshTestServer(rootB, { password: 'pw-b' })
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home }))
  await H.createVault(page, PASS)
  await H.addPasswordHost(page, { name: 'alpha', port: a.port, username: 'tester', password: 'pw-a', path: '/srv/www' })
  await H.addPasswordHost(page, { name: 'beta', port: b.port, username: 'tester', password: 'pw-b' })
  await H.addPasswordHost(page, { name: 'gamma', port: a.port, username: 'tester', password: 'pw-a', path: '/does/not/exist' })
  await H.goTo(page, 'Files')
  await page.waitForSelector('[data-testid=pane-0] [role=option]')
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await a?.close(); await b?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('default path of a host', () => {
  it('is shown in the host editor and saved with the host', async () => {
    await H.goTo(page, 'Hosts')
    await page.click('button[aria-label="Edit alpha"]')
    expect(await page.inputValue('.section:not([hidden]) input[name=path]')).toBe('/srv/www')
    await page.click('button:has-text("Cancel")')
    await H.goTo(page, 'Files')
  })

  it('is where a file pane lands after connecting (and a host without one lands in the home folder)', async () => {
    await pick(1, 'alpha')
    await expect.poll(() => names(1)).toEqual(['static', 'index.html'])
    expect(await crumbs(1)).toMatch(/srv\/www$/)
    await pick(0, 'beta')
    await expect.poll(() => names(0)).toEqual(['b-only.txt'])
  })

  it('a path that does not exist is reported and the pane falls back to the home folder', async () => {
    await pick(0, 'gamma')
    await page.locator('.notice.error').waitFor()
    expect(await page.locator('.notice.error').textContent()).toContain('/does/not/exist')
    await expect.poll(() => names(0)).toEqual(['srv', 'top.txt'])
  })
})

describe('connections stay open', () => {
  it('leaving a host keeps its connection, and coming back is instant, in the folder it was left in', async () => {
    await pick(1, 'alpha') // was left on /srv/www
    await row(1, 'static').dblclick()
    await expect.poll(() => names(1)).toEqual(['site.css'])
    const before = a.connectionCount()
    expect(before).toBeGreaterThan(0)

    await pick(1, 'beta')
    await expect.poll(() => names(1)).toEqual(['b-only.txt'])
    expect(a.connectionCount()).toBe(before) // alpha was not disconnected

    await pick(1, 'alpha')
    expect(await pane(1).locator('.pane-msg', { hasText: 'Đang kết nối' }).count()).toBe(0) // no connecting spinner
    await expect.poll(() => names(1)).toEqual(['site.css']) // still inside static/
    expect(await crumbs(1)).toMatch(/srv\/www\/static$/)
    expect(a.connectionCount()).toBe(before) // and no new login
  })

  it('also through the local disk: a host, then This computer, then back to the host', async () => {
    await pane(1).locator('select').selectOption({ label: 'Home' })
    await expect.poll(() => names(1)).toContain('local.txt')
    await pick(1, 'alpha')
    await expect.poll(() => names(1)).toEqual(['site.css'])
  })

  it('each pane keeps its own place on the same host', async () => {
    await pick(0, 'alpha')
    await expect.poll(() => names(0)).toEqual(['static', 'index.html']) // pane 0 never left /srv/www on alpha... it starts at the default
    expect(await crumbs(1)).toMatch(/static$/)
  })
})
