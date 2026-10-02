/** The Terminals tab starts with a shell on this computer (no SSH), and the tab behaves like any other. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as H from './helpers'

let tmp: string
let app: ElectronApplication
let page: Page

const screen = (key: string) => H.screen(page, key)
const wait = (key: string, text: string | RegExp) => H.waitForText(page, key, text)
const run = (key: string, cmd: string) => H.run(page, key, cmd)

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-local-'))
  const home = join(tmp, 'home')
  await mkdir(home)
  await writeFile(join(home, '.bash_history'), 'ls -la\nsystemctl status nginx\n')
  // A plain, predictable shell: no rc files, a short prompt.
  await writeFile(join(home, '.bashrc'), "PS1='local$ '\n")
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home, SHELL: '/bin/bash', MYMIUS_E2E_NO_LOCAL_TERMINAL: '0' }))
  await H.goTo(page, 'Terminals')
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await rm(tmp, { recursive: true, force: true })
})

describe('local terminal', () => {
  it('opens by itself instead of the connection form, and gives a working shell', async () => {
    await page.waitForSelector('.tab.active:has-text("Local") .dot.open')
    expect(await page.$('form.form input[name=host]')).toBeNull()
    await wait('t1', /local\$/)
    await run('t1', 'echo $((6*7))')
    await wait('t1', /\n42\n/)
  })

  it('is a real terminal: TERM, the window size and resizes reach the shell', async () => {
    await run('t1', 'echo "TERM=$TERM"')
    await wait('t1', 'TERM=xterm-256color')
    const d = await H.dims(page, 't1')
    await run('t1', 'stty size')
    await wait('t1', new RegExp(`\\n${d.rows} ${d.cols}\\n`))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 640))
    await expect.poll(async () => (await H.dims(page, 't1')).cols, { timeout: 10_000 }).not.toBe(d.cols)
    let after = await H.dims(page, 't1')
    for (let stable = 0; stable < 6; ) {
      await new Promise((r) => setTimeout(r, 100))
      const now = await H.dims(page, 't1')
      stable = now.cols === after.cols && now.rows === after.rows ? stable + 1 : 0
      after = now
    }
    await run('t1', 'stty size')
    await wait('t1', new RegExp(`\\n${after.rows} ${after.cols}\\n`))
  })

  it('the history sidebar shows this computer\'s shell history', async () => {
    await page.click('button[aria-label="Toggle command history"]')
    await page.waitForSelector('[data-testid=history-item]:has-text("systemctl status nginx")')
    await page.click('button[aria-label="Toggle command history"]')
  })

  it('+ still offers the connection form, with a button for another local terminal', async () => {
    await page.click('button[aria-label="New connection"]')
    await page.waitForSelector('form.form input[name=host]')
    await page.click('button:has-text("Open local terminal")')
    await page.waitForSelector('.tab.active:has-text("Local") .dot.open >> nth=0')
    await wait('t2', /local\$/)
    await run('t2', 'echo second')
    await wait('t2', /\nsecond\n/)
    expect(await screen('t1')).not.toContain('second') // separate shells
  })

  it('exiting the shell ends the tab with Reconnect, which starts a fresh shell', async () => {
    await run('t2', 'exit')
    await page.waitForSelector('.overlay button:has-text("Reconnect")')
    await page.click('.overlay button:has-text("Reconnect")')
    await wait('t2', /local\$/)
    await run('t2', 'echo again')
    await wait('t2', /\nagain\n/)
  })

  it('closing a tab ends its shell process', async () => {
    await run('t2', 'echo "PID=$$"')
    const text = await wait('t2', /PID=\d+\n/)
    const pid = Number(/PID=(\d+)/.exec(text)![1])
    expect(() => process.kill(pid, 0)).not.toThrow() // alive
    await page.click('.tab:has-text("Local") >> nth=1 >> button[aria-label^="Close"]')
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive' } catch { return 'gone' } }, { timeout: 10_000 }).toBe('gone')
  })
})
