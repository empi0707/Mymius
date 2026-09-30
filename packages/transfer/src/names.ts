import type { FileSystemProvider } from '@mymius/core'

/** "report.pdf" -> "report (2).pdf", first free name in `dir`. */
export async function freeName(provider: FileSystemProvider, dir: string, name: string): Promise<string> {
  const p = provider.path
  const ext = p.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!(await provider.stat(p.join(dir, candidate)))) return candidate
  }
  throw new Error(`Không tìm được tên còn trống cho ${name}`)
}

/** Names that would be unsafe to create on one of the systems the file may end up on. */
export function validateName(name: string): string | null {
  if (!name || name.trim() === '') return 'Hãy nhập tên'
  if (name === '.' || name === '..') return 'Tên đó không được phép'
  if (name.length > 255) return 'Tên quá dài'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f/\\]/.test(name)) return 'Tên không được chứa dấu gạch chéo hoặc ký tự điều khiển'
  return null
}
