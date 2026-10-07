/**
 * The two-pane file manager in the real app: browse, select, copy/move by keyboard and drag and drop,
 * conflicts, delete, folder sync between the panes, and editing a remote file with auto-upload.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSshTestServer, type TestServer } from '@mymius/ssh/testing'
import * as H from './helpers'

const PASS = 'correct horse battery staple'
const T0 = 1_700_000_000
let tmp: string
let home: string
let remote: string
let server: TestServer
let app: ElectronApplication
let page: Page

const pane = (i: 0 | 1) => page.locator(`[data-testid=pane-${i}]`)
const row = (i: 0 | 1, name: string): Locator => pane(i).locator(`[role=option][data-name="${name}"]`)
const names = async (i: 0 | 1): Promise<string[]> => pane(i).locator('[role=option]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name ?? ''))
const selected = (i: 0 | 1) => pane(i).locator('[role=option][aria-selected=true]').count()
const write = async (root: string, rel: string, content: string, mtime = T0) => {
  const p = join(root, ...rel.split('/'))
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, content)
  await utimes(p, mtime, mtime)
}
const jobDone = (kind: string) => page.locator(`[data-testid=job-${kind}].done, [data-testid=job-${kind}].cancelled, [data-testid=job-${kind}].failed`).first()
const waitJob = async (kind: string) => { await jobDone(kind).waitFor({ timeout: 20_000 }); return (await jobDone(kind).textContent()) ?? '' }
const dismissJobs = async () => { for (const b of await page.locator('[data-testid^=job-] button:has-text("Dismiss")').all()) await b.click() }
const key = (k: string) => page.keyboard.press(k)

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mymius-e2e-files-'))
  home = join(tmp, 'home')
  remote = join(tmp, 'remote')
  await mkdir(home); await mkdir(remote)
  await write(home, 'photo.jpg', 'JPEGDATA')
  await write(home, 'notes.md', '# notes')
  await write(home, 'docs/a.txt', 'aaa')
  await write(home, 'projects/x/readme.txt', 'x')
  await write(home, '.secret', 'hidden')
  await write(home, 'big.bin', 'b'.repeat(2000))
  await write(remote, 'app.conf', 'listen 80;\n')
  await write(remote, 'srv/keep.txt', 'k')
  server = await startSshTestServer(remote, { password: 'pw-files' })
  ;({ app, page } = await H.launch(join(tmp, 'profile'), { HOME: home, USERPROFILE: home }))
  await H.createVault(page, PASS)
  await H.addPasswordHost(page, { name: 'box', port: server.port, username: 'tester', password: 'pw-files' })
  await H.goTo(page, 'Files')
  await page.waitForSelector('[data-testid=pane-0] [role=option]')
})

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await server?.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('browsing the local disk', () => {
  it('starts with both panes in the home folder, folders first, hidden files hidden', async () => {
    expect(await names(0)).toEqual(['docs', 'projects', 'big.bin', 'notes.md', 'photo.jpg'])
    expect(await names(1)).toEqual(await names(0))
    await pane(0).locator('input[type=checkbox]').check()
    expect(await names(0)).toContain('.secret')
    await pane(0).locator('input[type=checkbox]').uncheck()
  })

  it('sorts by clicking a column header, keeping folders on top', async () => {
    await pane(0).locator('[role=columnheader]:has-text("Size")').click()
    expect(await names(0)).toEqual(['docs', 'projects', 'notes.md', 'photo.jpg', 'big.bin']) // ascending by size
    await pane(0).locator('[role=columnheader]:has-text("Size")').click()
    expect((await names(0)).slice(0, 3)).toEqual(['docs', 'projects', 'big.bin']) // descending; folders still first, in name order
    await pane(0).locator('[role=columnheader]:has-text("Name")').click()
    expect(await names(0)).toEqual(['docs', 'projects', 'big.bin', 'notes.md', 'photo.jpg'])
  })

  it('opens folders by double-click and goes up with Backspace; the breadcrumb and address bar work', async () => {
    await row(0, 'projects').dblclick()
    await expect.poll(() => names(0)).toEqual(['x'])
    await row(0, 'x').dblclick()
    await expect.poll(() => names(0)).toEqual(['readme.txt'])
    await key('Backspace')
    await expect.poll(() => names(0)).toEqual(['x'])
    await pane(0).locator('.crumb').first().click() // the root crumb
    await expect.poll(async () => (await names(0)).length).toBeGreaterThan(0)
    await pane(0).locator('.crumbs').dblclick()
    await page.fill('[data-testid=pane-0] input[aria-label=Path]', join(home, 'docs'))
    await key('Enter')
    await expect.poll(() => names(0)).toEqual(['a.txt'])
    await pane(0).locator('button[aria-label="Parent folder"]').click()
    await expect.poll(() => names(0)).toContain('photo.jpg')
  })

  it('a missing folder is reported in the pane instead of breaking it', async () => {
    await pane(0).locator('.crumbs').dblclick()
    await page.fill('[data-testid=pane-0] input[aria-label=Path]', join(home, 'nope'))
    await key('Enter')
    await pane(0).locator('[role=alert]:has-text("Không tìm thấy thư mục")').waitFor()
    await pane(0).locator('select').selectOption({ label: 'Home' })
    await expect.poll(() => names(0)).toContain('photo.jpg')
  })
})

describe('selecting', () => {
  it('click, shift-click for a range, ctrl/cmd-click to toggle, and select all', async () => {
    await row(0, 'docs').click()
    expect(await selected(0)).toBe(1)
    await row(0, 'notes.md').click({ modifiers: ['Shift'] })
    expect(await selected(0)).toBe(4) // docs..notes.md
    await row(0, 'projects').click({ modifiers: ['ControlOrMeta'] })
    expect(await selected(0)).toBe(3)
    await row(0, 'docs').click()
    await key('ControlOrMeta+a')
    expect(await selected(0)).toBe(5)
    await row(0, 'docs').click()
  })

  it('arrow keys move the selection and Shift extends it', async () => {
    await row(0, 'docs').click()
    await key('ArrowDown')
    expect(await row(0, 'projects').getAttribute('aria-selected')).toBe('true')
    await key('Shift+ArrowDown')
    expect(await selected(0)).toBe(2)
    await key('Home')
    expect(await row(0, 'docs').getAttribute('aria-selected')).toBe('true')
    expect(await selected(0)).toBe(1)
  })
})

describe('working with a server', () => {
  it('shows a saved host as a source, asks to trust it once, and lists its files', async () => {
    await pane(1).locator('select').selectOption({ label: 'box' })
    await expect.poll(() => names(1)).toEqual(['srv', 'app.conf'])
    expect((await H.dialogs(app)).length).toBe(1)
    expect(await pane(1).locator('.crumb').first().textContent()).toBe('/')
  })

  it('F5 copies the selection to the other pane, with progress and a summary', async () => {
    await row(0, 'photo.jpg').click()
    await key('F5')
    expect(await waitJob('copy')).toContain('1 file đã chép')
    await expect.poll(() => names(1)).toContain('photo.jpg')
    expect(await readFile(join(remote, 'photo.jpg'), 'utf8')).toBe('JPEGDATA')
    await dismissJobs()
  })

  it('copying something that exists asks what to do; "Keep both" leaves both', async () => {
    await row(0, 'photo.jpg').click()
    await key('F5')
    await page.waitForSelector('[role=dialog]:has-text("đã tồn tại")')
    await page.click('[role=dialog] button:has-text("Keep both")')
    await waitJob('copy')
    await expect.poll(() => names(1)).toEqual(expect.arrayContaining(['photo.jpg', 'photo (2).jpg']))
    expect(await readFile(join(remote, 'photo (2).jpg'), 'utf8')).toBe('JPEGDATA')
    await dismissJobs()
  })

  it('cancelling the conflict dialog copies nothing', async () => {
    await row(0, 'photo.jpg').click()
    await key('F5')
    await page.click('[role=dialog] button:has-text("Cancel")')
    await page.waitForTimeout(400)
    expect((await readdir(remote)).filter((n) => n.startsWith('photo'))).toEqual(['photo (2).jpg', 'photo.jpg'])
    expect(await page.locator('[data-testid^=job-]').count()).toBe(0)
  })

  it('folders are copied whole, and dragging between the panes copies too', async () => {
    await row(0, 'docs').dragTo(pane(1).locator('.rows'))
    await waitJob('copy')
    await expect.poll(() => names(1)).toContain('docs')
    expect(await readFile(join(remote, 'docs/a.txt'), 'utf8')).toBe('aaa')
    await dismissJobs()
  })

  it('dropping onto a folder puts the files inside it', async () => {
    await row(0, 'notes.md').dragTo(row(1, 'srv'))
    await waitJob('copy')
    expect(await readFile(join(remote, 'srv/notes.md'), 'utf8')).toBe('# notes')
    await dismissJobs()
  })

  it('F6 moves: the original disappears from the source pane', async () => {
    await write(home, 'to-move.txt', 'move me')
    await pane(0).locator('button[aria-label=Refresh]').click()
    await row(0, 'to-move.txt').click()
    await key('F6')
    await waitJob('move')
    await expect.poll(() => names(1)).toContain('to-move.txt')
    await expect.poll(() => names(0)).not.toContain('to-move.txt')
    await expect(stat(join(home, 'to-move.txt'))).rejects.toThrow()
    await dismissJobs()
  })
})

describe('creating, renaming and deleting', () => {
  it('F7 makes a folder in the active pane, F2 renames it', async () => {
    await row(1, 'srv').click()
    await key('F7')
    await page.fill('[role=dialog] input[aria-label=Name]', 'made-here')
    await key('Enter')
    await expect.poll(() => names(1)).toContain('made-here')
    expect((await stat(join(remote, 'made-here'))).isDirectory()).toBe(true)

    await row(1, 'made-here').click()
    await key('F2')
    await page.fill('[role=dialog] input[aria-label=Name]', 'renamed-dir')
    await key('Enter')
    await expect.poll(() => names(1)).toContain('renamed-dir')
    await expect.poll(() => names(1)).not.toContain('made-here')
  })

  it('a bad name is refused with a reason and nothing changes', async () => {
    await row(1, 'renamed-dir').click()
    await key('F2')
    await page.fill('[role=dialog] input[aria-label=Name]', 'a/b')
    await key('Enter')
    await page.waitForSelector('[role=alert]:has-text("gạch chéo")')
    expect(await names(1)).toContain('renamed-dir')
  })

  it('deleting on a server says it is permanent, and is', async () => {
    await row(1, 'renamed-dir').click()
    await key('F8')
    await page.waitForSelector('[role=dialog]:has-text("không lấy lại được")')
    await page.click('[role=dialog] button:has-text("Delete permanently")')
    await waitJob('delete')
    await expect.poll(() => names(1)).not.toContain('renamed-dir')
    await expect(stat(join(remote, 'renamed-dir'))).rejects.toThrow()
    await dismissJobs()
  })

  it('deleting on this computer moves things to the trash and says so; "Keep" does nothing', async () => {
    await write(home, 'junk.txt', 'junk')
    await pane(0).locator('button[aria-label=Refresh]').click()
    await row(0, 'junk.txt').click()
    await key('Delete')
    await page.click('[role=dialog] button:has-text("Keep")')
    expect(await names(0)).toContain('junk.txt')
    await key('Delete')
    await page.waitForSelector('[role=dialog]:has-text("khôi phục")')
    await page.click('[role=dialog] button:has-text("Move to trash")')
    await waitJob('delete')
    await expect.poll(() => names(0)).not.toContain('junk.txt')
    expect(await H.trashedByApp(app)).toEqual([join(home, 'junk.txt')])
    await dismissJobs()
  })
})

describe('folder sync between the panes', () => {
  it('compares two folders, lets the user flip an arrow, and syncs', async () => {
    await write(home, 'sync-a/index.html', 'NEW PAGE', T0 + 9000)
    await write(home, 'sync-a/style.css', 'css')
    await write(home, 'sync-a/img/logo.png', 'png')
    await write(remote, 'sync-b/index.html', 'OLD PAGE', T0)
    await write(remote, 'sync-b/stale.txt', 'stale')
    for (const i of [0, 1] as const) await pane(i).locator('button[aria-label=Refresh]').click()
    await row(0, 'sync-a').dblclick()
    await expect.poll(() => names(0)).toContain('style.css')
    await pane(1).locator('.crumbs').dblclick()
    await page.fill('[data-testid=pane-1] input[aria-label=Path]', '/sync-b')
    await key('Enter')
    await expect.poll(() => names(1)).toEqual(['index.html', 'stale.txt'])

    await page.click('button:has-text("Sync folders")')
    await page.waitForSelector('[role=dialog]:has-text("Sync folders")')
    await page.click('[role=dialog] button:has-text("Compare")')
    await page.waitForSelector('[data-testid=sync-row]')
    const rowsText = await page.locator('[data-testid=sync-row] .name').allTextContents()
    expect(rowsText.map((t) => t.replace('📁 ', '')).sort()).toEqual(['img', 'img/logo.png', 'index.html', 'stale.txt', 'style.css'])
    await expect.poll(() => page.locator('[data-testid=sync-summary]').textContent()).toContain('3 cần chép')

    // Mirror to the right, removing extras: stale.txt is marked for removal.
    await page.check('[role=dialog] input[name=deleteExtras]')
    const stale = page.locator('[data-rel="stale.txt"] .arrow')
    await expect.poll(() => stale.textContent()).toBe('✕')
    // The user changes their mind about it: click cycles ltr -> rtl (copy it to the left) instead.
    await stale.click()
    await expect.poll(() => stale.textContent()).toBe('←')
    await expect.poll(() => page.locator('[data-testid=sync-summary]').textContent()).toContain('4 cần chép')
    await page.screenshot({ path: process.env.E2E_SHOT_SYNC ?? join(tmp, 'sync.png') })

    await page.click('[role=dialog] button:has-text("Sync now")')
    await page.locator('[data-testid=sync-result]:has-text("Xong")').waitFor({ timeout: 20_000 })
    expect(await readFile(join(remote, 'sync-b/index.html'), 'utf8')).toBe('NEW PAGE')
    expect(await readFile(join(remote, 'sync-b/img/logo.png'), 'utf8')).toBe('png')
    expect(await readFile(join(home, 'sync-a/stale.txt'), 'utf8')).toBe('stale') // went the way the user chose
    await page.click('[role=dialog] button:has-text("Close")')
    await dismissJobs()
  })

  it('afterwards the two folders compare as identical', async () => {
    await page.click('button:has-text("Sync folders")')
    await page.click('[role=dialog] button:has-text("Compare")')
    await page.locator('[data-testid=sync-summary]:has-text("Không có gì cần làm")').waitFor()
    expect(await page.locator('[data-testid=sync-row]').count()).toBe(0) // identical items are hidden by default
    await page.click('[role=dialog] button:has-text("Cancel")')
  })

  it('refuses to sync a folder with itself', async () => {
    await pane(1).locator('select').selectOption({ label: 'Home' })
    await pane(0).locator('.crumbs').dblclick()
    await page.fill('[data-testid=pane-0] input[aria-label=Path]', home)
    await key('Enter')
    await expect.poll(() => names(0)).toContain('photo.jpg')
    await page.click('button:has-text("Sync folders")')
    await page.click('[role=dialog] button:has-text("Compare")')
    await page.waitForSelector('[role=alert]:has-text("trùng nhau")')
    await page.click('[role=dialog] button:has-text("Cancel")')
  })
})

describe('editing a remote file', () => {
  const remoteConf = () => join(remote, 'app.conf')
  const waitRemote = async (content: string) => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      if ((await readFile(remoteConf(), 'utf8').catch(() => '')) === content) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`app.conf never became ${JSON.stringify(content)}; it is ${JSON.stringify(await readFile(remoteConf(), 'utf8'))}`)
  }
  let local = ''

  it('double-clicking a server file opens it in the editor and shows it as being edited', async () => {
    await pane(1).locator('select').selectOption({ label: 'box' })
    // The connection was kept and the pane is back in the folder it was left in: go to the root, where app.conf is.
    await pane(1).locator('.crumb').first().click()
    await expect.poll(() => names(1)).toContain('app.conf')
    await row(1, 'app.conf').dblclick()
    // Nothing is saved yet for this kind of file, so the app asks which program to use: take the system default, for every file.
    await page.click('[role=dialog] label:has-text("Ứng dụng mặc định của hệ thống")')
    await page.click('[role=dialog] label:has-text("Luôn dùng cho mọi file")')
    await page.click('[role=dialog] button.primary')
    await page.locator('[data-testid="edit-app.conf"]').waitFor()
    await expect.poll(async () => (await H.openedByApp(app)).length).toBeGreaterThan(0)
    local = (await H.openedByApp(app)).at(-1)!
    expect(await readFile(local, 'utf8')).toBe('listen 80;\n')
    await expect.poll(() => page.locator('[data-testid="edit-app.conf"]').textContent()).toContain('đã lưu lên server')
  })

  it('saving in the editor uploads the file, with no further action', async () => {
    await writeFile(local, 'listen 8080;\n')
    await waitRemote('listen 8080;\n')
  })

  it('if the server copy changed meanwhile the user is asked; "Reload" brings the server version back', async () => {
    await write(remote, 'app.conf', 'changed by a colleague\n', T0 + 20_000)
    await H.setNextDialogAnswer(app, 2) // Reload from the server
    const before = (await H.dialogs(app)).length
    await writeFile(local, 'my edits\n')
    await expect.poll(async () => (await H.dialogs(app)).length).toBe(before + 1)
    const asked = (await H.dialogs(app)).at(-1)!
    expect(asked.message).toContain('/app.conf')
    expect(asked.detail).toContain('Reload')
    await expect.poll(() => readFile(local, 'utf8')).toBe('changed by a colleague\n')
    expect(await readFile(remoteConf(), 'utf8')).toBe('changed by a colleague\n')
    const aside = (await readdir(join(local, '..'))).find((n) => n.includes('.local-'))!
    expect(await readFile(join(local, '..', aside), 'utf8')).toBe('my edits\n') // the user's work was kept
  })

  it('"Cancel" uploads nothing and the activity bar warns that the file is NOT on the server', async () => {
    await write(remote, 'app.conf', 'server v3\n', T0 + 30_000)
    await H.setNextDialogAnswer(app, 0)
    await writeFile(local, 'local v3\n')
    await page.locator('[data-testid="edit-app.conf"] .badge.unsynced').waitFor({ timeout: 15_000 })
    await page.locator('[role=alert]:has-text("CHƯA")').waitFor()
    expect(await readFile(remoteConf(), 'utf8')).toBe('server v3\n')
    await page.screenshot({ path: process.env.E2E_SHOT_EDIT ?? join(tmp, 'edit.png') })
  })

  it('"Overwrite" replaces the server file with the local one', async () => {
    await H.setNextDialogAnswer(app, 1)
    await writeFile(local, 'local v4 wins\n')
    await waitRemote('local v4 wins\n')
    await H.setNextDialogAnswer(app, undefined)
  })

  it('"Done" ends the edit: everything was uploaded, so the working copy is removed and the server file is untouched', async () => {
    await page.locator('[data-testid="edit-app.conf"] button:has-text("Done")').click()
    await page.locator('[data-testid="edit-app.conf"]').waitFor({ state: 'detached' })
    await expect(stat(local)).rejects.toThrow() // nothing left behind in the cache
    expect(await readFile(remoteConf(), 'utf8')).toBe('local v4 wins\n')
  })
})

describe('layout', () => {
  it('captures both panes', async () => {
    await pane(1).locator('select').selectOption({ label: 'box' })
    await pane(1).locator('.crumb').first().click()
    await expect.poll(() => names(1)).toContain('srv')
    await row(0, 'photo.jpg').click()
    await page.screenshot({ path: process.env.E2E_SHOT_FILES ?? join(tmp, 'files.png') })
  })
})
