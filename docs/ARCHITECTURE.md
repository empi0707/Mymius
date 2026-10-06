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

- **Mỗi tab terminal có kết nối riêng** (`acquireChain(chain, { dedicated: true })`): sshd chỉ chạy `pam_motd` một lần cho mỗi kết nối, nên shell thứ hai trên kết nối dùng chung chỉ có dòng "Last login" mà không có thông báo trạng thái server (đã đo trên Ubuntu 24.04). **File pane dùng chung một kết nối** với nhau: `ConnectionBroker` cấp "lease" trên kết nối dùng chung (khóa gồm cả định danh thông tin đăng nhập), kết nối đóng khi lease cuối được trả. Host key của mọi bước trong chuỗi jump host đều được kiểm ở đây.
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

## Sync qua Dropbox

Cùng engine, định dạng file, MAC và mã hóa như Drive; chỉ lớp lưu trữ khác. Engine chỉ cần giao diện `RemoteStore` (`list/download/create/update/delete`), do `DriveClient` (Google) và `DropboxClient` cùng cài đặt. File được đặt tên trực tiếp trong App folder (`/mymius-vault.json`, `/mymius-device-<id>.json`), `create` dùng chế độ `add` để không ghi đè file do máy khác vừa tạo, `update` dùng `overwrite`. Dấu vân tay thay đổi lấy từ `rev` + `content_hash`.

Đăng nhập không chuyển hướng: mở `oauth2/authorize` với PKCE S256 và `token_access_type=offline`, người dùng dán mã Dropbox hiển thị, app đổi mã lấy access + refresh token (không có secret). `AuthSession` dùng chung cho refresh. Nhà cung cấp được lưu cùng token trong vùng niêm phong của vault (`provider`), nên khởi động lại tự tiếp tục đúng dịch vụ. Chỉ một dịch vụ hoạt động tại một thời điểm. Chưa thử với Dropbox thật: xem [docs/DROPBOX_SETUP.md](DROPBOX_SETUP.md).

## Sync và backup bằng file JSON (`packages/vault/src/bundle.ts`, `apps/desktop/src/main/file-sync-service.ts`)

Không cần tài khoản hay Client ID. Một file `.json` duy nhất chứa cùng nội dung như các file trên Drive: metadata vault (khóa dữ liệu đã bọc + MAC) và một bản trạng thái đầy đủ cho mỗi thiết bị đã ghi vào (tối đa 10 thiết bị khác, kèm MAC). Toàn ciphertext nên thư mục chứa nó không cần đáng tin.

- **Backup**: "Save backup…" ghi bundle một lần. "Restore from backup…" gộp vào vault đang mở; trên máy chưa có vault thì dựng vault từ metadata, mở khóa bằng passphrase rồi gộp bản ghi (không liên kết, không ghi lại vào file).
- **Sync liên tục**: "Create sync file…" / "Use existing file…" liên kết một file (đường dẫn lưu trong vùng niêm phong của vault). Mỗi vòng: đọc, kiểm MAC, gộp, rồi chỉ ghi lại khi bản của mình khác bản trong file. Ghi nguyên tử (file tạm + rename, đóng dấu phiên bản bằng mtime/size/inode của file tạm để không nhầm với bản do máy khác ghi chen vào). Chỉ "poll" định kỳ (15 giây) và sau mỗi thay đổi cục bộ.
- **An toàn**: file sai MAC, thuộc vault khác hoặc không phải bundle thì **không bao giờ bị ghi đè**, app dừng và báo rõ. Bản của thiết bị khác không qua được kiểm MAC bị bỏ qua và không được chép tiếp.
- **Giới hạn**: hai máy ghi cùng lúc thì một bản có thể bị ghi đè, nhưng máy kia sẽ thấy bản của mình vắng mặt và ghi lại nên hội tụ sau vài vòng. Nếu dịch vụ đồng bộ thư mục tạo bản "conflicted copy" thì app không đọc các bản đó. Chưa thử với iCloud/Dropbox thật, chỉ thử với hai instance dùng chung một thư mục.

## Tìm kiếm trong pane

Một ô duy nhất ở thanh công cụ, nhưng trạng thái `query` nằm trong `PaneState` của từng pane: ô luôn hiển thị và sửa tìm kiếm của pane đang hoạt động, đổi pane thì ô đổi sang tìm kiếm của pane kia. Lọc theo tên (chứa chuỗi, không phân biệt hoa thường, không phải mẫu/regex) trên thư mục hiện tại, gồm cả thư mục con; tìm bắt đầu bằng dấu chấm thì gồm cả file ẩn (`files/search.ts`). Mục bị lọc mất khỏi vùng chọn để Delete/Copy không bao giờ tác động lên thứ không nhìn thấy. Đi vào thư mục khác hoặc đổi nguồn thì xóa tìm kiếm của pane đó. Chỉ tìm trong thư mục đang mở, không đệ quy.

