import { ImportFormatError, MAX_IMPORT_HOSTS, checkSize, validHostname, validPort, type ImportedHost, type ParseOptions, type ParseResult } from './types'

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of Object.keys(o)) if (keys.includes(k.toLowerCase()) && typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim()
  return undefined
}
const num = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of Object.keys(o)) if (keys.includes(k.toLowerCase()) && (typeof o[k] === 'number' || typeof o[k] === 'string')) return o[k]
  return undefined
}

const SSH_SCHEMES = new Set(['sftp', 'ssh'])
const NAMES: Record<string, string> = { ftp: 'FTP', ftps: 'FTPS', http: 'WebDAV', https: 'WebDAV', dav: 'WebDAV', davs: 'WebDAV', s3: 'Amazon S3', smb: 'SMB', afp: 'AFP', nfs: 'NFS', webdav: 'WebDAV' }

/** Turns "SFTP", "sftp://", "ssh" etc. into a bare lower-case scheme. */
function schemeOf(v: string | undefined): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*)/i.exec((v ?? '').trim().replace(/:\/\/.*$/, ''))
  return m ? m[1]!.toLowerCase() : undefined
}

interface Candidate { obj: Record<string, unknown>; group: string | undefined }

/** Find every object that looks like a server entry, remembering the folder it sits in. */
function collect(node: unknown, group: string | undefined, out: Candidate[], depth = 0): void {
  if (depth > 20 || out.length > MAX_IMPORT_HOSTS * 4) return
  if (Array.isArray(node)) { for (const n of node) collect(n, group, out, depth + 1); return }
  if (!isObj(node)) return
  const hasServer = str(node, 'url', 'server', 'host', 'hostname', 'address') !== undefined
  if (hasServer) { out.push({ obj: node, group }); return }
  const folder = str(node, 'name', 'title', 'label') ?? group
  for (const v of Object.values(node)) collect(v, folder, out, depth + 1)
}

/**
 * ForkLift's favorites, read from `Favorites.json` (ForkLift 3: ~/Library/Application Support/ForkLift/Favorites/).
 * The exact layout of that file is not documented and this reader has NOT been checked against a real one: it
 * looks for entries with a server/URL, a protocol, a user and a port under the usual key names, so a differing
 * layout is reported as "nothing recognised" rather than guessed at. Only SFTP entries can be imported; others
 * are listed as skipped. ForkLift keeps passwords in the macOS Keychain, so none are ever present.
 * ForkLift 4 keeps favorites in a database that cannot be read here.
 */
export function parseForkLiftFavorites(text: string, opts: ParseOptions = {}): ParseResult {
  checkSize(text)
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new ImportFormatError('Đây không phải file JSON hợp lệ.') }
  const found: Candidate[] = []
  collect(json, undefined, found)
  const result: ParseResult = { source: 'forklift', hosts: [], skipped: [], warnings: [] }
  if (found.length === 0) throw new ImportFormatError('Không nhận ra mục yêu thích nào của ForkLift trong file. ForkLift 4 lưu danh sách trong database nên không đọc được; hãy dùng file Favorites.json của ForkLift 3 hoặc nhập qua ~/.ssh/config.')
  if (found.length > MAX_IMPORT_HOSTS) throw new ImportFormatError(`File có quá nhiều mục (tối đa ${MAX_IMPORT_HOSTS}).`)

  for (const { obj, group } of found) {
    const rawUrl = str(obj, 'url', 'server', 'host', 'hostname', 'address')!
    const name = str(obj, 'name', 'title', 'label', 'displayname')
    let scheme = schemeOf(str(obj, 'protocol', 'type', 'scheme', 'kind'))
    let host = rawUrl
    let port = num(obj, 'port')
    let user = str(obj, 'user', 'username', 'login', 'account')
    let urlPath: string | undefined
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) {
      try {
        const u = new URL(rawUrl)
        scheme = u.protocol.replace(':', '').toLowerCase()
        host = u.hostname
        if (u.port) port = u.port
        if (u.username && !user) user = decodeURIComponent(u.username)
        if (u.pathname && u.pathname !== '/') urlPath = decodeURIComponent(u.pathname)
      } catch {
        result.skipped.push({ label: name ?? rawUrl.slice(0, 60), reason: 'Địa chỉ không hợp lệ' }); continue
      }
    }
    const label = name ?? host
    if (!scheme) { result.skipped.push({ label, reason: 'Không rõ giao thức' }); continue }
    if (!SSH_SCHEMES.has(scheme)) { result.skipped.push({ label, reason: `${NAMES[scheme] ?? scheme.toUpperCase()} chưa được Mymius hỗ trợ (chỉ SFTP)` }); continue }
    if (!validHostname(host)) { result.skipped.push({ label, reason: `Hostname không hợp lệ: ${host.slice(0, 60)}` }); continue }
    const p = port === undefined || port === '' ? 22 : validPort(port)
    if (p === undefined) { result.skipped.push({ label, reason: 'Port không hợp lệ' }); continue }
    const assumed: string[] = []
    if (!user) {
      if (!opts.defaultUser) { result.skipped.push({ label, reason: 'Thiếu username' }); continue }
      user = opts.defaultUser; assumed.push('username')
    }
    const path = str(obj, 'path', 'remotepath', 'initialpath', 'directory') ?? urlPath
    result.hosts.push({
      name: label.slice(0, 100), host, port: p, username: user,
      ...(group ? { group: group.slice(0, 100) } : {}),
      ...(path ? { notes: `Thư mục ban đầu trong ForkLift: ${path}` } : {}),
      assumed
    })
  }
  result.warnings.push('ForkLift lưu mật khẩu trong Keychain của macOS nên không nhập được: hãy thêm mật khẩu hoặc khóa cho từng host sau khi nhập.')
  return result
}
