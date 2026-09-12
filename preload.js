const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件选择对话框
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  // 选择文件夹对话框
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  // 解析拖拽文件路径
  resolveFiles: (paths) => ipcRenderer.invoke('files:resolve', paths),
  // 校验 PDF
  validatePdf: (filePath) => ipcRenderer.invoke('pdf:validate', filePath),
  // 读取文件原始字节（图片格式预览用）
  readPdfBase64: (filePath) => ipcRenderer.invoke('pdf:readBase64', filePath),
  // 用 mupdf 在主进程渲染 PDF 页面为高清 PNG
  renderPage: (params) => ipcRenderer.invoke('pdf:renderPage', params),
  // 合成拼版 PDF
  composePdf: (params) => ipcRenderer.invoke('pdf:compose', params),
  // 导出 PDF
  exportPdf: (params) => ipcRenderer.invoke('pdf:export', params),
  // 打印 PDF
  printPdf: (params) => ipcRenderer.invoke('pdf:print', params),
  // 在文件管理器中显示文件
  showFile: (filePath) => ipcRenderer.invoke('shell:showFile', filePath),
  // 窗口控制
  windowMin: () => ipcRenderer.send('window-min'),
  windowMax: () => ipcRenderer.send('window-max'),
  windowClose: () => ipcRenderer.send('window-close')
})
