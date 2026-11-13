// Luồng phân tích một trang: nhị phân hóa -> tìm đường kẻ -> OCR ->
// bảng -> sơ đồ -> bảng không kẻ -> sắp xếp khối theo thứ tự đọc.
import { toGray, binarize, median, enhanceForOcr } from './imageproc.js';
import { detectLines, detectRuledTables, detectBorderlessTables, fillCells, wordsToText } from './table.js';
import { detectDiagram, outlineInside, outlineDistance, groupLabels } from './diagram.js';

/**
 * page: { width, height, rgba, words?, lines?, paragraphs? } — words có sẵn khi PDF có lớp chữ.
 * opts.ocr({width,height,gray}) -> { words, lines, paragraphs } (tọa độ pixel ảnh)
 * opts.ocrRegion({width,height,gray}, rect) -> string: OCR một vùng (chữ trong hình sơ đồ;
 *   ô bảng khi opts.cellOcr = true)
 */
export async function analyzePage(page, opts = {}) {
  const { width, height } = page;
  const { tables: wantTables = true, diagrams: wantDiagrams = true, progress = () => {} } = opts;
  const gray = toGray(page.rgba, width, height);
  const bin = binarize(gray, width, height);

  progress('Tìm đường kẻ…');
  const lines = detectLines(bin, width, height);

  // Dựng khung bảng trước (chưa có chữ) để xóa đúng các đường kẻ của bảng;
  // ảnh "sạch" giúp OCR chữ trong ô chính xác hơn mà không làm hỏng chữ to.
  let tables = wantTables ? detectRuledTables(lines, [], width, height) : [];
  const clean = gray.slice();
  for (const t of tables) {
    for (const s of [...t.segments.h, ...t.segments.v]) {
      for (let y = Math.max(0, s.y0 - 1); y <= Math.min(height - 1, s.y1 + 1); y++) {
        for (let x = Math.max(0, s.x0 - 1); x <= Math.min(width - 1, s.x1 + 1); x++) {
          const i = y * width + x;
          if (lines.hMask[i] || lines.vMask[i] || bin[i]) clean[i] = 255;
        }
      }
    }
  }

  let text = page.words ? page : null;
  if (!text) {
    progress('Nhận dạng chữ (OCR)…');
    const ocrGray = enhanceForOcr(clean, width, height);
    text = await opts.ocr({ width, height, gray: ocrGray });
  }
  const words = text.words.map((w) => ({ ...w, inTable: false, inShape: false, inDiagram: false }));
  const byRef = new Map(text.words.map((w, i) => [w, words[i]]));
  const textLines = (text.lines || buildLines(words)).map((l) => ({ ...l, words: l.words.map((w) => byRef.get(w) || w) }));
  for (const l of textLines) {
    const lineBox = { x0: Math.min(...l.words.map((w) => w.x0)), x1: Math.max(...l.words.map((w) => w.x1)) };
    for (const w of l.words) w.lineBox = lineBox;
  }
  const paragraphs = (text.paragraphs || buildParagraphs(textLines)).map((p) => ({
    ...p, lines: p.lines.map((l) => ({ ...l, words: l.words.map((w) => byRef.get(w) || w) })),
  }));

  if (wantTables) {
    progress('Phân tích bảng…');
    for (const t of tables) fillCells(t, words);
    // Một khung đơn chứa ít chữ (hộp trong sơ đồ) không phải bảng
    const th = median(words.map((w) => w.y1 - w.y0)) || 20;
    tables = tables.filter((t) => t.cells.filter((c) => c.text && c.x1 - c.x0 >= th * 1.5 && c.y1 - c.y0 >= th * 1.2).length >= 2);
    for (const w of words) w.inTable = tables.some((t) => t.cells.some((c) => c.words.includes(w)));
    if (opts.cellOcr && opts.ocrRegion && !page.words) {
      for (const t of tables) {
        for (const cell of t.cells) {
          const pad = 3;
          const r = { x0: cell.x0 + pad, y0: cell.y0 + pad, x1: cell.x1 - pad, y1: cell.y1 - pad };
          if (r.x1 - r.x0 < 6 || r.y1 - r.y0 < 6) continue;
          if (!cell.words.length && !hasInk(bin, width, r)) continue;
          cell.text = (await opts.ocrRegion({ width, height, gray: clean }, r)).trim();
        }
      }
    }
  }

  let diagram = null;
  if (wantDiagrams) {
    progress('Phân tích sơ đồ…');
    diagram = detectDiagram(bin, width, height, words, tables);
    if (diagram && !page.words && opts.ocrRegion) {
      progress('Đọc chữ trong sơ đồ…');
      // Chữ trong hình: Tesseract thường bỏ qua vùng hình vẽ khi phân tích bố
      // cục trang, nên OCR lại phần trong mỗi hình (đã xóa viền) nếu cần.
      for (const s of diagram.shapes) {
        const conf = s.words.length ? s.words.reduce((a, w) => a + w.conf, 0) / s.words.length : 0;
        if (s.text && conf >= 80) continue;
        const img = shapeInterior(gray, width, height, s);
        if (!img) continue;
        const t = (await opts.ocrRegion(img, { x0: 0, y0: 0, x1: img.width, y1: img.height })).trim();
        if (t && /[\p{L}\p{N}]/u.test(t)) s.text = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n');
      }
      // Nhãn tự do (trên đường nối…): OCR thưa trên vùng sơ đồ đã xóa hình vẽ
      if (opts.ocr) {
        const labelWords = await ocrDiagramLabels(gray, width, height, diagram, opts.ocr);
        if (labelWords.length) diagram.labels = groupLabels(labelWords, diagram.textHeight);
      }
      const b = diagram.bbox;
      for (const w of words) {
        const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
        if (!w.inTable && cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1 && w.lineBox.x0 >= b.x0 - 20 && w.lineBox.x1 <= b.x1 + 20) w.inDiagram = true;
      }
    }
  }
  if (wantTables) {
    const lineObjs = textLines.map((l) => ({ ...l, words: l.words.filter((w) => !w.inDiagram) }));
    tables.push(...detectBorderlessTables(lineObjs));
  }

  const blocks = orderBlocks(paragraphs, tables, diagram);
  return {
    width, height, words, lines: textLines, tables, diagram, blocks,
    source: page.words ? 'pdf-text' : 'ocr',
    meanConfidence: words.length ? Math.round(words.reduce((s, w) => s + (w.conf ?? 100), 0) / words.length) : null,
  };
}

