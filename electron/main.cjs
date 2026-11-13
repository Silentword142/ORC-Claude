const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

let mainWindow = null;
let pythonProcess = null;
let markItDownPort = 49152;
let isPythonReady = false;

function findPython() {
  const isWin = process.platform === 'win32';
  const candidates = [
    process.env.PYTHON_PATH,
    // Venv cục bộ
    isWin
      ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '..', '.venv', 'bin', 'python'),
    // Bundled resources (sau khi đóng gói)
    isWin
      ? path.join(process.resourcesPath, 'python', 'python.exe')
      : path.join(process.resourcesPath, 'python', 'bin', 'python3'),
    // Hệ thống
    isWin ? 'python.exe' : 'python3',
    'python'
  ].filter(Boolean);

  for (const cand of candidates) {
    if (cand.includes(path.sep) && fs.existsSync(cand)) {
      return cand;
    }
  }
  return isWin ? 'python.exe' : 'python3';
}

function resolveMarkItDownCommand(extraArgs = []) {
  const isWin = process.platform === 'win32';
  // 1. Ưu tiên binary đóng gói sẵn (standalone PyInstaller) trong resources/markitdown/
  const bundledExe = isWin
    ? path.join(process.resourcesPath || '', 'markitdown', 'markitdown_service.exe')
    : path.join(process.resourcesPath || '', 'markitdown', 'markitdown_service');
  if (fs.existsSync(bundledExe)) {
    return { cmd: bundledExe, args: extraArgs };
  }

  // 2. Fallback: chạy qua Python + script
  const pyExe = findPython();
  const scriptPath = path.join(__dirname, '..', 'scripts', 'markitdown_service.py');
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return { cmd: pyExe, args: [scriptPath, ...extraArgs] };
}

function startMarkItDownService() {
  const resolved = resolveMarkItDownCommand(['serve', '-p', String(markItDownPort)]);
  if (!resolved) {
    console.warn('[MarkItDown] Không tìm thấy service hoặc script.');
    return;
  }

  try {
    pythonProcess = spawn(resolved.cmd, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    pythonProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('MARKITDOWN_SERVER_READY')) {
        isPythonReady = true;
        console.log('[MarkItDown Server] Sẵn sàng tại cổng:', markItDownPort);
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error('[MarkItDown Server Stderr]:', data.toString());
    });

    pythonProcess.on('exit', (code) => {
      console.log('[MarkItDown Server] Tiến trình kết thúc với mã:', code);
      isPythonReady = false;
    });
  } catch (err) {
    console.error('[MarkItDown Server] Không thể khởi động tiến trình MarkItDown:', err);
  }
}

function createWindow() {
  const pngIcon = path.join(__dirname, '..', 'build', 'icon.png');
  const svgIcon = path.join(__dirname, '..', 'public', 'icon.svg');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 600,
    title: 'ORC Scanner & MarkItDown Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    icon: fs.existsSync(pngIcon) ? pngIcon : svgIcon
  });

  // Tùy biến thanh menu
  mainWindow.setMenuBarVisibility(false);

  // Load trang web (ưu tiên thư mục build dist/index.html)
  const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Khởi chạy ứng dụng
app.whenReady().then(() => {
  startMarkItDownService();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pythonProcess) {
    try {
      pythonProcess.kill();
    } catch (_) {}
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers
ipcMain.handle('markitdown-status', async () => {
  return { ready: isPythonReady, port: markItDownPort };
});

ipcMain.handle('markitdown-convert', async (event, filePath) => {
  // Thử gọi qua HTTP Server nếu đang chạy
  if (isPythonReady) {
    try {
      const resp = await fetch(`http://127.0.0.1:${markItDownPort}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      if (resp.ok) {
        return await resp.json();
      }
    } catch (e) {
      console.warn('[MarkItDown IPC] Gọi qua HTTP thất bại, chuyển sang CLI fallback:', e);
    }
  }

  // Fallback: Chạy trực tiếp CLI một lần
  return new Promise((resolve) => {
    const resolved = resolveMarkItDownCommand(['convert', filePath]);
    if (!resolved) {
      resolve({ success: false, error: 'Không tìm thấy engine MarkItDown', markdown: '' });
      return;
    }
    execFile(resolved.cmd, resolved.args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          error: stderr || error.message || 'Lỗi thực thi MarkItDown',
          markdown: ''
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        resolve({
          success: false,
          error: `Không thể đọc kết quả từ MarkItDown: ${stdout}`,
          markdown: ''
        });
      }
    });
  });
});

// Hộp thoại chọn tệp
ipcMain.handle('dialog-open-file', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Chọn tệp tài liệu',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Tất cả định dạng hỗ trợ', extensions: ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'htm', 'epub', 'rtf', 'txt', 'csv', 'tsv', 'json', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      { name: 'Văn bản Office (Word, Excel, PowerPoint)', extensions: ['docx', 'xlsx', 'xls', 'pptx', 'ppt'] },
      { name: 'Tài liệu PDF', extensions: ['pdf'] },
      { name: 'Hình ảnh scan & chụp', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg'] },
      { name: 'Mọi tệp (*.*)', extensions: ['*'] }
    ]
  });
  return result;
});

// Hộp thoại chọn thư mục chuyển đổi hàng loạt
ipcMain.handle('dialog-open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục chứa tài liệu để chuyển đổi hàng loạt',
    properties: ['openDirectory']
  });
  return result;
});

// Hộp thoại lưu file Markdown
ipcMain.handle('dialog-save-file', async (event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Lưu tệp Markdown',
    defaultPath: defaultName || 'document.md',
    filters: [{ name: 'Markdown Document', extensions: ['md'] }]
  });

  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { success: true, filePath: result.filePath };
  }
  return { success: false, canceled: true };
});

// Lưu trực tiếp file
ipcMain.handle('fs-save-file', async (event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Quét danh sách tệp trong thư mục
ipcMain.handle('fs-read-dir', async (event, dirPath) => {
  try {
    const files = fs.readdirSync(dirPath);
    const validExts = new Set(['.docx', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.html', '.htm', '.epub', '.rtf', '.txt', '.csv', '.tsv', '.json', '.png', '.jpg', '.jpeg', '.webp', '.bmp']);
    const fullPaths = files
      .map(f => path.join(dirPath, f))
      .filter(p => {
        try {
          return fs.statSync(p).isFile() && validExts.has(path.extname(p).toLowerCase());
        } catch {
          return false;
        }
      });
    return { success: true, files: fullPaths };
  } catch (err) {
    return { success: false, error: err.message, files: [] };
  }
});
