import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeDropbox, type FakeDropbox } from '@mymius/drive-sync/testing'
import * as H from './helpers'

/**
 * Two real app instances sharing one (stand-in) Dropbox account: sign in with a pasted code, sync, restore on a
 * second device, and sign out. The fake Dropbox is not Dropbox; see docs/DROPBOX_SETUP.md for what is unverified.
 */
const PASS = 'correct horse battery'
let tmp: string
let d: FakeDropbox
let one: Awaited<ReturnType<typeof H.launch>> & { profile: string }
let two: Awaited<ReturnType<typeof H.launch>> & { profile: string }
const vis = (s: string) => `.section:not([hidden]) ${s}`
const launchDevice = async (name: string) => {
  const profile = join(tmp, name)
  const env = { MYMIUS_E2E_DROPBOX: JSON.stringify({ authEndpoint: d.authEndpoint, tokenEndpoint: d.tokenEndpoint, apiUrl: d.baseUrl, contentUrl: d.baseUrl }) }
  return { ...(await H.launch(profile, env)), profile }
}
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out: ' + what); await new Promise((r) => setTimeout(r, 50)) }
}
const filesOnDropbox = () => d.control.files().map((f) => f.name).sort()
async function pasteCode(page: Page) {
  await page.waitForSelector('[data-testid=dropbox-code-form]')
  await until(() => d.control.lastCode() !== undefined, 'the consent page to have been opened')
  await page.fill('input[name=dropboxCode]', d.control.lastCode()!)
  await page.click('button:has-text("Finish sign-in")')
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-dbx-'))
  d = await startFakeDropbox()
  one = await launchDevice('one')
})
afterAll(async () => {
  await one?.app.close().catch(() => undefined)
  await two?.app.close().catch(() => undefined)
  await d?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('device one: signing in with Dropbox', () => {
  it('asks for the app key first, then opens the Dropbox page and waits for the pasted code', async () => {
    await H.createVault(one.page, PASS)
    await H.addPasswordHost(one.page, { name: 'shared-box', port: 2222, username: 'root', password: 'pw-only-on-servers' })
    await H.goTo(one.page, 'Settings')
    expect(await one.page.locator('button:has-text("Sign in with Dropbox")').count()).toBe(0)
    await one.page.screenshot({ path: process.env.E2E_SHOT_CLOUD ?? join(tmp, 'cloud.png') })
    await one.page.fill(vis('input[name=dropboxKey]'), d.appKey)
    await one.page.click('button:has-text("Save key")')
    await one.page.click('button:has-text("Sign in with Dropbox")')
    await one.page.waitForSelector('[data-testid=dropbox-code-form]')
    const url = new URL((await H.externalUrls(one.app))[0]!)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('token_access_type')).toBe('offline')
  })

  it('a wrong code is explained and the same page can still be used', async () => {
    await one.page.fill('input[name=dropboxCode]', 'this-is-not-the-code')
    await one.page.click('button:has-text("Finish sign-in")')
    await one.page.waitForSelector('[data-testid=dropbox-code-form] [role=alert]:has-text("Mã không đúng")')
    await one.page.fill('input[name=dropboxCode]', d.control.lastCode()!)
    await one.page.click('button:has-text("Finish sign-in")')
    await one.page.waitForSelector('[data-testid=drive-connected]', { timeout: 20_000 })
    expect(await one.page.textContent('[data-testid=drive-provider]')).toBe('Dropbox')
    expect(await one.page.textContent('[data-testid=drive-connected]')).toContain('dbx-user@example.com')
  })

  it('syncs, publishing only unreadable files, and keeps the sign-in sealed in the vault', async () => {
    await one.page.locator('[data-testid=drive-phase]:has-text("đã cập nhật")').waitFor({ timeout: 15_000 })
    expect(filesOnDropbox()).toHaveLength(2)
    const everything = JSON.stringify(d.control.files())
    for (const secret of ['shared-box', 'pw-only-on-servers', 'root', PASS, '2222']) expect(everything).not.toContain(secret)
    const disk = await readFile(join(one.profile, 'vault.json'), 'utf8')
    expect(disk).not.toMatch(/dbrt-[0-9a-f]{24}/)
  })
})

describe('device two: restoring from Dropbox', () => {
  it('restores from the create-vault screen, unlocks, and the host arrives', async () => {
    two = await launchDevice('two')
    await two.page.waitForSelector('h2:has-text("Create your vault")')
    await two.page.click('button:has-text("Set up Dropbox sign-in")')
    await two.page.fill(vis('input[name=dropboxKey]'), d.appKey)
    await two.page.click('button:has-text("Save key")')
    await two.page.click('[data-testid=restore] button:has-text("Sign in with Dropbox")')
    await pasteCode(two.page)
    await two.page.waitForSelector('h2:has-text("Unlock your vault")', { timeout: 20_000 })
    await two.page.fill(vis('input[name=passphrase]'), PASS)
    await two.page.click('button:has-text("Unlock")')
    await until(async () => (await H.hostNames(two.page)).includes('shared-box'), 'the host from device one to appear')
  })

  it('a host added on device two shows up on device one', async () => {
    await H.addPasswordHost(two.page, { name: 'added-on-two', port: 2222, username: 'root', password: 'x' })
    await H.goTo(one.page, 'Hosts')
    await until(async () => (await H.hostNames(one.page)).includes('added-on-two'), 'two -> one')
  })
})

describe('signing out', () => {
  it('signs out and can erase what was synced', async () => {
    await H.goTo(two.page, 'Settings')
    await two.page.click('button:has-text("Sign out…")')
    await two.page.check(vis('input[name=deleteRemote]'))
    await two.page.click('button:has-text("Sign out")>>nth=-1')
    await two.page.waitForSelector('button:has-text("Sign in with Dropbox")')
    expect(filesOnDropbox()).toEqual([])
    expect(d.stats.revocations).toBe(1)
  })
})
