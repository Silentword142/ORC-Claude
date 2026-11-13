#!/usr/bin/env python3
"""
Microsoft MarkItDown Bridge Service
Chuyển đổi đa định dạng văn bản sang Markdown với Microsoft MarkItDown.
Hỗ trợ cả chế độ CLI một lần và chế độ Local HTTP Server phục vụ cho Electron / Desktop App.
"""

import sys
import os
import json
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    from markitdown import MarkItDown
    _has_markitdown = True
except ImportError:
    _has_markitdown = False

def convert_url(url, languages=None):
    if not _has_markitdown:
        return {
            "success": False,
            "error": "Thư viện 'markitdown' chưa được cài đặt. Vui lòng chạy: pip install markitdown[all]",
            "markdown": ""
        }

    try:
        md = MarkItDown()
        langs = languages or ["vi", "en"]
        try:
            result = md.convert_uri(url, youtube_transcript_languages=langs)
        except Exception:
            result = md.convert_uri(url)
        title = getattr(result, 'title', None) or url
        text_content = result.text_content or ""
        return {
            "success": True,
            "title": title,
            "markdown": text_content,
            "error": None
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "markdown": ""
        }


def _doc_text_to_markdown(raw_text):
    import re
    # Loại bỏ mã trường Word (\x13...\x14...\x15)
    raw_text = re.sub(r'\x13[^\x14\x15]*\x14([^\x15]*)\x15', r'\1', raw_text)
    raw_text = re.sub(r'\x13[^\x15]*\x15', '', raw_text)
    raw_text = raw_text.replace('\r\n', '\n').replace('\r', '\n')
    raw_text = raw_text.replace('\x0b', '\n').replace('\x0c', '\n\n')

    lines_out = []
    table_rows = []

    def flush_table():
        if not table_rows:
            return
        max_cols = max(len(r) for r in table_rows)
        if max_cols > 0:
            norm = [r + [''] * (max_cols - len(r)) for r in table_rows]
            lines_out.append('')
            lines_out.append('| ' + ' | '.join(norm[0]) + ' |')
            lines_out.append('| ' + ' | '.join(['---'] * max_cols) + ' |')
            for r in norm[1:]:
                lines_out.append('| ' + ' | '.join(r) + ' |')
            lines_out.append('')
        table_rows.clear()

    # Trong Word .doc, ô bảng kết thúc bằng \x07 và hàng kết thúc bằng \x07\x07
    parts = raw_text.split('\x07\x07')
    for idx, part in enumerate(parts):
        if '\x07' in part:
            # Có thể có đoạn văn trước hàng bảng
            seg_lines = part.split('\n')
            # Tách phần không chứa \x07 ở đầu nếu có
            row_buf = []
            for ln in seg_lines:
                if '\x07' in ln or row_buf:
                    row_buf.append(ln)
                else:
                    flush_table()
                    clean = re.sub(r'[\x00-\x08\x0e-\x1f]', '', ln).strip()
                    if clean:
                        lines_out.append(clean)
            row_str = '\n'.join(row_buf)
            cells = [re.sub(r'[\x00-\x08\x0e-\x1f]', '', c).replace('\n', '<br>').replace('|', '\\|').strip()
                     for c in row_str.split('\x07')]
            if cells and cells[-1] == '':
                cells.pop()
            if cells:
                table_rows.append(cells)
        else:
            flush_table()
            for ln in part.split('\n'):
                clean = re.sub(r'[\x00-\x08\x0e-\x1f]', '', ln).strip()
                if clean:
                    lines_out.append(clean)
    flush_table()
    return '\n\n'.join(lines_out) if lines_out else ''


