/* =====================================================
   发票打印助手 — 渲染进程（完整版 v2）
   ===================================================== */

// ─── 全局状态 ──────────────────────────────────────────
const state = {
  invoices: [],
  errors:   [],
  composedPdfB64: '',
  settings: {
    layout:      'vertical',
    scaleMode:   'fit',
    showCutLine: true,
    sortMode:    'import'
  },
  composing: false
}

const $ = id => document.getElementById(id)
const PDF_POINTS_PER_INCH = 72
const PRINT_RENDER_DPI = 320
const PRINT_RENDER_SCALE = PRINT_RENDER_DPI / PDF_POINTS_PER_INCH
const EDGE_SAFE_PADDING_PT = 2
const RENDER_IMAGE_TYPE = 'png'
const RENDER_IMAGE_MIME = 'image/png'

// ─── pdfjs 加载 ────────────────────────────────────────
let _pdfjsLib = null
async function getPdfjs() {
  if (_pdfjsLib) return _pdfjsLib
  try {
    const mod = await import('../node_modules/pdfjs-dist/build/pdf.mjs')
    mod.GlobalWorkerOptions.workerSrc =
      new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', location.href).href
    _pdfjsLib = mod
    return _pdfjsLib
  } catch (e) {
    console.warn('pdfjs 加载失败，预览降级:', e.message)
    return null
  }
}

// ─── 工具 ──────────────────────────────────────────────
function genId()  { return Math.random().toString(36).slice(2, 9) }
function formatDate(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
}

function showSection(s) {
  $('emptyState').style.display   = s === 'empty'   ? 'flex' : 'none'
  $('loadingState').style.display = s === 'loading' ? 'flex' : 'none'
  $('previewArea').style.display  = s === 'preview' ? 'flex' : 'none'
}
function setProgress(p)   { $('progressBar').style.width = Math.min(100,p) + '%' }
function setLoadText(txt) { $('loadingText').textContent = txt }

function calcA4Pages() {
  const solo   = state.invoices.filter(i => i.soloPage).length
  const normal = state.invoices.length - solo
  return solo + Math.ceil(normal / 2)
}

function updateStats() {
  const total = state.invoices.length
  $('statTotal').textContent = total
  $('statPages').textContent = calcA4Pages()
  $('statError').textContent = state.errors.length
  $('headerStats').style.display = total > 0 ? 'flex' : 'none'
}

function updateActionBar() {
  const has = state.invoices.length > 0
  $('actionBar').style.display = has ? 'flex' : 'none'
  if (has) $('actionInfo').textContent =
    `共 ${state.invoices.length} 张发票 · 生成 ${calcA4Pages()} 张 A4`
}

function showError(msg) { showToast('❌ ' + msg); console.error(msg) }

// ─── 文件导入 ──────────────────────────────────────────
async function importFiles(filePaths) {
  if (!filePaths || filePaths.length === 0) return

  showSection('loading')
  setLoadText(`正在校验文件... (0/${filePaths.length})`)
  setProgress(0)

  const newInvoices = [], newErrors = []

  for (let i = 0; i < filePaths.length; i++) {
    setLoadText(`正在校验 (${i+1}/${filePaths.length})`)
    setProgress((i / filePaths.length) * 55)

    let info
    try { info = await window.electronAPI.validatePdf(filePaths[i]) }
    catch (e) { info = { ok:false, filePath:filePaths[i], fileName:filePaths[i].split(/[\\/]/).pop(), error:e.message } }

    if (info.ok) {
      for (let p = 0; p < info.pageCount; p++) {

        newInvoices.push({
          id:              genId(),
          filePath:        info.filePath,
          fileName:        info.pageCount > 1 ? `${info.fileName}（第${p+1}页）` : info.fileName,
          pageIndex:       p,
          pageCount:       info.pageCount,
          width:           info.width,
          height:          info.height,
          transform:       { x: 0, y: 0, scale: 1.0, isDefault: true },
          isUnusual:       info.isUnusual    || false,
          sizeTag:         info.sizeTag      || 'normal',
          sizeWarning:     info.sizeWarning  || '',
          soloPage:        false
        })
      }
    } else {
      newErrors.push({ id:genId(), ...info })
    }
  }

  // 去重合并
  const keys = new Set(state.invoices.map(i => `${i.filePath}::${i.pageIndex}`))
  for (const inv of newInvoices) {
    const k = `${inv.filePath}::${inv.pageIndex}`
    if (!keys.has(k)) { state.invoices.push(inv); keys.add(k) }
  }
  state.errors.push(...newErrors)

  applySort()
  renderFileList()
  renderErrorList()
  updateStats()
  $('fileListCard').style.display = state.invoices.length > 0 ? 'block' : 'none'

  if (!state.invoices.length) { showSection('empty'); return }
  await composeAndPreview()
}

