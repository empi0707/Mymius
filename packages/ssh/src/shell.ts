import type { ClientChannel } from 'ssh2'
import type { TerminalExit, TerminalSession } from '@mymius/core'

/** An interactive shell on an SSH channel, exposed as a TerminalSession. */
export class ShellSession implements TerminalSession {
  private dataListeners: ((d: Buffer) => void)[] = []
  private exitListeners: ((e: TerminalExit) => void)[] = []
  /** The shell prints its prompt immediately, usually before the UI has subscribed. Keep it. */
  private early: Buffer[] = []
  private exit: TerminalExit | undefined
  private closed = false

  constructor(private readonly channel: ClientChannel) {
    channel.on('data', (d: Buffer) => {
      if (this.dataListeners.length === 0) this.early.push(d)
      else for (const l of this.dataListeners) l(d)
    })
    channel.on('exit', (code: number | null, signal: string | null) => {
      this.exit = { ...(code !== null ? { code } : {}), ...(signal ? { signal } : {}) }
    })
    channel.on('error', (error: Error) => {
      this.exit = { ...this.exit, error }
    })
    channel.on('close', () => {
      this.closed = true
      const info = this.exit ?? {}
      for (const l of this.exitListeners) l(info)
    })
  }

  write(data: string | Uint8Array): void {
    if (!this.closed) this.channel.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.channel.setWindow(rows, cols, 0, 0)
  }

  pause(): void {
    this.channel.pause()
  }

  resume(): void {
    this.channel.resume()
  }

  onData(listener: (data: Buffer) => void): void {
    this.dataListeners.push(listener)
    if (this.early.length) {
      const pending = this.early
      this.early = []
      for (const chunk of pending) listener(chunk)
    }
  }

  onExit(listener: (info: TerminalExit) => void): void {
    if (this.closed) return listener(this.exit ?? {})
    this.exitListeners.push(listener)
  }

  close(): void {
    if (!this.closed) this.channel.close()
  }
}
