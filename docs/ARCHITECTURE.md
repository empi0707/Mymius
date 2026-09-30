# Kiến trúc

## Nguyên tắc

1. **Logic nghiệp vụ nằm trong `packages/*`, thuần Node, không import Electron.** Chạy được trong test, worker, hoặc CLI. Electron chỉ là lớp vỏ.
2. **Mọi thứ phụ thuộc hệ điều hành đi qua `@mymius/platform` hoặc một interface** (`SecretStore`, `FileSystemProvider`). Không rải `process.platform` khắp nơi.
3. **Renderer bị sandbox.** Nó chỉ gọi main qua các kênh khai báo trong `apps/desktop/src/shared/ipc.ts`. Dữ liệu file không đi qua renderer.

## FileSystemProvider

Một interface cho Local, SFTP, FTP, S3, WebDAV. Folder Sync và Remote Edit chỉ nói chuyện với interface này nên chạy được giữa mọi cặp provider, kể cả remote với remote.

- Provider khai báo `path` (posix cho remote, native cho local) và `capabilities` (mtime resolution, rename nguyên tử, hash phía server).
- `writeFileAtomic`: ghi file tạm, kiểm tra đích không đổi (`expect`), rồi rename đè. Gốc không bị đụng nếu có lỗi.

## SftpProvider

Dựng trên `ssh2`, một kết nối SSH cho mỗi provider.

- **Host key bắt buộc được xác minh**: `verifyHostKey` là tham số bắt buộc, không có mặc định tin mọi server. Callback nhận fingerprint dạng `SHA256:...` (giống OpenSSH) để so với known_hosts hoặc hỏi người dùng.
- Xác thực: mật khẩu, khóa riêng (+ passphrase), ssh-agent (`defaultSshAgent()` trong `platform` cho từng OS), keyboard-interactive (2FA). Hỗ trợ `sock` để đi qua jump host, và `algorithms` cho server cũ.
- SFTP v3 chỉ lưu mtime theo **giây**, nên `mtimeResolutionMs = 1000` và Folder Sync tự dùng dung sai tương ứng.
- `rename` đè file: dùng `posix-rename@openssh.com` (nguyên tử) nếu server có, nếu không thì xóa rồi đổi tên (**không nguyên tử**; `capabilities.atomicRename` báo rõ).
- Hash phía server qua exec (`sha256sum`/`shasum`, đường dẫn được quote an toàn). Tài khoản chỉ có SFTP không có exec thì tự tắt và rơi về tải xuống để hash.
- Bật `TCP_NODELAY`: không có nó, mỗi cặp yêu cầu/phản hồi nhỏ chịu thêm ~40 ms (Nagle + delayed ACK), ghi 3 MB mất ~9 giây thay vì ~0,1 giây. Có test chặn hồi quy.
- Mất kết nối: `onClose()` báo cho tầng trên. Tự kết nối lại chưa làm.

## Folder Sync

`scan` (liệt kê đệ quy, có ignore) -> `diff` (so sánh size + mtime, tùy chọn hash) -> `buildPlan` (theo chế độ + override từng mục của người dùng) -> `executePlan`.

- Không lưu trạng thái giữa các lần chạy (giống ForkLift): hai chiều không phân biệt được "file mới" với "file bị xóa ở phía kia", nên **xóa không tự lan truyền** ở chế độ hai chiều.
- Override trên một thư mục áp dụng cho cả cây con.
- Xóa mặc định chuyển vào `.mymius-trash/<runId>/` (phục hồi được).
- Dung sai mtime tối thiểu 1 giây (SFTP/FAT làm tròn), lấy theo provider kém chính xác nhất.

## Remote Edit

Tải file về thư mục riêng (quyền 0700) -> mở editor -> theo dõi thư mục cha (editor hay lưu bằng ghi tạm + rename) -> mỗi lần Save: chụp snapshot, so hash với lần upload trước, kiểm tra server có đổi không (mtime khác thì xác nhận bằng hash để bỏ qua `touch`), rồi upload nguyên tử.

Xung đột hỏi người dùng: **Ghi đè** / **Tải bản server** (bản local được giữ ở file `.local-<thời gian>`) / **Hủy** (không hỏi lại khi hai bên không đổi thêm). File bị xóa trên server: tạo lại hoặc hủy.

Giới hạn đã biết: SFTP không có ghi có điều kiện, nên còn một khoảng hở rất ngắn giữa lần kiểm tra cuối và lệnh rename.

## Vault và sync tài khoản

- Khóa dữ liệu ngẫu nhiên 256-bit mã hóa từng bản ghi (AES-256-GCM, AAD = id bản ghi). Khóa này chỉ tồn tại dưới dạng đã bọc bởi passphrase (Argon2id) và bởi recovery key. Đổi passphrase không phải mã hóa lại dữ liệu.
- Bản ghi: `{ id, hlc, deleted, payload }`. Gộp theo id, bản có HLC mới nhất thắng. Phép gộp giao hoán, kết hợp và lũy đẳng nên các thiết bị hội tụ dù đọc theo thứ tự nào.
- Kế hoạch backend: Google Drive `appDataFolder` (scope `drive.appdata`), mỗi thiết bị ghi một file riêng nên không có xung đột ghi. Chưa được viết.

## Đa nền tảng

| Vấn đề | macOS | Windows | Linux |
|---|---|---|---|
| Thư mục dữ liệu | `~/Library/...` | `%APPDATA%` | `XDG_*` |
| Lưu bí mật | Keychain (`safeStorage`) | DPAPI (`safeStorage`) | libsecret/kwallet; **có thể không có**, UI đã cảnh báo |
| Title bar | `hiddenInset` | khung native | khung native |
| ssh-agent | `SSH_AUTH_SOCK` | named pipe OpenSSH / Pageant | `SSH_AUTH_SOCK` |
| Đóng gói | dmg + zip, ký + notarize | nsis + zip | AppImage + deb |
| Mở file mặc định có thể chạy code | `.command`, `.app`... | `.exe`, `.bat`... | `.sh`, `.desktop`... |

Tên file từ server được làm sạch cho cả ba OS (ký tự cấm của Windows, tên thiết bị `CON`/`NUL`...).

## Chưa xác minh

SFTP mới được kiểm thử với server `ssh2` chạy trong process (mô phỏng OpenSSH: mtime theo giây, rename không đè, exec). **Chưa thử với OpenSSH thật**; nhánh `posix-rename` chỉ được kiểm bằng cách bơm extension vào phiên. Trình sinh khóa ed25519 của `ssh2` sinh ra khóa không đọc lại được khoảng 1% số lần: tính năng "tạo khóa" sau này phải kiểm tra lại đầu ra.

Mọi test đã chạy trên Linux. **Chưa chạy trên macOS và Windows** (CI ma trận 3 OS đã cấu hình để làm việc này). Chưa khởi chạy cửa sổ Electron thật; mới xác nhận `typecheck` và `build` thành công.
