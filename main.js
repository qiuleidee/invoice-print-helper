const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { PDFDocument, rgb } = require('pdf-lib')
const AdmZip = require('adm-zip')

// ─── mupdf 异步加载（ESM 模块）──────────────────────────────
let _mupdf = null
async function getMupdf() {
  if (_mupdf) return _mupdf
  const mod = await import('mupdf')
  _mupdf = mod.default || mod
  return _mupdf
}

// A4/A5 尺寸（pt，1mm ≈ 2.8346pt）
const A4_WIDTH  = 595.28  // 210mm
const A4_HEIGHT = 841.89  // 297mm

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    frame: false,
    show: false,
    backgroundColor: '#F5F7FA'
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })
}

app.whenReady().then(() => {
  createWindow()
  
  ipcMain.on('window-min', () => mainWindow.minimize())
  ipcMain.on('window-max', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window-close', () => mainWindow.close())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── 支持的文件扩展名 ─────────────────────────────────────
const SUPPORTED_EXTS = ['.pdf', '.jpg', '.jpeg', '.png']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png']

// ─── 工具：解析文件列表（支持文件夹 + ZIP）───────────────
function resolveFiles(filePaths) {
  const results = []
  for (const fp of filePaths) {
    try {
      const stat = fs.statSync(fp)
      if (stat.isDirectory()) {
        scanDir(fp, results)
      } else if (fp.toLowerCase().endsWith('.zip')) {
        extractZip(fp, results)
      } else {
        const ext = path.extname(fp).toLowerCase()
        if (SUPPORTED_EXTS.includes(ext)) results.push(fp)
      }
    } catch (e) {
      console.error('resolveFiles error:', fp, e.message)
    }
  }
  return results
}

function scanDir(dir, results) {
  try {
    const entries = fs.readdirSync(dir)
    for (const entry of entries) {
      const full = path.join(dir, entry)
      try {
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          scanDir(full, results)
        } else {
          const ext = path.extname(entry).toLowerCase()
          if (SUPPORTED_EXTS.includes(ext)) results.push(full)
        }
      } catch (e) {}
    }
  } catch (e) {}
}

function extractZip(zipPath, results) {
  try {
    const tmpDir = path.join(app.getPath('temp'), 'invoice_print_' + Date.now())
    fs.mkdirSync(tmpDir, { recursive: true })
    const zip = new AdmZip(zipPath)
    zip.extractAllTo(tmpDir, true)
    scanDir(tmpDir, results)
  } catch (e) {
    console.error('extractZip error:', e.message)
  }
}

// ─── IPC: 选择文件对话框 ──────────────────────────────────
ipcMain.handle('dialog:openFiles', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择发票文件',
    filters: [
      { name: '支持的格式', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'zip'] },
      { name: 'PDF 文件', extensions: ['pdf'] },
      { name: '图片文件', extensions: ['jpg', 'jpeg', 'png'] },
      { name: 'ZIP 压缩包', extensions: ['zip'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  if (canceled) return []
  return resolveFiles(filePaths)
})

// ─── IPC: 选择文件夹对话框 ────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择包含发票的文件夹',
    properties: ['openDirectory']
  })
  if (canceled || !filePaths.length) return []
  return resolveFiles(filePaths)
})

// ─── IPC: 解析拖拽文件 ────────────────────────────────────
ipcMain.handle('files:resolve', async (_, filePaths) => {
  return resolveFiles(filePaths)
})


// ─── 工具：检查是否为图片格式 ────────────────────────────
function isImageFile(filePath) {
  return IMAGE_EXTS.includes(path.extname(filePath).toLowerCase())
}

// ─── 工具：用 sharp/jimp 获取图片尺寸（纯 Node.js 实现）──
function getImageSize(filePath) {
  // 从文件头读取图片宽高（支持 JPEG/PNG）
  const buf = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') {
    // PNG: 宽高在字节 16-23 (IHDR chunk)
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const w = buf.readUInt32BE(16)
      const h = buf.readUInt32BE(20)
      return { width: w, height: h }
    }
  } else {
    // JPEG: 扫描 SOF marker
    let i = 2
    while (i < buf.length - 8) {
      if (buf[i] !== 0xFF) break
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
          (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
        const h = buf.readUInt16BE(i + 5)
        const w = buf.readUInt16BE(i + 7)
        return { width: w, height: h }
      }
      i += 2 + len
    }
  }
  // 读取失败时返回 A5 默认尺寸
  return { width: 419, height: 595 }
}

