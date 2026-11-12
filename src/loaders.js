// Đọc các loại tệp đầu vào thành "trang" để phân tích.
// Bản "legacy" tương thích cả trình duyệt cũ hơn (Chrome/Edge/Firefox vài năm trước)
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { toGray, binarize, estimateSkew } from './core/imageproc.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const PDF_BASE = new URL(import.meta.env.BASE_URL + 'pdfjs/', location.href).href;

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|avif|svg)$/i;
const TEXT_RE = /\.(txt|md|csv|tsv|json|xml|log|ini|yaml|yml)$/i;
const HTML_RE = /\.(html?|xhtml)$/i;
const OFFICE_DOCX = /\.docx?$/i;
const OFFICE_EXCEL = /\.(xlsx?|ods)$/i;
const OFFICE_PPT = /\.(pptx?|odp)$/i;
const EBOOK_RTF = /\.(epub|rtf|msg)$/i;

export function fileKind(file) {
  const n = file.name || '';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(n)) return 'pdf';
  if (OFFICE_DOCX.test(n)) return 'docx';
  if (OFFICE_EXCEL.test(n)) return 'excel';
  if (OFFICE_PPT.test(n)) return 'powerpoint';
  if (EBOOK_RTF.test(n)) return 'ebook';
  if (file.type.startsWith('image/') || IMAGE_RE.test(n)) return 'image';
  if (HTML_RE.test(n) || file.type === 'text/html') return 'html';
  if (file.type.startsWith('text/') || TEXT_RE.test(n)) return 'text';
  return 'unknown';
}

/** Chuẩn hóa kích thước: phóng to ảnh nhỏ (OCR tốt hơn), thu nhỏ ảnh quá lớn */
export function normalizeCanvas(src, w, h) {
  const long = Math.max(w, h);
  let s = 1;
  // Tesseract cho kết quả tốt nhất khi chữ cao ~30px: phóng to ảnh chụp màn hình/ảnh nhỏ
  if (long < 2200) s = Math.min(3, 2400 / long);
  else if (long > 4200) s = 4200 / long;
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function loadImageSource(blob) {
  if (/svg/.test(blob.type)) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { src: img, w: img.naturalWidth || 1000, h: img.naturalHeight || 1000 };
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const bmp = await createImageBitmap(blob);
  return { src: bmp, w: bmp.width, h: bmp.height };
}

export async function imagePage(blob, name) {
  return {
    name,
    async render() {
      const { src, w, h } = await loadImageSource(blob);
      return { canvas: normalizeCanvas(src, w, h), words: null };
    },
  };
}

/** Xoay canvas theo góc nghiêng ước lượng (chỉ khi cần) */
export function deskewCanvas(canvas) {
  const s = Math.min(1, 1200 / Math.max(canvas.width, canvas.height));
  const w = Math.round(canvas.width * s), h = Math.round(canvas.height * s);
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  small.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const data = small.getContext('2d').getImageData(0, 0, w, h).data;
  const angle = estimateSkew(binarize(toGray(data, w, h), w, h), w, h);
  if (Math.abs(angle) < 0.3) return { canvas, angle: 0 };
  const rad = (-angle * Math.PI) / 180;
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return { canvas: out, angle };
}

/** PDF: mỗi trang được render khi cần; dùng lớp chữ sẵn có nếu đủ */
export async function pdfPages(file, name) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: PDF_BASE + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: PDF_BASE + 'standard_fonts/',
    wasmUrl: PDF_BASE + 'wasm/', iccUrl: PDF_BASE + 'iccs/',
  }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    pages.push({
      name: `${name} — trang ${i}`,
      async render({ forceOcr = false } = {}) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(1.5, Math.min(4, 2200 / base.width));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, canvas, viewport }).promise;
        let words = null;
        if (!forceOcr) {
          const tc = await page.getTextContent();
          words = textItemsToWords(tc.items, viewport);
          const chars = words.reduce((s, w) => s + w.text.length, 0);
          if (chars < 30) words = null; // trang scan -> OCR
        }
        return { canvas, words };
      },
    });
  }
  return pages;
}

