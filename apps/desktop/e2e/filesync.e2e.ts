import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as H from './helpers'

/**
 * The account-free path: a JSON sync file in a folder both devices can reach (stand-in for iCloud Drive,
 * Dropbox, a NAS...), a one-off backup, and the light/dark appearance.
 */
const PASS = 'correct horse battery'
let tmp: string
let syncFile: string
type Device = Awaited<ReturnType<typeof H.launch>> & { profile: string }
let one: Device, two: Device
const vis = (sel: string) => `.section:not([hidden]) ${sel}`
const launchDevice = async (name: string, path: string, profile?: string): Promise<Device> => {
  const p = profile ?? join(tmp, name)
  return { ...(await H.launch(p, { MYMIUS_E2E_FILE_PICK: path, MYMIUS_E2E_BACKUP_DIR: join(tmp, 'auto-backups') })), profile: p }
}
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-file-'))
  syncFile = join(tmp, 'cloud-folder', 'mymius-sync.json')
})
afterAll(async () => {
  await one?.app.close().catch(() => undefined)
  await two?.app.close().catch(() => undefined)
  await rm(tmp, { recursive: true, force: true })
})

describe('device one: creating a sync file', () => {
  it('sets up a vault with a host, then creates the sync file from Settings', async () => {
    one = await launchDevice('one', syncFile)
    await H.createVault(one.page, PASS)
    await H.addPasswordHost(one.page, { name: 'shared-box', port: 2222, username: 'root', password: 'pw-only-on-servers' })
    await H.goTo(one.page, 'Settings')
    await one.page.click('button:has-text("Create sync file")')
    await one.page.locator('[data-testid=filesync-phase]:has-text("đã cập nhật")').waitFor({ timeout: 15_000 })
    expect(await one.page.textContent('[data-testid=filesync-path]')).toBe(syncFile)
  })

  it('the file is one JSON document that holds nothing readable', async () => {
    const raw = await readFile(syncFile, 'utf8')
    expect(JSON.parse(raw).kind).toBe('mymius-sync-bundle')
    for (const secret of ['shared-box', 'pw-only-on-servers', 'root', PASS, '2222']) expect(raw).not.toContain(secret)
    expect((await stat(syncFile)).mode & 0o077).toBe(0)
  })
})

describe('device two: restoring from the file, then staying in step', () => {
  it('restores from the file on the create-vault screen, asks for the passphrase, and the host arrives', async () => {
    two = await launchDevice('two', syncFile)
    await two.page.waitForSelector('h2:has-text("Create your vault")')
    await two.page.click('button:has-text("Restore and keep in sync with file")')
    await two.page.waitForSelector('h2:has-text("Unlock your vault")', { timeout: 20_000 })
    await two.page.fill(vis('input[name=passphrase]'), 'not the passphrase')
    await two.page.click('button:has-text("Unlock")')
    await two.page.waitForSelector('[role=alert]:has-text("Sai passphrase")')
    await two.page.fill(vis('input[name=passphrase]'), PASS)
    await two.page.click('button:has-text("Unlock")')
    await until(async () => (await H.hostNames(two.page)).includes('shared-box'), 'the host from device one to appear')
  })

  it('a host added on device two shows up on device one, and the other way round', async () => {
    await H.addPasswordHost(two.page, { name: 'added-on-two', port: 2222, username: 'root', password: 'x-secret-two' })
    await H.goTo(one.page, 'Hosts')
    await until(async () => (await H.hostNames(one.page)).includes('added-on-two'), 'two -> one')
    await H.addPasswordHost(one.page, { name: 'added-on-one', port: 2222, username: 'root', password: 'x-secret-one' })
    await until(async () => (await H.hostNames(two.page)).includes('added-on-one'), 'one -> two')
    const raw = await readFile(syncFile, 'utf8')
    expect(raw).not.toContain('x-secret-')
    expect(JSON.parse(raw).devices).toHaveLength(2)
  })
})

