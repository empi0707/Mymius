/**
 * Two real app instances sharing one (stand-in) Google account: set up sync, restore on a second device,
 * see edits travel both ways with nobody touching anything, change the passphrase, lose and regain access,
 * and disconnect. Google itself is faked (see packages/drive-sync/src/testing/fake-google.ts).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeGoogle, type FakeGoogle } from '@mymius/drive-sync/testing'
import * as H from './helpers'

const PASS = 'correct horse battery staple'
const NEW_PASS = 'a brand new passphrase 2'
const META_KEEP = 'mymius-vault.json'
let tmp: string
let g: FakeGoogle
let one: { app: ElectronApplication; page: Page; profile: string }
let two: { app: ElectronApplication; page: Page; profile: string }
const vis = (s: string) => `.section:not([hidden]) ${s}`

async function launchDevice(name: string, existing?: string) {
  const profile = existing ?? join(tmp, name)
  const env = { MYMIUS_E2E_GOOGLE: JSON.stringify({ authEndpoint: g.authEndpoint, tokenEndpoint: g.tokenEndpoint, revokeEndpoint: g.revokeEndpoint, baseUrl: g.baseUrl }) }
  return { ...(await H.launch(profile, env)), profile }
}
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const hostsOn = (d: { page: Page }) => H.hostNames(d.page)
const filesOnDrive = () => g.control.files().map((f) => f.name).sort()
async function configureClient(page: Page) {
  await page.fill(vis('input[name=clientId]'), g.clientId)
  await page.fill(vis('input[name=clientSecret]'), g.clientSecret)
  await page.click(vis('.inline-form button:has-text("Continue")'))
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-sync-'))
  g = await startFakeGoogle({ accessTokenTtlMs: 60_000 })
  one = await launchDevice('one')
})
afterAll(async () => {
  await one?.app.close().catch(() => undefined)
  await two?.app.close().catch(() => undefined)
  await g?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('device one: turning sync on', () => {
  it('has a vault with a host, and sync is off until asked for', async () => {
    await H.createVault(one.page, PASS)
    await H.addPasswordHost(one.page, { name: 'shared-box', port: 2222, username: 'root', password: 'pw-only-on-servers' })
    await H.goTo(one.page, 'Settings')
    await one.page.waitForSelector('[data-testid=drive-card]')
    expect(await one.page.locator('[data-testid=sync-line]').count()).toBe(0)
    expect(filesOnDrive()).toEqual([])
  })

  it('asks for the Google client credentials first, then signs in through the browser', async () => {
    await one.page.click('summary:has-text("Dùng Google Drive thay thế")')
    await one.page.waitForSelector(vis('input[name=clientId]'))
    await configureClient(one.page)
    await one.page.click('button:has-text("Sign in with Google")')
    await one.page.waitForSelector('[data-testid=drive-connected]', { timeout: 20_000 })
    expect(await one.page.textContent('[data-testid=drive-connected]')).toContain('user@example.com')
    const url = new URL((await H.externalUrls(one.app))[0]!)
    expect(url.origin + url.pathname).toBe(new URL(g.authEndpoint).origin + new URL(g.authEndpoint).pathname)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('drive.appdata')
  })

  it('shows it is up to date, and published only unreadable files', async () => {
    await one.page.locator('[data-testid=drive-phase]:has-text("đã cập nhật")').waitFor({ timeout: 15_000 })
    expect(await one.page.textContent('[data-testid=drive-line]')).toMatch(/Đồng bộ lần cuối.*chưa có thiết bị khác/)
    expect(await one.page.textContent('[data-testid=sync-line]')).toMatch(/Đã đồng bộ/)
    expect(filesOnDrive()).toHaveLength(2)
    const everything = JSON.stringify(g.control.files())
    for (const secret of ['shared-box', 'pw-only-on-servers', 'root', PASS, '2222']) expect(everything).not.toContain(secret)
  })

  it('kept the Google sign-in sealed inside the vault file', async () => {
    const disk = await readFile(join(one.profile, 'vault.json'), 'utf8')
    expect(disk).not.toMatch(/rt-[0-9a-f]{24}/) // a real refresh token (a bare 'rt-' can occur by chance in base64)
    expect(disk).not.toContain(g.clientSecret)
    const settings = await readFile(join(one.profile, 'drive-settings.json'), 'utf8')
    expect(JSON.parse(settings).clientId).toBe(g.clientId) // configuration, not a secret
  })
})

describe('device two: restoring from Google Drive', () => {
  it('offers to restore on the create-vault screen; sign-in needs the client credentials too', async () => {
    two = await launchDevice('two')
    await two.page.waitForSelector('h2:has-text("Create your vault")')
    await two.page.click('button:has-text("Set up Google sign-in")')
    await configureClient(two.page)
    await two.page.waitForSelector('button:has-text("Sign in with Google")')
  })

  it('a refused consent screen is explained and nothing changes', async () => {
    g.control.denyNextConsent()
    await two.page.click('button:has-text("Sign in with Google")')
    await two.page.waitForSelector('[data-testid=restore] [role=alert]:has-text("chưa được cấp")', { timeout: 15_000 })
    await two.page.waitForSelector('h2:has-text("Create your vault")')
  })

  it('restores, asks for the passphrase, refuses a wrong one, and brings the hosts in with the right one', async () => {
    await two.page.click('button:has-text("Sign in with Google")')
    await two.page.waitForSelector('h2:has-text("Unlock your vault")', { timeout: 20_000 })
    expect(await two.page.textContent('[data-testid=restored-hint]')).toContain('user@example.com')
    await two.page.fill(vis('input[name=passphrase]'), 'not the passphrase')
    await two.page.click('button:has-text("Unlock")')
    await two.page.waitForSelector('[role=alert]:has-text("Sai passphrase")')
    await two.page.fill(vis('input[name=passphrase]'), PASS)
    await two.page.click('button:has-text("Unlock")')
    await until(async () => (await hostsOn(two)).includes('shared-box'), 'the host from device one to appear (nobody clicked anything)')
    expect(await two.page.textContent('[data-testid="host-shared-box"]')).toContain('root@127.0.0.1:2222')
  })

  it('both devices now list each other', async () => {
    await H.goTo(two.page, 'Settings')
    await two.page.locator('[data-testid=drive-line]:has-text("1 thiết bị khác")').waitFor({ timeout: 15_000 })
    await H.goTo(one.page, 'Settings')
    await one.page.locator('[data-testid=drive-line]:has-text("1 thiết bị khác")').waitFor({ timeout: 15_000 })
    expect(filesOnDrive()).toHaveLength(3)
  })
})

describe('edits travel with nobody touching anything', () => {
  it('a host added on device two shows up on device one', async () => {
    await H.goTo(two.page, 'Hosts')
    await H.addPasswordHost(two.page, { name: 'from-two', port: 22, username: 'ops', password: 'pw2' })
    await H.goTo(one.page, 'Hosts')
    await until(async () => (await hostsOn(one)).includes('from-two'), 'device one to show the host added on device two')
  })

  it('a host deleted on device one disappears from device two', async () => {
    await one.page.click('button[aria-label="Edit shared-box"]')
    await one.page.click(vis('button:has-text("Delete")'))
    await one.page.click('button:has-text("Yes, delete")')
    await one.page.waitForSelector('[data-testid="host-shared-box"]', { state: 'detached' })
    await until(async () => !(await hostsOn(two)).includes('shared-box'), 'the deletion to reach device two')
    expect(await hostsOn(two)).toEqual(['from-two'])
  })

  it('what reaches the other device is usable there: the merged host connects with its stored password', async () => {
    // The password made the trip encrypted; device two can read it, which shows in the editor's "saved" hint.
    await two.page.click('button[aria-label="Edit from-two"]')
    expect(await two.page.getAttribute(vis('input[name=password]'), 'placeholder')).toMatch(/để trống nếu muốn giữ nguyên/)
    await two.page.click(vis('button:has-text("Cancel")'))
  })
})

describe('a new passphrase', () => {
  it('changed on one device is required on the other after it syncs', async () => {
    await H.goTo(one.page, 'Settings')
    await one.page.fill(vis('input[name=newPassphrase]'), NEW_PASS)
    await one.page.fill(vis('input[name=newPassphrase2]'), NEW_PASS)
    await one.page.click('button:has-text("Change passphrase")')
    await one.page.waitForSelector('[role=status]:has-text("Đã đổi passphrase")')
    const vaultOf = async (d: { profile: string }) => JSON.parse(await readFile(join(d.profile, 'vault.json'), 'utf8')).meta.rev as number
    await until(async () => (await vaultOf(two)) === 2, 'device two to adopt the new vault metadata')
    await two.app.close()
    two = await launchDevice('two', two.profile)
    await two.page.waitForSelector('h2:has-text("Unlock your vault")')
    await two.page.fill(vis('input[name=passphrase]'), PASS)
    await two.page.click('button:has-text("Unlock")')
    await two.page.waitForSelector('[role=alert]:has-text("Sai passphrase")')
    await two.page.fill(vis('input[name=passphrase]'), NEW_PASS)
    await two.page.click('button:has-text("Unlock")')
    await two.page.waitForSelector('[data-testid="host-from-two"]')
  })

  it('and after that restart sync resumes by itself on device two, with no new sign-in', async () => {
    expect(await H.externalUrls(two.app)).toEqual([])
    await H.goTo(two.page, 'Settings')
    await two.page.locator('[data-testid=drive-phase]:has-text("đã cập nhật")').waitFor({ timeout: 15_000 })
  })
})

describe('losing and regaining access', () => {
  it('revoked access is noticed, explained, and one click signs in again', async () => {
    g.control.expireAccessTokens()
    g.control.revokeAllGrants()
    await H.goTo(one.page, 'Settings')
    await one.page.locator('[data-testid=drive-phase]:has-text("cần đăng nhập lại")').waitFor({ timeout: 20_000 })
    await one.page.locator('[role=alert]:has-text("đăng nhập lại")').waitFor()
    expect(await one.page.textContent('[data-testid=sync-line]')).toMatch(/sự cố/)
    await one.page.screenshot({ path: process.env.E2E_SHOT_SYNC_ERROR ?? join(tmp, 'needs-auth.png') })
    await one.page.click('button:has-text("Sign in again")')
    await one.page.locator('[data-testid=drive-phase]:has-text("đã cập nhật")').waitFor({ timeout: 20_000 })
    await one.page.screenshot({ path: process.env.E2E_SHOT_SYNC_OK ?? join(tmp, 'connected.png') })
  })
})

describe('disconnecting', () => {
  it('signs out of Google and keeps the local vault; the other device is unaffected', async () => {
    await H.goTo(one.page, 'Settings')
    await one.page.click('button:has-text("Sign out…")')
    await one.page.click('button:has-text("Sign out")>>nth=-1')
    await one.page.waitForSelector('button:has-text("Sign in with Google")')
    expect(g.stats.revocations).toBeGreaterThanOrEqual(1)
    expect(await one.page.locator('[data-testid=sync-line]').count()).toBe(0)
    await H.goTo(one.page, 'Hosts')
    await until(async () => (await hostsOn(one)).length > 0, 'the host list to load')
    expect(await hostsOn(one)).toEqual(['from-two'])
    const disk = await readFile(join(one.profile, 'vault.json'), 'utf8')
    expect(disk).toContain('"local"') // (the sealed area still exists; the Google entries in it were removed)
  })

  it('signing out here works even if Google no longer accepts this device, and the card says what it could not do', async () => {
    // Every sign-in was revoked earlier; device two has not signed in again.
    await H.goTo(two.page, 'Settings')
    await two.page.locator('[data-testid=drive-phase]:has-text("cần đăng nhập lại")').waitFor({ timeout: 20_000 })
    await two.page.click('button:has-text("Sign out…")')
    await two.page.check(vis('input[name=deleteRemote]'))
    await two.page.click('button:has-text("Sign out")>>nth=-1')
    await two.page.waitForSelector('button:has-text("Sign in with Google")')
    await two.page.waitForSelector('[role=alert]:has-text("chưa xóa được")')
    expect(filesOnDrive()).toHaveLength(2) // untouched: the shared metadata and device two's own file (device one's left earlier)
    expect(filesOnDrive()).toContain(META_KEEP)
  })

  it('can erase the synced data from Drive when signed in', async () => {
    await H.goTo(two.page, 'Settings')
    await two.page.click('button:has-text("Sign in with Google")')
    await two.page.locator('[data-testid=drive-phase]').waitFor({ timeout: 20_000 })
    await two.page.click('button:has-text("Sign out…")')
    await two.page.check(vis('input[name=deleteRemote]'))
    await two.page.click('button:has-text("Sign out")>>nth=-1')
    await two.page.waitForSelector('button:has-text("Sign in with Google")')
    expect(filesOnDrive()).toEqual([])
  })
})

describe('a brand-new Google account', () => {
  let three: Awaited<ReturnType<typeof launchDevice>>
  afterAll(async () => { await three?.app.close().catch(() => undefined) })

  it('signs in before any vault exists, shows who it is, and the vault created next syncs by itself', async () => {
    three = await launchDevice('three')
    await three.page.waitForSelector('h2:has-text("Create your vault")')
    await three.page.click('button:has-text("Set up Google sign-in")')
    await configureClient(three.page)
    await three.page.click('button:has-text("Sign in with Google")')
    await three.page.waitForSelector('[data-testid=signed-in-hint]', { timeout: 20_000 })
    expect(await three.page.textContent('[data-testid=account-name]')).toBe('Test user')
    expect(await three.page.textContent('[data-testid=account-email]')).toBe('user@example.com')
    expect(filesOnDrive()).toEqual([]) // nothing to upload yet
    await H.createVault(three.page, PASS)
    await until(() => filesOnDrive().length === 2, 'the new vault to be uploaded')
    expect(await three.page.textContent('[data-testid=account-line]')).toBe('Test user')
  })
})
