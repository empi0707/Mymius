# Cấu hình đồng bộ qua Dropbox

Dùng cho nhóm nhỏ (khoảng 20 người) không có Google Workspace. Không cần domain, không cần Google duyệt. Một app Dropbox được tạo **một lần** rồi nhúng vào bản build; mỗi người chỉ bấm **Sign in with Dropbox**.

## Tạo app (một lần, bởi người phát hành)

1. Vào <https://www.dropbox.com/developers/apps> → **Create app**.
2. Chọn **Scoped access** → **App folder** → đặt tên (vd. `Mymius`). Tên này cũng là tên thư mục `Apps/Mymius` trong Dropbox của mỗi người.
3. Tab **Permissions**: bật **cả bốn** quyền `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write` → **Submit**. (Thiếu `files.metadata.read` thì app báo lỗi 400 "not permitted to access this endpoint" khi liệt kê file.)
   Nếu bạn bật thêm quyền sau khi đã có người đăng nhập, token cũ không tự có quyền mới: người đó phải **Sign in again**.
4. Tab **Settings**: chép **App key**. Không cần App secret (đăng nhập dùng PKCE) và không cần đăng ký Redirect URI (app dùng luồng "dán mã", không chuyển hướng).
5. Nhúng App key vào bản build để các máy khác **không phải nhập key**, chỉ bấm Sign in:
   ```bash
   cp apps/desktop/.env.example apps/desktop/.env      # rồi điền MAIN_VITE_DROPBOX_APP_KEY=<app key>
   pnpm dist                                           # tạo bộ cài đặt; gửi bộ cài này cho mọi người
   ```
   (Hoặc đặt biến môi trường `MAIN_VITE_DROPBOX_APP_KEY=<app key> pnpm dist`.) File `.env` không bị commit.

   **Lưu ý:** App key nhập tay trong Settings chỉ lưu trên *máy đó* (`drive-settings.json`), không đi theo vault. Máy nào cài bản build *không* nhúng key sẽ vẫn hỏi App key. Vì vậy hãy phát cùng một bộ cài đã nhúng key cho cả nhóm.

## Giới hạn của Dropbox cần biết

- App ở trạng thái **development** chỉ liên kết được tối đa **500** tài khoản. Khi đã liên kết 50 người, Dropbox cho hai tuần để xin lên production (mô tả cách dùng API + icon). Với khoảng 20 người bạn không chạm ngưỡng này.
- App folder chỉ thấy đúng thư mục `Apps/<tên app>`, không thấy file Dropbox khác của người dùng.
- Dung lượng file đồng bộ tính vào quota Dropbox của từng người (vài KB đến vài MB).

## Cách đăng nhập

1. Settings → Cloud account → **Sign in with Dropbox**. Trình duyệt mở trang Dropbox.
2. Bấm **Allow**. Dropbox hiện một mã ngắn.
3. Dán mã vào ô "Mã từ Dropbox" → **Finish sign-in**.
4. Máy mới: ở màn hình tạo vault, đăng nhập Dropbox tương tự; vault được khôi phục và mở khóa bằng passphrase đã chọn ở máy đầu.

## Chưa xác minh

Mọi thứ mới chỉ được kiểm thử với **Dropbox giả** (`fake-dropbox.ts`), không phải Dropbox thật. Cần kiểm tra khi có App key thật:

- luồng lấy mã không chuyển hướng với PKCE và `token_access_type=offline` có trả refresh token như mong đợi;
- gốc thư mục App folder là đường dẫn rỗng `""` khi liệt kê;
- các chuỗi lỗi (`path/conflict`, `path/insufficient_space`, `expired_access_token`) và cơ chế `Retry-After`;
- giới hạn tốc độ thực tế.

Nếu một trong các điểm trên khác, phần sửa nằm trọn trong `packages/drive-sync/src/dropbox.ts` và `dropbox-oauth.ts`.
