/**
 * The saved-hosts flow in the real app: create a vault, save hosts, connect from them, and check that
 * secrets never reach the UI or the disk in the clear - across lock, restart and recovery.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateEd25519, startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import * as H from './helpers'

const PASS = 'correct horse battery staple'
const PASSWORD = 'pw-Zx91-only-on-server'
let tmp: string
let profile: string
let server: TestServer
let keyServer: TestServer
let app: ElectronApplication
let page: Page
let recoveryKey = ''

/** Hidden sections stay mounted (so terminals survive), so scope form fields to the visible one. */
const vis = (selector: string) => `.section:not([hidden]) ${selector}`
const tab = (n: number) => `t${n}`
const vaultFile = () => join(profile, 'vault.json')

async function addPasswordHost(name: string, opts: { group?: string } = {}) {
  await page.click('button:has-text("New host")')
  await page.fill(vis('input[name=name]'), name)
  await page.fill(vis('input[name=host]'), '127.0.0.1')
  await page.fill(vis('input[name=port]'), String(server.port))
  await page.fill(vis('input[name=username]'), 'tester')
  await page.fill(vis('input[name=password]'), PASSWORD)
  if (opts.group) await page.fill(vis('input[name=group]'), opts.group)
  await page.click('button[type=submit]:has-text("Save")')
  await page.waitForSelector(`[data-testid="host-${name}"]`)
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-vault-'))
  profile = join(tmp, 'profile')
  server = await startSshTestServer(tmp, { password: PASSWORD })
  ;({ app, page } = await H.launch(profile))
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await server?.close()
  await keyServer?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('creating the vault', () => {
  it('starts on the setup screen and warns that there is no system keychain here', async () => {
    await page.waitForSelector('h2:has-text("Create your vault")')
    await page.waitForSelector('.warn:has-text("không có kho khóa hệ thống")')
    expect(await page.locator(vis('input[name=remember]')).count()).toBe(0) // offering it would be a lie
  })

  it('rejects a short or mismatched passphrase and creates nothing', async () => {
    await page.fill(vis('input[name=passphrase]'), 'short')
    await page.fill(vis('input[name=passphrase2]'), 'short')
    await page.click('button:has-text("Create vault")')
    await page.waitForSelector('[role=alert]:has-text("ít nhất 10")')
    await page.fill(vis('input[name=passphrase]'), PASS)
    await page.fill(vis('input[name=passphrase2]'), PASS + 'x')
    await page.click('button:has-text("Create vault")')
    await page.waitForSelector('[role=alert]:has-text("không khớp")')
    await expect(readFile(vaultFile())).rejects.toThrow()
  })

  it('shows a recovery key once and will not continue until it is confirmed saved', async () => {
    await page.fill(vis('input[name=passphrase2]'), PASS)
    await page.click('button:has-text("Create vault")')
    await page.waitForSelector('h2:has-text("Save your recovery key")')
    recoveryKey = (await page.textContent('[data-testid=recovery-key]'))!.trim()
    expect(recoveryKey).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/)
    expect(await page.isDisabled('button:has-text("Continue")')).toBe(true)
    await page.check(vis('input[name=saved]'))
    await page.click('button:has-text("Continue")')
    await page.waitForSelector('text=Chưa có host nào được lưu')
  })
})

describe('saving hosts', () => {
  it('adds a host and lists it', async () => {
    await addPasswordHost('prod-box', { group: 'Production' })
    await page.waitForSelector('h3:has-text("Production")')
    expect(await page.textContent('[data-testid="host-prod-box"]')).toContain(`tester@127.0.0.1:${server.port}`)
  })

  it('the UI can never read a saved secret, and the file on disk is unreadable without the passphrase', async () => {
    const seen = JSON.stringify(await page.evaluate(async () => [await window.mymius.hosts.list(), await window.mymius.keys.list()]))
    expect(seen).not.toContain(PASSWORD)
    expect(seen).toContain('prod-box') // it does get the redacted summary

    const disk = await readFile(vaultFile(), 'utf8')
    for (const secret of [PASSWORD, 'prod-box', '127.0.0.1', 'tester', 'Production', PASS, recoveryKey]) {
      expect(disk).not.toContain(secret)
    }
  })

  it('rejects an invalid host without losing what was typed', async () => {
    await page.click('button:has-text("New host")')
    await page.fill(vis('input[name=host]'), '-oProxyCommand=evil')
    await page.fill(vis('input[name=username]'), 'x')
    await page.fill(vis('input[name=password]'), 'x')
    await page.click('button[type=submit]:has-text("Save")')
    await page.waitForSelector('[role=alert]:has-text("hợp lệ")')
    expect(await page.inputValue(vis('input[name=host]'))).toBe('-oProxyCommand=evil')
    await page.click('button:has-text("Cancel")')
  })
})

