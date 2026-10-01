import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import type { OS, TerminalTarget } from '../../../shared/ipc'
import { THEME_EVENT, isDark } from '../theme'
import { CommandTracker } from './command-tracker'
import { router } from './session'

export type TabStatus = 'connecting' | 'open' | 'closed' | 'error'

interface Props {
  request: TerminalTarget
  os: OS
  /** Changes when the user asks to reconnect: mounts a fresh session. */
  attempt: number
  active: boolean
  onStatus(status: TabStatus, message?: string): void
  /** The id of the running session (null when it ends), so the page can read that server's history. */
  onSession(id: string | null): void
  /** A command the person typed and the terminal echoed (never a password). */
  onCommand(command: string): void
  testId: string
}

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace"

const LIGHT = { background: '#ffffff', foreground: '#1c1c1e', cursor: '#1c1c1e', selectionBackground: '#b4d5fe' }
const DARK = { background: '#1e1e20', foreground: '#f2f2f4', cursor: '#f2f2f4', selectionBackground: '#3f5f8f' }

export function TerminalView({ request, os, attempt, active, onStatus, onSession, onCommand, testId }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: isDark() ? DARK : LIGHT
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
    term.open(el)
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose()) // falls back to the DOM renderer
      term.loadAddon(gl)
    } catch {
      /* no WebGL: the default renderer is fine */
    }
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    if (import.meta.env.MODE === 'e2e') {
      const w = window as unknown as { __mymiusTerminals?: Record<string, Terminal> }
      ;(w.__mymiusTerminals ??= {})[testId] = term
    }

    const onTheme = (): void => { term.options.theme = isDark() ? DARK : LIGHT }
    dark.addEventListener('change', onTheme)
    window.addEventListener(THEME_EVENT, onTheme)

    // Copy/paste that does not fight the terminal: Ctrl+C is SIGINT unless something is selected.
    const mac = os === 'darwin'
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || mac) return true
      const key = e.key.toLowerCase()
      if (e.ctrlKey && key === 'c' && (e.shiftKey || term.hasSelection())) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      if (e.ctrlKey && e.shiftKey && key === 'v') {
        void navigator.clipboard.readText().then((t) => term.paste(t))
        return false
      }
      return true
    })

    let disposed = false
    let sessionId: string | null = null
    let unregister: (() => void) | undefined
    const api = window.mymius.terminal
    onStatus('connecting')

    void api.open({ ...request, cols: term.cols, rows: term.rows }).then((res) => {
      if (disposed) {
        if (res.ok) api.close(res.id)
        return
      }
      if (!res.ok) {
        term.write(`\r\n\x1b[31m${res.error}\x1b[0m\r\n`)
        return onStatus('error', res.error)
      }
      const id = res.id
      sessionId = id
      onSession(id)
      unregister = router.register(id, {
        onData: (data) => term.write(data, () => api.ack(id, data.length)),
        onExit: (e) => {
          const why = e.error ? `Mất kết nối: ${e.error}` : 'Phiên đã đóng'
          term.write(`\r\n\x1b[2m[${why}]\x1b[0m\r\n`)
          sessionId = null
          onSession(null)
          onStatus(e.error ? 'error' : 'closed', why)
        }
      })
      // The size may have changed while connecting.
      api.resize(id, term.cols, term.rows)
      onStatus('open')
      term.focus()
    })

    // The text on buffer row `y`, joined with the rows the terminal wrapped it over.
    const rowText = (y: number): string => {
      const b = term.buffer.active
      let text = b.getLine(y)?.translateToString(false) ?? ''
      while (y > 0 && b.getLine(y)?.isWrapped) text = (b.getLine(--y)?.translateToString(false) ?? '') + text
      return text.trimEnd()
    }
    const tracker = new CommandTracker()
    const input = term.onData((d) => {
      if (!sessionId) return
      // Typing inside vim/less/htop is not a command line.
      if (term.buffer.active.type === 'normal') {
        const cmd = tracker.feed(d)
        if (cmd) {
          // The echo may still be on its way over the network: look at the row again a moment later.
          const b = term.buffer.active
          const y = b.baseY + b.cursorY
          setTimeout(() => { if (!disposed && rowText(y).endsWith(cmd)) onCommand(cmd) }, 300)
        }
      }
      api.write(sessionId, d)
    })
    const size = term.onResize(({ cols, rows }) => { if (sessionId) api.resize(sessionId, cols, rows) })

    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (el.offsetParent !== null) fit.fit() // a hidden tab has no size to fit
      })
    })
    observer.observe(el)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      dark.removeEventListener('change', onTheme)
      window.removeEventListener(THEME_EVENT, onTheme)
      input.dispose()
      size.dispose()
      unregister?.()
      if (sessionId) { api.close(sessionId); onSession(null) }
      if (import.meta.env.MODE === 'e2e') delete (window as unknown as { __mymiusTerminals: Record<string, Terminal> }).__mymiusTerminals[testId]
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // A new `attempt` deliberately rebuilds the terminal; nothing else may.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  // Coming back to a tab: fit to whatever size the pane has now, and give it the keyboard.
  useEffect(() => {
    if (!active) return
    // The pane was just un-hidden in this same commit, so it already has a size: no need to wait a frame
    // (keystrokes typed right after switching tabs would otherwise go nowhere).
    fitRef.current?.fit()
    termRef.current?.focus()
  }, [active])

  return <div ref={host} className="term-host" data-testid={testId} />
}
