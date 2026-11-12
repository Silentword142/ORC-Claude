@echo off
chcp 65001 >nul
echo ========================================================
echo   ĐÓNG GÓI ỨNG DỤNG WINDOWS: ORC MARKITDOWN STUDIO (.EXE)
echo ========================================================
echo.

REM 1. Cài đặt dependencies Node.js
echo [1/3] Đang cài đặt thư viện Node.js / Electron...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [LỖI] Không thể cài đặt npm packages. Vui lòng kiểm tra lại Node.js!
    pause
    exit /b %ERRORLEVEL%
)

REM 2. Thiết lập môi trường Python MarkItDown
echo.
echo [2/3] Đang chuẩn bị môi trường Python và Microsoft MarkItDown...
if not exist .venv (
    python -m venv .venv
)
call .venv\Scripts\activate.bat
pip install -r requirements.txt

REM 3. Đóng gói ứng dụng thành file thực thi Windows (.exe)
echo.
echo [3/3] Đang đóng gói ứng dụng Windows (.exe) vào thư mục release\...
call npm run package:win
if %ERRORLEVEL% NEQ 0 (
    echo [LỖI] Quá trình đóng gói thất bại.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ========================================================
echo   HOÀN TẤT ĐÓNG GÓI!
echo   Bản cài đặt Setup (.exe) và bản chạy ngay Portable (.exe)
echo   đã được lưu tại thư mục: release\
echo ========================================================
pause
