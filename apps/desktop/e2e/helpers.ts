import { resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import electronPath from 'electron'

export const appDir = resolve(__dirname, '..')

export async function launch(profileDir: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ['--no-sandbox', `--user-data-dir=${profileDir}`, appDir],
    // The Terminals tab opens a local shell by default; most tests start from the connection form instead.
    env: { ...process.env, NODE_ENV: 'production', MYMIUS_E2E_NO_LOCAL_TERMINAL: '1', ...env }
  })
  // Stand in for the user at the native dialogs, and for OS features that do not exist under Xvfb.
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as {
      __dialogs: { message: string; detail: string }[]
      __nextResponse?: number
      __opened: string[]
      __trashed: string[]
      __external: string[]
    }
    g.__external = []
    // The system browser: record the URL, then do what a signed-in user's browser would (follow the redirect
    // back to the app's loopback listener).
    shell.openExternal = (async (url: string) => {
      g.__external.push(url)
      void fetch(url, { redirect: 'follow' }).catch(() => undefined)
    }) as never
    g.__dialogs = []
    g.__opened = []
    g.__trashed = []
    // Default answer 1 = "Trust and connect" / "Overwrite". Tests set __nextResponse for other choices.
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = args[args.length - 1] as { message: string; detail: string }
      g.__dialogs.push({ message: opts.message, detail: opts.detail })
      return { response: g.__nextResponse ?? 1, checkboxChecked: false }
    }) as never
    shell.openPath = (async (p: string) => { g.__opened.push(p); return '' }) as never
    shell.trashItem = (async (p: string) => {
      g.__trashed.push(p)
      ;(process as unknown as { mainModule: NodeJS.Module }).mainModule.require('node:fs').rmSync(p, { recursive: true, force: true })
    }) as never
  })
  return { app, page: await app.firstWindow() }
}

export const dialogs = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __dialogs: { message: string; detail: string }[] }).__dialogs)

/** Make the native "choose a file" dialog answer with this path. */
export const answerFilePicker = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never
  }, path)

/** Text currently in the xterm buffer of a tab (scrollback included). */
export const screen = (page: Page, key: string) =>
  page.evaluate((k) => {
    type Term = { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } }
    const t = (window as unknown as { __mymiusTerminals?: Record<string, Term> }).__mymiusTerminals?.[k]
    if (!t) return ''
    const b = t.buffer.active
    return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n')
  }, key)

export const dims = (page: Page, key: string) =>
  page.evaluate((k) => {
    const t = (window as unknown as { __mymiusTerminals: Record<string, { cols: number; rows: number }> }).__mymiusTerminals[k]!
    return { cols: t.cols, rows: t.rows }
  }, key)

export async function waitForText(page: Page, key: string, text: string | RegExp, timeout = 15_000): Promise<string> {
  const deadline = Date.now() + timeout
  let last = ''
  while (Date.now() < deadline) {
    last = await screen(page, key)
    if (typeof text === 'string' ? last.includes(text) : text.test(last)) return last
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${text}\n--- screen ---\n${last.slice(-600)}`)
}

export async function run(page: Page, key: string, cmd: string): Promise<void> {
  await page.waitForFunction((k) => document.querySelector(`[data-testid="${k}"]`)?.contains(document.activeElement), key)
  await page.keyboard.type(cmd)
  await page.keyboard.press('Enter')
}

export const goTo = (page: Page, section: 'Hosts' | 'Terminals' | 'Files' | 'Settings') => page.click(`nav >> text=${section}`)

export const setNextDialogAnswer = (app: ElectronApplication, n: number | undefined) =>
  app.evaluate((_e, v) => { (globalThis as unknown as { __nextResponse?: number }).__nextResponse = v }, n)

export const openedByApp = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

export const trashedByApp = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __trashed: string[] }).__trashed)

/** Set up a fresh vault through the UI and leave it unlocked on the Hosts page. */
export async function createVault(page: Page, passphrase: string): Promise<void> {
  await page.waitForSelector('h2:has-text("Create your vault")')
  await page.fill('.section:not([hidden]) input[name=passphrase]', passphrase)
  await page.fill('.section:not([hidden]) input[name=passphrase2]', passphrase)
  await page.click('button:has-text("Create vault")')
  await page.check('input[name=saved]')
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('text=Chưa có host nào được lưu')
}

export async function addPasswordHost(page: Page, opts: { name: string; port: number; username: string; password: string }): Promise<void> {
  await page.click('button:has-text("New host")')
  const f = (n: string) => `.section:not([hidden]) input[name=${n}]`
  await page.fill(f('name'), opts.name)
  await page.fill(f('host'), '127.0.0.1')
  await page.fill(f('port'), String(opts.port))
  await page.fill(f('username'), opts.username)
  await page.fill(f('password'), opts.password)
  await page.click('button[type=submit]:has-text("Save")')
  await page.waitForSelector(`[data-testid="host-${opts.name}"]`)
}

export const externalUrls = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __external: string[] }).__external)

/** Names shown in the host list, in order. */
export const hostNames = (page: Page) =>
  page.locator('[data-testid^="host-"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice(5)))
