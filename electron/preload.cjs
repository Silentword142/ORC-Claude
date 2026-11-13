const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || '';
    }
  },
  convertWithMarkItDown: (filePath) => ipcRenderer.invoke('markitdown-convert', filePath),
  convertUrlWithMarkItDown: (url, languages) => ipcRenderer.invoke('markitdown-convert-url', { url, languages }),
  checkMarkItDownStatus: () => ipcRenderer.invoke('markitdown-status'),
  openFileDialog: (options) => ipcRenderer.invoke('dialog-open-file', options),
  openFolderDialog: () => ipcRenderer.invoke('dialog-open-folder'),
  saveMarkdownDialog: (defaultName, content) => ipcRenderer.invoke('dialog-save-file', { defaultName, content }),
  saveDirectFile: (filePath, content) => ipcRenderer.invoke('fs-save-file', { filePath, content }),
  scanDirectory: (dirPath) => ipcRenderer.invoke('fs-read-dir', dirPath),
  getPlatform: () => process.platform,
});
