import { useState } from 'react'
import { timeAgo } from './useDrive'
import { useAutoBackup } from './useAutoBackup'

/** A backup file is written by itself each time a new host is added. */
export function AutoBackupCard(): React.JSX.Element {
  const { status, refresh } = useAutoBackup()
  const [message, setMessage] = useState('')
  const api = window.mymius.autoBackup
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setMessage('')
    const r = await fn()
    if (!r.ok && r.error) setMessage(r.error)
    await refresh()
  }
  if (!status) return <section className="card"><h3>Auto backup</h3><p className="hint">Đang tải…</p></section>

  return (
    <section className="card" data-testid="autobackup-card">
      <h3>Auto backup</h3>
      <p className="hint">
        Mỗi khi bạn thêm một host mới, Mymius tự lưu một bản backup <code>.json</code> đã mã hóa (giống nút Save backup) vào thư mục bên dưới và chỉ giữ 20 bản mới nhất.
        Nhờ vậy nếu lỡ xóa hoặc sửa nhầm, bạn vẫn khôi phục được. Muốn an toàn hơn, hãy chọn thư mục nằm trong iCloud Drive, Dropbox hoặc ổ đĩa khác.
      </p>
      <label className="radio"><input type="checkbox" name="autobackup" checked={status.enabled} onChange={(e) => void act(() => api.setEnabled(e.target.checked))} />Tự động backup khi thêm host mới</label>
      <div className="row"><code className="path" data-testid="autobackup-dir">{status.dir}</code></div>
      <p className="sub" data-testid="autobackup-line">
        {status.lastBackupAt ? `Backup gần nhất ${timeAgo(status.lastBackupAt)}` : 'Chưa có backup tự động nào'}
      </p>
      {(status.error || message) && <p className="error" role="alert">{status.error ?? message}</p>}
      <div className="row wrap">
        <button className="secondary" onClick={() => void act(() => api.backupNow())}>Backup now</button>
        <button className="secondary" onClick={() => void act(() => api.chooseFolder())}>Choose folder…</button>
        {status.customDir && <button className="link" onClick={() => void act(() => api.resetFolder())}>Use default folder</button>}
      </div>
    </section>
  )
}