## Thanh tiến trình (`apps/desktop/src/renderer/src/activity`)

Một kho trạng thái nhỏ (`activity-core.ts`): mỗi phần của giao diện báo danh sách việc đang chờ theo "scope" (`files`, `terminals`, `list:<pane>`), thanh (`ActivityBar`) hiển thị ở góc trên bên phải. Nguồn: tab terminal đang kết nối, pane đang kết nối hoặc đọc thư mục trên máy chủ, tác vụ sao chép/di chuyển đang chạy (có phần trăm khi biết dung lượng), file sửa từ xa đang `opening`/`uploading`. Chỉ hiện sau 200 ms và ở lại tối thiểu 600 ms để không nhấp nháy; nhiều việc cùng lúc thì hiện việc đầu tiên kèm "(+N)". Không nhận chuột.

## Tên ứng dụng

`app.setName('Mymius')` ở tiến trình chính (tên trong menu, hộp About, tiêu đề cửa sổ). Thư mục dữ liệu được ghim lại vị trí cũ trước khi đổi tên, vì Electron suy ra thư mục đó từ tên ứng dụng. Ở chế độ dev trên macOS, tên trên thanh menu và Dock vẫn là "Electron" vì nó đọc từ gói `Electron.app`; bản đóng gói (`pnpm dist`) dùng `productName: Mymius` của electron-builder.

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

## Lịch sử lệnh (sidebar trong tab Terminals)

Nút **Lịch sử lệnh** ở thanh tab mở một sidebar bên phải, hiển thị lệnh gần đây của server mà tab đang chọn kết nối tới. Hai nguồn, gộp và bỏ trùng, mới nhất ở trên:

- **File lịch sử trên server**: `TerminalService.history` chạy `sh -c` (một lệnh chỉ-đọc, `HISTORY_SCRIPT` trong `packages/ssh/src/history.ts`) qua kết nối riêng của tab, đọc 1500 dòng cuối của `~/.bash_history`, `~/.zsh_history` và fish history. `parseHistory` hiểu bash (kể cả dòng `#timestamp`), zsh extended history (nhiều dòng) và fish. Kết quả chỉ nằm trong RAM, không lưu vào vault hay đồng bộ.
- **Lệnh gõ trong tab** (chấm ●): `CommandTracker` theo dõi phím gõ. Chỉ ghi nhận dòng gõ "sạch" (ký tự thường + Backspace, không Tab/mũi tên/paste nhiều dòng, không ở vim/less) và sau 300 ms phải thấy chính dòng đó hiện trên terminal. Mật khẩu gõ ở prompt không được server echo lại nên không bao giờ bị ghi.

Bấm một lệnh: đưa lên dòng lệnh, chưa chạy (nhiều dòng thì dán dạng bracketed paste). Nút ▶ khi rê chuột: chạy ngay (chỉ với lệnh một dòng).

Giới hạn: bash chỉ ghi lịch sử khi một phiên kết thúc (trừ khi server đặt `PROMPT_COMMAND='history -a'`), nên lệnh của một phiên đang chạy ở tab khác chưa có trong file; lệnh gõ ở tab này vẫn hiện nhờ nguồn thứ hai. Lệnh gọi qua Tab-completion hoặc phím mũi tên không được ghi ở nguồn thứ hai (nhưng sẽ có trong file lịch sử sau khi phiên kết thúc). Tài khoản dùng shell khác (vd. nushell) hoặc `HISTFILE` tùy chỉnh thì sidebar có thể trống.

## Menu ứng dụng và phím đóng tab

`apps/desktop/src/main/menu.ts` thay menu mặc định của Electron (menu mặc định gán Cmd/Ctrl+W cho "Close Window", nên bấm để đóng tab terminal lại đóng cả ứng dụng). macOS: **Cmd+W** đóng tab đang chọn, **Shift+Cmd+W** đóng cửa sổ. Windows/Linux: **Ctrl+Shift+W** đóng tab (đi cùng Ctrl+Shift+T mở tab), còn **Ctrl+W** để nguyên cho shell ("xóa từ"). Mục Close Tab chỉ có tác dụng khi đang ở trang Terminals; ở trang khác thì không làm gì. Khi chưa có tab nào, Cmd+W không đóng cửa sổ: dùng Shift+Cmd+W.

## Menu chuột phải trong pane

Chuột phải vào file/thư mục (hoặc phím Menu / Shift+F10 trên dòng đang chọn) mở menu: **Open, Download… (chỉ pane server), Copy/Move to other pane, Rename, Copy path, Delete, New folder, Refresh**. Chuột phải vào chỗ trống: New folder, Refresh, Select all. Chuột phải vào mục chưa chọn thì chọn mục đó; vào mục đang nằm trong vùng chọn thì menu tác động lên cả vùng chọn (Open và Rename bị tắt khi chọn nhiều mục).

