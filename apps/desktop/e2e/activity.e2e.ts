import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as H from './helpers'

/** The small bar in the top-right corner, driven through the same hook the app's own screens use. */
let tmp: string
let launched: Awaited<ReturnType<typeof H.launch>>
const page = () => launched.page
const report = (scope: string, list: { id: string; label: string; progress?: number }[]) =>
  page().evaluate(([s, l]) => (window as unknown as { __mymiusActivity: { setActivities(s: string, l: unknown): void } }).__mymiusActivity.setActivities(s as string, l), [scope, list] as const)

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-activity-'))
  launched = await H.launch(join(tmp, 'profile'))
  await H.createVault(page(), 'correct horse battery')
})
afterAll(async () => {
  await launched?.app.close().catch(() => undefined)
  await rm(tmp, { recursive: true, force: true })
})

describe('the app name', () => {
  it('is Mymius, in the process and in the window title, and the data folder did not move', async () => {
    expect(await launched.app.evaluate(({ app }) => app.getName())).toBe('Mymius')
    expect(await page().title()).toBe('Mymius')
    expect(await launched.app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(tmp, 'profile'))
  })
})

describe('the activity bar', () => {
  it('is absent when nothing is going on', async () => {
    expect(await page().locator('[data-testid=activity]').count()).toBe(0)
  })

  it('shows what is happening, small, in the top-right corner, and leaves it alone if the work is quick', async () => {
    await report('test', [{ id: 'quick', label: 'Very quick' }])
    await report('test', [])
    await new Promise((r) => setTimeout(r, 400))
    expect(await page().locator('[data-testid=activity]').count()).toBe(0) // gone before it was worth showing

    await report('test', [{ id: 'up', label: 'Đang tải lên app.conf…' }])
    await page().waitForSelector('[data-testid=activity]')
    expect(await page().textContent('[data-testid=activity-label]')).toBe('Đang tải lên app.conf…')
    expect(await page().getAttribute('[data-testid=activity-fill]', 'class')).toContain('indeterminate')
    const box = (await page().locator('[data-testid=activity]').boundingBox())!
    const view = { width: await page().evaluate(() => window.innerWidth) }
    expect(view.width - (box.x + box.width)).toBeLessThan(30) // hugging the right edge
    expect(box.y).toBeLessThan(20) // and the top
    expect(box.width).toBeLessThan(270)
    expect(box.height).toBeLessThan(30)
    await page().screenshot({ path: process.env.E2E_SHOT_ACTIVITY ?? join(tmp, 'activity.png'), clip: { x: view.width - 320, y: 0, width: 320, height: 60 } })
  })

  it('fills as a transfer progresses, and stays out of the way of clicks', async () => {
    await report('test', [{ id: 'job', label: 'Đang chép 3 mục', progress: 0.5 }])
    await page().waitForFunction(() => document.querySelector<HTMLElement>('[data-testid=activity-fill]')?.style.width === '50%')
    expect(await page().getAttribute('[data-testid=activity-fill]', 'class')).not.toContain('indeterminate')
    expect(await page().evaluate(() => getComputedStyle(document.querySelector('[data-testid=activity]')!).pointerEvents)).toBe('none')
    await report('test', [{ id: 'job', label: 'Đang chép 3 mục', progress: 1 }])
    await page().waitForFunction(() => document.querySelector<HTMLElement>('[data-testid=activity-fill]')?.style.width === '100%')
  })

  it('with several things going on, names the first and counts the rest', async () => {
    await report('test', [{ id: 'a', label: 'Đang kết nối prod…' }, { id: 'b', label: 'Đang tải lên x…' }])
    await page().waitForFunction(() => document.querySelector('[data-testid=activity-label]')?.textContent === 'Đang kết nối prod… (+1)')
  })

  it('goes away shortly after the work ends', async () => {
    await report('test', [])
    await page().waitForSelector('[data-testid=activity]', { state: 'detached', timeout: 5000 })
  })
})
