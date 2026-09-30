import { ImportFormatError, MAX_IMPORT_HOSTS, checkSize, validHostname, validPort, type ImportedHost, type ParseOptions, type ParseResult } from './types'

/** RFC 4180 CSV: quoted fields, doubled quotes, embedded commas and newlines, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += c
  }
  if (quoted) throw new ImportFormatError('File CSV bị lỗi: có dấu ngoặc kép chưa được đóng.')
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
const COLUMNS: Record<string, string> = {
  groups: 'group', group: 'group', label: 'name', name: 'name', tags: 'tags', tag: 'tags',
  hostnameip: 'host', hostname: 'host', host: 'host', ip: 'host', address: 'host',
  protocol: 'protocol', port: 'port', username: 'user', user: 'user', login: 'user', password: 'password'
}

/**
 * The CSV that Termius reads on import (Groups, Label, Tags, Hostname/IP, Protocol, Port, Username, Password),
 * which is also what the community tools that liberate hosts from Termius write. Columns are found by name,
 * so their order and case do not matter. Termius itself has no export button; see docs/IMPORT.md.
 */
export function parseTermiusCsv(text: string, opts: ParseOptions = {}): ParseResult {
  checkSize(text)
  const rows = parseCsv(text)
  if (rows.length === 0) throw new ImportFormatError('File CSV trống.')
  const header = rows[0]!.map((h) => COLUMNS[norm(h)])
  if (!header.includes('host')) throw new ImportFormatError('Không thấy cột Hostname/IP. Hãy dùng file CSV theo mẫu của Termius (Groups, Label, Tags, Hostname/IP, Protocol, Port, Username, Password).')
  if (rows.length - 1 > MAX_IMPORT_HOSTS) throw new ImportFormatError(`File có quá nhiều dòng (tối đa ${MAX_IMPORT_HOSTS}).`)

  const result: ParseResult = { source: 'termius-csv', hosts: [], skipped: [], warnings: [] }
  for (let n = 1; n < rows.length; n++) {
    const cell = (col: string): string => (rows[n]![header.indexOf(col)] ?? '').trim()
    const host = cell('host')
    const label = cell('name') || host || `dòng ${n + 1}`
    if (!host) { result.skipped.push({ label, reason: 'Thiếu Hostname/IP' }); continue }
    if (!validHostname(host)) { result.skipped.push({ label, reason: `Hostname không hợp lệ: ${host.slice(0, 60)}` }); continue }
    const protocol = cell('protocol').toLowerCase()
    if (protocol && protocol !== 'ssh') { result.skipped.push({ label, reason: `Giao thức ${protocol} chưa được hỗ trợ (chỉ SSH)` }); continue }
    const rawPort = cell('port')
    const port = rawPort === '' ? 22 : validPort(rawPort)
    if (port === undefined) { result.skipped.push({ label, reason: `Port không hợp lệ: ${rawPort.slice(0, 20)}` }); continue }
    const assumed: string[] = []
    let username = cell('user')
    if (!username) {
      if (!opts.defaultUser) { result.skipped.push({ label, reason: 'Thiếu username' }); continue }
      username = opts.defaultUser; assumed.push('username')
    }
    const tags = cell('tags')
    const password = rows[n]![header.indexOf('password')] ?? ''
    result.hosts.push({
      name: label.slice(0, 100), host, port, username,
      ...(cell('group') ? { group: cell('group').slice(0, 100) } : {}),
      ...(password ? { password } : {}),
      ...(tags ? { notes: `Tags: ${tags}` } : {}),
      assumed
    })
  }
  if (result.hosts.some((h) => h.password)) result.warnings.push('File này chứa mật khẩu dạng văn bản thường. Sau khi nhập xong hãy xóa file khỏi máy.')
  return result
}