def _extract_ole2_doc_markdown(file_path):
    import struct
    import olefile

    if not olefile.isOleFile(file_path):
        raise ValueError("Không phải tệp OLE2 Word hợp lệ")

    with olefile.OleFileIO(file_path) as ole:
        if not ole.exists("WordDocument"):
            raise ValueError("Thiếu luồng WordDocument trong tệp .doc")
        word_stream = ole.openstream("WordDocument").read()

        flags = struct.unpack_from("<H", word_stream, 0x000A)[0]
        table_name = "1Table" if (flags & 0x0200) else "0Table"
        if not ole.exists(table_name):
            raise ValueError(f"Thiếu luồng {table_name} trong tệp .doc")
        table_stream = ole.openstream(table_name).read()

        # Tính offset tới FibRgFcLcb từ cấu trúc FIB động
        pos = 32
        csw = struct.unpack_from("<H", word_stream, pos)[0]
        pos += 2 + csw * 2
        cslw = struct.unpack_from("<H", word_stream, pos)[0]
        pos += 2 + cslw * 4
        cb_rg_fc_lcb = struct.unpack_from("<H", word_stream, pos)[0]
        pos += 2

        if cb_rg_fc_lcb <= 33:
            raise ValueError("Định dạng Word quá cũ (trước Word 97)")

        fc_clx, lcb_clx = struct.unpack_from("<II", word_stream, pos + 33 * 8)
        clx = table_stream[fc_clx:fc_clx + lcb_clx]

        c_pos = 0
        while c_pos < len(clx):
            clxt = clx[c_pos]
            if clxt == 1:
                cb_grpprl = struct.unpack_from("<H", clx, c_pos + 1)[0]
                c_pos += 3 + cb_grpprl
            elif clxt == 2:
                lcb = struct.unpack_from("<I", clx, c_pos + 1)[0]
                plc_pcd = clx[c_pos + 5:c_pos + 5 + lcb]
                break
            else:
                raise ValueError("Không tìm thấy bảng mảnh văn bản (PlcPcd)")
        else:
            raise ValueError("Không tìm thấy bảng mảnh văn bản (PlcPcd)")

        n = (len(plc_pcd) - 4) // 12
        cps = struct.unpack_from(f"<{n + 1}I", plc_pcd, 0)
        pcd_offset = (n + 1) * 4

        chunks = []
        for i in range(n):
            char_count = cps[i + 1] - cps[i]
            fc = struct.unpack_from("<I", plc_pcd, pcd_offset + i * 8 + 2)[0]
            if fc & 0x40000000:
                offset = (fc & ~0x40000000) // 2
                raw = word_stream[offset:offset + char_count]
                chunks.append(raw.decode("cp1252", errors="replace"))
            else:
                offset = fc
                raw = word_stream[offset:offset + char_count * 2]
                chunks.append(raw.decode("utf-16le", errors="replace"))

        full_text = "".join(chunks)
        # Chỉ lấy phần thân tài liệu chính (ccpText tại offset 0x004C)
        ccp_text = struct.unpack_from("<I", word_stream, 0x004C)[0]
        if 0 < ccp_text <= len(full_text):
            full_text = full_text[:ccp_text]

        return _doc_text_to_markdown(full_text)


def convert_legacy_doc(file_path, md):
    import shutil
    import subprocess
    import tempfile

    with open(file_path, "rb") as f:
        head = f.read(64)

    head_low = head.lstrip().lower()
    # Một số file .doc tải từ web thực chất là .docx, .rtf hoặc .html
    if head.startswith(b"PK\x03\x04"):
        return md.convert(file_path, file_extension=".docx").text_content or ""
    if head_low.startswith(b"{\\rtf"):
        return md.convert(file_path, file_extension=".rtf").text_content or ""
    if head_low.startswith((b"<html", b"<!doctype", b"<?xml", b"mime-version:")):
        return md.convert(file_path, file_extension=".html").text_content or ""

    # Thử dùng Microsoft Word COM trên Windows hoặc LibreOffice để chuyển sang .docx chuẩn 100%
    with tempfile.TemporaryDirectory() as tmpdir:
        out_docx = os.path.join(tmpdir, "converted.docx")

        if os.name == "nt":
            ps_script = (
                "$ErrorActionPreference='Stop';"
                "$w = New-Object -ComObject Word.Application;"
                "$w.Visible = $false; $w.DisplayAlerts = 0;"
                "try {"
                f"  $d = $w.Documents.Open('{file_path.replace(chr(39), chr(39)*2)}', $false, $true);"
                f"  $d.SaveAs2('{out_docx.replace(chr(39), chr(39)*2)}', 16);"
                "  $d.Close($false);"
                "} finally { $w.Quit(); }"
            )
            try:
                r = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                    capture_output=True, timeout=45
                )
                if r.returncode == 0 and os.path.exists(out_docx):
                    return md.convert(out_docx).text_content or ""
            except Exception:
                pass

        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice and os.name == "nt":
            cand = r"C:\Program Files\LibreOffice\program\soffice.exe"
            if os.path.exists(cand):
                soffice = cand
        if soffice:
            try:
                subprocess.run(
                    [soffice, "--headless", "--convert-to", "docx", "--outdir", tmpdir, file_path],
                    capture_output=True, timeout=45
                )
                cand_docx = os.path.join(tmpdir, os.path.splitext(os.path.basename(file_path))[0] + ".docx")
                if os.path.exists(cand_docx):
                    return md.convert(cand_docx).text_content or ""
            except Exception:
                pass

    # Fallback thuần Python (không cần cài Word hay LibreOffice)
    return _extract_ole2_doc_markdown(file_path)


