import { describe, expect, it } from 'vitest'
import { buildOpenCommand, getAppPaths, isRiskyToOpen, sanitizeFileName } from '../src'

describe('getAppPaths', () => {
  it('macOS', () => {
    expect(getAppPaths('Mymius', 'darwin', {}, '/Users/a')).toEqual({
      data: '/Users/a/Library/Application Support/Mymius',
      cache: '/Users/a/Library/Caches/Mymius',
      logs: '/Users/a/Library/Logs/Mymius'
    })
  })
  it('Windows honours APPDATA/LOCALAPPDATA', () => {
    const p = getAppPaths('Mymius', 'win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'D:\\L' }, 'C:\\Users\\a')
    expect(p.data).toBe('C:\\Users\\a\\AppData\\Roaming\\Mymius')
    expect(p.cache).toBe('D:\\L\\Mymius\\Cache')
  })
  it('Linux honours XDG_*', () => {
    expect(getAppPaths('Mymius', 'linux', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/a').data).toBe('/x/cfg/Mymius')
    expect(getAppPaths('Mymius', 'linux', {}, '/home/a').cache).toBe('/home/a/.cache/Mymius')
  })
})

describe('sanitizeFileName', () => {
  it.each([
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['a:b*c?.txt', 'a_b_c_.txt'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['trailing. ', 'trailing'],
    ['', 'file'],
    ['..', 'file']
  ])('%s -> %s', (input, expected) => expect(sanitizeFileName(input)).toBe(expected))

  it('never produces a path separator and keeps the extension when truncating', () => {
    const out = sanitizeFileName('x'.repeat(400) + '.conf')
    expect(out.length).toBeLessThanOrEqual(180)
    expect(out.endsWith('.conf')).toBe(true)
    expect(sanitizeFileName('a/b\\c')).not.toMatch(/[\\/]/)
  })
})

describe('isRiskyToOpen', () => {
  it('flags things that run code on the matching OS only', () => {
    expect(isRiskyToOpen('x.command', 'darwin')).toBe(true)
    expect(isRiskyToOpen('x.EXE', 'win32')).toBe(true)
    expect(isRiskyToOpen('x.sh', 'linux')).toBe(true)
    expect(isRiskyToOpen('notes.txt', 'darwin')).toBe(false)
    expect(isRiskyToOpen('Makefile', 'linux')).toBe(false)
  })
})

describe('buildOpenCommand', () => {
  it('per OS, without going through a shell string', () => {
    expect(buildOpenCommand({ file: '/t/a b.txt', os: 'darwin' })).toEqual({ command: 'open', args: ['/t/a b.txt'] })
    expect(buildOpenCommand({ file: '/t/a.txt', app: 'Sublime Text', os: 'darwin' })).toEqual({ command: 'open', args: ['-a', 'Sublime Text', '/t/a.txt'] })
    expect(buildOpenCommand({ file: 'C:\\t\\a.txt', os: 'win32' }).command).toBe('cmd.exe')
    expect(buildOpenCommand({ file: '/t/a.txt', os: 'linux' })).toEqual({ command: 'xdg-open', args: ['/t/a.txt'] })
  })
})
