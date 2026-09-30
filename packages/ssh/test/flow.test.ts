import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowControl, OutputBatcher } from '../src'

describe('OutputBatcher', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('merges chunks that arrive within the interval into one flush', () => {
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d.toString()), { intervalMs: 8 })
    b.push(Buffer.from('a')); b.push(Buffer.from('b')); b.push(Buffer.from('c'))
    expect(out).toEqual([])
    vi.advanceTimersByTime(8)
    expect(out).toEqual(['abc'])
  })

  it('flushes immediately when the size cap is reached', () => {
    const out: number[] = []
    const b = new OutputBatcher((d) => out.push(d.length), { maxBytes: 10, intervalMs: 1000 })
    b.push(Buffer.alloc(6)); b.push(Buffer.alloc(6))
    expect(out).toEqual([12])
  })

  it('never delivers bytes out of order or drops any', () => {
    const out: Buffer[] = []
    const b = new OutputBatcher((d) => out.push(d), { intervalMs: 5, maxBytes: 4 })
    const input = Buffer.from('the quick brown fox jumps over the lazy dog')
    for (const byte of input) b.push(Buffer.from([byte]))
    b.dispose()
    expect(Buffer.concat(out).equals(input)).toBe(true)
  })

  it('dispose flushes what is pending and nothing fires afterwards', () => {
    const out: string[] = []
    const b = new OutputBatcher((d) => out.push(d.toString()))
    b.push(Buffer.from('tail'))
    b.dispose()
    vi.advanceTimersByTime(100)
    expect(out).toEqual(['tail'])
  })
})

describe('FlowControl', () => {
  const setup = (high = 100, low = 40) => {
    const calls: string[] = []
    const fc = new FlowControl({ pause: () => calls.push('pause'), resume: () => calls.push('resume') }, high, low)
    return { fc, calls }
  }

  it('pauses above the high-water mark, once', () => {
    const { fc, calls } = setup()
    fc.sent(60); fc.sent(60); fc.sent(60)
    expect(calls).toEqual(['pause'])
    expect(fc.isPaused).toBe(true)
  })

  it('resumes only once acknowledgements bring it down to the low-water mark (hysteresis)', () => {
    const { fc, calls } = setup()
    fc.sent(150)
    fc.acked(60) // 90 outstanding: still above low
    expect(calls).toEqual(['pause'])
    fc.acked(50) // 40: at low
    expect(calls).toEqual(['pause', 'resume'])
  })

  it('can pause again after a resume', () => {
    const { fc, calls } = setup()
    fc.sent(150); fc.acked(150); fc.sent(150)
    expect(calls).toEqual(['pause', 'resume', 'pause'])
  })

  it('over-acknowledging cannot make the counter negative', () => {
    const { fc, calls } = setup()
    fc.acked(999)
    fc.sent(101)
    expect(calls).toEqual(['pause'])
  })
})
