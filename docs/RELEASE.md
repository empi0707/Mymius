# Tạo bản release

Dành cho người phát hành. Người dùng cuối chỉ cần cài bộ cài và bấm **Sign in**.

## Chuẩn bị (một lần)

- Node ≥ 22 và pnpm 10 (`corepack enable`).
- `pnpm install`
- Nhúng khóa dịch vụ vào bản build để máy khác không phải nhập (xem `docs/DROPBOX_SETUP.md`):
  ```bash
  cp apps/desktop/.env.example apps/desktop/.env   # điền MAIN_VITE_DROPBOX_APP_KEY=...
  ```
  Biến `MAIN_VITE_*` được ghi vào file build lúc `electron-vite build`. Đổi khóa thì phải build lại.
- (Tùy chọn) icon: đặt `icon.png` (≥ 512×512) vào `apps/desktop/build/`. Chưa có thì app dùng icon Electron mặc định.

## Trước khi build

```bash
pnpm typecheck && pnpm test
```

Đổi số phiên bản trong `apps/desktop/package.json` (`"version"`); tên file cài đặt lấy từ đây.

## Build

Mỗi hệ điều hành build trên chính hệ điều hành đó (build chéo bị hạn chế: `.exe` cần wine, `.dmg` cần macOS).

| Máy build | Lệnh | Kết quả trong `apps/desktop/release/` |
|---|---|---|
| Linux | `pnpm dist` | `Mymius-<ver>-linux-x86_64.AppImage`, `Mymius-<ver>-linux-amd64.deb` |
| Windows | `pnpm dist` | `Mymius-<ver>-win-x64.exe` (bộ cài NSIS), `.zip` |
| macOS | `pnpm dist` | `.dmg`, `.zip` |

Chỉ một định dạng: `pnpm --filter @mymius/desktop exec electron-builder --linux AppImage` (hoặc `--win nsis`, `--mac dmg`).
Chỉ kiểm tra đóng gói, không tạo bộ cài: thêm `--dir`.

`pnpm dist` chạy `electron-vite build` rồi `electron-builder`. Không có auto-update: phát bộ cài mới cho cả nhóm mỗi khi nâng phiên bản.

## Kiểm tra bản build

1. Cài hoặc chạy thử trên máy sạch, mở app, tạo vault.
2. Settings → Cloud account: phải hiện nút **Sign in with Dropbox** (không hỏi App key). Nếu vẫn hỏi, `.env` chưa có khóa lúc build.
3. Kết nối thử một máy SSH và mở một thư mục bên phải.

## Ký số (tùy chọn)

- **Windows**: chưa ký thì SmartScreen báo "unknown publisher"; bấm *More info → Run anyway*. Để ký, đặt `CSC_LINK` (đường dẫn `.pfx`) và `CSC_KEY_PASSWORD` trước khi build.
- **macOS**: cần `CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (và team id) để ký và notarize. Không ký thì người dùng phải chuột phải → Open lần đầu.
- **Linux**: không cần ký. AppImage cần `chmod +x`; trên vài bản mới có thể phải chạy với `--no-sandbox`, hoặc cài `.deb`.

## Build tự động trên CI

Job `package` trong `.github/workflows/ci.yml` chạy `electron-builder --dir` trên Ubuntu, Windows, macOS để bắt lỗi đóng gói (không sinh bộ cài, không có khóa Dropbox). Muốn CI tạo bộ cài phát hành, thêm bước `pnpm dist` kèm secret `MAIN_VITE_DROPBOX_APP_KEY` và tải `apps/desktop/release/*` làm artifact.

## Chưa xác minh

Đã build và chạy thử trên Linux (AppImage, deb). Windows và macOS chưa từng được build hay chạy thật.