// ─── 排序 ──────────────────────────────────────────────
function applySort() {
  const m = state.settings.sortMode
  if (m === 'name-asc')  state.invoices.sort((a,b) => a.fileName.localeCompare(b.fileName,'zh'))
  if (m === 'name-desc') state.invoices.sort((a,b) => b.fileName.localeCompare(a.fileName,'zh'))
}

// ─── 单张删除 ──────────────────────────────────────────
function deleteInvoice(id) {
  state.invoices = state.invoices.filter(i => i.id !== id)
  renderFileList()
  updateStats()
  if (!state.invoices.length) {
    state.composedPdfB64 = ''
    updateActionBar()
    $('fileListCard').style.display = 'none'
    showSection('empty')
  } else {
    composeAndPreview()
  }
}

// ─── 合成 + 预览 ───────────────────────────────────────
function getRenderPaddingPx(scale) {
  return Math.ceil(EDGE_SAFE_PADDING_PT * scale)
}

function getInvoiceRenderSize(inv) {
  return {
    width:  inv.cachedImgData?.ptWidth  || inv.width,
    height: inv.cachedImgData?.ptHeight || inv.height
  }
}

function getInvoiceImageSrc(imgData) {
  const mime = imgData?.mimeType || (imgData?.imageFormat === 'png' ? 'image/png' : 'image/jpeg')
  return `data:${mime};base64,${imgData.base64}`
}

// ─── 判断是否为图片格式
 const IMAGE_FILE_EXTS = ['.jpg', '.jpeg', '.png']
function isInvoiceImageFile(filePath) {
  const ext = filePath.toLowerCase().split('.').pop()
  return ['jpg','jpeg','png'].includes(ext)
}

async function renderInvoiceToImageBase64(pdfjsLib, invoice) {
  // 图片格式：直接读取并绘制到 canvas
  if (isInvoiceImageFile(invoice.filePath)) {
    const res = await window.electronAPI.readPdfBase64(invoice.filePath)
    if (!res.ok) throw new Error(res.error)
    const ext = invoice.filePath.toLowerCase().split('.').pop()
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
    const imgSrc = `data:${mime};base64,${res.data}`
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d', { alpha: false })
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0)
        const outMime = 'image/png'
        resolve({
          base64: canvas.toDataURL(outMime).split(',')[1],
          imageFormat: 'png',
          mimeType: outMime,
          ptWidth: img.naturalWidth / PRINT_RENDER_SCALE,
          ptHeight: img.naturalHeight / PRINT_RENDER_SCALE,
          edgePaddingPt: 0
        })
      }
      img.onerror = reject
      img.src = imgSrc
    })
  }

  // PDF 格式：通过主进程的 mupdf 渲染（解决 pdf.js 框线丢失问题）
  const res = await window.electronAPI.renderPage({
    filePath: invoice.filePath,
    pageIndex: invoice.pageIndex,
    dpi: PRINT_RENDER_DPI
  })
  if (!res.ok) throw new Error(res.error)
  return {
    base64: res.data,
    imageFormat: 'png',
    mimeType: 'image/png',
    ptWidth: res.width / PRINT_RENDER_SCALE,
    ptHeight: res.height / PRINT_RENDER_SCALE,
    edgePaddingPt: 0
  }
}

async function composeAndPreview() {
  if (state.composing) return
  state.composing = true
  showSection('loading')
  setLoadText('正在将发票渲染为高清图像...')
  setProgress(20)

  let invoicesWithImage = []
  try {
    const pdfjsLib = await getPdfjs()
    let completed = 0
    const queue = state.invoices.map((inv, index) => ({ inv, index }))
    const results = new Array(state.invoices.length)
    const CONCURRENCY = 4 // 并发数

    async function worker() {
      while (queue.length > 0) {
        const { inv, index } = queue.shift()
        if (!inv.cachedImgData) {
          inv.cachedImgData = await renderInvoiceToImageBase64(pdfjsLib, inv)
        }
        completed++
        setLoadText(`正在处理发票 (${completed}/${state.invoices.length})...`)
        setProgress(20 + (completed / state.invoices.length) * 40)
      }
    }

    const workers = []
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
      workers.push(worker())
    }
    await Promise.all(workers)

    // 所有发票的高清图已准备就绪，直接渲染 DOM 预览！
    state.composing = false
    await renderPreviewGrid()
  } catch (e) {
    state.composing = false
    showError('发票渲染失败：' + e.message)
    showSection(state.invoices.length ? 'preview' : 'empty')
    return
  }
}



