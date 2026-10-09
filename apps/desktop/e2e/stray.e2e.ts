/** A stray error in the main process must not freeze the window (no modal "JavaScript error" box), only be logged. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as H from './helpers'

let tmp: string
let app: ElectronApplication
let page: Page

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-stray-'))
  ;({ app, page } = await H.launch(join(tmp, 'profile')))
  await H.goTo(page, 'Terminals')
})
afterAll(async () => { await app?.close().catch(() => undefined); await rm(tmp, { recursive: true, force: true }) })

describe('stray errors in the main process', () => {
  it('an uncaught exception and an unhandled rejection leave the window usable and are written to a log', async () => {
    await app.evaluate(() => {
      setTimeout(() => { throw new Error('stray-exception-from-test') }, 0)
      void Promise.reject(new Error('stray-rejection-from-test'))
    })
    await new Promise((r) => setTimeout(r, 800))
    // Still responsive: a click goes through and the page answers.
    const answered = await Promise.race([page.evaluate(() => 'alive'), new Promise((r) => setTimeout(() => r('frozen'), 4000))])
    expect(answered).toBe('alive')
    await page.click('button[aria-label="New connection"]', { timeout: 4000 })
    const logDir = await app.evaluate(({ app: a }) => a.getPath('logs'))
    const log = await readFile(join(logDir, 'main.log'), 'utf8')
    expect(log).toContain('stray-exception-from-test')
    expect(log).toContain('stray-rejection-from-test')
  })
})
