# ORC Scanner — quét văn bản, bảng và sơ đồ (không dùng API AI)

Ứng dụng quét chữ từ **ảnh, PDF, DOCX, TXT/HTML**, tự nhận dạng **bảng** (kể cả ô gộp,
bảng không kẻ khung) và **sơ đồ/lưu đồ**, rồi **vẽ lại** thành bảng sửa được, SVG,
tệp draw.io và trang dựng lại. Mọi xử lý chạy **ngay trên máy bạn**: không gọi API AI,
không gửi tài liệu ra ngoài, dùng được cả khi **ngoại tuyến**.

## Vì sao là ứng dụng web (chạy cục bộ) thay vì phần mềm PC?

| Tiêu chí | Web (WASM, chạy cục bộ) | Phần mềm PC (Python/C#…) |
|---|---|---|
| Cài đặt | Không cần: mở trình duyệt là dùng, hoặc "Cài đặt ứng dụng" (PWA) để có biểu tượng như app PC | Phải cài Tesseract, Python, thư viện… theo từng máy |
| Hệ điều hành | Windows, macOS, Linux, cả máy tính bảng | Thường phải đóng gói riêng từng HĐH |
| Bảo mật | Tệp không rời máy (xử lý trong trình duyệt) | Như nhau |
| Tốc độ | Tesseract biên dịch WebAssembly (SIMD), ~2–5 giây/trang | Nhanh hơn một chút |
| Cập nhật | Chỉ cần triển khai lại một thư mục tĩnh | Phát hành bản cài mới |

→ Chọn **web chạy cục bộ**: cùng độ chính xác (cùng lõi Tesseract), không phải cài đặt, chạy
được trên mọi PC. Sau lần mở đầu tiên, service worker lưu đệm toàn bộ (kể cả dữ liệu ngôn ngữ)
nên dùng ngoại tuyến được.

## Tính năng

- **Đầu vào**: PNG, JPG, WEBP, BMP, GIF, AVIF, SVG · PDF (nhiều trang) · DOCX · TXT/MD/CSV/JSON · HTML.
  Kéo thả, chọn tệp hoặc **dán ảnh chụp màn hình bằng Ctrl+V**.
- **Nhận dạng chữ** tiếng Việt + tiếng Anh (Tesseract LSTM, dữ liệu `best_int`).
  - PDF có sẵn lớp chữ → lấy chữ trực tiếp (chính xác 100%, rất nhanh); PDF scan → OCR.
  - Tự phóng to ảnh nhỏ, tự chỉnh ảnh chụp bị nghiêng.
- **Bảng**
  - Bảng có kẻ khung: tìm đường ngang/dọc, dựng lưới, phát hiện **ô gộp** (rowspan/colspan).
  - Bảng không kẻ khung: nhận ra từ các cột chữ thẳng hàng.
  - Sửa trực tiếp từng ô; xuất **CSV, Excel, Markdown**, sao chép dán thẳng vào Excel.
  - Tùy chọn "OCR riêng từng ô" cho kết quả chính xác hơn với bảng dày đặc.
- **Sơ đồ / lưu đồ**
  - Nhận hình: chữ nhật, chữ nhật bo góc, elip/tròn, thoi, bình hành, đa giác bất kỳ.
  - Nhận đường nối: thẳng, gấp khúc (L, Z), **mũi tên** một/hai chiều, hình nguồn → đích.
  - Đọc chữ trong hình và nhãn trên đường nối.
  - **Vẽ lại** thành SVG/PNG, xuất **draw.io** (mở bằng diagrams.net để sửa tiếp) và **Mermaid**.
- **Dựng lại trang**: tái tạo trang với chữ, bảng, sơ đồ đúng vị trí; có thể chồng lên ảnh gốc để so sánh; tải về dạng HTML.
- **Vùng nhận dạng**: hiển thị khung chữ/bảng/hình/đường nối trên ảnh gốc để kiểm tra.
- **Xuất văn bản**: TXT, Markdown (bảng dạng Markdown, sơ đồ dạng Mermaid), Word (.doc), HTML.

## Dùng ngay trên GitHub (GitHub Pages)

App được tự động build và đăng lên GitHub Pages bởi workflow `.github/workflows/main.yml`
mỗi khi đẩy mã lên nhánh chính. Địa chỉ: **https://silentword142.github.io/ORC-Claude/**

Thiết lập một lần: vào **Settings → Pages → Build and deployment → Source**, chọn
**GitHub Actions**. Sau đó vào tab **Actions**, chạy lại workflow "Deploy GitHub Pages"
(hoặc đẩy một commit mới). Khi workflow xanh, mở địa chỉ trên là dùng được.

## Cài đặt & chạy trên máy

Yêu cầu: Node.js 18+ (chỉ cần khi build; người dùng cuối chỉ cần trình duyệt).

```bash
npm install          # tự sao chép lõi OCR + dữ liệu tiếng Việt/Anh vào public/
npm run dev          # chạy thử: http://localhost:5173
npm run build        # tạo thư mục dist/ (web tĩnh, chạy offline)
npm run preview      # xem bản build
```

Triển khai: chép thư mục `dist/` lên bất kỳ máy chủ web tĩnh nào (GitHub Pages, Nginx, IIS,
máy chủ nội bộ…). Trên Chrome/Edge bấm biểu tượng **Cài đặt ứng dụng** ở thanh địa chỉ để dùng
như phần mềm PC.

> Lưu ý: cần mở qua `http://`/`https://` (không mở trực tiếp `file://index.html`) vì WebAssembly
> và Web Worker yêu cầu vậy.

## Cách hoạt động (không dùng AI API)

```
Tệp ─► trang (canvas) ─► chỉnh nghiêng ─► ảnh xám ─► nhị phân hóa thích nghi (Bradley + Otsu)
                                                        │
      ┌──────────── đường kẻ ngang/dọc (mở hình thái học) ┘
      ├─► lưới bảng + ô gộp ─► xóa đường kẻ ─► Tesseract OCR ─► gán chữ vào ô
      ├─► sơ đồ: vùng nền khép kín = hình ─► phân loại theo biên dạng độ rộng
      │         xóa viền hình ─► thành phần còn lại = đường nối ─► đầu mút, mũi tên, gấp khúc
      │         OCR lại chữ trong hình + nhãn (chế độ chữ thưa)
      └─► bảng không kẻ: cụm chữ thẳng cột qua nhiều dòng
                                   ▼
             khối theo thứ tự đọc ─► văn bản / bảng / SVG / draw.io / trang dựng lại
```

- `src/core/imageproc.js` — nhị phân hóa, thành phần liên thông, mặt nạ đường thẳng, giãn nở, ước lượng góc nghiêng.
- `src/core/table.js` — bảng có kẻ (lưới + ô gộp) và không kẻ.
- `src/core/diagram.js` — hình, đường nối, mũi tên, nhãn.
- `src/core/analyze.js` — luồng phân tích một trang.
- `src/core/export.js` — CSV, Markdown, SVG, draw.io, Mermaid, trang dựng lại.
- `src/ocr.js`, `src/loaders.js`, `src/main.js` — OCR (Tesseract.js), đọc tệp (pdf.js, mammoth), giao diện.

Các thuật toán lõi là JavaScript thuần, không phụ thuộc trình duyệt, nên kiểm thử được bằng Node.

## Kiểm thử

```bash
npm test             # kiểm thử thuật toán trên ảnh tổng hợp (bảng, ô gộp, sơ đồ, góc nghiêng)
npm run build && npm run test:e2e   # đầu-cuối trong Chromium với ảnh PNG và PDF mẫu
```

## Giới hạn

- Chữ viết tay, ảnh chụp mờ/tối hoặc nền phức tạp cho kết quả OCR kém hơn.
- Sơ đồ: hỗ trợ tốt lưu đồ/sơ đồ khối nét rõ; đường cong, hình chồng lấn phức tạp, biểu đồ
  (chart) và hình vẽ tự do chưa được dựng lại chính xác.
- Bảng không kẻ khung dựa trên căn cột, có thể nhầm với văn bản nhiều cột căn đều.
- Định dạng .doc/.xls cũ và TIFF chưa hỗ trợ (hãy chuyển sang DOCX/PDF/PNG).