// ─── 渲染预览网格 (全 DOM 加速版) ────────────────────────
async function renderPreviewGrid() {
  const grid = $('previewGrid')
  grid.innerHTML = ''

  const totalPages = calcA4Pages()
  $('previewInfo').textContent = `共 ${totalPages} 张 A4`

  if (state.invoices.length === 0) {
    showSection('empty'); updateActionBar(); return
  }

  const pages = []
  let pending = null
  for (const inv of state.invoices) {
    if (inv.soloPage) {
      if (pending) { pages.push([pending]); pending = null }
      pages.push([inv])
    } else {
      if (pending) { pages.push([pending, inv]); pending = null }
      else { pending = inv }
    }
  }
  if (pending) pages.push([pending])

  const A4_W = 595.28, A4_H = 841.89
  const MARGIN = 28

  pages.forEach((pageInvs, pageIdx) => {
    const pageDiv = document.createElement('div')
    pageDiv.className = 'preview-page'
    pageDiv.style.aspectRatio = '1 / 1.414'
    pageDiv.style.position = 'relative'
    pageDiv.style.overflow = 'hidden'
    pageDiv.style.backgroundColor = '#fff'
    pageDiv.style.cursor = 'pointer'

    pageInvs.forEach((inv, slot) => {
      if (!inv.cachedImgData) return
      
      const ptW = inv.cachedImgData.ptWidth
      const ptH = inv.cachedImgData.ptHeight
      const isSolo = inv.soloPage
      const layout = state.settings.layout

      let zoneX, zoneY, zoneW, zoneH
      if (isSolo) {
        zoneX = MARGIN; zoneY = MARGIN
        zoneW = A4_W - MARGIN * 2; zoneH = A4_H - MARGIN * 2
      } else {
        if (layout === 'vertical') {
          zoneW = A4_W; zoneH = A4_H / 2
          zoneX = 0; zoneY = slot === 0 ? 0 : A4_H / 2
        } else {
          zoneW = A4_W / 2; zoneH = A4_H
          zoneX = slot === 0 ? 0 : A4_W / 2
          zoneY = 0
        }
      }

      const clipDiv = document.createElement('div')
      clipDiv.style.position = 'absolute'
      clipDiv.style.left = (zoneX / A4_W * 100) + '%'
      clipDiv.style.top = (zoneY / A4_H * 100) + '%'
      clipDiv.style.width = (zoneW / A4_W * 100) + '%'
      clipDiv.style.height = (zoneH / A4_H * 100) + '%'
      clipDiv.style.overflow = 'hidden'

      const ratio = 595.28 / 350
      const t = inv.transform || { x: 0, y: 0, scale: 1.0, isDefault: true }
      let finalScale, tX, tY
      if (isSolo) {
        if (t.isDefault) {
          const mode = state.settings.scaleMode
          const baseScale = mode === 'fill' ? Math.max(zoneW/ptW, zoneH/ptH) : Math.min(zoneW/ptW, zoneH/ptH)
          finalScale = baseScale
          tX = (zoneW - ptW * baseScale) / 2
          tY = (zoneH - ptH * baseScale) / 2
        } else {
          finalScale = t.scale; tX = t.x * ratio; tY = t.y * ratio
        }
      } else {
        finalScale = t.scale; tX = t.x * ratio; tY = t.y * ratio
        if (t.isDefault) {
          const baseScale = Math.min((zoneW - 20) / ptW, (zoneH - 20) / ptH)
          finalScale = baseScale
          tX = (zoneW - ptW * baseScale) / 2
          tY = (zoneH - ptH * baseScale) / 2
        }
      }

      const img = document.createElement('img')
      img.src = getInvoiceImageSrc(inv.cachedImgData)
      img.style.position = 'absolute'
      img.style.left = (tX / zoneW * 100) + '%'
      img.style.top = (tY / zoneH * 100) + '%'
      img.style.width = ((ptW * finalScale) / zoneW * 100) + '%'
      img.style.height = ((ptH * finalScale) / zoneH * 100) + '%'
      img.style.pointerEvents = 'none'

      clipDiv.appendChild(img)

      if (!isSolo && slot === 1 && state.settings.showCutLine) {
         if (layout === 'vertical') clipDiv.style.borderTop = '1px dashed #999'
         else clipDiv.style.borderLeft = '1px dashed #999'
      }

      pageDiv.appendChild(clipDiv)
    })

    const wrapper = document.createElement('div')
    wrapper.style.display = 'flex'; wrapper.style.flexDirection = 'column'
    wrapper.appendChild(pageDiv)
    
    // 绑定点击进入可视编辑器
    pageDiv.addEventListener('click', () => openVisualEditor(pageIdx + 1))

    const label = document.createElement('div')
    label.className = 'preview-page-label'
    label.innerHTML = `<span class="page-num">第 ${pageIdx + 1} 页</span><span>/ ${totalPages}</span>`
    wrapper.appendChild(label)

    grid.appendChild(wrapper)
  })
  
  setProgress(100)
  showSection('preview')
  updateActionBar()
}

// ─── 灯箱 ──────────────────────────────────────────────
function openLightbox(src, label) {
  const c = $('lightboxCanvas')
  c.width = src.width; c.height = src.height
  c.getContext('2d').drawImage(src, 0, 0)
  $('lightboxLabel').textContent = label
  $('lightboxOverlay').style.display = 'flex'
}
$('lightboxClose').addEventListener('click', () => { $('lightboxOverlay').style.display = 'none' })
$('lightboxOverlay').addEventListener('click', e => {
  if (e.target === $('lightboxOverlay')) $('lightboxOverlay').style.display = 'none'
})

