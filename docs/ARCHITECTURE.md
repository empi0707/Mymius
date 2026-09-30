# Kiến trúc

## Nguyên tắc

1. **Logic nghiệp vụ nằm trong `packages/*`, thuần Node, không import Electron.** Chạy được trong test, worker, hoặc CLI. Electron chỉ là lớp vỏ.
2. **Mọi thứ phụ thuộc hệ điều hành đi qua `@mymius/platform` hoặc một interface** (`SecretStore`, `FileSystemProvider`). Không rải `process.platform` khắp nơi.
3. **Renderer bị sandbox.** Nó chỉ gọi main qua các kênh khai báo trong `apps/desktop/src/shared/ipc.ts`. Dữ liệu file không đi qua renderer.

## FileSystemProvider

Một interface cho Local, SFTP, FTP, S3, WebDAV. Folder Sync và Remote Edit chỉ nói chuyện với interface này nên chạy được giữa mọi cặp provider, kể cả remote với remote.

- Provider khai báo `path` (posix cho remote, native cho local) và `capabilities` (mtime resolution, rename nguyên tử, hash phía server).
- `writeFileAtomic`: ghi file tạm, kiểm tra đích không đổi (`expect`), rồi rename đè. Gốc không bị đụng nếu có lỗi.

## Terminal SSH

`@mymius/ssh` không phụ thuộc Electron. Luồng dữ liệu:

```
xterm.js (renderer) ⇄ IPC ⇄ TerminalService (main) ⇄ TerminalHub ⇄ ShellSession ⇄ SshConnection ⇄ server
```

- **`SshConnection`**: một kết nối, nhiều kênh. Terminal, SFTP và exec cùng đi trên một kết nối (`SftpProvider.fromConnection`). `ConnectionPool` chia sẻ kết nối giữa các tab; khóa chia sẻ gồm **cả định danh thông tin đăng nhập** (băm có salt, chỉ trong RAM), nếu không một tab nhập sai mật khẩu sẽ âm thầm dùng lại phiên của tab khác. Kết nối rớt được thay ở lần mở kế tiếp.
- **Jump host**: `jump` là một `SshConnectOptions` khác, có thể lồng nhau. Host key của cả bastion lẫn đích đều được kiểm.
- **Host key (TOFU)**: `KnownHosts` lưu fingerprint. Host lạ → hỏi người dùng (nút mặc định là *Cancel*, Enter không chấp nhận). Host đã biết mà khóa **đổi** → từ chối ngay, không đưa ra lựa chọn, và lỗi hiển thị đúng lý do (không phải "handshake failed"). File hỏng là lỗi, không coi như rỗng.
- **Luồng dữ liệu**: `OutputBatcher` gộp các gói nhỏ (mỗi 8 ms hoặc 64 KB) để không làm nghẽn IPC. `FlowControl` dùng ack từ renderer (sau khi xterm vẽ xong) để `pause()` kênh SSH khi còn quá 512 KB chưa vẽ, và `resume()` khi còn dưới 128 KB, nên `cat` file lớn không làm phình bộ nhớ. Exit luôn được gửi *sau* phần dữ liệu cuối.
- **Không tin renderer**: `parseOpenRequest` kiểm host (chặn giá trị bắt đầu bằng `-`, khoảng trắng, ký tự điều khiển), cổng, kích thước; `TerminalHub` bỏ qua dữ liệu vào sai kiểu hoặc quá 1 MB; mỗi tab chỉ điều khiển được session của chính cửa sổ đó.
- **Đầu ra đến trước khi tab biết id session**: `TerminalRouter` giữ lại thay vì bỏ.
- Sao chép/dán: macOS dùng Cmd; Windows/Linux dùng Ctrl+Shift+C/V, và Ctrl+C chỉ là copy khi đang có vùng chọn (còn lại là SIGINT).

Chưa làm: terminal cục bộ (`node-pty`), lưu host/credential (cần vault), port forwarding, agent forwarding, tìm kiếm trong terminal, tự kết nối lại (hiện có nút Reconnect).

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

Mọi test đã chạy trên Linux. **Chưa chạy trên macOS và Windows** (CI ma trận 3 OS đã cấu hình để làm việc này). Terminal đã được chạy trong **Electron thật dưới Xvfb** (Linux). Trên macOS/Windows chưa chạy: đặc biệt cần xem lại WebGL renderer, phím tắt copy/paste, và hành vi của hộp thoại native.
