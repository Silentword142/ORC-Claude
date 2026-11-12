@echo off
chcp 65001 >nul
echo Đang khởi động ORC MarkItDown Studio trên Windows...

if not exist .venv (
    echo Khởi tạo môi trường Python MarkItDown lần đầu...
    python -m venv .venv
    call .venv\Scripts\activate.bat
    pip install -r requirements.txt
)

call npm run electron:dev
