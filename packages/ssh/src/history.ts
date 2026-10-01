export interface HistoryEntry {
  command: string
  /** Unix seconds, when the shell recorded one (bash with HISTTIMEFORMAT, zsh extended history, fish). */
  at?: number
}

const MAX_COMMAND_CHARS = 1000

/**
 * Shell script (for `sh -c`) that prints the tail of the usual history files, each after an
 * `@@FILE <path>` line. Only reads; unreadable or missing files are skipped.
 */
export const HISTORY_SCRIPT = [
  'for f in "$HOME/.bash_history" "$HOME/.zsh_history" "${XDG_DATA_HOME:-$HOME/.local/share}/fish/fish_history"; do',
  '  if [ -r "$f" ]; then echo "@@FILE $f"; tail -n 1500 "$f" 2>/dev/null; fi',
  'done'
].join('\n')

function parseBash(lines: string[]): HistoryEntry[] {
  const out: HistoryEntry[] = []
  let at: number | undefined
  for (const line of lines) {
    const ts = /^#(\d{9,11})$/.exec(line)
    if (ts) { at = Number(ts[1]); continue }
    if (line.trim()) out.push({ command: line, ...(at !== undefined ? { at } : {}) })
    at = undefined
  }
  return out
}

function parseZsh(lines: string[]): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    let at: number | undefined
    const ext = /^: (\d+):\d+;(.*)$/s.exec(line)
    if (ext) { at = Number(ext[1]); line = ext[2]! }
    // A command that spans lines is stored with a trailing backslash on all but the last.
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + '\n' + lines[++i]!
    if (line.trim()) out.push({ command: line, ...(at !== undefined ? { at } : {}) })
  }
  return out
}

function parseFish(lines: string[]): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const line of lines) {
    const cmd = /^- cmd: (.*)$/.exec(line)
    if (cmd) {
      const command = cmd[1]!.replace(/\\(n|\\)/g, (_m, c: string) => (c === 'n' ? '\n' : '\\'))
      if (command.trim()) out.push({ command })
      continue
    }
    const when = /^ {2}when: (\d+)$/.exec(line)
    if (when && out.length > 0) out[out.length - 1]!.at = Number(when[1])
  }
  return out
}

/** Merge the output of HISTORY_SCRIPT into one list: newest first, each command once. */
export function parseHistory(text: string, limit = 300): HistoryEntry[] {
  const all: HistoryEntry[] = []
  const parts = text.replace(/\r/g, '').split(/^@@FILE (.*)$/m)
  // split() with a capture group: [before, path1, body1, path2, body2, ...]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const path = parts[i]!
    const lines = parts[i + 1]!.split('\n')
    const entries = path.endsWith('.zsh_history') ? parseZsh(lines) : path.endsWith('fish_history') ? parseFish(lines) : parseBash(lines)
    all.push(...entries)
  }
  if (all.length > 0 && all.every((e) => e.at !== undefined)) all.sort((a, b) => a.at! - b.at!)
  const seen = new Set<string>()
  const out: HistoryEntry[] = []
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const e = all[i]!
    const command = e.command.length > MAX_COMMAND_CHARS ? e.command.slice(0, MAX_COMMAND_CHARS) : e.command
    if (seen.has(command)) continue
    seen.add(command)
    out.push({ command, ...(e.at !== undefined ? { at: e.at } : {}) })
  }
  return out
}
