# Mymius

Ứng dụng desktop kết hợp **SSH terminal** (kiểu Termius) và **dual-pane file manager** (kiểu ForkLift), chạy trên macOS, Windows và Linux.

## Tính năng chính

| Tính năng | Trạng thái |
|---|---|
| Folder Sync giữa 2 pane (mirror trái→phải, phải→trái, hai chiều; dry-run; thùng rác phục hồi được) | Lõi xong, có test (`packages/folder-sync`) |
| Remote Edit: mở file server bằng editor máy, Save là tự upload, phát hiện xung đột (Ghi đè / Tải bản server / Hủy) | Lõi xong, có test (`packages/remote-edit`) |
| Vault mã hóa đầu-cuối + gộp bản ghi giữa các thiết bị | Lõi xong, có test (`packages/vault`) |
| Khung Electron (bảo mật: sandbox, contextIsolation, CSP) | Có, build được |
| Provider Local và **SFTP** (xác thực mật khẩu / khóa / ssh-agent / keyboard-interactive, xác minh host key, hash phía server) | Xong, có test (`packages/providers`) |
| Provider FTP / S3 / WebDAV | Chưa |
| Terminal SSH (xterm.js + ssh2) | Chưa |
| Sync tài khoản qua Google Drive `appDataFolder` | Chưa (vault đã sẵn sàng cho việc này) |
| UI file manager, danh sách phiên Remote Edit, UI Folder Sync | Chưa (mới có khung) |

## Bắt đầu

Yêu cầu: Node.js >= 22, pnpm 10.

```bash
pnpm install
pnpm test          # chạy toàn bộ test
pnpm typecheck
pnpm dev           # mở app Electron
pnpm dist          # đóng gói cho hệ điều hành hiện tại
```

## Cấu trúc

```
packages/
  core/         interface FileSystemProvider, ghi nguyên tử, copy, hash, version
  platform/     khác biệt giữa các OS: thư mục app, tên file an toàn, mở file bằng app
  providers/    các FileSystemProvider (hiện có: Local, SFTP)
  folder-sync/  scan -> diff -> plan -> execute
  remote-edit/  phiên sửa file từ xa + phát hiện xung đột
  vault/        Argon2id + AES-256-GCM, recovery key, HLC, merge bản ghi
apps/desktop/   Electron (main / preload / renderer React)
```

Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) để biết các quyết định thiết kế.