- Danh sách mục do `files/menu.ts` (`buildMenu`, hàm thuần, có unit test); `ContextMenu.tsx` vẽ và xử lý bàn phím (mũi tên, Enter, Esc, bấm ra ngoài).
- **Download**: hộp thoại chọn thư mục của hệ điều hành (`files.pickFolder`, mở sẵn ở Downloads), rồi chạy đúng luồng copy sẵn có từ pane server sang đĩa máy này: hỏi khi trùng tên (skip / keep both / replace), tiến độ và nút Cancel ở thanh job, thư mục được tải đệ quy. Không có thư mục tạm hay đường đi riêng nào khác.
- Các lệnh còn lại dùng lại đúng hàm của nút trên toolbar và phím F2/F5/F6/F7/F8.

## Terminal local

Lần đầu trang Terminals hiện ra (và chưa có tab nào do Hosts yêu cầu), app mở sẵn một tab **Local**: một shell trên máy này. Đóng hết tab thì hiện form kết nối, có nút **Open local terminal** để mở lại.

- `main/local-shell.ts`: `LocalShellSession` bọc `node-pty` và có cùng giao diện `TerminalSession` với shell SSH, nên `TerminalHub` (gom output, back-pressure), bộ định tuyến, xterm, resize, copy/paste và sidebar lịch sử dùng chung, không có đường đi riêng. Yêu cầu `{ local: true }` đi qua `TerminalService.open`.
- Shell chọn như terminal của từng hệ điều hành (`shellCommand`, có unit test): `$SHELL` (macOS chạy dạng login shell `-l`), rơi về `/bin/zsh`/`/bin/bash`/`/bin/sh`; Windows dùng `powershell.exe`. Thư mục bắt đầu là thư mục home; `TERM=xterm-256color`.
- Đóng tab là kết thúc tiến trình shell (đã kiểm tra bằng PID). Gõ `exit` thì tab báo đã đóng và nút Reconnect mở shell mới.
- Sidebar lịch sử đọc trực tiếp `~/.bash_history`, `~/.zsh_history`, fish history của máy này (không hỗ trợ PSReadLine của PowerShell).
- **Gói native**: `node-pty` dùng N-API nên không cần rebuild theo phiên bản Electron (`npmRebuild: false` vẫn đúng). Bản npm kèm sẵn binary cho macOS và Windows; trên **Linux nó được biên dịch lúc `pnpm install`**, nên máy phát triển/CI Linux cần `python3`, `make`, `g++`. `pnpm-workspace.yaml` cho phép script cài đặt của `node-pty` (`onlyBuiltDependencies`), và `electron-builder.yml` đặt `asarUnpack` cho nó (macOS cần cả chương trình `spawn-helper` nằm ngoài app.asar).

## Chọn ứng dụng mở file (Open / Edit / Open with…)

Trước đây file trên server được tải về bản tạm rồi mở bằng ứng dụng mặc định của hệ điều hành, nên `.html` mở ra trình duyệt (trình duyệt không lưu ngược lên server). Giờ có ba cách mở, tính theo từng file:

- **Open** (nhấp đúp, Enter, menu): dùng ứng dụng đã lưu cho đuôi file đó, nếu không có thì ứng dụng đã lưu cho *mọi file*, nếu vẫn không có thì **hỏi**. Có thể chọn "ứng dụng mặc định của hệ thống".
- **Edit** (menu chuột phải, **F4**): như Open nhưng bắt buộc là một ứng dụng cụ thể (lựa chọn "mặc định hệ thống" bị bỏ qua), vì ứng dụng mặc định thường chỉ xem hoặc là trình duyệt.
- **Open with…**: luôn hỏi.

Hộp thoại hỏi cho chọn ứng dụng bằng hộp thoại hệ điều hành (`files.pickApp`) và cách nhớ: *luôn cho đuôi .ext* (mặc định), *luôn cho mọi file*, hoặc *chỉ lần này*. Lựa chọn chỉ được lưu sau khi mở thành công. Lưu ở `open-with.json` trong thư mục dữ liệu của app, **riêng từng máy** (không vào vault, không đồng bộ vì đường dẫn ứng dụng khác nhau mỗi máy). Settings → Open files with liệt kê và cho Forget từng mục.

Với file trên server, ứng dụng được chọn mở **bản tạm**, vẫn theo dõi thay đổi và tải lên mỗi lần lưu, phát hiện xung đột như cũ (`RemoteEditManager.openInEditor` nay nhận hàm khởi chạy riêng). Ứng dụng chạy bằng `execFile`/`open -a`/`start` (không qua shell, nên tên file không chèn được lệnh) và tách khỏi Mymius (`detached`). `files.open` không có tham số `options` vẫn giữ hành vi cũ (ứng dụng mặc định) để tương thích.

