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
        result = md.convert(file_path)
        title = getattr(result, 'title', None) or os.path.splitext(os.path.basename(file_path))[0]
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
