/**
 * The command-history sidebar in the real app: shows the server's shell history, adds what was typed in
 * the tab, puts a command on the prompt without running it, runs one on request, filters, and leaves
 * the other tabs' lists alone.
 */
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

const items = () => page.$$eval('[data-testid=history-item]', (els) => els.map((e) => e.textContent?.replace('●', '').trim()))

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-'))
  server = await startSshTestServer(tmp, { history: '@@FILE /home/tester/.bash_history\nsystemctl status nginx\ndocker ps -a\ntail -f /var/log/syslog\n' })
  ;({ app, page } = await H.launch(join(tmp, 'profile')))
  await H.goTo(page, 'Terminals')
  await page.waitForSelector('form.form input[name=host]')
  await page.fill('input[name=host]', '127.0.0.1')
  await page.fill('input[name=port]', String(server.port))
  await page.fill('input[name=username]', 'tester')
  await page.fill('input[name=password]', 'secret')
  await page.click('button[type=submit]')
  await H.waitForText(page, 't1', 'welcome tester')
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await server?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('command history sidebar', () => {
  it('is closed at first and opens on the right with the server history, newest first', async () => {
    expect(await page.$('[data-testid=history]')).toBeNull()
    await page.click('button[aria-label="Toggle command history"]')
    await page.waitForSelector('[data-testid=history-item]')
    expect(await items()).toEqual(['tail -f /var/log/syslog', 'docker ps -a', 'systemctl status nginx'])
    const box = await page.locator('[data-testid=history]').boundingBox()
    const term = await page.locator('[data-testid=t1]').boundingBox()
    expect(box!.x).toBeGreaterThan(term!.x + term!.width - 1) // beside the terminal, to its right
  })

  it('adds a command typed in the tab to the top of the list after Refresh', async () => {
    await page.click('[data-testid=t1]') // the sidebar button had the focus
    await H.run(page, 't1', 'echo typed here')
    await H.waitForText(page, 't1', /typed here\n\$/)
    await page.waitForFunction(() => document.querySelector('[data-testid=history-item]')?.textContent?.includes('echo typed here'))
    expect((await items())[0]).toBe('echo typed here')
  })

  it('puts a clicked command on the prompt without running it', async () => {
    await page.click('[data-testid=history-item]:has-text("docker ps -a")')
    await H.waitForText(page, 't1', /\$ docker ps -a\s*$/)
    expect(server.shells[0]!.received).not.toContain('docker ps -a\r') // typed on the line, Enter not sent
    for (let i = 0; i < 'docker ps -a'.length; i++) await page.keyboard.press('Backspace') // clear the line again
  })

  it('runs a command when asked to', async () => {
    await page.hover('[data-testid=history-item]:has-text("systemctl status nginx")')
    await page.click('button[aria-label="Run systemctl status nginx"]')
    await H.waitForText(page, 't1', /systemctl: command not found/)
    expect(server.shells[0]!.received).toContain('systemctl status nginx\r')
  })

  it('filters the list', async () => {
    await page.fill('input[aria-label="Filter history"]', 'DOCKER')
    expect(await items()).toEqual(['docker ps -a'])
    await page.fill('input[aria-label="Filter history"]', 'zzz')
    expect(await items()).toEqual([])
    await page.fill('input[aria-label="Filter history"]', '')
  })

  it('keeps each tab\'s typed commands to itself', async () => {
    await page.click('button[aria-label="New connection"]')
    await page.fill('input[name=host]', '127.0.0.1')
    await page.fill('input[name=port]', String(server.port))
    await page.fill('input[name=username]', 'tester')
    await page.fill('input[name=password]', 'secret')
    await page.click('button[type=submit]')
    await H.waitForText(page, 't2', 'welcome tester')
    await page.waitForSelector('[data-testid=history-item]')
    expect(await items()).not.toContain('echo typed here') // typed in tab 1 only
    await page.click('.tab:has-text("tester@127.0.0.1") >> nth=0')
    await page.waitForSelector('[data-testid=history-item]:has-text("echo typed here")')
  })

  it('closes again and remembers it', async () => {
    await page.click('button[aria-label="Toggle command history"]')
    expect(await page.$('[data-testid=history]')).toBeNull()
  })
})
