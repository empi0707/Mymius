import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decide, extensionKey, launchWith, parseOpenOptions } from '../src/main/open-with'

let dir: string | undefined
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined })

const app = (path: string) => ({ kind: 'app' as const, path, name: 'Editor' })

describe('extensionKey', () => {
  it('is the lower-case extension; dotfiles and bare names have none', () => {
    expect(extensionKey('Index.HTML')).toBe('.html')
    expect(extensionKey('archive.tar.gz')).toBe('.gz')
    expect(extensionKey('.bashrc')).toBe('(no extension)')
    expect(extensionKey('Makefile')).toBe('(no extension)')
    expect(extensionKey('trailing.')).toBe('(no extension)')
  })
})

describe('decide', () => {
  const prefs = { '.html': app('/a'), '*': app('/all'), '.png': { kind: 'system' as const } }
  it('open: the extension first, then every file, else ask', () => {
    expect(decide(prefs, 'x.html', 'open')).toEqual({ use: app('/a') })
    expect(decide(prefs, 'x.txt', 'open')).toEqual({ use: app('/all') })
    expect(decide({}, 'x.txt', 'open')).toEqual({ ask: true })
  })
  it('edit skips a "system default" choice; open with always asks', () => {
    expect(decide(prefs, 'x.png', 'open')).toEqual({ use: { kind: 'system' } })
    expect(decide(prefs, 'x.png', 'edit')).toEqual({ use: app('/all') })
    expect(decide({ '.png': { kind: 'system' } }, 'x.png', 'edit')).toEqual({ ask: true })
    expect(decide(prefs, 'x.html', 'with')).toEqual({ ask: true })
  })
})

describe('parseOpenOptions', () => {
  it('accepts plain data and refuses anything else', () => {
    expect(parseOpenOptions({ mode: 'open' })).toEqual({ mode: 'open', remember: 'none' })
    expect(() => parseOpenOptions({ mode: 'x' })).toThrow()
    expect(() => parseOpenOptions({ mode: 'open', app: { kind: 'app', path: 'rel' } })).toThrow(/không hợp lệ/)
    expect(() => parseOpenOptions({ mode: 'edit', app: { kind: 'system' } })).toThrow(/cụ thể/)
  })
})

describe.skipIf(process.platform === 'win32')('launchWith', () => {
  it('starts the program with the file as its argument, without a shell', async () => {
    dir = await mkdtemp(join(tmpdir(), 'launch-'))
    const out = join(dir, 'out.txt')
    const script = join(dir, 'editor.sh')
    await writeFile(script, `#!/bin/sh\nprintf '%s' "$1" > "${out}"\n`)
    await chmod(script, 0o755)
    const file = join(dir, 'a file; touch pwned.html')
    await launchWith(app(script), file, 'linux')
    for (let i = 0; i < 100 && !(await readFile(out, 'utf8').catch(() => '')); i++) await new Promise((r) => setTimeout(r, 30))
    expect(await readFile(out, 'utf8')).toBe(file)
  })

  it('says so when the program is gone', async () => {
    await expect(launchWith(app('/no/such/editor'), '/tmp/x', 'linux')).rejects.toThrow(/Không tìm thấy ứng dụng Editor/)
  })
})