// ─── 渲染文件列表 ─────────────────────────────────────
function renderFileList() {
  const list = $('fileList')
  list.innerHTML = ''

  for (const inv of state.invoices) {
    const item = document.createElement('div')
    const classes = ['file-item']
    if (inv.isUnusual) classes.push('file-item-warn')
    if (inv.soloPage)  classes.push('file-item-solo')
    item.className = classes.join(' ')
    item.dataset.id = inv.id
    item.draggable = true

    // 徽标
    let badges = ''
    if (inv.isUnusual) badges += `<span class="file-badge badge-warn" title="${inv.sizeWarning}">⚠️ 比例异常</span>`
    if (inv.soloPage)  badges += `<span class="file-badge badge-solo">🖨️ 独占A4</span>`
    
    item.innerHTML = `
      <div class="file-item-main">
        <div class="file-thumb"><span class="file-thumb-icon">📄</span></div>
        <div class="file-info">
          <div class="file-name" title="${inv.fileName}">${inv.fileName}</div>
          <div class="file-meta">第 ${inv.pageIndex + 1} 页</div>
        </div>
        <button class="file-solo-btn ${inv.soloPage ? 'active' : ''}" data-id="${inv.id}" title="独占整张 A4">🖨️</button>
        <button class="file-del-btn" data-id="${inv.id}" title="移除此发票">✕</button>
      </div>
      ${badges ? `<div class="badge-row">${badges}</div>` : ''}
    `

    // 独占按钮
    item.querySelector('.file-solo-btn').addEventListener('click', e => {
      e.stopPropagation()
      inv.soloPage = !inv.soloPage
      renderFileList()
      composeAndPreview()
    })

    // 删除按钮
    item.querySelector('.file-del-btn').addEventListener('click', e => {
      e.stopPropagation()
      deleteInvoice(inv.id)
    })
    
    // 双击预览
    item.addEventListener('dblclick', () => {
      showPreview(inv)
    })

    renderThumb(inv, item.querySelector('.file-thumb'))

    item.addEventListener('dragstart', onDragStart)
    item.addEventListener('dragover',  onDragOver)
    item.addEventListener('drop',      onDrop)
    item.addEventListener('dragend',   onDragEnd)
    list.appendChild(item)
  }

  renderWarnSummary()
}

// 缩略图（支持 PDF 和图片格式）
async function renderThumb(inv, thumbEl) {
  try {
    // 图片格式：直接用 img 标签显示
    if (isInvoiceImageFile(inv.filePath)) {
      const res = await window.electronAPI.readPdfBase64(inv.filePath)
      if (!res.ok) return
      const ext = inv.filePath.toLowerCase().split('.').pop()
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
      const img = document.createElement('img')
      img.src = `data:${mime};base64,${res.data}`
      img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'contain'
      thumbEl.innerHTML = ''
      thumbEl.appendChild(img)
      return
    }
    // PDF 格式：用 mupdf 主进程渲染，尺寸用 72dpi（缩略图不需要高清）
    const res = await window.electronAPI.renderPage({
      filePath: inv.filePath,
      pageIndex: inv.pageIndex,
      dpi: 72 // 缩略图用低分辨率，快速生成
    })
    if (!res.ok) return
    const img = document.createElement('img')
    img.src = `data:image/png;base64,${res.data}`
    img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'contain'
    thumbEl.innerHTML = ''
    thumbEl.appendChild(img)
  } catch (e) { console.warn('renderThumb error:', e) }
}

// ─── 大图预览 ──────────────────────────────────────────
async function showPreview(inv) {
  try {
    const pdfjsLib = await getPdfjs()
    if (!pdfjsLib) return
    const res = await window.electronAPI.readPdfBase64(inv.filePath)
    if (!res.ok) {
      showToast('读取文件失败')
      return
    }
    const bytes  = Uint8Array.from(atob(res.data), c => c.charCodeAt(0))
    const doc    = await pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: '../node_modules/pdfjs-dist/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '../node_modules/pdfjs-dist/standard_fonts/'
    }).promise
    const page   = await doc.getPage(inv.pageIndex + 1)
    
    // 根据屏幕高度动态计算缩放
    const vp1 = page.getViewport({ scale: 1.0 })
    const scale = (window.innerHeight * 0.85) / vp1.height
    const vp = page.getViewport({ scale: Math.max(scale, 1.0) })
    
    const canvas = $('lightboxCanvas')
    canvas.width = vp.width; canvas.height = vp.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
    
    $('lightboxLabel').textContent = `${inv.fileName} (第${inv.pageIndex + 1}页)`
    $('lightboxOverlay').style.display = 'flex'
  } catch (e) {
    showToast('预览生成失败')
  }
}

