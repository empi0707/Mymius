import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import * as H from './helpers'

/** Importing hosts from ~/.ssh/config and ForkLift, through the real screens. */
const PASS = 'correct horse battery'
let tmp: string
let server: TestServer
let launched: Awaited<ReturnType<typeof H.launch>>
const file = () => join(tmp, 'import-source.txt')

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-import-'))
  server = await startSshTestServer(tmp, { password: 'unused-here' })
  launched = await H.launch(join(tmp, 'profile'), { MYMIUS_E2E_IMPORT_FILE: file() })
})
afterAll(async () => {
  await launched?.app.close().catch(() => undefined)
  await server?.close()
  await rm(tmp, { recursive: true, force: true })
})

const page = () => launched.page
const openImport = async (source: string) => {
  await page().click('button:has-text("Import…")')
  await page().click(`[data-testid=import-source-${source}] button:has-text("Choose file")`)
}

describe('ssh config', () => {
  it('previews what is in the file, with skipped entries explained', async () => {
    await H.createVault(page(), PASS)
    await writeFile(file(), [
      'Host lab-box', ` HostName 127.0.0.1`, ` Port ${server.port}`, ' User tester', ' IdentityFile ~/.ssh/lab_key',
      'Host second', ' HostName 10.9.9.9', ' User root',
      'Host needs-tokens', ' HostName %h.example.com', ' User x'
    ].join('\n'))
    await openImport('ssh-config')
    await page().waitForSelector('[data-testid=import-summary]')
    expect(await page().textContent('[data-testid=import-summary]')).toMatch(/2.*host.*1.*bị bỏ qua/)
    expect(await page().textContent('.import-list')).toContain('lab-box')
    await page().click('.issues summary')
    expect(await page().textContent('.issues')).toMatch(/needs-tokens/)
    await page().screenshot({ path: process.env.E2E_SHOT_IMPORT ?? join(tmp, 'import.png') })
  })

  it('imports only what is ticked', async () => {
    await page().uncheck('input[aria-label="Nhập second"]')
    await page().click('button:has-text("Import 1 hosts")')
    await page().waitForSelector('[data-testid=import-result]')
    expect(await page().textContent('[data-testid=import-result]')).toContain('Đã nhập 1 host')
    await page().click('[data-testid=import-result] button:has-text("Done")')
    await page().waitForSelector('[data-testid="host-lab-box"]')
    expect(await H.hostNames(page())).toEqual(['lab-box'])
  })

  it('importing the same file again marks the host as already there and leaves it unticked', async () => {
    await H.goTo(page(), 'Hosts')
    await openImport('ssh-config')
    await page().waitForSelector('[data-testid=import-summary]')
    expect(await page().locator('[data-testid=import-item-lab-box] [data-testid=import-duplicate]').count()).toBe(1)
    expect(await page().isChecked('input[aria-label="Nhập lab-box"]')).toBe(false)
    expect(await page().isChecked('input[aria-label="Nhập second"]')).toBe(true)
    await page().click('[data-testid=import-panel] button:has-text("Back")')
    await page().waitForSelector('button:has-text("New host")')
  })
})

describe('a jump host, ForkLift, and bad files', () => {
  it('imports an ssh config with a bastion, wiring the jump host', async () => {
    await writeFile(file(), 'Host bastion\n HostName 127.0.0.1\n User jump\nHost inner\n HostName 10.1.1.1\n User app\n ProxyJump bastion\n')
    await page().click('button:has-text("Import…")')
    await page().click('[data-testid=import-source-ssh-config] button:has-text("Choose file")')
    await page().waitForSelector('[data-testid=import-item-inner]')
    expect(await page().textContent('[data-testid=import-item-inner]')).toContain('qua bastion')
    await page().click('button:has-text("Import 2 hosts")')
    await page().waitForSelector('[data-testid=import-result]:has-text("Đã nhập 2 host")')
    await page().click('[data-testid=import-result] button:has-text("Done")')
    await page().waitForSelector('[data-testid="host-inner"]')
    expect(await page().textContent('[data-testid="host-inner"]')).toContain('via bastion')
  })

  it('reads ForkLift favorites: only SFTP entries come in, and the rest are listed with the reason', async () => {
    await writeFile(file(), JSON.stringify({ favorites: [{ name: 'fl-sftp', url: 'sftp://me@fl.example.com:2200/srv' }, { name: 'fl-ftp', url: 'ftp://f.example.com' }] }))
    await page().click('button:has-text("Import…")')
    await page().click('[data-testid=import-source-forklift] button:has-text("Choose file")')
    await page().waitForSelector('[data-testid=import-item-fl-sftp]')
    expect(await page().textContent('.warn-text')).toMatch(/Keychain/)
    await page().click('.issues summary')
    expect(await page().textContent('.issues')).toMatch(/FTP chưa được Mymius hỗ trợ/)
  })

  it('says plainly when a file is not in the expected format', async () => {
    await page().click('button:has-text("Back")')
    await writeFile(file(), 'this is not json')
    await page().click('button:has-text("Import…")')
    await page().click('[data-testid=import-source-forklift] button:has-text("Choose file")')
    await page().waitForSelector('[role=alert]:has-text("JSON")')
  })
})
