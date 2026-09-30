import { useState } from 'react'
import type { ImportOutcome, ImportPreview, ImportSourceId } from '../../../shared/ipc'

const SOURCES: { id: ImportSourceId; title: string; how: string }[] = [
  {
    id: 'termius-csv', title: 'Termius (CSV)',
    how: 'Termius không có nút xuất dữ liệu. Hãy dùng file CSV theo mẫu nhập của Termius (Groups, Label, Tags, Hostname/IP, Protocol, Port, Username, Password) hoặc file do công cụ cộng đồng như termius-exporter tạo ra. Nếu file có mật khẩu, mật khẩu sẽ được mã hóa vào vault.'
  },
  {
    id: 'forklift', title: 'ForkLift (Favorites.json)',
    how: 'File nằm ở ~/Library/Application Support/ForkLift/Favorites/Favorites.json (ForkLift 3). Chỉ các mục SFTP được nhập; ForkLift lưu mật khẩu trong Keychain nên bạn sẽ phải thêm mật khẩu hoặc khóa sau đó. ForkLift 4 lưu trong database nên không đọc được.'
  },
  {
    id: 'ssh-config', title: 'OpenSSH (~/.ssh/config)',
    how: 'Nhập mọi Host trong file config, kể cả IdentityFile và ProxyJump. Đây cũng là cách gọn nhất để đưa host từ Termius sang, vì các công cụ cộng đồng có thể xuất Termius ra định dạng này.'
  }
]

const AUTH: Record<string, string> = { password: 'mật khẩu', keyFile: 'file khóa', agent: 'ssh-agent' }

export function ImportPanel({ onBack, onDone }: { onBack(): void; onDone(): Promise<void> }): React.JSX.Element {
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const choose = async (source: ImportSourceId): Promise<void> => {
    setError(''); setBusy(true)
    const r = await window.mymius.importer.preview(source)
    setBusy(false)
    if (!r.ok) { if (r.error) setError(r.error); return }
    setPreview(r.preview)
    setSelected(new Set(r.preview.items.filter((i) => !i.duplicate).map((i) => i.id)))
  }

  const toggle = (id: string): void => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const commit = async (): Promise<void> => {
    if (!preview) return
    setBusy(true); setError('')
    const r = await window.mymius.importer.commit(preview.token, [...selected])
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setOutcome(r.outcome); setPreview(null)
    await onDone()
  }

  const back = (): void => {
    if (preview) void window.mymius.importer.cancel(preview.token)
    onBack()
  }

  return (
    <div className="form wide" data-testid="import-panel">
      <div className="row"><h2 className="grow">Import hosts</h2><button className="secondary" onClick={back}>Back</button></div>

      {!preview && !outcome && (
        <>
          <p className="hint">Chọn nơi bạn muốn lấy danh sách host cũ. File được đọc ngay trên máy này; mật khẩu (nếu có) chỉ được lưu vào vault đã mã hóa.</p>
          {SOURCES.map((s) => (
            <div className="card" key={s.id} data-testid={`import-source-${s.id}`}>
              <div className="row"><strong className="grow">{s.title}</strong><button className="primary" disabled={busy} onClick={() => void choose(s.id)}>Choose file…</button></div>
              <p className="hint">{s.how}</p>
            </div>
          ))}
        </>
      )}

      {preview && (
        <>
          <p className="hint" data-testid="import-summary">
            Tìm thấy <strong>{preview.items.length}</strong> host trong <code>{preview.fileName}</code>
            {preview.skipped.length > 0 && <>, <strong>{preview.skipped.length}</strong> mục bị bỏ qua</>}. Bỏ chọn những host bạn không muốn nhập.
          </p>
          {preview.warnings.map((w) => <p key={w} className="hint warn-text" role="status">{w}</p>)}
          <div className="import-list">
            {preview.items.map((i) => (
              <label key={i.id} className="import-row" data-testid={`import-item-${i.name}`}>
                <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Nhập ${i.name}`} />
                <span className="grow">
                  <strong>{i.name}</strong>{i.group && <span className="badge">{i.group}</span>}
                  <span className="sub"> {i.username}@{i.host}{i.port !== 22 ? `:${i.port}` : ''} · đăng nhập bằng {AUTH[i.auth]}{i.jump ? ` · qua ${i.jump}` : ''}</span>
                  {i.duplicate && <span className="badge conflict" data-testid="import-duplicate">đã có trong vault</span>}
                  {i.assumed.includes('username') && <span className="sub"> · username do Mymius tự đặt theo tài khoản máy này</span>}
                </span>
              </label>
            ))}
          </div>
          {preview.skipped.length > 0 && (
            <details className="issues"><summary>{preview.skipped.length} mục bị bỏ qua</summary>
              <ul>{preview.skipped.map((s, n) => <li key={n}><strong>{s.label}</strong>: {s.reason}</li>)}</ul></details>
          )}
          {preview.items.some((i) => i.auth === 'agent') && <p className="hint">Host dùng ssh-agent chưa có thông tin đăng nhập trong file: sau khi nhập, hãy sửa host để thêm mật khẩu hoặc khóa nếu cần.</p>}
          <div className="row">
            <span className="grow" />
            <button className="secondary" onClick={back}>Cancel</button>
            <button className="primary" disabled={busy || selected.size === 0} onClick={() => void commit()}>Import {selected.size} hosts</button>
          </div>
        </>
      )}

      {outcome && (
        <div data-testid="import-result" role="status">
          <p><strong>Đã nhập {outcome.created} host.</strong></p>
          {outcome.failed.length > 0 && (
            <details className="issues" open><summary>{outcome.failed.length} vấn đề</summary>
              <ul>{outcome.failed.map((f, n) => <li key={n}><strong>{f.name}</strong>: {f.error}</li>)}</ul></details>
          )}
          <div className="row"><span className="grow" /><button className="primary" onClick={onBack}>Done</button></div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}
