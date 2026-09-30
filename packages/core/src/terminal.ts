export interface TerminalExit {
  /** Exit status of the remote shell, when it reported one. */
  code?: number
  signal?: string
  /** Set when the session ended because the connection failed, not because the shell exited. */
  error?: Error
}

/**
 * A running interactive terminal, whatever is behind it (SSH shell, local PTY, serial port).
 * The UI only ever talks to this interface.
 */
export interface TerminalSession {
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  /** Stop delivering output (back-pressure: the remote side slows down instead of us buffering). */
  pause(): void
  resume(): void
  /** Output arrives here. Output produced before the first listener is added is not lost. */
  onData(listener: (data: Buffer) => void): void
  onExit(listener: (info: TerminalExit) => void): void
  close(): void
}