async function ocrDiagramLabels(gray, width, height, d, ocr) {
  const pad = 10;
  const x0 = Math.max(0, Math.floor(d.bbox.x0 - pad)), y0 = Math.max(0, Math.floor(d.bbox.y0 - pad));
  const x1 = Math.min(width - 1, Math.ceil(d.bbox.x1 + pad)), y1 = Math.min(height - 1, Math.ceil(d.bbox.y1 + pad));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = x + x0, Y = y + y0, i = Y * width + X;
      const inShape = d.shapes.some((s) => X >= s.x0 - 2 && X <= s.x1 + 2 && Y >= s.y0 - 2 && Y <= s.y1 + 2 && (outlineInside(s, X, Y, true) || outlineDistance(s, X, Y) < s.stroke + 3));
      img[y * w + x] = d.graphicMask[i] || inShape ? 255 : gray[i];
    }
  }
  const res = await ocr({ width: w, height: h, gray: img }, { psm: '11' });
  return res.words
    .filter((wd) => wd.conf >= 55 && /[\p{L}\p{N}]/u.test(wd.text))
    .map((wd) => ({ ...wd, x0: wd.x0 + x0, x1: wd.x1 + x0, y0: wd.y0 + y0, y1: wd.y1 + y0 }));
}

/** Cắt vùng trong của hình, tô trắng phần ngoài và đường viền */
function shapeInterior(gray, width, height, s) {
  const x0 = Math.max(0, Math.floor(s.ix0)), y0 = Math.max(0, Math.floor(s.iy0));
  const x1 = Math.min(width - 1, Math.ceil(s.ix1)), y1 = Math.min(height - 1, Math.ceil(s.iy1));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < 8 || h < 8) return null;
  const out = new Uint8Array(w * h);
  const margin = s.stroke + 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = x + x0, Y = y + y0;
      const keep = outlineInside(s, X, Y, true) && outlineDistance(s, X, Y) > margin;
      out[y * w + x] = keep ? gray[Y * width + X] : 255;
    }
  }
  return { width: w, height: h, gray: out };
}