def convert_file(file_path, languages=None):
    if isinstance(file_path, str) and (file_path.startswith("http://") or file_path.startswith("https://")):
        return convert_url(file_path, languages=languages)

    if not _has_markitdown:
        return {
            "success": False,
            "error": "Thư viện 'markitdown' chưa được cài đặt. Vui lòng chạy: pip install markitdown[all]",
            "markdown": ""
        }
    
    if not os.path.exists(file_path):
        return {
            "success": False,
            "error": f"Không tìm thấy tệp: {file_path}",
            "markdown": ""
        }
    
    try:
        md = MarkItDown()
        title = os.path.splitext(os.path.basename(file_path))[0]
        if file_path.lower().endswith(".doc"):
            text_content = convert_legacy_doc(file_path, md)
        else:
            result = md.convert(file_path)
            title = getattr(result, 'title', None) or title
            text_content = result.text_content or ""
        return {
            "success": True,
            "title": title,
            "markdown": text_content,
            "error": None
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "markdown": ""
        }

class MarkItDownHandler(BaseHTTPRequestHandler):
    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._set_cors_headers()
            self.end_headers()
            status = {
                "status": "ok",
                "engine": "Microsoft MarkItDown",
                "available": _has_markitdown
            }
            self.wfile.write(json.dumps(status).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/convert":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode("utf-8"))
                url = data.get("url")
                file_path = data.get("filePath")
                languages = data.get("languages")
                if url:
                    res = convert_url(url, languages=languages)
                elif file_path:
                    res = convert_file(file_path, languages=languages)
                else:
                    res = {"success": False, "error": "Thiếu tham số 'filePath' hoặc 'url'"}
            except Exception as e:
                res = {"success": False, "error": f"Lỗi xử lý yêu cầu: {e}"}

            self.send_response(200 if res.get("success") else 400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(res, ensure_ascii=False).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # Ẩn bớt log request thông thường
        pass

def run_server(port=0):
    server_address = ("127.0.0.1", port)
    httpd = HTTPServer(server_address, MarkItDownHandler)
    actual_port = httpd.server_port
    print(f"MARKITDOWN_SERVER_READY:{actual_port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()

def main():
    parser = argparse.ArgumentParser(description="Microsoft MarkItDown Bridge Service")
    subparsers = parser.add_subparsers(dest="command")

    # CLI convert
    convert_parser = subparsers.add_parser("convert", help="Chuyển đổi một tệp sang Markdown")
    convert_parser.add_argument("file_path", help="Đường dẫn tệp cần chuyển đổi")
    convert_parser.add_argument("-o", "--output", help="Đường dẫn lưu file .md kết quả")

    # Serve HTTP
    server_parser = subparsers.add_parser("serve", help="Chạy HTTP service phục vụ Electron / App Desktop")
    server_parser.add_argument("-p", "--port", type=int, default=49152, help="Cổng chạy service (mặc định 49152)")

    args = parser.parse_args()

    if args.command == "convert":
        res = convert_file(args.file_path)
        if args.output and res["success"]:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(res["markdown"])
        print(json.dumps(res, ensure_ascii=False, indent=2))
        sys.exit(0 if res["success"] else 1)
    elif args.command == "serve":
        run_server(args.port)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
