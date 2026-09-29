// Bọc Tesseract.js (WASM, chạy cục bộ). Tài nguyên được phục vụ từ
// public/tesseract nên không cần mạng sau khi tải trang.
import { createWorker, PSM } from 'tesseract.js';

const BASE = import.meta.env.BASE_URL + 'tesseract';
let worker = null;
let workerLangs = '';
let logger = () => {};

export function setOcrLogger(fn) { logger = fn; }

async function getWorker(langs) {
  if (worker && workerLangs === langs) return worker;
  if (worker) await worker.terminate();
  worker = await createWorker(langs.split('+'), 1, {
    workerPath: new URL(`${BASE}/worker.min.js`, location.href).href,
    corePath: new URL(`${BASE}/core`, location.href).href,
    langPath: new URL(`${BASE}/lang`, location.href).href,
    gzip: true,
    logger: (m) => logger(m),
  });
  await worker.setParameters({ preserve_interword_spaces: '1' });
  workerLangs = langs;
  return worker;
}

export function grayToCanvas({ width, height, gray }, rect) {
  const x0 = rect ? Math.max(0, Math.round(rect.x0)) : 0;
  const y0 = rect ? Math.max(0, Math.round(rect.y0)) : 0;
  const w = rect ? Math.min(width, Math.round(rect.x1)) - x0 : width;
  const h = rect ? Math.min(height, Math.round(rect.y1)) - y0 : height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[(y + y0) * width + x + x0];
      const j = (y * w + x) * 4;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = v;
      img.data[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** OCR cả trang -> { words, lines, paragraphs } theo tọa độ ảnh */
export async function ocrPage(image, langs, psm = PSM.AUTO) {
  psm = psm || PSM.AUTO;
  const w = await getWorker(langs);
  await w.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await w.recognize(grayToCanvas(image), {}, { blocks: true, text: true });
  const words = [], lines = [], paragraphs = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      const p = { lines: [], bbox: bb(para.bbox) };
      for (const line of para.lines || []) {
        const l = { words: [], bbox: bb(line.bbox) };
        for (const wd of line.words || []) {
          const text = (wd.text || '').trim();
          if (!text) continue;
          const o = { text, conf: wd.confidence, ...bb(wd.bbox) };
          words.push(o); l.words.push(o);
        }
        if (l.words.length) { p.lines.push(l); lines.push(l); }
      }
      if (p.lines.length) paragraphs.push(p);
    }
  }
  return { words, lines, paragraphs, text: data.text };
}

/** OCR một vùng (ô bảng) với chế độ khối đơn */
export async function ocrRegion(image, rect, langs) {
  const w = await getWorker(langs);
  await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  const c = grayToCanvas(image, rect);
  // thêm viền trắng giúp Tesseract nhận chữ sát mép
  const pad = document.createElement('canvas');
  pad.width = c.width + 20; pad.height = c.height + 20;
  const ctx = pad.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pad.width, pad.height);
  ctx.drawImage(c, 10, 10);
  const { data } = await w.recognize(pad);
  return data.text.replace(/\n{2,}/g, '\n').trim();
}

const bb = (b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
