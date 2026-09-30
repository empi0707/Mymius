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

## File manager

```
Pane (renderer) ──IPC──▶ FilesService (main) ──▶ FileSystemProvider (Local | SFTP) ──▶ đĩa / máy chủ
                              │                       ▲
                              ├── runTransfer / deletePaths (@mymius/transfer)
                              ├── compareFolders / buildPlan / executePlan (@mymius/folder-sync)
                              └── RemoteEditManager (@mymius/remote-edit)
```

- **Terminal và file pane dùng chung một kết nối** tới cùng host: `ConnectionBroker` cấp "lease" trên kết nối dùng chung (khóa gồm cả định danh thông tin đăng nhập), kết nối đóng khi lease cuối được trả. Host key của mọi bước trong chuỗi jump host đều được kiểm ở đây.
- **`FilesService` không phụ thuộc Electron** (thùng rác, mở file, hộp thoại xung đột được tiêm vào) nên test được với SFTP thật. Mọi đường dẫn từ renderer đều được kiểm (kiểu, độ dài, NUL). Mỗi cửa sổ chỉ dùng được các kết nối, job và phiên sửa file của chính nó; đóng cửa sổ thì hủy job, đóng kết nối và kết thúc phiên sửa.
- **`runTransfer`**: ghi qua file tạm rồi rename nên không bao giờ để file dở ở đích; giữ nguyên mtime và quyền. Di chuyển trong cùng một hệ thống tệp là `rename` (tức thì); khác hệ thống thì sao chép rồi **chỉ xóa nguồn nào đã sang đủ**. Chống sao chép thư mục vào chính nó (so sánh theo đường dẫn tương đối, nên `proj-backup` không bị nhầm là nằm trong `proj`). Liên kết (symlink) và file đặc biệt được báo là bỏ qua, không đi theo.
- **Xóa**: trên máy này đi vào thùng rác hệ điều hành (có thể khôi phục); trên máy chủ là vĩnh viễn và hộp thoại nói rõ điều đó. Folder Sync xóa vào `.mymius-trash/<lần chạy>/`.
- **Xung đột tên**: giao diện hỏi trước (Thay thế / Bỏ qua / Giữ cả hai) sau khi `conflicts()` liệt kê các tên trùng.
- **Folder Sync**: so sánh -> bảng khác biệt -> `preview` (mỗi lần đổi chế độ hoặc mũi tên) -> `run` như một job. Bấm mũi tên của một mục để xoay vòng phải/trái/bỏ qua; chọn hướng cho thư mục áp dụng cho cả cây con. Từ chối hai thư mục trùng nhau hoặc lồng nhau. Kết quả so sánh chỉ sống trong bộ nhớ (tối đa 8) và gắn với cửa sổ đã tạo ra nó.
- **Sửa file từ xa**: dùng riêng một lease kết nối nên đóng pane không làm đứt phiên sửa. Hộp thoại xung đột là hộp thoại native với nút mặc định là **Cancel** (Enter không thể vô tình ghi đè thay đổi của người khác). Thanh hoạt động hiện trạng thái của từng file, cảnh báo đỏ khi một file **chưa** lên máy chủ.
- **Danh sách lớn**: chỉ vẽ các dòng đang thấy (chiều cao dòng cố định), nên thư mục 20.000 mục vẫn mượt. Giới hạn 20.000 mục mỗi thư mục và 50.000 khác biệt mỗi lần so sánh, có báo là bị cắt.

Chưa làm: tab trong mỗi pane, kéo thả từ/đến Finder hay Explorer, xem trước, đổi tên hàng loạt, tiến độ khi đang quét thư mục lớn, FTP/S3/WebDAV.

## Lưu host trong vault

```
UI (renderer)  ──chỉ thấy bản đã che bí mật──▶  VaultService (main)  ──▶  VaultStore  ──▶  vault.json (chỉ ciphertext)
      │  "Connect" chỉ gửi hostId                        │
      └──────────────────────────────────────────▶ TerminalService: resolveChain → mật khẩu / khóa nằm trong main
```

