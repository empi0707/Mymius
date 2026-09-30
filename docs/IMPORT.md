# Nhập host cũ từ ForkLift và OpenSSH

Vào **Hosts → Import…**, chọn nguồn, chọn file, xem danh sách sẽ được nhập, bỏ chọn những host không muốn rồi bấm **Import**. File được đọc ngay trên máy.

| Nguồn | File | Nhập được | Không nhập được |
|---|---|---|---|
| **ForkLift** | `~/Library/Application Support/ForkLift/Favorites/Favorites.json` (ForkLift 3) | mục SFTP: host, port, user, thư mục ban đầu (vào ghi chú), thư mục chứa làm nhóm | FTP, WebDAV, S3, SMB...; mật khẩu (nằm trong Keychain của macOS) |
| **OpenSSH** | `~/.ssh/config` | mọi `Host` cụ thể, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump` (nối với host trong file hoặc host đã có trong vault) | khối `Match`, `Include`, `ProxyCommand`, ký hiệu `%h`... |

## Quy tắc chung

- **Trùng lặp**: host có cùng địa chỉ (không phân biệt hoa thường), port và user với host đã có trong vault được đánh dấu "đã có trong vault" và mặc định **không** được chọn.
- **Không có username**: dùng tên tài khoản của máy này (giống `ssh`), và ghi rõ trong danh sách. Nếu không xác định được thì host bị bỏ qua.
- **Không có thông tin đăng nhập trong file**: host dùng ssh-agent; hãy sửa host để thêm mật khẩu hoặc khóa. `IdentityFile` giữ nguyên làm đường dẫn khóa *trên máy này* (không đọc nội dung khóa).
- **Jump host**: `ProxyJump` tên-trần được nối với host cùng tên trong file, hoặc trong vault. `ProxyJump a,b` chỉ nối chặng cuối. Dạng `user@host:port` không nối được và được ghi vào ghi chú.
- **Giới hạn**: file tối đa 5 MB, 5000 host. Tên host bắt đầu bằng `-` bị từ chối (ssh sẽ đọc thành tùy chọn).
- Nhập host cũng kích hoạt **Auto backup** như thêm host thông thường.

## Chưa xác minh

Cấu trúc của `Favorites.json` (ForkLift) **không được tài liệu hóa** và trình đọc ForkLift **chưa được thử với file thật**: nó tìm các mục có địa chỉ/URL, giao thức, user và port dưới những tên khóa thông dụng. Nếu file thật khác, bạn sẽ thấy thông báo "không nhận ra mục nào" thay vì nhập sai. ForkLift 4 lưu favorites trong database (`~/Library/Group Containers/J3CP9BBBN6.com.binarynights.ForkLift`) nên chưa đọc được; cách thay thế là dùng ForkLift 3 để lấy `Favorites.json`, hoặc nhập host thủ công.