function hasInk(bin, width, r) {
  let k = 0;
  for (let y = Math.round(r.y0); y < r.y1; y++) {
    for (let x = Math.round(r.x0); x < r.x1; x++) if (bin[y * width + x]) k++;
  }
  return k > 15;
}

/** Nhóm từ thành dòng theo tọa độ (dùng cho lớp chữ PDF) */
export function buildLines(words) {
  const hMed = median(words.map((w) => w.y1 - w.y0)) || 10;
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1) || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    const line = lines.find((l) => Math.abs(l.cy - cy) < hMed * 0.5 && w.x0 - l.bbox.x1 < hMed * 3 && l.bbox.x0 - w.x1 < hMed * 3);
    if (line) {
      line.words.push(w);
      line.bbox = { x0: Math.min(line.bbox.x0, w.x0), y0: Math.min(line.bbox.y0, w.y0), x1: Math.max(line.bbox.x1, w.x1), y1: Math.max(line.bbox.y1, w.y1) };
    } else lines.push({ cy, words: [w], bbox: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 } });
  }
  for (const l of lines) l.words.sort((a, b) => a.x0 - b.x0);
  return lines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

/** Nhóm dòng thành đoạn theo khoảng cách dọc và căn lề trái */
export function buildParagraphs(lines) {
  const paras = [];
  for (const l of lines) {
    const h = l.bbox.y1 - l.bbox.y0;
    const p = paras.find((p) => {
      const last = p.lines[p.lines.length - 1];
      return l.bbox.y0 - last.bbox.y1 < h * 0.9 && l.bbox.y0 >= last.bbox.y0
        && Math.min(l.bbox.x1, p.bbox.x1) - Math.max(l.bbox.x0, p.bbox.x0) > 0;
    });
    if (p) {
      p.lines.push(l);
      p.bbox = { x0: Math.min(p.bbox.x0, l.bbox.x0), y0: p.bbox.y0, x1: Math.max(p.bbox.x1, l.bbox.x1), y1: Math.max(p.bbox.y1, l.bbox.y1) };
    } else paras.push({ lines: [l], bbox: { ...l.bbox } });
  }
  return paras;
}

function orderBlocks(paragraphs, tables, diagram) {
  const blocks = [];
  for (const p of paragraphs) {
    const lines = p.lines
      .map((l) => l.words.filter((w) => !w.inTable && !w.inDiagram))
      .filter((ws) => ws.length);
    if (!lines.length) continue;
    const ws = lines.flat();
    blocks.push({
      type: 'para', text: lines.map((ws) => ws.map((w) => w.text).join(' ')).join('\n'),
      lines: lines.map((ws) => ({
        text: ws.map((w) => w.text).join(' '),
        bbox: { x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)), x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)) },
      })),
      bbox: { x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)), x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)) },
    });
  }
  const objs = [...tables.map((t) => ({ type: 'table', table: t, bbox: t.bbox }))];
  if (diagram) objs.push({ type: 'diagram', diagram, bbox: diagram.bbox });
  for (const o of objs.sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const idx = blocks.findIndex((b) => b.type === 'para' && b.bbox.y0 > o.bbox.y0);
    if (idx < 0) blocks.push(o); else blocks.splice(idx, 0, o);
  }
  return blocks;
}

export { fillCells, wordsToText };