// ─── IPC: 校验文件（PDF + 图片）────────────────────────────
ipcMain.handle('pdf:validate', async (_, filePath) => {
  try {
    // 图片文件处理分支
    if (isImageFile(filePath)) {
      const { width, height } = getImageSize(filePath)
      return {
        ok: true,
        filePath,
        fileName: path.basename(filePath),
        pageCount: 1,
        width,
        height,
        isImage: true,
        isUnusual: false,
        sizeTag: 'normal',
        sizeWarning: ''
      }
    }

    // PDF 处理分支
    const bytes = fs.readFileSync(filePath)
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const pageCount = pdfDoc.getPageCount()
    const page = pdfDoc.getPage(0)
    const { width, height } = page.getSize()

    // ── 尺寸异常分析（按 A5 比例） ───────────────────────
    const STANDARD_RATIO = 1.414
    const longSide  = Math.max(width, height)
    const shortSide = Math.min(width, height)
    const aspect    = longSide / shortSide
    const diff = Math.abs(aspect - STANDARD_RATIO) / STANDARD_RATIO
    const isUnusual = diff > 0.20

    let sizeTag = 'normal', sizeWarning = ''
    if (isUnusual) {
      sizeTag = 'unusual-ratio'
      if (aspect > 1.8) {
        sizeWarning = `发票比例过于细长 (长宽比 ${aspect.toFixed(2)})，建议单张调整样式避免变形或留白`
      } else if (aspect < 1.15) {
        sizeWarning = `发票比例接近正方形 (长宽比 ${aspect.toFixed(2)})，建议单张调整样式避免变形或留白`
      } else {
        sizeWarning = `发票比例偏离标准 A5 (长宽比 ${aspect.toFixed(2)})，建议单张调整样式避免变形或留白`
      }
    }

    return {
      ok: true,
      filePath,
      fileName: path.basename(filePath),
      pageCount,
      width,
      height,
      isUnusual,
      sizeTag,
      sizeWarning
    }
  } catch (e) {
    console.error('pdf:validate error for file:', filePath, e)
    return {
      ok: false,
      filePath,
      fileName: path.basename(filePath),
      error: e.message
    }
  }
})