- **Renderer không bao giờ nhận được mật khẩu, passphrase hay khóa riêng đã lưu.** `hosts.list()` trả `HostSummary` (không có bí mật). Khi sửa host, bí mật để trống nghĩa là "giữ nguyên" (`applyHostInput`). Kiểu dùng chung ở `shared/ipc.ts` là bản sao (renderer không được import package Node); `main/ipc-check.ts` làm biên dịch thất bại nếu chúng lệch khỏi kiểu thật.
- **`VaultStore`**: một file JSON các bản ghi đã seal (AES-256-GCM, AAD = id bản ghi nên không thể tráo ciphertext giữa các bản ghi). Không có gì đọc được nếu thiếu khóa: tên host, người dùng, nhóm, ghi chú đều nằm trong payload. Ghi file nguyên tử, quyền 0600, mọi thay đổi xếp hàng tuần tự. File hỏng thì báo `damaged` và **không bao giờ tự tạo vault mới đè lên**.
- **Passphrase** tối thiểu 10 ký tự (Argon2id 64 MiB x 3). **Recovery key** hiện một lần, không lưu. Đổi passphrase chỉ bọc lại khóa dữ liệu, không mã hóa lại bản ghi.
- **Ghi nhớ trên thiết bị**: khóa dữ liệu được bọc bằng `safeStorage` (Keychain / DPAPI / keyring). Trên Linux không có keyring, Electron rơi về khóa cố định `basic_text` vốn không bảo vệ gì, nên tùy chọn này bị ẩn hẳn. "Khóa vault" luôn quên khóa đã nhớ. Tự khóa sau 15 phút không dùng, trừ khi đã ghi nhớ trên thiết bị.
- **Khóa SSH** nhập vào vault được kiểm tra ngay (đúng là khóa riêng, passphrase đúng) và đi theo vault sang mọi thiết bị. Kiểu "key file" chỉ là đường dẫn trên máy này, đọc lúc kết nối. Xóa khóa hoặc host đang được dùng (làm khóa đăng nhập, làm jump host) bị từ chối, vòng lặp jump host bị chặn khi lưu và khi kết nối.
- **Bản ghi đọc lên đều được kiểm tra lại** (`parseHostProfile`), bản ghi hỏng hoặc bị sửa bị bỏ qua thay vì làm hỏng cả danh sách.
- Khi vault khóa, các terminal đang mở vẫn chạy; kết nối mới tới host đã lưu bị từ chối.

## Vault và sync tài khoản

- Khóa dữ liệu ngẫu nhiên 256-bit mã hóa từng bản ghi (AES-256-GCM, AAD = id bản ghi). Khóa này chỉ tồn tại dưới dạng đã bọc bởi passphrase (Argon2id) và bởi recovery key. Đổi passphrase không phải mã hóa lại dữ liệu.
- Bản ghi: `{ id, hlc, deleted, payload }`. Gộp theo id, bản có HLC mới nhất thắng. Phép gộp giao hoán, kết hợp và lũy đẳng nên các thiết bị hội tụ dù đọc theo thứ tự nào.
- `VaultStore` có `snapshot()`, `applyRemote()`, `bootstrap()`, và cho sync: `buildDeviceFile/applyDeviceFile`, `buildMetaFile/applyMetaFile`, vùng `local` (niêm phong, không bao giờ sync) chứa token Drive và trạng thái sync.

## Sync qua Google Drive (`packages/drive-sync`)