describe('backup and restore', () => {
  it('saves a backup and merges one into an unlocked vault', async () => {
    const backup = join(tmp, 'backup.json')
    await one.app.close()
    one = await launchDevice('one', backup, one.profile)
    await one.page.waitForSelector('h2:has-text("Unlock your vault")')
    await one.page.fill(vis('input[name=passphrase]'), PASS)
    await one.page.click('button:has-text("Unlock")')
    await H.goTo(one.page, 'Settings')
    await one.page.click('button:has-text("Save backup")')
    await one.page.locator('[data-testid=filesync-message]:has-text("Đã lưu backup")').waitFor()
    expect(JSON.parse(await readFile(backup, 'utf8')).kind).toBe('mymius-sync-bundle')
    await one.page.click('button:has-text("Restore from backup")')
    await one.page.locator('[data-testid=filesync-message]:has-text("Đã gộp")').waitFor()
  })

  it('explains a file that is not a backup', async () => {
    await one.app.close()
    one = await launchDevice('one', join(tmp, 'notes.txt'), one.profile)
    await writeNotes(join(tmp, 'notes.txt'))
    await one.page.waitForSelector('h2:has-text("Unlock your vault")')
    await one.page.fill(vis('input[name=passphrase]'), PASS)
    await one.page.click('button:has-text("Unlock")')
    await H.goTo(one.page, 'Settings')
    await one.page.click('button:has-text("Restore from backup")')
    await one.page.waitForSelector('[data-testid=filesync-message]:has-text("không phải file đồng bộ của Mymius")')
  })
})

const autoBackups = async () => (await readdir(join(tmp, 'auto-backups')).catch(() => [] as string[])).filter((n) => n.endsWith('.json'))

describe('automatic backup when a host is added', () => {
  it('shows what it does, and a new host produces one backup that holds nothing readable', async () => {
    await H.goTo(one.page, 'Settings')
    await one.page.waitForSelector('[data-testid=autobackup-card]')
    expect(await one.page.textContent('[data-testid=autobackup-dir]')).toContain('backups')
    await one.page.click('[data-testid=autobackup-card] button:has-text("Choose folder")')
    await one.page.waitForFunction(() => document.querySelector('[data-testid=autobackup-dir]')?.textContent?.includes('auto-backups'))
    const before = (await autoBackups()).length
    await H.goTo(one.page, 'Hosts')
    await H.addPasswordHost(one.page, { name: 'brand-new-host', port: 2222, username: 'root', password: 'pw-auto-backup' })
    await until(async () => (await autoBackups()).length === before + 1, 'the automatic backup')
    const files = await autoBackups()
    const raw = await readFile(join(tmp, 'auto-backups', files.sort().at(-1)!), 'utf8')
    expect(JSON.parse(raw).kind).toBe('mymius-sync-bundle')
    for (const secret of ['brand-new-host', 'pw-auto-backup']) expect(raw).not.toContain(secret)
    await H.goTo(one.page, 'Settings')
    await one.page.locator('[data-testid=autobackup-line]:has-text("Backup gần nhất")').waitFor()
  })

  it('can be turned off, and then a new host makes no backup', async () => {
    await one.page.click('input[name=autobackup]')
    await one.page.waitForSelector('input[name=autobackup]:not(:checked)')
    const before = (await autoBackups()).length
    await H.goTo(one.page, 'Hosts')
    await H.addPasswordHost(one.page, { name: 'quiet-host', port: 2222, username: 'root', password: 'x' })
    await new Promise((r) => setTimeout(r, 1200))
    expect((await autoBackups()).length).toBe(before)
    await H.goTo(one.page, 'Settings')
    await one.page.click('input[name=autobackup]')
    await one.page.waitForSelector('input[name=autobackup]:checked')
  })
})

describe('appearance', () => {
  it('switches to dark and back, remembers the choice across a restart', async () => {
    await H.goTo(one.page, 'Settings')
    await one.page.click('input[name=theme][value=light]')
    expect(await one.page.getAttribute('html', 'data-theme')).toBe('light')
    const light = await bg(one.page)
    await one.page.click('input[name=theme][value=dark]')
    expect(await one.page.getAttribute('html', 'data-theme')).toBe('dark')
    const dark = await bg(one.page)
    expect(dark).not.toBe(light)
    expect(dark).toBe('rgb(30, 30, 32)')
    await one.app.close()
    one = await launchDevice('one', join(tmp, 'x.json'), one.profile)
    await one.page.waitForSelector('h2:has-text("Unlock your vault")')
    expect(await one.page.getAttribute('html', 'data-theme')).toBe('dark')
    expect(await bg(one.page)).toBe('rgb(30, 30, 32)')
    await one.page.fill(vis('input[name=passphrase]'), PASS)
    await one.page.click('button:has-text("Unlock")')
    await H.goTo(one.page, 'Settings')
    await one.page.waitForSelector('[data-testid=filesync-card]')
    await one.page.screenshot({ path: '/tmp/claude-0/dark-settings.png' })
  })
})

async function writeNotes(path: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, 'just some notes')
}
