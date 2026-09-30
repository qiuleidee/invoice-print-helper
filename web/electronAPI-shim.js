/**
 * 浏览器端模拟 Electron API (Shim)
 * 将原本主进程的 Node.js 逻辑用 HTML5 和纯前端库替代，使 app.js 可以无缝运行
 */

const fileRegistry = new Map();
let nextFileId = 1;

function registerFile(file) {
  const id = `blob-file-${nextFileId++}-${file.name}`;
  fileRegistry.set(id, file);
  return id;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];

function isImageFile(name) {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

// 模拟文件读取，转为 ArrayBuffer
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// 模拟文件读取，转为 Base64
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result.split(',')[1];
      resolve(b64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// PDF.js worker 配置
const pdfjsLib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

window.electronAPI = {
  windowMin: () => {},
  windowMax: () => {},
  windowClose: () => {},
  showFile: () => {},
  
  openFiles: () => {
    return new Promise((resolve) => {
      const input = document.getElementById('fileInput');
      input.onchange = (e) => {
        const paths = [];
        for (const file of e.target.files) {
          paths.push(registerFile(file));
        }
        resolve(paths);
        input.value = ''; // reset
      };
      input.click();
    });
  },

  openFolder: () => {
    return new Promise((resolve) => {
      const input = document.getElementById('folderInput');
      input.onchange = (e) => {
        const paths = [];
        for (const file of e.target.files) {
          if (file.name.toLowerCase().endsWith('.pdf') || isImageFile(file.name)) {
            paths.push(registerFile(file));
          }
        }
        resolve(paths);
        input.value = '';
      };
      input.click();
    });
  },

  // 原本用来解析拖拽路径，现在直接在前端劫持拖拽事件，把文件放进 registry
  resolveFiles: async (paths) => {
    // 这个接口现在变成了通过 drag&drop 传入真实 File 对象的入口
    // 因为我们需要修改 app.js 中 drop 的处理
    return paths;
  },

  validatePdf: async (filePath) => {
    try {
      const file = fileRegistry.get(filePath);
      if (!file) throw new Error('文件未找到');

      if (isImageFile(file.name)) {
        return { ok: true, filePath, fileName: file.name, pageCount: 1, type: 'image' };
      }

      const arrayBuffer = await readFileAsArrayBuffer(file);
      const loadingTask = pdfjsLib.getDocument({ 
        data: arrayBuffer,
        cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/standard_fonts/',
        fontExtraProperties: true
      });
      const pdf = await loadingTask.promise;
      
      // 提取第一页宽高作为参照
      const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale: 1.0 });
      return { 
        ok: true, 
        filePath, 
        fileName: file.name, 
        pageCount: pdf.numPages, 
        type: 'pdf',
        ptWidth: vp.width,
        ptHeight: vp.height
      };
    } catch (e) {
      return { ok: false, filePath, fileName: filePath, error: e.message };
    }
  },

  readPdfBase64: async (filePath) => {
    try {
      const file = fileRegistry.get(filePath);
      if (!file) throw new Error('文件未找到');
      const b64 = await readFileAsBase64(file);
      return { ok: true, data: b64 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  renderPage: async ({ filePath, pageIndex, dpi }) => {
    try {
      const file = fileRegistry.get(filePath);
      const arrayBuffer = await readFileAsArrayBuffer(file);
      const loadingTask = pdfjsLib.getDocument({ 
        data: arrayBuffer,
        cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/standard_fonts/',
        fontExtraProperties: true
      });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(pageIndex + 1); // pdf.js index 从 1 开始

      const scale = dpi / 72; // pdf.js 默认 72dpi
      const viewport = page.getViewport({ scale });
      
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.split(',')[1];
      
      return {
        ok: true,
        data: b64,
        width: viewport.width,
        height: viewport.height
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  composePdf: async ({ invoices, settings }) => {
    try {
      const { PDFDocument, rgb } = PDFLib;
      const outDoc = await PDFDocument.create();
      
      const A4_WIDTH = 595.28;
      const A4_HEIGHT = 841.89;

      const pages = [];
      let pending = null;

      for (const inv of invoices) {
        if (inv.soloPage) {
          if (pending) { pages.push({ top: pending, bottom: null, solo: false }); pending = null; }
          pages.push({ top: inv, bottom: null, solo: true });
        } else {
          if (pending) {
            pages.push({ top: pending, bottom: inv, solo: false });
            pending = null;
          } else {
            pending = inv;
          }
        }
      }
      if (pending) pages.push({ top: pending, bottom: null, solo: false });

      async function embedInvoice(invoice, targetDoc) {
        const b64 = invoice.imageBase64 || invoice.jpgBase64 || invoice.cachedImgData;
        const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const format = String(invoice.imageFormat || invoice.fileName || 'png').toLowerCase();
        const image = format.includes('jpg') || format.includes('jpeg') ? await targetDoc.embedJpg(imgBytes) : await targetDoc.embedPng(imgBytes);
        return { element: image, isPage: false };
      }

      function drawCutLine(page, layout) {
        if (layout === 'vertical') {
          page.drawLine({ start: { x: 0, y: A4_HEIGHT/2 }, end: { x: A4_WIDTH, y: A4_HEIGHT/2 }, thickness: 1, color: rgb(0.5, 0.5, 0.5), dashes: [5, 5] });
        } else {
          page.drawLine({ start: { x: A4_WIDTH/2, y: 0 }, end: { x: A4_WIDTH/2, y: A4_HEIGHT }, thickness: 1, color: rgb(0.5, 0.5, 0.5), dashes: [5, 5] });
        }
      }

      async function placeInvoiceFull(a4Page, invoice) {
        const { element: embedded, isPage } = await embedInvoice(invoice, outDoc);
        const srcW = invoice.ptWidth || embedded.width;
        const srcH = invoice.ptHeight || embedded.height;
        const MARGIN = 28;
        const zoneW = A4_WIDTH - MARGIN * 2;
        const zoneH = A4_HEIGHT - MARGIN * 2;
        const t = invoice.transform || { x: 0, y: 0, scale: 1.0, isDefault: true };
        const ratio = A4_WIDTH / 350; // default preview width mapping
        
        let finalScale, tX, tY;
        if (t.isDefault) {
          const baseScale = settings.scaleMode === 'fill' ? Math.max(zoneW/srcW, zoneH/srcH) : Math.min(zoneW/srcW, zoneH/srcH);
          finalScale = baseScale;
          tX = (zoneW - srcW * baseScale) / 2;
          tY = (zoneH - srcH * baseScale) / 2;
        } else {
          finalScale = t.scale;
          tX = t.x * ratio;
          tY = t.y * ratio;
        }
        const scaledW = srcW * finalScale;
        const scaledH = srcH * finalScale;
        if (isPage) {
          a4Page.drawPage(embedded, { x: MARGIN + tX, y: MARGIN + zoneH - tY - scaledH, width: scaledW, height: scaledH });
        } else {
          a4Page.drawImage(embedded, { x: MARGIN + tX, y: MARGIN + zoneH - tY - scaledH, width: scaledW, height: scaledH });
        }
      }

      async function placeInvoice(a4Page, invoice, slot) {
        let zoneX, zoneY, zoneW, zoneH;
        if (settings.layout === 'vertical') {
          zoneW = A4_WIDTH; zoneH = A4_HEIGHT / 2;
          zoneX = 0; zoneY = slot === 0 ? A4_HEIGHT / 2 : 0;
        } else {
          zoneW = A4_WIDTH / 2; zoneH = A4_HEIGHT;
          zoneX = slot === 0 ? 0 : A4_WIDTH / 2; zoneY = 0;
        }
        
        // 使用临时文档进行裁切 (Clipping 防溢出)
        const tempDoc = await PDFDocument.create();
        const a5Page = tempDoc.addPage([zoneW, zoneH]);
        
        const { element: embedded, isPage } = await embedInvoice(invoice, tempDoc);
        const srcW = invoice.ptWidth || embedded.width;
        const srcH = invoice.ptHeight || embedded.height;
        const MARGIN = 14;
        const innerW = zoneW - MARGIN * 2;
        const innerH = zoneH - MARGIN * 2;
        
        const t = invoice.transform || { x: 0, y: 0, scale: 1.0, isDefault: true };
        const ratio = (settings.layout === 'vertical' ? A4_WIDTH : A4_WIDTH / 2) / 350;
        
        let finalScale, tX, tY;
        if (t.isDefault) {
          const baseScale = settings.scaleMode === 'fill' ? Math.max(innerW/srcW, innerH/srcH) : Math.min(innerW/srcW, innerH/srcH);
          finalScale = baseScale;
          tX = (innerW - srcW * baseScale) / 2;
          tY = (innerH - srcH * baseScale) / 2;
        } else {
          finalScale = t.scale;
          tX = t.x * ratio;
          tY = t.y * ratio;
        }
        
        const scaledW = srcW * finalScale;
        const scaledH = srcH * finalScale;
        
        // 渲染到临时A5页面进行边界裁切
        const pdfX = MARGIN + tX;
        const pdfY = MARGIN + innerH - tY - scaledH;
        
        if (isPage) {
          a5Page.drawPage(embedded, { x: pdfX, y: pdfY, width: scaledW, height: scaledH });
        } else {
          a5Page.drawImage(embedded, { x: pdfX, y: pdfY, width: scaledW, height: scaledH });
        }
        
        // 获取裁切后的临时页面数据并嵌入最终 A4 文档
        const tempBytes = await tempDoc.save();
        const [clippedEmbedded] = await outDoc.embedPdf(tempBytes);
        a4Page.drawPage(clippedEmbedded, { x: zoneX, y: zoneY, width: zoneW, height: zoneH });
      }

      for (const pg of pages) {
        const a4Page = outDoc.addPage([A4_WIDTH, A4_HEIGHT]);
        if (pg.solo) {
          await placeInvoiceFull(a4Page, pg.top);
        } else {
          await placeInvoice(a4Page, pg.top, 0);
          if (pg.bottom) await placeInvoice(a4Page, pg.bottom, 1);
          if (settings.showCutLine && pg.bottom) drawCutLine(a4Page, settings.layout);
        }
      }

      const pdfBytes = await outDoc.save();
      const b64 = btoa(new Uint8Array(pdfBytes).reduce((data, byte) => data + String.fromCharCode(byte), ''));
      return { ok: true, data: b64 };
    } catch (e) {
      console.error(e);
      return { ok: false, error: e.message };
    }
  },

  exportPdf: async ({ pdfBase64, defaultName }) => {
    try {
      const bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName || '合成发票.pdf';
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true, filePath: a.download };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  printPdf: async ({ pdfBase64 }) => {
    try {
      const bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = url;
      document.body.appendChild(iframe);
      
      iframe.onload = () => {
        setTimeout(() => {
          iframe.contentWindow.print();
          // setTimeout(() => document.body.removeChild(iframe), 10000); // 清理
        }, 500);
      };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
};