// ─── 异常汇总条 ────────────────────────────────────────
function renderWarnSummary() {
  const card  = $('warnSummaryCard')
  const label = $('warnSummaryText')
  if (!card || !label) return
  const unusual = state.invoices.filter(i => i.isUnusual)
  card.style.display = unusual.length ? 'block' : 'none'
  if (unusual.length) label.textContent =
    `⚠️ 发现 ${unusual.length} 张比例异常发票，右键单张发票 → 调整显示样式`
}

// ─── 渲染异常清单 ─────────────────────────────────────
function renderErrorList() {
  const card = $('errorCard'), list = $('errorList')
  list.innerHTML = ''
  if (!state.errors.length) { card.style.display = 'none'; return }
  card.style.display = 'block'
  for (const err of state.errors) {
    const item = document.createElement('div')
    item.className = 'error-item'
    item.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="error-item-name" title="${err.fileName}">${err.fileName}</div>
        <div class="error-item-reason">${err.error || '无法读取'}</div>
      </div>
      <div class="error-item-actions">
        <button class="btn-tiny skip" data-id="${err.id}">跳过</button>
      </div>
    `
    item.querySelector('.btn-tiny.skip').addEventListener('click', () => {
      state.errors = state.errors.filter(e => e.id !== err.id)
      renderErrorList(); updateStats()
    })
    list.appendChild(item)
  }
}

// ─── 画布交互 ──────────────────────────────────────────
let dragSrcId = null
function onDragStart(e) {
  dragSrcId = e.currentTarget.dataset.id
  e.currentTarget.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', dragSrcId)
}
function onDragOver(e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move'
  document.querySelectorAll('.file-item').forEach(el => el.classList.remove('drag-over-item'))
  e.currentTarget.classList.add('drag-over-item')
}
function onDrop(e) {
  e.preventDefault()
  const tid = e.currentTarget.dataset.id
  if (!dragSrcId || dragSrcId === tid) return
  const si = state.invoices.findIndex(i => i.id === dragSrcId)
  const ti = state.invoices.findIndex(i => i.id === tid)
  if (si < 0 || ti < 0) return
  const [m] = state.invoices.splice(si, 1)
  state.invoices.splice(ti, 0, m)
  renderFileList(); composeAndPreview()
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging')
  document.querySelectorAll('.file-item').forEach(el => el.classList.remove('drag-over-item'))
  dragSrcId = null
}

// ─── 拖拽文件导入 ──────────────────────────────────────
const dropZone = $('dropZone')
dropZone.addEventListener('dragenter', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over')
})
dropZone.addEventListener('drop', async e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const rawPaths = []
  if (e.dataTransfer.files?.length) {
    for (const f of e.dataTransfer.files) { if (f.path) rawPaths.push(f.path) }
  }
  if (!rawPaths.length) { showError('未获取到文件路径，请点击"选择文件"按钮'); return }
  try {
    const resolved = await window.electronAPI.resolveFiles(rawPaths)
    if (!resolved.length) { showError('未找到 PDF 文件'); return }
    await importFiles(resolved)
  } catch (e) { showError('导入失败：' + e.message) }
})

// ─── 选择文件按钮 ─────────────────────────────────────
$('btnSelectFiles').addEventListener('click', async () => {
  try {
    const files = await window.electronAPI.openFiles()
    if (!files.length) return
    await importFiles(files)
  } catch (e) { showError('打开文件失败：' + e.message) }
})

// ─── 选择文件夹按钮 ────────────────────────────────────
$('btnSelectFolder').addEventListener('click', async () => {
  try {
    const files = await window.electronAPI.openFolder()
    if (!files.length) return
    await importFiles(files)
  } catch (e) { showError('打开文件夹失败：' + e.message) }
})

// ─── 设置区 ────────────────────────────────────────────
function setupSettings() {
  $('btnLayoutV').addEventListener('click', () => {
    state.settings.layout = 'vertical'
    $('btnLayoutV').classList.add('active'); $('btnLayoutH').classList.remove('active')
    if (state.invoices.length) composeAndPreview()
  })
  $('btnLayoutH').addEventListener('click', () => {
    state.settings.layout = 'horizontal'
    $('btnLayoutH').classList.add('active'); $('btnLayoutV').classList.remove('active')
    if (state.invoices.length) composeAndPreview()
  })
  $('btnScaleFit').addEventListener('click', () => {
    state.settings.scaleMode = 'fit'
    $('btnScaleFit').classList.add('active'); $('btnScaleFill').classList.remove('active')
    if (state.invoices.length) composeAndPreview()
  })
  $('btnScaleFill').addEventListener('click', () => {
    state.settings.scaleMode = 'fill'
    $('btnScaleFill').classList.add('active'); $('btnScaleFit').classList.remove('active')
    if (state.invoices.length) composeAndPreview()
  })
  $('chkCutLine').addEventListener('change', e => {
    state.settings.showCutLine = e.target.checked
    if (state.invoices.length) composeAndPreview()
  })
  $('selectSort').addEventListener('change', e => {
    state.settings.sortMode = e.target.value
    applySort(); renderFileList()
    if (state.invoices.length) composeAndPreview()
  })
}

// ─── 重新合成 / 清空 ──────────────────────────────────
$('btnRecompose').addEventListener('click', () => composeAndPreview())

$('btnClearAll').addEventListener('click', () => {
  showModal('🗑️', '清空所有文件', '将清空已导入的所有发票文件，此操作不可恢复。', () => {
    state.invoices = []; state.errors = []; state.composedPdfB64 = ''
    renderFileList(); renderErrorList(); updateStats(); updateActionBar()
    $('fileListCard').style.display = 'none'
    showSection('empty')
  })
})

// ─── 导出 PDF ──────────────────────────────────────────
$('btnExport').addEventListener('click', async () => {
  if (state.invoices.length === 0) return
  const n = state.invoices.length, p = calcA4Pages()
  const name = `发票打印_${n}张_${formatDate()}.pdf`
  showModal('📤', '导出 PDF',
    `本次共 ${n} 张发票，生成 ${p} 张 A4。\n\n默认文件名：${name}`,
    async () => {
      try {
        // 先生成 invoicesWithImage
        const invoicesWithImage = state.invoices.map(inv => ({
          filePath: inv.filePath,
          pageIndex: inv.pageIndex,
          soloPage: inv.soloPage,
          transform: inv.transform,
          imageBase64: inv.cachedImgData.base64,
          imageFormat: inv.cachedImgData.imageFormat || 'jpeg',
          ptWidth: inv.cachedImgData.ptWidth,
          ptHeight: inv.cachedImgData.ptHeight,
          edgePaddingPt: inv.cachedImgData.edgePaddingPt || 0
        }))

        // 后台合成完整的高清 PDF
        showSection('loading')
        setLoadText('正在生成最终高清 PDF，这可能需要数秒钟...')
        setProgress(50)

        const result = await window.electronAPI.composePdf({
          invoices: invoicesWithImage,
          settings: state.settings
        })

        if (!result.ok) {
          showError('生成失败：' + (result.error || '未知错误'))
          showSection('preview')
          return
        }

        setProgress(90)
        const res = await window.electronAPI.exportPdf({ pdfBase64: result.data, defaultName: name })
        showSection('preview')
        
        if (res.ok) { showToast('✅ 导出成功！'); window.electronAPI.showFile(res.filePath) }
        else if (res.error && res.error !== 'cancelled') showError('导出失败：' + res.error)
      } catch (e) { 
        showSection('preview')
        showError('导出失败：' + e.message) 
      }
    }
  )
})

// ─── 错误提示 ─────────────────────────────
function showError(msg) {
  showModal('❌', '错误', msg, null)
}

// 删除原有的 btnPrint 绑定，因为它已被隐藏

// ─── 确认模态弹窗 ─────────────────────────────────────
let _modalCb = null
function showModal(icon, title, body, onConfirm) {
  $('modalIcon').textContent = icon; $('modalTitle').textContent = title; $('modalBody').textContent = body
  _modalCb = onConfirm; $('modalOverlay').style.display = 'flex'
}
$('modalConfirm').addEventListener('click', () => {
  $('modalOverlay').style.display = 'none'; if (_modalCb) { _modalCb(); _modalCb = null }
})
$('modalCancel').addEventListener('click', () => { $('modalOverlay').style.display = 'none'; _modalCb = null })
$('modalOverlay').addEventListener('click', e => {
  if (e.target === $('modalOverlay')) { $('modalOverlay').style.display = 'none'; _modalCb = null }
})

// 列表大图预览关闭
$('lightboxClose').addEventListener('click', () => {
  $('lightboxOverlay').style.display = 'none'
})

// ─── Toast ────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('_toast')
  if (!t) {
    t = document.createElement('div')
    t.id = '_toast'
    Object.assign(t.style, {
      position:'fixed', bottom:'80px', left:'50%', transform:'translateX(-50%)',
      background:'#0F172A', color:'#fff', padding:'10px 20px', borderRadius:'20px',
      fontSize:'13px', fontWeight:'500', zIndex:'9999',
      boxShadow:'0 4px 12px rgba(0,0,0,.2)', transition:'opacity .3s ease',
      fontFamily:'inherit', whiteSpace:'nowrap', pointerEvents:'none'
    })
    document.body.appendChild(t)
  }
  t.textContent = msg; t.style.opacity = '1'
  clearTimeout(t._ti)
  t._ti = setTimeout(() => { t.style.opacity = '0' }, 3000)
}

// ─── 启动 ──────────────────────────────────────────────
;(function init() {
  if (typeof window.electronAPI === 'undefined') {
    document.body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100vh;font-family:sans-serif;background:#F5F7FA;gap:16px;">
        <div style="font-size:56px">⚠️</div>
        <h2 style="color:#EF4444;margin:0">请通过 Electron 启动本应用</h2>
        <p style="color:#6B7280;margin:0">请运行：<code style="background:#e5e7eb;padding:2px 8px;border-radius:4px">npm start</code></p>
      </div>
    `
    return
  }
  setupSettings()
  setupResizer()
  
  // 绑定窗口控制
  const winMin = $('winMin')
  if (winMin) winMin.addEventListener('click', () => window.electronAPI.windowMin())
  const winMax = $('winMax')
  if (winMax) winMax.addEventListener('click', () => window.electronAPI.windowMax())
  const winClose = $('winClose')
  if (winClose) winClose.addEventListener('click', () => window.electronAPI.windowClose())
  
  console.log('✅ 发票打印助手就绪')
})()

