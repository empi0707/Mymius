import { randomUUID } from 'node:crypto'
import type { TerminalExit, TerminalSession } from '@mymius/core'
import { FlowControl, OutputBatcher } from './flow'

export interface HubOutput {
  data(id: string, data: Buffer): void
  /** Always comes after the last `data` of that session. */
  exit(id: string, info: TerminalExit): void
}

interface Entry {
  session: TerminalSession
  batcher: OutputBatcher
  flow: FlowControl
  onDispose: (() => void) | undefined
  done: boolean
}

export const MAX_INPUT_BYTES = 1024 * 1024
const MAX_DIMENSION = 1000

/**
 * Owns the live terminal sessions of the app and sits between them and the UI: coalesces output,
 * applies back-pressure from the UI's acknowledgements, and validates everything the UI sends
 * (the UI process is less trusted than this one).
 */
export class TerminalHub {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly out: HubOutput,
    private readonly opts: { maxSessions?: number; flushIntervalMs?: number } = {}
  ) {}

  get size(): number {
    return this.entries.size
  }

  /** Register a session and start forwarding its output. `onDispose` runs once when it is gone. */
  add(session: TerminalSession, onDispose?: () => void): string {
    if (this.entries.size >= (this.opts.maxSessions ?? 64)) {
      session.close()
      onDispose?.()
      throw new Error('Too many open terminals')
    }
    const id = randomUUID()
    const flow = new FlowControl({ pause: () => session.pause(), resume: () => session.resume() })
    const batcher = new OutputBatcher(
      (data) => {
        flow.sent(data.length)
        this.out.data(id, data)
      },
      { intervalMs: this.opts.flushIntervalMs ?? 8 }
    )
    const entry: Entry = { session, batcher, flow, onDispose, done: false }
    this.entries.set(id, entry)
    session.onData((d) => batcher.push(d))
    session.onExit((info) => {
      batcher.dispose() // deliver the tail before announcing the end
      this.finish(id, entry)
      this.out.exit(id, info)
    })
    return id
  }

  write(id: string, data: unknown): void {
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) return
    this.entries.get(id)?.session.write(data)
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    if (!isDimension(cols) || !isDimension(rows)) return
    this.entries.get(id)?.session.resize(cols, rows)
  }

  ack(id: string, bytes: unknown): void {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return
    this.entries.get(id)?.flow.acked(bytes)
  }

  close(id: string): void {
    this.entries.get(id)?.session.close()
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
  }

  private finish(id: string, entry: Entry): void {
    if (entry.done) return
    entry.done = true
    this.entries.delete(id)
    entry.onDispose?.()
  }
}

function isDimension(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION
}
