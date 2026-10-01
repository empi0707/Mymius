/**
 * Drives the real Electron app against an in-process SSH server: connect, type, resize, share a
 * connection between tabs, survive a large output, reconnect, and refuse a changed host key.
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

const screen = (key: string) => H.screen(page, key)
const dims = (key: string) => H.dims(page, key)
const waitForText = (key: string, text: string | RegExp, timeout?: number) => H.waitForText(page, key, text, timeout)
const run = (key: string, cmd: string) => H.run(page, key, cmd)
const dialogs = () => H.dialogs(app)

async function connect(host: string, port: number) {
  await page.fill('input[name=host]', host)
  await page.fill('input[name=port]', String(port))
  await page.fill('input[name=username]', 'tester')
  await page.fill('input[name=password]', 'secret')
  await page.click('button[type=submit]')
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-'))
  server = await startSshTestServer(tmp)
  ;({ app, page } = await H.launch(join(tmp, 'profile')))
  // Quick connect (no vault needed) lives on the Terminals page.
  await H.goTo(page, 'Terminals')
  await page.waitForSelector('form.form input[name=host]')
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await server?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('terminal in the real app', () => {
  it('asks to trust an unknown host showing its fingerprint, then opens a shell', async () => {
    await connect('127.0.0.1', server.port)
    await waitForText('t1', 'welcome tester')
    const seen = await dialogs()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.detail).toContain(server.fingerprint)
    await page.waitForSelector('.tab.active .dot.open')
  })

  it('types into the terminal and shows the output', async () => {
    await run('t1', 'echo hello from e2e')
    await waitForText('t1', /hello from e2e\n\$/)
    expect(server.shells[0]!.received).toContain('echo hello from e2e')
  })

  it('tells the server the real terminal size, and follows window resizes', async () => {
    const before = await dims('t1')
    await run('t1', 'size')
    await waitForText('t1', `${before.cols}x${before.rows}`)
    expect(server.shells[0]).toMatchObject(before)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 640))
    await expect.poll(async () => (await dims('t1')).cols, { timeout: 10_000 }).not.toBe(before.cols)
    const after = await dims('t1')
    await expect.poll(() => ({ cols: server.shells[0]!.cols, rows: server.shells[0]!.rows }), { timeout: 10_000 }).toEqual(after)
    await run('t1', 'size')
    await waitForText('t1', new RegExp(`${after.cols}x${after.rows}\\n`))
  })

  it('a second tab to the same host reuses the connection and does not ask again', async () => {
    await page.click('button[aria-label="New connection"]')
    await connect('127.0.0.1', server.port)
    await waitForText('t2', 'welcome tester')
    expect(server.shells).toHaveLength(2)
    expect(server.connectionCount()).toBe(1) // one login, two shells
    expect(await dialogs()).toHaveLength(1)
    await run('t2', 'echo second tab')
    await waitForText('t2', /second tab\n\$/)
    expect(await screen('t1')).not.toContain('second tab') // sessions do not bleed into each other
  })

  it('keeps the terminal responsive through a huge output (flow control end to end)', async () => {
    await page.click('.tab:has-text("tester@127.0.0.1") >> nth=0')
    const started = Date.now()
    await run('t1', 'big 6000000')
    await waitForText('t1', 'BIG-DONE', 40_000)
    expect(server.shells[0]!.bigSent).toBe(6_000_000)
    console.log(`6 MB rendered in ${Date.now() - started} ms`)
    await run('t1', 'echo still alive')
    await waitForText('t1', /still alive\n\$/)
  })

  it('shows a closed session, and reconnects into a working shell', async () => {
    await run('t1', 'exit 0')
    await page.waitForSelector('.overlay:has-text("Phiên đã đóng")')
    await page.click('.overlay button:has-text("Reconnect")')
    await page.waitForSelector('.overlay', { state: 'detached' })
    await waitForText('t1', /welcome tester\n\$/)
    await run('t1', 'whoami')
    await waitForText('t1', /tester\n\$/)
  })

  it('a wrong password is reported in the tab instead of hanging', async () => {
    await page.click('button[aria-label="New connection"]')
    await page.fill('input[name=host]', '127.0.0.1')
    await page.fill('input[name=port]', String(server.port))
    await page.fill('input[name=username]', 'tester')
    await page.fill('input[name=password]', 'wrong')
    await page.click('button[type=submit]')
    await page.waitForSelector('.overlay:has-text("authentication")', { timeout: 20_000 })
    await page.click('.overlay button:has-text("Close tab")')
  })

  it('refuses a server whose host key changed, without asking the user', async () => {
    const port = server.port
    const dialogCount = (await dialogs()).length
    await server.close()
    server = await startSshTestServer(tmp, { port }) // same address, different key
    await page.click('button[aria-label="New connection"]')
    await connect('127.0.0.1', port)
    await page.waitForSelector('.overlay:has-text("KHÓA HOST ĐÃ THAY ĐỔI")', { timeout: 20_000 })
    expect((await dialogs()).length).toBe(dialogCount) // never offered as a choice
    await page.screenshot({ path: process.env.E2E_SHOT ?? join(tmp, 'changed.png') })
  })

  it('takes a screenshot of a working session', async () => {
    await page.click('.tab:has-text("tester@127.0.0.1") >> nth=1')
    await page.waitForTimeout(300)
    await page.screenshot({ path: process.env.E2E_SHOT_OK ?? join(tmp, 'ok.png') })
  })

  it('shows the whole MOTD a server prints as the shell opens, not only the last line', async () => {
    const motd = ['Welcome to Ubuntu 24.04.4 LTS', '', ' System information as of Thu Oct  1 07:28:17 UTC 2026', '',
      '  System load:  0.15               Processes:             168', '  Memory usage: 37%', '', ...Array.from({ length: 30 }, (_, i) => `news ${i}`),
      '*** System restart required ***', 'Last login: Thu Oct  1 07:20:35 2026 from 1.2.3.4'].join('\r\n') + '\r\n'
    const other = await startSshTestServer(tmp, { greeting: motd })
    try {
      await page.click('button[aria-label="New connection"]')
      await connect('127.0.0.1', other.port)
      const key = await page.waitForFunction(() => {
        const t = (window as unknown as { __mymiusTerminals?: Record<string, { buffer: { active: { length: number; getLine(i: number): { translateToString(t: boolean): string } | undefined } } }> }).__mymiusTerminals ?? {}
        return Object.entries(t).find(([, term]) => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).join('\n').includes('welcome tester') && Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).join('\n').includes('Last login'))?.[0] ?? false
      }, undefined, { timeout: 20_000 }).then((h) => h.jsonValue() as Promise<string>)
      const text = await screen(key)
      expect(text).toContain('System information as of')
      expect(text).toContain('System load:  0.15')
      expect(text).toContain('news 0')
      expect(text.indexOf('Welcome to Ubuntu')).toBeLessThan(text.indexOf('Last login'))
    } finally {
      await other.close()
    }
  })
})