function textItemsToWords(items, viewport) {
  const words = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    if (Math.abs(tx[1]) > Math.abs(tx[0]) * 0.1) continue; // bỏ chữ xoay
    const fh = Math.hypot(tx[2], tx[3]);
    const x = tx[4], base = tx[5];
    const totalW = it.width * viewport.scale;
    const cw = totalW / it.str.length;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str))) {
      words.push({
        text: m[0], conf: 100,
        x0: x + m.index * cw, x1: x + (m.index + m[0].length) * cw,
        y0: base - fh * 0.82, y1: base + fh * 0.2,
      });
    }
  }
  return words;
}

/** DOCX: chuyển sang HTML (giữ bảng) + OCR các ảnh nhúng */
/** Gọi Microsoft MarkItDown thông qua Electron IPC hoặc local HTTP service */
export async function convertWithMarkItDown(file) {
  const filePath = file.path || file.name;
  // 1. Thử qua Electron API nếu có
  if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.convertWithMarkItDown) {
    if (file.path) {
      const res = await window.electronAPI.convertWithMarkItDown(file.path);
      if (res && res.success) return res;
      if (res && res.error) throw new Error(res.error);
    }
  }

  // 2. Thử qua Local HTTP server MarkItDown
  try {
    const resp = await fetch('http://127.0.0.1:49152/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.success) return data;
    }
  } catch (_) {
    // Service chưa bật hoặc không thể kết nối
  }

  return null;
}

/** DOCX: chuyển sang Markdown (giữ bảng, heading, in đậm/nghiêng) + OCR các ảnh nhúng */
export async function docxDocument(file) {
  // Thử MarkItDown trước nếu có
  try {
    const mRes = await convertWithMarkItDown(file);
    if (mRes && mRes.markdown) {
      return {
        html: `<pre class="md-raw">${esc(mRes.markdown)}</pre>`,
        text: mRes.markdown,
        markdown: mRes.markdown,
        tables: [],
        pages: []
      };
    }
  } catch (e) {
    console.warn('[Docx MarkItDown fallback]:', e.message);
  }

  // Fallback: Mammoth chuyển sang HTML rồi dịch sang Markdown
  const mod = await import('mammoth/mammoth.browser.min.js');
  const mammoth = mod.default || mod;
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return htmlDocument(html, file.name);
}

export async function htmlDocument(html, name) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed').forEach((e) => e.remove());
  const tables = [...doc.querySelectorAll('table')].map(htmlTableToTable);
  const markdown = htmlToMarkdown(doc.body);
  const pages = [];
  let k = 0;
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:')) continue;
    const blob = await (await fetch(src)).blob();
    pages.push(await imagePage(blob, `${name} — ảnh ${++k}`));
  }
  return { html: doc.body.innerHTML, text: htmlToText(doc.body), markdown, tables, pages };
}

const BLOCK = /^(P|DIV|H[1-6]|LI|TR|BR|PRE|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|TABLE|UL|OL)$/;