describe('connecting from a saved host', () => {
  it('one click opens a terminal using the stored password, after asking to trust the host', async () => {
    await page.click('button[aria-label="Connect to prod-box"]')
    await H.waitForText(page, tab(1), 'welcome tester')
    expect((await H.dialogs(app))).toHaveLength(1)
    expect(await page.textContent('.tab.active')).toContain('prod-box')
    await H.run(page, tab(1), 'echo saved works')
    await H.waitForText(page, tab(1), /saved works\n\$/)
  })

  it('connecting again shares the connection and does not ask again', async () => {
    await H.goTo(page, 'Hosts')
    await page.click('button[aria-label="Connect to prod-box"]')
    await H.waitForText(page, tab(2), 'welcome tester')
    expect(server.connectionCount()).toBe(1)
    expect(await H.dialogs(app)).toHaveLength(1)
  })
})

describe('locking', () => {
  it('locking hides the hosts behind the unlock screen but leaves open terminals running', async () => {
    await H.goTo(page, 'Hosts')
    await page.click('button:has-text("Lock vault")')
    await page.waitForSelector('h2:has-text("Unlock your vault")')
    expect(await page.locator('[data-testid="host-prod-box"]').count()).toBe(0)
    await H.goTo(page, 'Terminals')
    await page.click('.tab >> nth=0')
    await H.run(page, tab(1), 'echo still connected')
    await H.waitForText(page, tab(1), /still connected\n\$/)
  })

  it('the main process refuses saved-host operations while locked', async () => {
    const r = await page.evaluate(async () => ({ hosts: await window.mymius.hosts.list(), keys: await window.mymius.keys.list() }))
    expect(r.hosts).toMatchObject({ ok: false, error: expect.stringMatching(/đang khóa/) })
    expect(r.keys).toMatchObject({ ok: false })
  })

  it('a wrong passphrase is refused, the right one unlocks', async () => {
    await H.goTo(page, 'Hosts')
    await page.fill(vis('input[name=passphrase]'), 'not the passphrase')
    await page.click('button:has-text("Unlock")')
    await page.waitForSelector('[role=alert]:has-text("Sai passphrase")')
    await page.fill(vis('input[name=passphrase]'), PASS)
    await page.click('button:has-text("Unlock")')
    await page.waitForSelector('[data-testid="host-prod-box"]')
  })
})

describe('editing', () => {
  it('renaming a host without retyping its password keeps the password working', async () => {
    await page.click('button[aria-label="Edit prod-box"]')
    expect(await page.getAttribute(vis('input[name=password]'), 'placeholder')).toMatch(/để trống nếu muốn giữ nguyên/)
    await page.fill(vis('input[name=name]'), 'prod-renamed')
    await page.click('button[type=submit]:has-text("Save")')
    await page.waitForSelector('[data-testid="host-prod-renamed"]')
    await page.click('button[aria-label="Connect to prod-renamed"]')
    await H.waitForText(page, tab(3), 'welcome tester')
  })
})

