import { describe, expect, it } from 'vitest'
import { parseHistory } from '../src/history'

const file = (path: string, body: string): string => `@@FILE ${path}\n${body}`

describe('parseHistory', () => {
  it('reads bash history newest first, once per command', () => {
    const r = parseHistory(file('/h/.bash_history', 'ls\ncd /var/log\nls\ndf -h\n'))
    expect(r.map((e) => e.command)).toEqual(['df -h', 'ls', 'cd /var/log'])
  })

  it('uses bash timestamp comments when HISTTIMEFORMAT is set', () => {
    const r = parseHistory(file('/h/.bash_history', '#1700000000\nuptime\n#1700000100\nfree -m\n'))
    expect(r).toEqual([{ command: 'free -m', at: 1700000100 }, { command: 'uptime', at: 1700000000 }])
  })

  it('reads zsh extended history including multi-line commands', () => {
    const r = parseHistory(file('/h/.zsh_history', ': 1700000000:0;echo a\n: 1700000050:0;for i in 1 2; do \\\necho $i\\\ndone\n'))
    expect(r[0]).toEqual({ command: 'for i in 1 2; do \necho $i\ndone', at: 1700000050 })
    expect(r[1]).toEqual({ command: 'echo a', at: 1700000000 })
  })

  it('reads fish history and unescapes newlines', () => {
    const r = parseHistory(file('/h/.local/share/fish/fish_history', '- cmd: ls -la\n  when: 1700000000\n- cmd: echo a\\nb\n  when: 1700000010\n'))
    expect(r).toEqual([{ command: 'echo a\nb', at: 1700000010 }, { command: 'ls -la', at: 1700000000 }])
  })

  it('merges several files by time when all have times, ignores blanks and CRs', () => {
    const text = file('/h/.bash_history', '#1700000200\nlate\r\n\n#1700000001\nearly\n') + file('/h/.zsh_history', ': 1700000100:0;middle\n')
    expect(parseHistory(text).map((e) => e.command)).toEqual(['late', 'middle', 'early'])
  })

  it('caps the list and very long commands; empty output gives an empty list', () => {
    const many = Array.from({ length: 50 }, (_, i) => `cmd${i}`).join('\n')
    expect(parseHistory(file('/h/.bash_history', many), 10)).toHaveLength(10)
    expect(parseHistory(file('/h/.bash_history', 'x'.repeat(5000)))[0]!.command).toHaveLength(1000)
    expect(parseHistory('')).toEqual([])
  })
})
