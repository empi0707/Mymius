# Cấu hình Google Drive sync

Mymius không kèm sẵn khóa Google; bạn tạo OAuth client của riêng mình (miễn phí).

1. Vào Google Cloud Console, tạo project mới.
2. **APIs & Services → Library**: bật **Google Drive API**.
3. **OAuth consent screen**: loại External, điền tên app và email.
   - Thêm scope `.../auth/drive.appdata` (cùng `openid`, `email`).
   - **Publish app → "In production"**. Nếu để "Testing", refresh token hết hạn sau **7 ngày** và phải đăng nhập lại. Scope `drive.appdata` không cần Google duyệt.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Lấy **Client ID** và **Client secret** (với app Desktop, secret không được coi là bí mật).
5. Trong Mymius: **Settings → Google Drive**, dán Client ID/Secret, bấm **Connect** và đăng nhập trong trình duyệt.
6. Máy khác: cấu hình cùng Client ID, ở màn hình tạo vault chọn khôi phục từ Drive, nhập passphrase.

Ghi chú: dữ liệu trên Drive được mã hóa; Google chỉ thấy file mờ trong `appDataFolder`. Chưa thử với Google thật trong phiên phát triển này.