describe('restart and recovery', () => {
  it('after a restart the vault is locked, the data is intact, and connecting still works', async () => {
    await app.close()
    ;({ app, page } = await H.launch(profile))
    await page.waitForSelector('h2:has-text("Unlock your vault")')
    await page.fill(vis('input[name=passphrase]'), PASS)
    await page.click('button:has-text("Unlock")')
    await page.waitForSelector('[data-testid="host-prod-renamed"]')
    await page.click('button[aria-label="Connect to prod-renamed"]')
    await H.waitForText(page, tab(1), 'welcome tester')
    expect(await H.dialogs(app)).toHaveLength(0) // known_hosts persisted: no new prompt for a known host
  })

  it('the recovery key gets you in when the passphrase is forgotten', async () => {
    await H.goTo(page, 'Hosts')
    await page.click('button:has-text("Lock vault")')
    await page.click('button:has-text("I forgot my passphrase")')
    await page.fill(vis('input[name=recovery]'), '0'.repeat(64))
    await page.click('button:has-text("Unlock")')
    await page.waitForSelector('[role=alert]:has-text("Sai passphrase")')
    await page.fill(vis('input[name=recovery]'), recoveryKey)
    await page.click('button:has-text("Unlock")')
    await page.waitForSelector('[data-testid="host-prod-renamed"]')
  })
})

describe('keys and jump hosts', () => {
  it('imports a private key into the vault and signs in with it', async () => {
    const pair = generateEd25519()
    keyServer = await startSshTestServer(tmp, { authorizedKey: pair.public })
    const keyFile = join(tmp, 'id_test')
    await writeFile(keyFile, pair.private)
    await H.answerFilePicker(app, keyFile)

    await page.click('button:has-text("Keys (")')
    await page.click('button:has-text("Import key file")')
    await page.waitForSelector('.hostrow:has-text("id_test")')
    const listed = JSON.stringify(await page.evaluate(() => window.mymius.keys.list()))
    expect(listed).toContain('SHA256:')
    expect(listed).not.toContain('PRIVATE KEY')
    expect(await readFile(vaultFile(), 'utf8')).not.toContain('PRIVATE KEY')
    await page.click('button:has-text("Back")')

    await page.click('button:has-text("New host")')
    await page.fill(vis('input[name=name]'), 'key-box')
    await page.fill(vis('input[name=host]'), '127.0.0.1')
    await page.fill(vis('input[name=port]'), String(keyServer.port))
    await page.fill(vis('input[name=username]'), 'tester')
    await page.check(vis('input[value=key]'))
    await page.click('button[type=submit]:has-text("Save")')
    await page.waitForSelector('[data-testid="host-key-box"]')
    await page.click('button[aria-label="Connect to key-box"]')
    await H.waitForText(page, tab(2), 'welcome tester')
    expect(keyServer.shells).toHaveLength(1)
  })

  it('a host can be reached through another saved host', async () => {
    await H.goTo(page, 'Hosts')
    await page.click('button:has-text("New host")')
    await page.fill(vis('input[name=name]'), 'inner')
    await page.fill(vis('input[name=host]'), '127.0.0.1')
    await page.fill(vis('input[name=port]'), String(keyServer.port))
    await page.fill(vis('input[name=username]'), 'tester')
    await page.check(vis('input[value=key]'))
    await page.selectOption(vis('select[name=jump]'), { label: 'prod-renamed' })
    await page.click('button[type=submit]:has-text("Save")')
    await page.waitForSelector('[data-testid="host-inner"] >> text=via prod-renamed')
    await page.click('button[aria-label="Connect to inner"]')
    await H.waitForText(page, tab(3), 'welcome tester')
    expect(server.forwards).toEqual([{ host: '127.0.0.1', port: keyServer.port }])
  })

  it('a key that hosts still use cannot be deleted', async () => {
    await H.goTo(page, 'Hosts')
    await page.click('button:has-text("Keys (")')
    await page.click('button[aria-label="Delete id_test"]')
    await page.waitForSelector('[role=alert]:has-text("Vẫn đang được dùng bởi")')
  })

  it('a host used as a jump host cannot be deleted', async () => {
    await page.click('button:has-text("Back")')
    await page.click('button[aria-label="Edit prod-renamed"]')
    await page.click('button:has-text("Delete")')
    await page.click('button:has-text("Yes, delete")')
    await page.waitForSelector('[role=alert]:has-text("Đang được dùng làm jump host bởi: inner")')
  })
})

describe('screenshots', () => {
  it('captures the hosts page', async () => {
    await page.click('button:has-text("Cancel")')
    await page.waitForSelector('[data-testid="host-inner"]')
    await page.screenshot({ path: process.env.E2E_SHOT_HOSTS ?? join(tmp, 'hosts.png') })
  })
})
