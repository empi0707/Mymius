import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { buildOpenCommand } from '@mymius/platform'
import type { AppChoice, OpenAssociation, OpenMode, OpenOptions } from '../shared/ipc'

/** Which application opens which kind of file. Keys: a lower-case extension such as ".html", or "*" for every file. */
export type Prefs = Record<string, AppChoice>

export const ALL_FILES = '*'
const NO_EXTENSION = '(no extension)'

export function extensionKey(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot).toLowerCase() : NO_EXTENSION
}

export type Decision = { use: AppChoice } | { ask: true }

/**
 * What to do when someone opens a file. `open`: the application chosen for this extension, else the one for all
 * files, else ask. `edit` needs a real application (the system default is usually a viewer or a browser).
 * `with` always asks.
 */
export function decide(prefs: Prefs, fileName: string, mode: OpenMode): Decision {
  if (mode === 'with') return { ask: true }
  const candidates = [prefs[extensionKey(fileName)], prefs[ALL_FILES]]
  const found = candidates.find((c) => c !== undefined && (mode === 'open' || c.kind === 'app'))
  return found ? { use: found } : { ask: true }
}

/** Checks an application choice that came from the UI. */
export function parseAppChoice(v: unknown): AppChoice {
  const o = (v ?? {}) as Record<string, unknown>
  if (o.kind === 'system') return { kind: 'system' }
  if (o.kind === 'app' && typeof o.path === 'string' && o.path.length > 0 && o.path.length <= 4096 && isAbsolute(o.path) && !o.path.includes('\0')) {
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 200) : o.path
    return { kind: 'app', path: o.path, name }
  }
  throw new Error('Ứng dụng đã chọn không hợp lệ')
}

export function parseOpenOptions(v: unknown): OpenOptions {
  const o = (v ?? {}) as Record<string, unknown>
  if (o.mode !== 'open' && o.mode !== 'edit' && o.mode !== 'with') throw new Error('Cách mở không hợp lệ')
  const remember = o.remember === 'ext' || o.remember === 'all' ? o.remember : 'none'
  const app = o.app === undefined ? undefined : parseAppChoice(o.app)
  if (o.mode === 'edit' && app?.kind === 'system') throw new Error('Để sửa file, hãy chọn một ứng dụng cụ thể')
  return { mode: o.mode, remember, ...(app ? { app } : {}) }
}

export class OpenWithStore {
  private prefs: Prefs = {}

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>
      const next: Prefs = {}
      for (const [k, v] of Object.entries(raw)) {
        try { next[k] = parseAppChoice(v) } catch { /* skip an entry that no longer makes sense */ }
      }
      this.prefs = next
    } catch { /* first run, or unreadable: start empty */ }
  }

  get current(): Prefs { return this.prefs }

  decide(fileName: string, mode: OpenMode): Decision { return decide(this.prefs, fileName, mode) }

  async remember(fileName: string, how: 'none' | 'ext' | 'all', app: AppChoice): Promise<void> {
    if (how === 'none') return
    this.prefs = { ...this.prefs, [how === 'all' ? ALL_FILES : extensionKey(fileName)]: app }
    await this.save()
  }

  async remove(key: string): Promise<void> {
    if (!(key in this.prefs)) return
    const { [key]: _gone, ...rest } = this.prefs
    this.prefs = rest
    await this.save()
  }

  list(): OpenAssociation[] {
    return Object.entries(this.prefs)
      .map(([key, app]) => ({ key, label: key === ALL_FILES ? 'Mọi file' : key, app }))
      .sort((a, b) => (a.key === ALL_FILES ? -1 : b.key === ALL_FILES ? 1 : a.key.localeCompare(b.key)))
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.prefs, null, 2) + '\n')
    await rename(tmp, this.file)
  }
}

/** Start a chosen application on a file and leave it running on its own (never through a shell). */
export async function launchWith(app: Extract<AppChoice, { kind: 'app' }>, file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  await access(app.path).catch(() => { throw new Error(`Không tìm thấy ứng dụng ${app.name} (${app.path}). Hãy chọn lại ở menu Open with…`) })
  const { command, args } = buildOpenCommand({ file, app: app.path, os: platform as 'darwin' | 'win32' | 'linux' })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', (e) => reject(new Error(`Không mở được ${app.name}: ${e.message}`)))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