// ─── 拖拽右侧面板 ──────────────────────────────────────
function setupResizer() {
  const resizer = $('resizer')
  const rightPanel = $('rightListPanel')
  if (!resizer || !rightPanel) return

  let isResizing = false
  let startX = 0
  let startW = 0

  resizer.addEventListener('mousedown', e => {
    e.preventDefault() // 防止拖拽时选中文本
    isResizing = true
    startX = e.clientX
    startW = rightPanel.offsetWidth
    document.body.style.cursor = 'col-resize'
    resizer.style.backgroundColor = 'var(--accent)'
  })

  document.addEventListener('mousemove', e => {
    if (!isResizing) return
    const dx = startX - e.clientX
    let newW = startW + dx
    if (newW < 200) newW = 200 // 最小宽度
    if (newW > 600) newW = 600 // 最大宽度
    rightPanel.style.width = newW + 'px'
  })

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false
      document.body.style.cursor = 'default'
      resizer.style.backgroundColor = ''
    }
  })
}

// ─── 可视化编辑器 ───────────────────────────────────────
let _editorCurrentPage = 1
let _editorData = null
let _pdfDocs = {} // 缓存加载过的 PDF

function getA4PageData(pageIndex) {
  let pages = []
  let currentPage = null
  for (const inv of state.invoices) {
    if (inv.soloPage) {
      pages.push({ solo: true, top: inv, bottom: null })
    } else if (!currentPage) {
      currentPage = { solo: false, top: inv, bottom: null }
    } else {
      currentPage.bottom = inv
      pages.push(currentPage)
      currentPage = null
    }
  }
  if (currentPage) pages.push(currentPage)
  return pages[pageIndex - 1] // 1-indexed
}