// ─── IPC: 读取文件原始字节为 base64（确认文件存在用）──────
ipcMain.handle('pdf:readBase64', async (_, filePath) => {
  try {
    const bytes = fs.readFileSync(filePath)
    return { ok: true, data: bytes.toString('base64') }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── IPC: 用 mupdf 渲染 PDF 页面为高清 PNG ───────────────────────
// 使用 mupdf 而不是 pdf.js 的原因：mupdf 对缺少画笔操作符（S）的内容流有进一步容错，
// 能正确显示部分国内开票系统生成的 PDF 中缺失的表格框线。
ipcMain.handle('pdf:renderPage', async (_, { filePath, pageIndex, dpi }) => {
  try {
    const mupdf = await getMupdf()
    const bytes = fs.readFileSync(filePath)
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
    const page = doc.loadPage(pageIndex)
    const scale = dpi / 72
    const mat = mupdf.Matrix.scale(scale, scale)
    // 渲染：DeviceRGB、不需要 alpha、显示注释和表单内容
    const pixmap = page.toPixmap(mat, mupdf.ColorSpace.DeviceRGB, false)
    const png = pixmap.asPNG()
    const w = pixmap.getWidth()
    const h = pixmap.getHeight()
    // 释放资源
    pixmap.destroy()
    page.destroy()
    doc.destroy()
    return {
      ok: true,
      data: Buffer.from(png).toString('base64'),
      width: w,
      height: h
    }
  } catch (e) {
    console.error('[mupdf render error]', e.message)
    return { ok: false, error: e.message }
  }
})

// ─── IPC: 使用 mupdf 提取 PDF 纯文本 ──────────────────────
// 由于 pdfjs 在处理部分带有自建字体子集的发票时，会将 00 错误映射为 88，
// 我们转而使用 mupdf 提取结构化文本以确保精准度。
ipcMain.handle('pdf:extractText', async (_, { filePath, pageIndex }) => {
  try {
    const mupdf = await getMupdf()
    const bytes = fs.readFileSync(filePath)
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
    const page = doc.loadPage(pageIndex)
    
    // 使用 asJSON 获取结构化文本
    const stext = page.toStructuredText()
    const textData = JSON.parse(stext.asJSON())
    
    // 展平所有文本块
    let rawText = ''
    if (textData.blocks) {
      for (const block of textData.blocks) {
        if (block.type === 'text' && block.lines) {
          for (const line of block.lines) {
            if (line.chars) {
              rawText += line.chars.map(c => typeof c.c === 'number' ? String.fromCodePoint(c.c) : c.c).join('')
            }
          }
        }
      }
    }
    
    return { ok: true, text: rawText }
  } catch (e) {
    console.error('[mupdf extract error]', e.message)
    return { ok: false, error: e.message }
  }
})

// ─── IPC: 合成拼版 PDF ────────────────────────────────────
ipcMain.handle('pdf:compose', async (_, { invoices, settings }) => {
  try {
    const outDoc = await PDFDocument.create()

    // 页面分配算法：处理 soloPage（独占整张A4）
    const pages = []
    let pending = null

    for (const inv of invoices) {
      if (inv.soloPage) {
        // 先落地等待中的发票
        if (pending) { pages.push({ top: pending, bottom: null, solo: false }); pending = null }
        pages.push({ top: inv, bottom: null, solo: true })
      } else {
        if (pending) {
          pages.push({ top: pending, bottom: inv, solo: false })
          pending = null
        } else {
          pending = inv
        }
      }
    }
    if (pending) pages.push({ top: pending, bottom: null, solo: false })

    for (const pg of pages) {
      const a4Page = outDoc.addPage([A4_WIDTH, A4_HEIGHT])
      if (pg.solo) {
        // 独占整张 A4
        await placeInvoiceFull(outDoc, a4Page, pg.top, settings)
      } else {
        await placeInvoice(outDoc, a4Page, pg.top, 0, settings)
        if (pg.bottom) await placeInvoice(outDoc, a4Page, pg.bottom, 1, settings)
        if (settings.showCutLine && pg.bottom) drawCutLine(a4Page, settings.layout)
      }
    }

    const pdfBytes = await outDoc.save()
    return { ok: true, data: Buffer.from(pdfBytes).toString('base64') }
  } catch (e) {
    console.error('compose error:', e)
    return { ok: false, error: e.message }
  }
})

// 获取处理过 CropBox 的嵌入页面
async function getEmbeddedPage(outDoc, invoice) {
  const srcBytes = fs.readFileSync(invoice.filePath)
  if (!invoice.cropBox) {
    const pages = await outDoc.embedPdf(srcBytes, [invoice.pageIndex])
    return pages[0]
  }

  // 应用裁剪框
  const srcDoc = await PDFDocument.load(srcBytes)
  const page = srcDoc.getPage(invoice.pageIndex)
  const cb = invoice.cropBox
  page.setCropBox(cb.x, cb.y, cb.width, cb.height)
  
  const modifiedBytes = await srcDoc.save()
  const pages = await outDoc.embedPdf(modifiedBytes, [invoice.pageIndex])
  return pages[0]
}

async function embedInvoiceImage(pdfDoc, invoice) {
  const imageBase64 = invoice.imageBase64 || invoice.jpgBase64
  if (!imageBase64) throw new Error('缺少发票图像数据')
  const imgBytes = Buffer.from(imageBase64, 'base64')
  const format = String(invoice.imageFormat || 'jpeg').toLowerCase()
  return format === 'png' ? pdfDoc.embedPng(imgBytes) : pdfDoc.embedJpg(imgBytes)
}

// 独占整张 A4（soloPage 模式）
async function placeInvoiceFull(outDoc, a4Page, invoice, settings) {
  const embedded = await embedInvoiceImage(outDoc, invoice)
  
  const srcW = invoice.ptWidth
  const srcH = invoice.ptHeight
  const MARGIN = 28
  const zoneW = A4_WIDTH - MARGIN * 2
  const zoneH = A4_HEIGHT - MARGIN * 2
  const t = invoice.transform || { x: 0, y: 0, scale: 1.0, isDefault: true }
  const ratio = 595.28 / 350
  let finalScale, tX, tY
  
  if (t.isDefault) {
    const scaleMode = settings.scaleMode
    const baseScale = scaleMode === 'fill'
      ? Math.max(zoneW / srcW, zoneH / srcH)
      : Math.min(zoneW / srcW, zoneH / srcH)
    finalScale = baseScale
    tX = (zoneW - srcW * baseScale) / 2
    tY = (zoneH - srcH * baseScale) / 2
  } else {
    finalScale = t.scale
    tX = t.x * ratio
    tY = t.y * ratio
  }

  const scaledW = srcW * finalScale
  const scaledH = srcH * finalScale
  
  const pdfX = MARGIN + tX
  const pdfY = MARGIN + zoneH - tY - scaledH
  
  a4Page.drawImage(embedded, { 
    x: pdfX, 
    y: pdfY, 
    width: scaledW, 
    height: scaledH 
  })
}

// slot: 0=上/左，1=下/右
async function placeInvoice(outDoc, a4Page, invoice, slot, settings) {
  let zoneX, zoneY, zoneW, zoneH
  if (settings.layout === 'vertical') {
    zoneW = A4_WIDTH
    zoneH = A4_HEIGHT / 2
    zoneX = 0
    zoneY = slot === 0 ? A4_HEIGHT / 2 : 0
  } else {
    zoneW = A4_WIDTH / 2
    zoneH = A4_HEIGHT
    zoneX = slot === 0 ? 0 : A4_WIDTH / 2
    zoneY = 0
  }

  // 1. 创建临时的 A5 PDFDocument，用于实现完美的超出裁剪 (Clipping)
  const tempDoc = await PDFDocument.create()
  const a5Page = tempDoc.addPage([zoneW, zoneH])
  
  // 2. 将高分图像嵌入临时 A5
  const embedded = await embedInvoiceImage(tempDoc, invoice)
  const srcW = invoice.ptWidth
  const srcH = invoice.ptHeight
  
  // 3. 计算坐标
  const ratio = 595.28 / 350
  const t = invoice.transform || { x: 0, y: 0, scale: 1.0 }
  
  let finalScale = t.scale
  let tX = t.x * ratio
  let tY = t.y * ratio
  
  if (t.isDefault) {
    const baseScale = Math.min((zoneW - 20) / srcW, (zoneH - 20) / srcH)
    finalScale = baseScale
    tX = (zoneW - srcW * baseScale) / 2
    tY = (zoneH - srcH * baseScale) / 2
  }
  
  const scaledW = srcW * finalScale
  const scaledH = srcH * finalScale
  
  const pdfX = tX
  const pdfY = zoneH - tY - scaledH
  
  a5Page.drawImage(embedded, { x: pdfX, y: pdfY, width: scaledW, height: scaledH })
  
  // 4. 将截取好的 A5 生成字节，然后嵌入最终 A4
  const tempBytes = await tempDoc.save()
  const [clippedEmbedded] = await outDoc.embedPdf(tempBytes)
  
  a4Page.drawPage(clippedEmbedded, { x: zoneX, y: zoneY, width: zoneW, height: zoneH })
}

function drawCutLine(page, layout) {
  const { width, height } = page.getSize()
  const gray = rgb(0.65, 0.65, 0.65)
  if (layout === 'vertical') {
    const y = height / 2
    // 虚线：手动绘制多段短线段模拟
    const segLen = 6, gapLen = 4
    let x = 8
    while (x < width - 8) {
      page.drawLine({
        start: { x, y },
        end: { x: Math.min(x + segLen, width - 8), y },
        thickness: 0.6,
        color: gray
      })
      x += segLen + gapLen
    }
  } else {
    const x = width / 2
    let y = 8
    const segLen = 6, gapLen = 4
    while (y < height - 8) {
      page.drawLine({
        start: { x, y },
        end: { x, y: Math.min(y + segLen, height - 8) },
        thickness: 0.6,
        color: gray
      })
      y += segLen + gapLen
    }
  }
}

// ─── IPC: 导出 PDF ────────────────────────────────────────
ipcMain.handle('pdf:export', async (_, { pdfBase64, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出合并 PDF',
    defaultPath: defaultName,
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  })
  if (canceled || !filePath) return { ok: false }
  try {
    const buf = Buffer.from(pdfBase64, 'base64')
    fs.writeFileSync(filePath, buf)
    return { ok: true, filePath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── IPC: 打印 PDF ──────────────────────────────────────
let globalPrintWin = null

ipcMain.handle('pdf:print', async (_, { pdfBase64 }) => {
  try {
    const tmpPath = path.join(app.getPath('temp'), 'invoice_print_output.pdf')
    fs.writeFileSync(tmpPath, Buffer.from(pdfBase64, 'base64'))

    if (!globalPrintWin || globalPrintWin.isDestroyed()) {
      globalPrintWin = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
    }

    return await new Promise((resolve, reject) => {
      // 每次加载前清除之前的事件监听，避免重复绑定
      globalPrintWin.webContents.removeAllListeners('did-finish-load')
      
      globalPrintWin.webContents.on('did-finish-load', () => {
        setTimeout(() => {
          // Electron 31 的 print() 不接受 callback 也不返回 Promise
          // 因此我们调用后立刻向前端 resolve，窗口不会被销毁以保证打印进程不被掐断
          try {
            globalPrintWin.webContents.print({ silent: false, printBackground: true })
            resolve({ ok: true })
          } catch (err) {
            resolve({ ok: false, error: err.message })
          }
        }, 800)
      })
      
      globalPrintWin.loadFile(tmpPath).catch(e => {
        resolve({ ok: false, error: e.message })
      })
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }
})


// ─── IPC: 在文件夹中显示文件 ─────────────────────────────
ipcMain.handle('shell:showFile', async (_, filePath) => {
  shell.showItemInFolder(filePath)
})