- **Đăng nhập**: OAuth 2.0 loopback (`127.0.0.1`, cổng ngẫu nhiên) + PKCE S256, `access_type=offline`, scope `drive.appdata` (chỉ thấy thư mục ẩn của app, không thấy file Drive khác). Người dùng tự tạo OAuth client (xem `docs/GOOGLE_DRIVE_SETUP.md`); refresh token nằm trong vùng niêm phong của vault, khóa vault thì bỏ khỏi bộ nhớ.
- **Bố cục trên Drive**: `mymius-vault.json` (meta: khóa dữ liệu đã bọc, `rev` tăng khi đổi passphrase, kèm MAC) và `mymius-device-<id>.json` mỗi thiết bị một file (toàn bộ trạng thái đã gộp, kèm MAC). Mỗi thiết bị chỉ ghi file của mình nên không có xung đột ghi; thiết bị khác đọc, kiểm MAC rồi gộp LWW theo bản ghi.
- **Chống sửa**: MAC HMAC-SHA256 (khóa dẫn xuất HKDF từ khóa dữ liệu, JSON chuẩn hóa) phủ cả cờ xóa/HLC. File sai MAC bị bỏ qua và báo "bị sửa"; vault khác (khóa không khớp) báo riêng là "khác vault". Giới hạn 20MB mỗi file.
- **Engine**: một lượt sync tại một thời điểm, debounce sau thay đổi, polling định kỳ (chưa dùng Changes API), backoff mũ khi lỗi mạng, hết dung lượng thử lại mỗi giờ, thu hồi quyền/vault khác/bị sửa thì dừng và hiện trạng thái.
- **Vì sao không cần Client ID của người dùng**: scope `drive.appdata` không thuộc nhóm nhạy cảm nên không phải qua kiểm duyệt của Google; nhà phát hành tạo **một** OAuth Desktop client cho cả ứng dụng và nhúng vào bản build, người dùng chỉ bấm đăng nhập. (Termius dùng máy chủ riêng; ForkLift dùng iCloud/file.) Ai không muốn đăng nhập Google dùng sync bằng file JSON bên dưới.
- **Đăng nhập tài khoản**: scope thêm `profile` để hiện tên/email (chỉ hiển thị, không dùng để quyết định gì). Đăng nhập có thể làm *trước khi có vault*: nếu tài khoản đã có vault trên Drive thì khôi phục, nếu chưa thì giữ phiên đăng nhập trong bộ nhớ và tự bắt đầu sync ngay khi vault được tạo. Có thể nhúng sẵn OAuth client vào bản build (`MAIN_VITE_GOOGLE_CLIENT_ID` / `MAIN_VITE_GOOGLE_CLIENT_SECRET`) để người dùng không phải tự tạo project Google Cloud; client tự nhập trong app được ưu tiên.
- **Máy mới**: chọn "Khôi phục từ Google Drive" ở màn hình tạo vault; dựng vault khóa từ meta, nhập passphrase hoặc recovery key để mở.
- **Ngắt kết nối**: luôn đăng xuất cục bộ; tùy chọn xóa dữ liệu trên Drive (lỗi bước này được báo riêng).

Giới hạn đã biết: máy đã có vault riêng không thể gộp vào vault trên Drive; bản xóa (tombstone) chưa được dọn nên máy offline rất lâu có thể làm sống lại bản ghi đã xóa.

## Sync và backup bằng file JSON (`packages/vault/src/bundle.ts`, `apps/desktop/src/main/file-sync-service.ts`)

Không cần tài khoản hay Client ID. Một file `.json` duy nhất chứa cùng nội dung như các file trên Drive: metadata vault (khóa dữ liệu đã bọc + MAC) và một bản trạng thái đầy đủ cho mỗi thiết bị đã ghi vào (tối đa 10 thiết bị khác, kèm MAC). Toàn ciphertext nên thư mục chứa nó không cần đáng tin.

- **Backup**: "Save backup…" ghi bundle một lần. "Restore from backup…" gộp vào vault đang mở; trên máy chưa có vault thì dựng vault từ metadata, mở khóa bằng passphrase rồi gộp bản ghi (không liên kết, không ghi lại vào file).
- **Sync liên tục**: "Create sync file…" / "Use existing file…" liên kết một file (đường dẫn lưu trong vùng niêm phong của vault). Mỗi vòng: đọc, kiểm MAC, gộp, rồi chỉ ghi lại khi bản của mình khác bản trong file. Ghi nguyên tử (file tạm + rename, đóng dấu phiên bản bằng mtime/size/inode của file tạm để không nhầm với bản do máy khác ghi chen vào). Chỉ "poll" định kỳ (15 giây) và sau mỗi thay đổi cục bộ.
- **An toàn**: file sai MAC, thuộc vault khác hoặc không phải bundle thì **không bao giờ bị ghi đè**, app dừng và báo rõ. Bản của thiết bị khác không qua được kiểm MAC bị bỏ qua và không được chép tiếp.
- **Giới hạn**: hai máy ghi cùng lúc thì một bản có thể bị ghi đè, nhưng máy kia sẽ thấy bản của mình vắng mặt và ghi lại nên hội tụ sau vài vòng. Nếu dịch vụ đồng bộ thư mục tạo bản "conflicted copy" thì app không đọc các bản đó. Chưa thử với iCloud/Dropbox thật, chỉ thử với hai instance dùng chung một thư mục.

