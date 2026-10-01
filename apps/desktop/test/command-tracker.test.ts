import { describe, expect, it } from 'vitest'
import { CommandTracker } from '../src/renderer/src/terminal/command-tracker'

const type = (t: CommandTracker, s: string): void => {
  for (const ch of s) t.feed(ch)
}

describe('CommandTracker', () => {
  it('reports a plainly typed command on Enter', () => {
    const t = new CommandTracker()
    type(t, 'ls -la')
    expect(t.feed('\r')).toBe('ls -la')
  })

  it('follows Backspace and ignores empty lines', () => {
    const t = new CommandTracker()
    type(t, 'lss')
    t.feed('\x7f')
    expect(t.feed('\r')).toBe('ls')
    expect(t.feed('\r')).toBeNull()
  })

  it('skips a line that was completed with Tab, recalled with arrows, or cleared', () => {
    const t = new CommandTracker()
    type(t, 'cd /va'); t.feed('\t')
    expect(t.feed('\r')).toBeNull()
    t.feed('\x1b[A')
    expect(t.feed('\r')).toBeNull()
    type(t, 'secret'); t.feed('\x03')
    expect(t.feed('\r')).toBeNull()
    type(t, 'pwd')
    expect(t.feed('\r')).toBe('pwd') // the next line is tracked normally again
  })

  it('accepts a pasted single line but not a paste containing newlines', () => {
    const t = new CommandTracker()
    t.feed('git status')
    expect(t.feed('\r')).toBe('git status')
    t.feed('a\nb')
    expect(t.feed('\r')).toBeNull()
  })
})
