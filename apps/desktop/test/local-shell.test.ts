import { describe, expect, it, vi } from 'vitest'
import { shellCommand } from '../src/main/local-shell'

const all = () => true

describe('which shell a local terminal runs', () => {
  it('Linux: the user\'s shell, interactive', () => {
    expect(shellCommand('linux', { SHELL: '/usr/bin/fish' }, all)).toEqual({ file: '/usr/bin/fish', args: [] })
  })

  it('macOS: the user\'s shell as a login shell, like Terminal.app', () => {
    expect(shellCommand('darwin', { SHELL: '/bin/zsh' }, all)).toEqual({ file: '/bin/zsh', args: ['-l'] })
  })

  it('falls back when SHELL is unset or points at nothing', () => {
    expect(shellCommand('linux', {}, all).file).toBe('/bin/bash')
    expect(shellCommand('darwin', { SHELL: '/gone' }, (p) => p === '/bin/zsh').file).toBe('/bin/zsh')
    expect(shellCommand('linux', { SHELL: '/gone' }, (p) => p === '/bin/sh').file).toBe('/bin/sh')
    expect(shellCommand('linux', {}, () => false).file).toBe('/bin/sh')
  })

  it('Windows: PowerShell', () => {
    expect(shellCommand('win32', { SHELL: '/bin/bash' }, all)).toEqual({ file: 'powershell.exe', args: [] })
  })
})

describe('when node-pty cannot be loaded', () => {
  it('fails the one terminal with advice, instead of crashing the app', async () => {
    vi.resetModules()
    vi.doMock('node-pty', () => { throw new Error("Cannot find module 'node-pty'") })
    const { LocalShellSession } = await import('../src/main/local-shell')
    await expect(LocalShellSession.spawn(80, 24)).rejects.toThrow(/pnpm install/)
    vi.doUnmock('node-pty')
  })
})
