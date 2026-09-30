# Mymius

Ứng dụng desktop kết hợp **SSH terminal** (kiểu Termius) và **dual-pane file manager** (kiểu ForkLift), chạy trên macOS, Windows và Linux.

## Tính năng chính

| Tính năng | Trạng thái |
|---|---|
| Folder Sync giữa 2 pane (mirror trái→phải, phải→trái, hai chiều; dry-run; thùng rác phục hồi được) | Lõi xong, có test (`packages/folder-sync`) |
| Remote Edit: mở file server bằng editor máy, Save là tự upload, phát hiện xung đột (Ghi đè / Tải bản server / Hủy) | Lõi xong, có test (`packages/remote-edit`) |
| **Lưu host / khóa SSH vào vault mã hóa** (tạo, mở khóa, khóa, recovery key, đổi passphrase, jump host, nhập khóa) | Xong, có test + E2E (`packages/vault`, `apps/desktop`) |
| Gộp bản ghi vault giữa các thiết bị (`snapshot` / `applyRemote` / `bootstrap`) | Xong, có test |
| Khung Electron (bảo mật: sandbox, contextIsolation, CSP) | Có, build được |
| Provider Local và **SFTP** (xác thực mật khẩu / khóa / ssh-agent / keyboard-interactive, xác minh host key, hash phía server) | Xong, có test (`packages/providers`) |
| Provider FTP / S3 / WebDAV | Chưa |
| **File manager hai pane** (Local + host SFTP đã lưu): duyệt, chọn nhiều, phím tắt, kéo thả, copy/move/xóa/đổi tên/tạo thư mục, hàng đợi có tiến độ và hủy, xử lý trùng tên | Xong, có test + E2E (`packages/transfer`, `apps/desktop`) |
| **Folder Sync giữa hai pane** (3 chế độ, bảng khác biệt, đổi mũi tên từng mục, bỏ qua theo mẫu, so sánh nội dung, xóa vào thùng rác phục hồi được) | Xong, có test + E2E |
| **Sửa file từ xa và tự upload** khi lưu, hỏi Ghi đè / Tải bản server / Hủy khi server đã đổi | Xong, có test + E2E |
| **Terminal SSH** (xterm.js + ssh2): nhiều tab, resize, jump host, known_hosts (TOFU), chia sẻ kết nối, back-pressure | Xong, có test + E2E trên Electron thật |
| **Đăng nhập Google → sync vault qua Google Drive** `appDataFolder` (OAuth PKCE, mã hóa đầu-cuối, chống sửa file, khôi phục trên máy mới) | Xong, có test + E2E hai máy với Google **giả**; **chưa thử với Google thật** (xem [docs/GOOGLE_DRIVE_SETUP.md](docs/GOOGLE_DRIVE_SETUP.md)) |
| **Sync / backup bằng file `.json`** tùy chọn (không cần tài khoản: đặt file trong thư mục iCloud Drive, Dropbox, OneDrive, Syncthing, NAS...; sao lưu và khôi phục một lần) | Xong, có test + E2E |
| **Nhập host cũ** từ Termius (CSV), ForkLift (`Favorites.json`) và `~/.ssh/config`: xem trước, bỏ chọn, phát hiện trùng, nối ProxyJump ([docs/IMPORT.md](docs/IMPORT.md)) | Xong, có test + E2E; định dạng ForkLift và file xuất từ Termius thật **chưa thử** |
| **Tự động backup mỗi khi thêm host mới** (file `.json` mã hóa, mặc định bật, giữ 20 bản mới nhất, chọn được thư mục) | Xong, có test + E2E |
| **Giao diện tiếng Việt** cho mô tả, hướng dẫn và thông báo (nút bấm giữ tiếng Anh) | Xong |
| **Giao diện tối / sáng / theo hệ thống** | Xong, có E2E |
| Tab trong mỗi pane, kéo file từ/đến Finder, xem trước (Quick Look), đổi tên hàng loạt, gắn thẻ | Chưa |

## Bắt đầu

Yêu cầu: Node.js >= 22, pnpm 10.

```bash
pnpm install
pnpm test          # chạy toàn bộ test
pnpm typecheck
pnpm dev           # mở app Electron
xvfb-run -a pnpm --filter @mymius/desktop e2e   # E2E (Linux headless; trên macOS/Windows bỏ xvfb-run)
pnpm dist          # đóng gói cho hệ điều hành hiện tại
```

## Cấu trúc

```
packages/
  core/         interface FileSystemProvider, ghi nguyên tử, copy, hash, version
  platform/     khác biệt giữa các OS: thư mục app, tên file an toàn, mở file bằng app
  ssh/          kết nối SSH dùng chung, shell/PTY, known_hosts, jump host, điều phối terminal
  providers/    các FileSystemProvider (hiện có: Local, SFTP)
  folder-sync/  scan -> diff -> plan -> execute
  remote-edit/  phiên sửa file từ xa + phát hiện xung đột
  vault/        Argon2id + AES-256-GCM, recovery key, HLC, merge bản ghi, định dạng file sync có MAC
  importers/    đọc danh sách host từ Termius CSV, ForkLift, ssh config
  drive-sync/   OAuth loopback + PKCE, client Drive appDataFolder, engine đồng bộ
apps/desktop/   Electron (main / preload / renderer React)
```

Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) để biết các quyết định thiết kế.