## Nhập host (`packages/importers`, `apps/desktop/src/main/import-service.ts`)

Ba trình đọc thuần (không I/O) trả về `{hosts, skipped, warnings}`; `ImportService` ở tiến trình chính mở hộp thoại chọn file, đọc file, đối chiếu trùng với vault và giữ kết quả (kèm mật khẩu) trong bộ nhớ dưới một token dùng một lần, hết hạn sau 10 phút hoặc khi vault khóa. Giao diện chỉ nhận bản xem trước không có bí mật và gửi lại token cùng danh sách id đã chọn; việc ghi đi qua `VaultService.saveHost`, tức cùng lớp kiểm tra như thêm host bằng tay. Jump host được nối ở lượt thứ hai sau khi mọi host đã có id. Chi tiết định dạng và giới hạn: [docs/IMPORT.md](IMPORT.md).

## Tự động backup khi thêm host (`apps/desktop/src/main/auto-backup-service.ts`)

Mỗi lần tập host của vault xuất hiện thêm một id mới (thêm ở máy này hoặc host đến từ thiết bị khác qua sync), app ghi một bundle như "Save backup…" vào thư mục backup, sau 1 giây debounce. Mặc định **bật**, thư mục là `<userData>/backups`, đổi được trong Settings (nên chọn thư mục nằm ngoài máy, ví dụ iCloud Drive). Tên file `mymius-backup-YYYYMMDD-HHMMSS-xxxx.json`, quyền 0600, chỉ giữ 20 bản mới nhất và **chỉ xóa file khớp đúng mẫu tên này**. Mở khóa vault không tính là thêm host; sửa host cũng không. Cấu hình lưu trong vùng niêm phong của vault. Lỗi ghi (thư mục không ghi được, đầy đĩa) hiện ngay trên thẻ Auto backup và không làm hỏng thao tác thêm host.

Giới hạn: bundle chứa toàn bộ vault nên mỗi bản có dung lượng bằng cả vault; backup chỉ kích hoạt khi *thêm* host, không phải khi xóa hay sửa (nên dùng Save backup… cho các mốc khác).

## Ngôn ngữ

Mô tả, hướng dẫn, thông báo trạng thái và lỗi hiển thị cho người dùng đã được dịch sang tiếng Việt; nút bấm, tiêu đề, nhãn ô nhập, `aria-label` và `data-testid` giữ tiếng Anh. Chuỗi nằm rải trong mã (chưa có lớp i18n), gồm cả thông báo lỗi ở `packages/*` và `apps/desktop/src/main`. Nếu sau này cần nhiều ngôn ngữ, bước đầu là gom chúng vào một bảng thông điệp.

## Giao diện

Settings → Appearance: theo hệ thống / sáng / tối. Lựa chọn lưu trong `localStorage` của renderer, áp dụng bằng `data-theme` trên `<html>`, đồng bộ `nativeTheme` (hộp thoại, menu) và bảng màu terminal xterm. Màu trạng thái (badge, cảnh báo, nguy hiểm) đều là biến CSS có bản tối.

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

**Sync Google Drive chỉ được kiểm thử với Google giả** (`fake-google.ts`: PKCE, state, hết hạn token, hạn ngạch, lỗi chèn). Chưa thử OAuth/Drive thật: hành vi thực tế của consent screen, thông báo lỗi, giới hạn tốc độ có thể khác. Nếu consent screen ở trạng thái "Testing", refresh token hết hạn sau 7 ngày.

SFTP mới được kiểm thử với server `ssh2` chạy trong process (mô phỏng OpenSSH: mtime theo giây, rename không đè, exec). **Chưa thử với OpenSSH thật**; nhánh `posix-rename` chỉ được kiểm bằng cách bơm extension vào phiên. Trình sinh khóa ed25519 của `ssh2` sinh ra khóa không đọc lại được khoảng 1% số lần: tính năng "tạo khóa" sau này phải kiểm tra lại đầu ra.

Mọi test đã chạy trên Linux. **Chưa chạy trên macOS và Windows** (CI ma trận 3 OS đã cấu hình để làm việc này). Terminal đã được chạy trong **Electron thật dưới Xvfb** (Linux). Trên macOS/Windows chưa chạy: đặc biệt cần xem lại WebGL renderer, phím tắt copy/paste, và hành vi của hộp thoại native.
