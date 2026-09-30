import { resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import electronPath from 'electron'

export const appDir = resolve(__dirname, '..')

export async function launch(profileDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ['--no-sandbox', `--user-data-dir=${profileDir}`, appDir],
    env: { ...process.env, NODE_ENV: 'production' }
  })
  // Stand in for the user clicking "Trust and connect", and record what they would have seen.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dialogs: { message: string; detail: string }[] }
    g.__dialogs = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = args[args.length - 1] as { message: string; detail: string }
      g.__dialogs.push({ message: opts.message, detail: opts.detail })
      return { response: 1, checkboxChecked: false }
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

export const goTo = (page: Page, section: 'Hosts' | 'Terminals') => page.click(`nav >> text=${section}`)
