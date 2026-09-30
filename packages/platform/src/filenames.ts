import type { OS } from './paths'

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Turn a name that came from a server into something safe to create locally on any OS:
 * no path separators, no control chars, no Windows-illegal characters or reserved device names.
 */
export function sanitizeFileName(name: string, maxLength = 180): string {
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '')
  if (out === '' || out === '.' || out === '..') out = 'file'
  if (WIN_RESERVED.test(out)) out = `_${out}`
  if (out.length > maxLength) {
    const dot = out.lastIndexOf('.')
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : ''
    out = out.slice(0, maxLength - ext.length) + ext
  }
  return out
}

const RISKY: Record<OS, Set<string>> = {
  darwin: new Set(['.app', '.command', '.terminal', '.workflow', '.pkg', '.dmg', '.action', '.tool', '.scpt', '.jar']),
  win32: new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.lnk', '.scr', '.reg', '.jar', '.hta']),
  linux: new Set(['.sh', '.desktop', '.run', '.appimage', '.bin', '.jar'])
}

/**
 * Opening these with the OS default handler may execute them. Ask before doing so
 * (or open with a text editor explicitly instead).
 */
export function isRiskyToOpen(fileName: string, os: OS = process.platform as OS): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return false
  return RISKY[os].has(fileName.slice(dot).toLowerCase())
}
