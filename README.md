# Lucky Quiz

Website Lucky Quiz chạy bằng Node.js thuần, thiết kế mobile-first. Chương trình được nạp sẵn 9 mã voucher Lotteria lấy từ tài liệu cung cấp, trao tối đa một mã trên một phiên và không gửi danh sách mã xuống trình duyệt trước khi phát hành.

## Chạy local

Yêu cầu Node.js 20 trở lên. Không cần cài thêm package.

1. Sao chép `.env.example` thành `.env`.
2. Đặt `ADMIN_PASSWORD` thành mật khẩu mạnh, riêng tư. Đặt `SESSION_SECRET` thành chuỗi ngẫu nhiên dài ít nhất 32 ký tự. Ví dụ: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. Mở terminal tại thư mục dự án và chạy `npm start`.
4. Truy cập `http://localhost:3000`; trang quản trị ở `/admin.html`.

Node.js không tự nạp `.env`. Trước khi chạy, khai báo các biến trong môi trường terminal. PowerShell:

```powershell
$env:ADMIN_PASSWORD = "your-long-private-password"
$env:SESSION_SECRET = "your-random-secret-at-least-32-characters"
npm start
```

Dữ liệu tham gia và voucher được lưu trong `data/store.json` (tự tạo lần đầu chạy). Sao lưu tệp này an toàn và hạn chế quyền truy cập vì có thông tin cá nhân. Không đưa thư mục `data` lên Git.

## Cấu hình và chức năng

- `server.mjs` chứa API, cấu hình chương trình, câu hỏi và 9 mã voucher riêng tư.
- Quản trị viên đăng nhập bằng `ADMIN_PASSWORD`; có thể đổi thời gian chương trình, bật yêu cầu trả lời đúng, bật thu thập email, thêm câu hỏi và xuất danh sách voucher CSV.
- Trường họ tên và số điện thoại được bật mặc định; email tùy chọn. Checkbox quyền riêng tư luôn để trống ban đầu.
- Dữ liệu demo của chương trình, câu hỏi và một giải voucher được khai báo trong `seed` tại `server.mjs`. Chỉnh sửa seed trước lần chạy đầu nếu cần đổi câu hỏi hoặc nội dung thể lệ. Các mã voucher là mã thật đã chép từ tài liệu người dùng cung cấp.
- Mã phát ra đúng một lần, mỗi phiên chơi tối đa một lượt quay; điện thoại tham gia lại bị từ chối. Phần thưởng được xác định, trừ kho và ghi sổ tại backend.

## Triển khai

Dùng máy chủ Node.js 20+ có ổ đĩa bền vững; cấu hình biến `ADMIN_PASSWORD`, `SESSION_SECRET`, `PORT`, `PUBLIC_ORIGIN`. Bật HTTPS tại reverse proxy và đặt `NODE_ENV=production` để bật cookie Secure. Sao lưu dữ liệu định kỳ. Bản triển khai này phù hợp cho bản demo hoặc lưu lượng thấp trên một tiến trình máy chủ. Trước khi dùng cho chiến dịch thương mại quy mô lớn, cần chuyển kho JSON sang PostgreSQL với transaction/unique constraints, thêm cơ chế đăng nhập admin theo tài khoản và kiểm tra điều kiện đổi voucher với hệ thống bán hàng Lotteria. Không đặt nhiều tiến trình trên cùng tệp JSON.

### Vercel

Vercel serves the files in `public/` and routes `/api/*` to `api/[...path].mjs`. The serverless API does not start a long-running HTTP listener or read/write the deployment filesystem. It stores campaign state, voucher inventory, and sessions in Upstash Redis under one serialized state key and a short-lived distributed lock. This keeps the inventory check and voucher issue serialized across function instances.

Before redeploying:

1. Add the Upstash Redis integration to the Vercel project. It provides `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. Add `ADMIN_PASSWORD` and a random `SESSION_SECRET` (at least 32 characters) in Vercel Project Settings → Environment Variables for Production and Preview as needed.
3. Redeploy the latest commit. The first API call initializes the demo campaign and the nine supplied voucher codes in Redis.

If storage or security variables are missing, the API returns a clear `503` setup response instead of crashing the function. Keep these credentials private; never add them to source control.

## Kiểm tra thủ công

Chạy `npm start`, hoàn thành luồng người chơi, kiểm tra một mã được hiển thị sau vòng quay và thử lại cùng số điện thoại. Đăng nhập `/admin.html`, xác nhận thống kê cập nhật, tải CSV và cấu hình kết thúc chương trình để kiểm tra trạng thái đóng. Không có bộ kiểm thử tự động đi kèm.