function applyDefaultTransform(inv, isSolo) {
  if (!inv || !inv.transform.isDefault) return
  const ratio = 595.28 / 350
  const MARGIN = 28
  
  let zoneW, zoneH
  if (isSolo) {
    zoneW = 595.28 - MARGIN * 2
    zoneH = 841.89 - MARGIN * 2
  } else if (state.settings.layout === 'vertical') {
    zoneW = 595.28
    zoneH = 841.89 / 2
  } else {
    zoneW = 595.28 / 2
    zoneH = 841.89
  }
  
  const { width: srcW, height: srcH } = getInvoiceRenderSize(inv)
  const baseScale = state.settings.scaleMode === 'fill'
    ? Math.max((zoneW - 20) / srcW, (zoneH - 20) / srcH)
    : Math.min((zoneW - 20) / srcW, (zoneH - 20) / srcH)
    
  inv.transform.scale = baseScale
  inv.transform.x = ((zoneW - srcW * baseScale) / 2) / ratio
  inv.transform.y = ((zoneH - srcH * baseScale) / 2) / ratio
  inv.transform.isDefault = false
}

async function renderEditorLayer(inv, layerId, isSolo) {
  const layer = $(layerId)
  layer.innerHTML = ''
  if (!inv) return null
  
  const pdfjsLib = await getPdfjs()
  if (!inv.cachedImgData) {
    inv.cachedImgData = await renderInvoiceToImageBase64(pdfjsLib, inv)
  }
  const imgData = inv.cachedImgData
  const ratio = 595.28 / 350
  const img = document.createElement('img')
  img.src = getInvoiceImageSrc(imgData)
  img.style.width = (imgData.ptWidth / ratio) + 'px'
  img.style.height = (imgData.ptHeight / ratio) + 'px'
  
  layer.appendChild(img)
  
  // 应用之前的变换或初始化默认居中
  applyDefaultTransform(inv, isSolo)
  const t = inv.transform || { x: 0, y: 0, scale: 1.0 }
  updateLayerTransform(layerId, t.x, t.y, t.scale)
  return layer.firstElementChild
}

function updateLayerTransform(layerId, x, y, scale) {
  const layer = $(layerId)
  layer.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
}

