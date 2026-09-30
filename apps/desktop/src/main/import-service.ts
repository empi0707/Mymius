import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ImportFormatError, MAX_IMPORT_BYTES, parseImport, type ImportedHost, type ImportSource } from '@mymius/importers'
import type { HostInput, ImportOutcome, ImportPreview, ImportSourceId, Result } from '../shared/ipc'
import type { VaultService } from './vault-service'

export interface ImportHost {
  /** Ask which file to read. Undefined when the person cancels. */
  pick(source: ImportSourceId): Promise<string | undefined>
  /** The local account name, for hosts whose file does not name a user. */
  defaultUser: string
  /** How long a previewed file stays available before it must be chosen again. */
  keepMs?: number
}

const SOURCES: readonly ImportSourceId[] = ['ssh-config', 'forklift']
const addressKey = (host: string, port: number, user: string): string => `${host.toLowerCase()}|${port}|${user}`

interface Pending {
  hosts: ImportedHost[]
  timer: NodeJS.Timeout
}

/**
 * Reads a host list exported from another app and adds the chosen hosts to the vault. The file is read and
 * parsed here, in the main process, and kept in memory only until the import is confirmed or abandoned.
 */
export class ImportService {
  private pending = new Map<string, Pending>()

  constructor(private readonly vault: VaultService, private readonly host: ImportHost) {
    vault.store.on('state', (s: string) => { if (s !== 'unlocked') this.clear() })
  }

  private clear(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
  }

  async preview(source: unknown): Promise<Result<{ preview: ImportPreview }>> {
    if (typeof source !== 'string' || !SOURCES.includes(source as ImportSourceId)) return { ok: false, error: 'Nguồn nhập không hợp lệ' }
    const listing = this.vault.listHosts()
    if (!listing.ok) return { ok: false, error: listing.error }
    const file = await this.host.pick(source as ImportSourceId)
    if (!file) return { ok: false, error: '' }
    try {
      const st = await stat(file)
      if (!st.isFile()) return { ok: false, error: 'Đây không phải là một file.' }
      if (st.size > MAX_IMPORT_BYTES) return { ok: false, error: 'File quá lớn để là file danh sách host.' }
      const parsed = parseImport(source as ImportSource, await readFile(file, 'utf8'), { defaultUser: this.host.defaultUser })

      const existing = new Set(listing.hosts.map((h) => addressKey(h.host, h.port, h.username)))
      this.clear()
      const token = randomUUID()
      const timer = setTimeout(() => this.pending.delete(token), this.host.keepMs ?? 10 * 60_000)
      timer.unref?.()
      this.pending.set(token, { hosts: parsed.hosts, timer })
      return {
        ok: true,
        preview: {
          token, source: source as ImportSourceId, fileName: path.basename(file),
          items: parsed.hosts.map((h, i) => ({
            id: String(i), name: h.name, host: h.host, port: h.port, username: h.username,
            ...(h.group ? { group: h.group } : {}),
            auth: h.keyPath ? 'keyFile' : 'agent',
            ...(h.jump ? { jump: h.jump } : {}),
            duplicate: existing.has(addressKey(h.host, h.port, h.username)),
            assumed: h.assumed
          })),
          skipped: parsed.skipped,
          warnings: parsed.warnings
        }
      }
    } catch (err) {
      if (err instanceof ImportFormatError) return { ok: false, error: err.message }
      const code = (err as NodeJS.ErrnoException).code
      return { ok: false, error: code === 'ENOENT' ? 'Không tìm thấy file.' : code === 'EACCES' || code === 'EPERM' ? 'Ứng dụng không được phép đọc file đó.' : err instanceof Error ? err.message : String(err) }
    }
  }

  cancel(token: unknown): void {
    if (typeof token !== 'string') return
    const p = this.pending.get(token)
    if (p) { clearTimeout(p.timer); this.pending.delete(token) }
  }

  async commit(token: unknown, ids: unknown): Promise<Result<{ outcome: ImportOutcome }>> {
    if (typeof token !== 'string' || !Array.isArray(ids)) return { ok: false, error: 'Yêu cầu không hợp lệ' }
    const p = this.pending.get(token)
    if (!p) return { ok: false, error: 'Bản xem trước đã hết hạn. Hãy chọn lại file.' }
    const chosen = [...new Set(ids.filter((x): x is string => typeof x === 'string'))]
      .map((id) => ({ id, host: /^\d+$/.test(id) ? p.hosts[Number(id)] : undefined }))
      .filter((c): c is { id: string; host: ImportedHost } => c.host !== undefined)
    this.cancel(token) // one confirmation per preview

    const outcome: ImportOutcome = { created: 0, failed: [] }
    const created = new Map<string, string>() // name -> id, for connecting jump hosts
    const inputs = new Map<string, HostInput>()
    for (const { host: h } of chosen) {
      const input: HostInput = {
        name: h.name, host: h.host, port: h.port, username: h.username,
        auth: h.keyPath ? { type: 'keyFile', path: h.keyPath } : { type: 'agent' },
        ...(h.group ? { group: h.group } : {}),
        ...(h.notes ? { notes: h.notes } : {})
      }
      const r = await this.vault.saveHost(undefined, input)
      if (r.ok) { outcome.created++; created.set(h.name, r.id); inputs.set(h.name, input) }
      else outcome.failed.push({ name: h.name, error: r.error })
    }

    // Second pass: connect jump hosts, now that every id exists. A target may already be in the vault.
    const listing = this.vault.listHosts()
    const known = new Map(listing.ok ? listing.hosts.map((x) => [x.name, x.id] as const) : [])
    for (const { host: h } of chosen) {
      if (!h.jump || !created.has(h.name)) continue
      const target = created.get(h.jump) ?? known.get(h.jump)
      if (!target) { outcome.failed.push({ name: h.name, error: `Đã thêm, nhưng không tìm thấy jump host "${h.jump}" để nối.` }); continue }
      const base = inputs.get(h.name)!
      const r = await this.vault.saveHost(created.get(h.name), { ...base, jumpHostId: target })
      if (!r.ok) outcome.failed.push({ name: h.name, error: `Đã thêm, nhưng không nối được jump host: ${r.error}` })
    }
    return { ok: true, outcome }
  }
}
