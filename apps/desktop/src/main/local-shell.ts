import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { TerminalExit, TerminalSession } from '@mymius/core'

export interface ShellCommand {
  file: string
  args: string[]
}

/**
 * Which shell a local terminal runs, the way each system's own terminal app picks it: the user's login
 * shell on macOS (started as a login shell, like Terminal.app) and Linux, PowerShell on Windows.
 */
export function shellCommand(platform: NodeJS.Platform, env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): ShellCommand {
  if (platform === 'win32') return { file: 'powershell.exe', args: [] }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const candidates = [env.SHELL, fallback, '/bin/sh']
  const file = candidates.find((c): c is string => Boolean(c) && exists(c as string)) ?? '/bin/sh'
  return { file, args: platform === 'darwin' ? ['-l'] : [] }
}

/** A shell on this computer, behind a pseudo-terminal, shaped like an SSH shell so tabs treat both alike. */
export class LocalShellSession implements TerminalSession {
  private readonly dataListeners: ((d: Buffer) => void)[] = []
  private readonly exitListeners: ((e: TerminalExit) => void)[] = []
  /** The prompt is printed before anyone listens; keep it. */
  private early: Buffer[] = []
  private exit: TerminalExit | undefined
  private closed = false

  private constructor(private readonly proc: pty.IPty) {
    proc.onData((d) => {
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d as string)
      if (this.dataListeners.length === 0) this.early.push(chunk)
      else for (const l of this.dataListeners) l(chunk)
    })
    proc.onExit((e) => {
      this.closed = true
      this.exit = { code: e.exitCode, ...(e.signal ? { signal: String(e.signal) } : {}) }
      for (const l of this.exitListeners) l(this.exit)
    })
  }

  static spawn(cols: number, rows: number): LocalShellSession {
    const { file, args } = shellCommand(process.platform, process.env)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env.ELECTRON_RUN_AS_NODE
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Mymius'
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: homedir(), env, encoding: null })
    return new LocalShellSession(proc)
  }

  write(data: string | Uint8Array): void {
    if (!this.closed) this.proc.write(typeof data === 'string' ? data : Buffer.from(data))
  }
  resize(cols: number, rows: number): void {
    if (!this.closed) this.proc.resize(cols, rows)
  }
  pause(): void {
    if (!this.closed) this.proc.pause()
  }
  resume(): void {
    if (!this.closed) this.proc.resume()
  }
  onData(listener: (data: Buffer) => void): void {
    this.dataListeners.push(listener)
    const pending = this.early
    this.early = []
    for (const chunk of pending) listener(chunk)
  }
  onExit(listener: (info: TerminalExit) => void): void {
    if (this.closed && this.exit) return listener(this.exit)
    this.exitListeners.push(listener)
  }
  close(): void {
    if (!this.closed) this.proc.kill()
  }
}