async function openVisualEditor(p) {
  _editorCurrentPage = p
  _editorData = getA4PageData(p)
  if (!_editorData) return
  
  $('editorOverlay').style.display = 'flex'
  
  // 如果是 soloPage，隐藏虚线和下方区域
  if (_editorData.solo) {
    document.querySelector('.editor-divider').style.display = 'none'
    $('editorBottomA5').style.display = 'none'
    $('ctrlBottom').style.display = 'none'
    $('editorTopA5').style.height = '100%' // 占满整个 A4
  } else {
    document.querySelector('.editor-divider').style.display = 'block'
    $('editorBottomA5').style.display = 'block'
    $('ctrlBottom').style.display = 'flex'
    $('editorTopA5').style.height = '50%'
  }

  // 渲染
  const cTop = await renderEditorLayer(_editorData.top, 'editorTopLayer', _editorData.solo)
  const cBot = await renderEditorLayer(_editorData.bottom, 'editorBottomLayer', false)

  // 同步滑块
  $('zoomTop').value = (_editorData.top.transform?.scale || 1.0) * 100
  if (_editorData.bottom) $('zoomBottom').value = (_editorData.bottom.transform?.scale || 1.0) * 100
}

// 绑定拖拽逻辑
function bindDrag(a5Id, layerId, invoiceKey) {
  const a5 = $(a5Id)
  let isDragging = false, startX = 0, startY = 0, initX = 0, initY = 0
  
  a5.addEventListener('mousedown', e => {
    // 关键修复：阻止默认行为，防止触发 img 原生拖拽，避免松开鼠标时 mouseup 事件丢失
    e.preventDefault()
    isDragging = true
    startX = e.clientX; startY = e.clientY
    const inv = _editorData[invoiceKey]
    if (inv) {
      initX = inv.transform.x || 0
      initY = inv.transform.y || 0
    }
  })
  
  document.addEventListener('mousemove', e => {
    if (!isDragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    const inv = _editorData[invoiceKey]
    if (inv) {
      inv.transform.x = initX + dx
      inv.transform.y = initY + dy
      updateLayerTransform(layerId, inv.transform.x, inv.transform.y, inv.transform.scale)
    }
  })
  
  document.addEventListener('mouseup', () => { isDragging = false })
  
  // 滚轮缩放
  a5.addEventListener('wheel', e => {
    e.preventDefault()
    const inv = _editorData[invoiceKey]
    if (!inv) return
    let scale = inv.transform.scale || 1.0
    scale += e.deltaY * -0.001
    scale = Math.min(Math.max(.2, scale), 3)
    inv.transform.scale = scale
    updateLayerTransform(layerId, inv.transform.x, inv.transform.y, inv.transform.scale)
    
    const sliderId = invoiceKey === 'top' ? 'zoomTop' : 'zoomBottom'
    $(sliderId).value = scale * 100
  })
}

bindDrag('editorTopA5', 'editorTopLayer', 'top')
bindDrag('editorBottomA5', 'editorBottomLayer', 'bottom')

// 绑定滑块
// 绑定滑块
function updateZoom(key, absVal, relVal) {
  const inv = _editorData[key]
  if (!inv) return
  let s = absVal !== null ? absVal : (inv.transform.scale + relVal)
  s = Math.min(Math.max(.2, s), 3)
  inv.transform.scale = s
  const id = key === 'top' ? 'editorTopLayer' : 'editorBottomLayer'
  updateLayerTransform(id, inv.transform.x, inv.transform.y, inv.transform.scale)
  const slider = key === 'top' ? $('zoomTop') : $('zoomBottom')
  slider.value = s * 100
}

$('zoomTop').addEventListener('input', e => updateZoom('top', e.target.value / 100, null))
$('zoomBottom').addEventListener('input', e => updateZoom('bottom', e.target.value / 100, null))

$('btnZoomOutTop')?.addEventListener('click', () => updateZoom('top', null, -0.1))
$('btnZoomInTop')?.addEventListener('click', () => updateZoom('top', null, 0.1))
$('btnZoomOutBottom')?.addEventListener('click', () => updateZoom('bottom', null, -0.1))
$('btnZoomInBottom')?.addEventListener('click', () => updateZoom('bottom', null, 0.1))

// 重置
$('btnResetTop').addEventListener('click', () => {
  if (_editorData?.top) {
    _editorData.top.transform = { x: 0, y: 0, scale: 1.0, isDefault: true }
    applyDefaultTransform(_editorData.top, _editorData.solo)
    $('zoomTop').value = _editorData.top.transform.scale * 100
    updateLayerTransform('editorTopLayer', _editorData.top.transform.x, _editorData.top.transform.y, _editorData.top.transform.scale)
  }
})
$('btnResetBottom').addEventListener('click', () => {
  if (_editorData?.bottom) {
    _editorData.bottom.transform = { x: 0, y: 0, scale: 1.0, isDefault: true }
    applyDefaultTransform(_editorData.bottom, false)
    $('zoomBottom').value = _editorData.bottom.transform.scale * 100
    updateLayerTransform('editorBottomLayer', _editorData.bottom.transform.x, _editorData.bottom.transform.y, _editorData.bottom.transform.scale)
  }
})

// 模态窗关闭与确认
$('editorClose').addEventListener('click', () => $('editorOverlay').style.display = 'none')
$('editorCancel').addEventListener('click', () => $('editorOverlay').style.display = 'none')
$('editorApply').addEventListener('click', () => {
  $('editorOverlay').style.display = 'none'
  composeAndPreview()
})