/** Chuyển đổi cây DOM HTML sang Markdown chuẩn GitHub Flavored Markdown (GFM) */
export function htmlToMarkdown(root) {
  function walk(node, depth = 0) {
    if (node.nodeType === 3) {
      return node.nodeValue.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toUpperCase();

    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n\n---\n\n';

    if (/^H[1-6]$/.test(tag)) {
      const lvl = parseInt(tag[1], 10);
      const text = Array.from(node.childNodes).map((c) => walk(c, depth)).join('').trim();
      return text ? `\n\n${'#'.repeat(lvl)} ${text}\n\n` : '';
    }

    if (tag === 'P') {
      const text = Array.from(node.childNodes).map((c) => walk(c, depth)).join('').trim();
      return text ? `\n\n${text}\n\n` : '';
    }

    if (tag === 'B' || tag === 'STRONG') {
      const text = Array.from(node.childNodes).map((c) => walk(c, depth)).join('').trim();
      return text ? `**${text}**` : '';
    }

    if (tag === 'I' || tag === 'EM') {
      const text = Array.from(node.childNodes).map((c) => walk(c, depth)).join('').trim();
      return text ? `*${text}*` : '';
    }

    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') {
      const text = Array.from(node.childNodes).map((c) => walk(c, depth)).join('').trim();
      return text ? `~~${text}~~` : '';
    }

    if (tag === 'CODE') {
      return `\`${node.textContent.replace(/`/g, '\\`')}\``;
    }

    if (tag === 'PRE') {
      return `\n\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n\n`;
    }

    if (tag === 'BLOCKQUOTE') {
      const text = Array.from(node.childNodes).map((c) => walk(c, depth)).join('').trim();
      return text ? `\n\n> ${text.replace(/\n/g, '\n> ')}\n\n` : '';
    }

    if (tag === 'A') {
      const text = Array.from(node.childNodes).map((c) => walk(c, depth)).join('').trim();
      const href = node.getAttribute('href') || '#';
      return `[${text || href}](${href})`;
    }

    if (tag === 'IMG') {
      const alt = node.getAttribute('alt') || 'ảnh';
      const src = node.getAttribute('src') || '';
      return `![${alt}](${src})`;
    }

    if (tag === 'UL' || tag === 'OL') {
      let idx = 1;
      let res = '\n';
      for (const li of node.children) {
        if (li.tagName.toUpperCase() === 'LI') {
          const prefix = tag === 'UL' ? '- ' : `${idx++}. `;
          const indent = '  '.repeat(depth);
          const liText = Array.from(li.childNodes).map((c) => walk(c, depth + 1)).join('').trim();
          res += `${indent}${prefix}${liText}\n`;
        }
      }
      return res + '\n';
    }

    if (tag === 'TABLE') {
      return '\n\n' + htmlTableToMarkdown(node) + '\n\n';
    }

    return Array.from(node.childNodes).map((c) => walk(c, depth)).join('');
  }

  const res = walk(root);
  return res.replace(/\n{3,}/g, '\n\n').trim();
}

/** Chuyển bảng HTML sang Markdown Table */
export function htmlTableToMarkdown(tableEl) {
  const trList = Array.from(tableEl.querySelectorAll('tr'));
  if (!trList.length) return '';

  const matrix = [];
  let maxCols = 0;

  for (const tr of trList) {
    const cells = Array.from(tr.querySelectorAll('th, td')).map((td) => {
      return td.textContent.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>').trim();
    });
    if (cells.length > maxCols) maxCols = cells.length;
    matrix.push(cells);
  }

  if (!matrix.length || maxCols === 0) return '';

  for (const row of matrix) {
    while (row.length < maxCols) row.push('');
  }

  const head = matrix[0];
  const body = matrix.slice(1);
  const sep = head.map(() => '---');

  return [
    `| ${head.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** HTML -> văn bản giữ xuống dòng; ô bảng cách nhau bằng Tab */
function htmlToText(root) {
  let out = '';
  const walk = (node) => {
    if (node.nodeType === 3) { out += node.nodeValue.replace(/\s+/g, ' '); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { out += '\n'; return; }
    if (tag === 'IMG') { out += '[ảnh]'; return; }
    if (tag === 'TD' || tag === 'TH') {
      out += htmlToText(node).replace(/\s*\n\s*/g, ' ');
      if (node.nextElementSibling) out += '\t';
      return;
    }
    const block = BLOCK.test(tag);
    if (block && out && !out.endsWith('\n')) out += '\n';
    if (tag === 'LI') out += '• ';
    node.childNodes.forEach(walk);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  root.childNodes.forEach(walk);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Bảng HTML -> cấu trúc bảng nội bộ (xử lý rowspan/colspan) */
export function htmlTableToTable(el) {
  const cells = [];
  const occ = [];
  let cols = 0;
  [...el.rows].forEach((tr, r) => {
    occ[r] = occ[r] || [];
    let c = 0;
    for (const td of tr.cells) {
      while (occ[r][c]) c++;
      const rs = Math.max(1, td.rowSpan || 1), cs = Math.max(1, td.colSpan || 1);
      for (let i = 0; i < rs; i++) { occ[r + i] = occ[r + i] || []; for (let j = 0; j < cs; j++) occ[r + i][c + j] = 1; }
      cells.push({ r, c, rs, cs, text: htmlToText(td) });
      c += cs;
      cols = Math.max(cols, c);
    }
  });
  return { kind: 'document', rows: occ.length, cols, cells, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } };
}
