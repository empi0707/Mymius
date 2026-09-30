import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import * as H from './helpers'

/** Importing hosts from Termius (CSV), ForkLift and ~/.ssh/config, through the real screens. */
const PASS = 'correct horse battery'
const SERVER_PASSWORD = 'pw-import-only-on-server'
let tmp: string
let server: TestServer
let launched: Awaited<ReturnType<typeof H.launch>>
const file = () => join(tmp, 'import-source.txt')

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-import-'))
  server = await startSshTestServer(tmp, { password: SERVER_PASSWORD })
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

describe('Termius CSV', () => {
  it('previews what is in the file, with skipped rows explained, and no password shown', async () => {
    await H.createVault(page(), PASS)
    await writeFile(file(), [
      'Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password',
      `Lab,from-termius,,127.0.0.1,ssh,${server.port},tester,${SERVER_PASSWORD}`,
      ',second,,10.9.9.9,ssh,22,root,',
      ',a-telnet-box,,10.9.9.8,telnet,23,x,y'
    ].join('\n'))
    await openImport('termius-csv')
    await page().waitForSelector('[data-testid=import-summary]')
    expect(await page().textContent('[data-testid=import-summary]')).toMatch(/2.*host.*1.*bị bỏ qua/)
    expect(await page().textContent('.import-list')).toContain('from-termius')
    expect(await page().textContent('.import-list')).not.toContain(SERVER_PASSWORD)
    await page().click('.issues summary')
    expect(await page().textContent('.issues')).toMatch(/telnet/)
    expect(await page().textContent('.warn-text')).toMatch(/xóa file/)
    await page().screenshot({ path: process.env.E2E_SHOT_IMPORT ?? join(tmp, 'import.png') })
  })

  it('imports only what is ticked, and the imported password really signs in', async () => {
    await page().uncheck('input[aria-label="Nhập second"]')
    await page().click('button:has-text("Import 1 hosts")')
    await page().waitForSelector('[data-testid=import-result]')
    expect(await page().textContent('[data-testid=import-result]')).toContain('Đã nhập 1 host')
    await page().click('[data-testid=import-result] button:has-text("Done")')
    await page().waitForSelector('[data-testid="host-from-termius"]')
    expect(await H.hostNames(page())).toEqual(['from-termius'])
    await page().waitForSelector('h3:has-text("Lab")')
    await page().click('button[aria-label="Connect to from-termius"]')
    await H.waitForText(page(), 't1', 'welcome tester')
  })

  it('importing the same file again marks the host as already there and leaves it unticked', async () => {
    await H.goTo(page(), 'Hosts')
    await openImport('termius-csv')
    await page().waitForSelector('[data-testid=import-summary]')
    expect(await page().locator('[data-testid=import-item-from-termius] [data-testid=import-duplicate]').count()).toBe(1)
    expect(await page().isChecked('input[aria-label="Nhập from-termius"]')).toBe(false)
    expect(await page().isChecked('input[aria-label="Nhập second"]')).toBe(true)
    await page().click('[data-testid=import-panel] button:has-text("Back")')
    await page().waitForSelector('button:has-text("New host")')
  })
})

describe('ssh config and ForkLift', () => {
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
    await writeFile(file(), 'this is not csv with a host column')
    await page().click('button:has-text("Import…")')
    await page().click('[data-testid=import-source-termius-csv] button:has-text("Choose file")')
    await page().waitForSelector('[role=alert]:has-text("Hostname/IP")')
  })
})
