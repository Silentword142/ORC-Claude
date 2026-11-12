# ORC MarkItDown Studio — Chuyển đổi mọi định dạng sang Markdown (.md) chính xác 100%

Ứng dụng Windows và Web đa nền tảng kết hợp **Microsoft MarkItDown**, **ORC Scanner (Offline Tesseract)** và **Claude AI Vision**, chuyên chuyển đổi mọi định dạng văn bản sang file Markdown (`.md`) với độ toàn vẹn cấu trúc cao nhất.

---

## 🌟 Ba động cơ chuyển đổi (Hybrid Engine)

| Động cơ | Định dạng tối ưu | Độ chính xác & Đặc điểm |
|---|---|---|
| **Microsoft MarkItDown** *(Mới)* | `DOCX`, `XLSX`, `PPTX`, `PDF`, `HTML`, `EPUB`, `RTF`, `CSV`, `JSON`, `Audio` | **100% chính xác**: Không qua OCR, trích xuất cấu trúc văn bản gốc (tiêu đề H1-H6, in đậm/nghiêng, link, danh sách, bảng GFM Table). |
| **Claude AI Vision** | Tài liệu scan mờ, chữ viết tay, bảng biểu phức tạp, lưu đồ & sơ đồ | **~99% chính xác**: Nhận diện ngữ cảnh, tự động sinh mã biểu đồ **Mermaid** và bảng phức tạp có ô gộp. |
| **Offline Tesseract WASM** | Ảnh chụp, tài liệu in scan ngoại tuyến | Miễn phí 100%, không cần kết nối mạng, xử lý ngay trong máy tính cá nhân. |

---

## 🚀 Chạy và đóng gói ứng dụng Windows (.exe)

### Cách 1: Đóng gói thành file cài đặt hoặc Portable .exe (1-Click)
Nhấp đúp chuột vào file:
```cmd
build-windows.bat
```
Script sẽ tự động:
1. Cài đặt các gói Node.js và môi trường Python (`requirements.txt`).
2. Build ứng dụng và đóng gói thành file `.exe` (bản cài đặt NSIS Setup + bản chạy ngay Portable) đặt tại thư mục `release/`.

### Cách 2: Khởi chạy nhanh chế độ Desktop (Dev Mode)
Nhấp đúp chuột vào file:
```cmd
start-windows.bat
```
Hoặc chạy lệnh từ terminal:
```bash
npm run electron:dev
```

### Cách 3: Dùng trên Web / Trình duyệt
```bash
npm install
npm run dev
```
Mở trình duyệt tại `http://localhost:5173`.

---

## 📋 Tính năng nổi bật

- **Hỗ trợ đầy đủ định dạng**:
  - **Office**: Word (`.docx`, `.doc`), Excel (`.xlsx`, `.xls`), PowerPoint (`.pptx`, `.ppt`).
  - **Tài liệu số**: PDF (cả lớp chữ và trang scan), HTML, EPUB, RTF, CSV, JSON, TXT.
  - **Hình ảnh**: PNG, JPG, WEBP, BMP, GIF, AVIF, SVG (kéo thả hoặc `Ctrl+V` ảnh dán).
- **Tab Markdown chuyên dụng**:
  - Xem trước Markdown trực quan (Rendered Preview) song song với Mã nguồn (Raw Source).
  - Tự động xuất bảng chuẩn GFM (`| Cột 1 | Cột 2 |`).
  - Tự động xuất lưu đồ/sơ đồ sang khối code ````mermaid ````.
- **Tính năng Desktop Windows**:
  - Hộp thoại chọn tệp và chọn cả thư mục (Batch conversion).
  - Nút **"Lưu tất cả cạnh file gốc"**: Tự động tạo file `.md` ngay cạnh file tài liệu nguồn chỉ với 1 cú nhấp chuột.
  - Hỗ trợ lưu trữ ngoại tuyến tuyệt đối an toàn.

---

## 🛠 Yêu cầu hệ thống

- **Hệ điều hành**: Windows 10/11 (64-bit).
- **Node.js**: >= 18.x
- **Python**: >= 3.10 (phục vụ engine Microsoft MarkItDown: `pip install -r requirements.txt`).
