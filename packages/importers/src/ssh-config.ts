import { ImportFormatError, MAX_IMPORT_HOSTS, checkSize, validHostname, validPort, type ImportedHost, type ParseOptions, type ParseResult } from './types'

interface Block {
  patterns: string[]
  /** Keyword (lower case) to value, first occurrence only, as ssh reads a file. */
  opts: Map<string, string>
  isMatch: boolean
}

function tokenize(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2]!)
  return out
}

/** ssh's pattern language: * and ?, and a leading ! negates. */
function globToRegExp(p: string): RegExp {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}

function matches(patterns: string[], alias: string): boolean {
  let hit = false
  for (const p of patterns) {
    if (p.startsWith('!')) { if (globToRegExp(p.slice(1)).test(alias)) return false }
    else if (globToRegExp(p).test(alias)) hit = true
  }
  return hit
}

/**
 * `~/.ssh/config`: every concrete `Host` alias becomes a host. Settings are resolved the way ssh does it (the
 * first value found, in file order, across all blocks whose patterns match), so `Host *` defaults apply.
 * `Match` blocks, `Include`, `ProxyCommand` and token expansion (%h) are not followed; what is left out is reported.
 */
export function parseSshConfig(text: string, opts: ParseOptions = {}): ParseResult {
  checkSize(text)
  const blocks: Block[] = [{ patterns: ['*'], opts: new Map(), isMatch: false }] // options before any Host line apply to all
  const result: ParseResult = { source: 'ssh-config', hosts: [], skipped: [], warnings: [] }
  const aliases: string[] = []
  let ignoredMatch = false
  let includes = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!.replace(/\s+#.*$/, '').trim()
    if (key === 'host') {
      const patterns = tokenize(value)
      blocks.push({ patterns, opts: new Map(), isMatch: false })
      for (const p of patterns) if (!/[*?!]/.test(p) && !aliases.includes(p)) aliases.push(p)
    } else if (key === 'match') {
      blocks.push({ patterns: [], opts: new Map(), isMatch: true }); ignoredMatch = true
    } else if (key === 'include') {
      includes = true
    } else {
      const b = blocks[blocks.length - 1]!
      if (!b.opts.has(key)) b.opts.set(key, tokenize(value)[0] ?? '')
    }
  }
  if (aliases.length > MAX_IMPORT_HOSTS) throw new ImportFormatError(`File có quá nhiều host (tối đa ${MAX_IMPORT_HOSTS}).`)
  if (ignoredMatch) result.warnings.push('Các khối "Match" không được xử lý.')
  if (includes) result.warnings.push('Các dòng "Include" không được theo dõi: hãy nhập từng file được include riêng.')

  const resolve = (alias: string, key: string): string | undefined => {
    for (const b of blocks) if (!b.isMatch && matches(b.patterns, alias) && b.opts.has(key)) return b.opts.get(key)
    return undefined
  }

  for (const alias of aliases) {
    const hostName = resolve(alias, 'hostname') ?? alias
    if (hostName.includes('%')) { result.skipped.push({ label: alias, reason: 'HostName dùng ký hiệu %… mà Mymius không mở rộng' }); continue }
    if (!validHostname(hostName)) { result.skipped.push({ label: alias, reason: `Hostname không hợp lệ: ${hostName.slice(0, 60)}` }); continue }
    const portRaw = resolve(alias, 'port')
    const port = portRaw === undefined ? 22 : validPort(portRaw)
    if (port === undefined) { result.skipped.push({ label: alias, reason: `Port không hợp lệ: ${portRaw?.slice(0, 20)}` }); continue }
    const assumed: string[] = []
    let username = resolve(alias, 'user') ?? ''
    if (!username) {
      if (!opts.defaultUser) { result.skipped.push({ label: alias, reason: 'Thiếu username' }); continue }
      username = opts.defaultUser; assumed.push('username')
    }
    const notes: string[] = []
    const identity = resolve(alias, 'identityfile')
    let jump: string | undefined
    const proxyJump = resolve(alias, 'proxyjump')
    if (proxyJump && proxyJump.toLowerCase() !== 'none') {
      const hops = proxyJump.split(',').map((h) => h.trim()).filter(Boolean)
      const last = hops[hops.length - 1]!
      // A bare name is looked up among the imported hosts and the vault's own; anything with user@ or :port cannot be.
      if (/^[A-Za-z0-9_.-]+$/.test(last)) jump = last
      else notes.push(`ProxyJump ${proxyJump} (không trỏ tới host nào trong file, cần thiết lập tay)`)
      if (hops.length > 1) notes.push(`ProxyJump có ${hops.length} chặng; chỉ chặng cuối được nối`)
    }
    if (resolve(alias, 'proxycommand')) notes.push('Host này dùng ProxyCommand, Mymius không hỗ trợ')
    result.hosts.push({
      name: alias.slice(0, 100), host: hostName, port, username,
      ...(identity && identity !== 'none' ? { keyPath: identity } : {}),
      ...(jump ? { jump } : {}),
      ...(notes.length ? { notes: notes.join('\n') } : {}),
      assumed
    })
  }
  return result
}
