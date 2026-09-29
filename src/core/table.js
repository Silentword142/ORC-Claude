// Phát hiện và dựng lại cấu trúc bảng: bảng có kẻ đường (dựa trên đường
// ngang/dọc) và bảng không kẻ (dựa trên căn cột của chữ).
import { lineMask, lineSegments, cluster1D, median } from './imageproc.js';

const center = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const inside = (p, r, m = 0) => p.x >= r.x0 - m && p.x <= r.x1 + m && p.y >= r.y0 - m && p.y <= r.y1 + m;

/** Phát hiện đoạn kẻ ngang/dọc trong ảnh nhị phân */
export function detectLines(bin, width, height) {
  const minH = Math.max(30, Math.round(width * 0.025));
  const minV = Math.max(18, Math.round(height * 0.012));
  const maxT = Math.max(6, Math.round(Math.min(width, height) / 150));
  const hMask = lineMask(bin, width, height, 'h', minH, 2);
  const vMask = lineMask(bin, width, height, 'v', minV, 2);
  const h = lineSegments(hMask, width, height, 'h', maxT);
  const v = lineSegments(vMask, width, height, 'v', maxT);
  return { h, v, hMask, vMask };
}

const hits = (hs, vs, tol) =>
  vs.x >= hs.x0 - tol && vs.x <= hs.x1 + tol && hs.y >= vs.y0 - tol && hs.y <= vs.y1 + tol;

/**
 * Tìm bảng có đường kẻ. Trả về danh sách bảng
 * { bbox, xs, ys, cells:[{r,c,rs,cs,x0,y0,x1,y1,text,words}], rows, cols, kind:'ruled' }
 */
export function detectRuledTables(lines, words, width, height) {
  const tol = Math.max(4, Math.round(Math.min(width, height) / 300));
  let { h, v } = lines;
  // Lọc lặp: đường dọc phải cắt >= 2 đường ngang và ngược lại
  for (let it = 0; it < 3; it++) {
    const v2 = v.filter((vs) => h.filter((hs) => hits(hs, vs, tol)).length >= 2);
    const h2 = h.filter((hs) => v2.filter((vs) => hits(hs, vs, tol)).length >= 1);
    const stable = v2.length === v.length && h2.length === h.length;
    v = v2; h = h2;
    if (stable) break;
  }
  if (!h.length || !v.length) return [];

  // Gom nhóm đoạn giao nhau thành từng bảng (union-find)
  const all = [...h.map((s) => ({ s, d: 'h' })), ...v.map((s) => ({ s, d: 'v' }))];
  const parent = all.map((_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (let i = 0; i < h.length; i++) {
    for (let j = 0; j < v.length; j++) {
      if (hits(h[i], v[j], tol)) parent[find(i)] = find(h.length + j);
    }
  }
  const groups = new Map();
  all.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { h: [], v: [] });
    groups.get(r)[e.d].push(e.s);
  });

  const tables = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const t = buildGrid(g.h, g.v, words, tol);
    if (t) t.segments = g;
    // Một khung chữ nhật đơn (hộp trong sơ đồ) không phải bảng
    if (t && t.cells.length >= 2) tables.push(t);
  }
  return tables;
}

function buildGrid(hs, vs, words, tol) {
  const x0 = Math.min(...hs.map((s) => s.x0), ...vs.map((s) => s.x));
  const x1 = Math.max(...hs.map((s) => s.x1), ...vs.map((s) => s.x));
  const y0 = Math.min(...vs.map((s) => s.y0), ...hs.map((s) => s.y));
  const y1 = Math.max(...vs.map((s) => s.y1), ...hs.map((s) => s.y));
  const ctol = tol * 2;
  let xs = cluster1D(vs.map((s) => s.x), ctol);
  let ys = cluster1D(hs.map((s) => s.y), ctol);
  // Bảng hở biên: thêm biên ngoài nếu thiếu
  if (xs[0] - x0 > ctol * 2) xs.unshift(x0);
  if (x1 - xs[xs.length - 1] > ctol * 2) xs.push(x1);
  if (ys[0] - y0 > ctol * 2) ys.unshift(y0);
  if (y1 - ys[ys.length - 1] > ctol * 2) ys.push(y1);
  // Bỏ hàng/cột quá hẹp (đường kẻ đôi)
  const minGap = Math.max(8, tol * 2);
  xs = xs.filter((x, i) => i === 0 || x - xs[i - 1] >= minGap);
  ys = ys.filter((y, i) => i === 0 || y - ys[i - 1] >= minGap);
  // Biên trên/dưới của bảng phải là đường kẻ gần như trọn chiều rộng; nếu
  // không (vd. đáy elip + mũi tên nối vào hộp), cắt bỏ hàng đó.
  const coverage = (y) => {
    const segs = hs.filter((s) => Math.abs(s.y - y) <= ctol).map((s) => [Math.max(s.x0, xs[0]), Math.min(s.x1, xs[xs.length - 1])]).sort((a, b) => a[0] - b[0]);
    let cov = 0, end = -Infinity;
    for (const [a, b] of segs) { if (b > end) { cov += b - Math.max(a, end); end = b; } }
    return cov / Math.max(1, xs[xs.length - 1] - xs[0]);
  };
  while (ys.length > 2 && coverage(ys[0]) < 0.85) ys.shift();
  while (ys.length > 2 && coverage(ys[ys.length - 1]) < 0.85) ys.pop();
  if (coverage(ys[0]) < 0.85 || coverage(ys[ys.length - 1]) < 0.85) return null;
  const rows = ys.length - 1, cols = xs.length - 1;
  if (rows < 1 || cols < 1) return null;

  const hasV = (x, ya, yb) => vs.some((s) => Math.abs(s.x - x) <= ctol && s.y0 - tol <= ya && s.y1 + tol >= yb);
  const hasH = (y, xa, xb) => hs.some((s) => Math.abs(s.y - y) <= ctol && s.x0 - tol <= xa && s.x1 + tol >= xb);

  // Union-find ô lưới để xử lý ô gộp
  const id = (r, c) => r * cols + c;
  const parent = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (let r = 0; r < rows; r++) {
    const ya = ys[r] + (ys[r + 1] - ys[r]) * 0.3, yb = ys[r] + (ys[r + 1] - ys[r]) * 0.7;
    for (let c = 0; c < cols; c++) {
      const xa = xs[c] + (xs[c + 1] - xs[c]) * 0.3, xb = xs[c] + (xs[c + 1] - xs[c]) * 0.7;
      if (c < cols - 1 && !hasV(xs[c + 1], ya, yb)) parent[find(id(r, c + 1))] = find(id(r, c));
      if (r < rows - 1 && !hasH(ys[r + 1], xa, xb)) parent[find(id(r + 1, c))] = find(id(r, c));
    }
  }
  const spans = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = find(id(r, c));
      const s = spans.get(k);
      if (!s) spans.set(k, { r0: r, r1: r, c0: c, c1: c });
      else { s.r0 = Math.min(s.r0, r); s.r1 = Math.max(s.r1, r); s.c0 = Math.min(s.c0, c); s.c1 = Math.max(s.c1, c); }
    }
  }
  const occupied = new Uint8Array(rows * cols);
  const cells = [];
  for (const s of [...spans.values()].sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)) {
    let free = true;
    for (let r = s.r0; r <= s.r1 && free; r++) for (let c = s.c0; c <= s.c1; c++) if (occupied[id(r, c)]) { free = false; break; }
    if (!free) continue;
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) occupied[id(r, c)] = 1;
    cells.push({
      r: s.r0, c: s.c0, rs: s.r1 - s.r0 + 1, cs: s.c1 - s.c0 + 1,
      x0: xs[s.c0], y0: ys[s.r0], x1: xs[s.c1 + 1], y1: ys[s.r1 + 1], text: '', words: [],
    });
  }
  const table = { kind: 'ruled', bbox: { x0: xs[0], y0: ys[0], x1: xs[cols], y1: ys[rows] }, xs, ys, rows, cols, cells };
  fillCells(table, words);
  return table;
}

/** Gán từ vào ô theo tâm từ, rồi ghép chữ theo dòng */
export function fillCells(table, words) {
  for (const cell of table.cells) { cell.words = []; }
  for (const w of words) {
    const p = center(w);
    if (!inside(p, table.bbox)) continue;
    const cell = table.cells.find((c) => inside(p, c));
    if (cell) { cell.words.push(w); w.inTable = true; }
  }
  for (const cell of table.cells) cell.text = wordsToText(cell.words);
}

/** Ghép danh sách từ (có bbox) thành văn bản nhiều dòng */
export function wordsToText(words) {
  if (!words.length) return '';
  const hMed = median(words.map((w) => w.y1 - w.y0)) || 10;
  const sorted = [...words].sort((a, b) => center(a).y - center(b).y);
  const lines = [];
  for (const w of sorted) {
    const cy = center(w).y;
    const line = lines.find((l) => Math.abs(l.cy - cy) < hMed * 0.6);
    if (line) { line.words.push(w); line.cy = (line.cy * (line.words.length - 1) + cy) / line.words.length; }
    else lines.push({ cy, words: [w] });
  }
  lines.sort((a, b) => a.cy - b.cy);
  return lines.map((l) => l.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ')).join('\n');
}

/**
 * Phát hiện bảng không kẻ khung từ các dòng chữ: các dòng liên tiếp có
 * >= 2 cụm chữ cách nhau bởi khoảng trắng lớn và các cột thẳng hàng.
 */
export function detectBorderlessTables(lines, { minRows = 3 } = {}) {
  lines = mergeRows(lines);
  const cand = [];
  for (const line of lines) {
    const ws = line.words.filter((w) => !w.inTable && !w.inShape).sort((a, b) => a.x0 - b.x0);
    if (ws.length < 2) { cand.push(null); continue; }
    const lh = median(ws.map((w) => w.y1 - w.y0)) || 10;
    const chunks = [];
    let cur = [ws[0]];
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].x0 - ws[i - 1].x1 > lh * 1.6) { chunks.push(cur); cur = []; }
      cur.push(ws[i]);
    }
    chunks.push(cur);
    cand.push(chunks.length >= 2 ? { line, lh, chunks: chunks.map(toChunk) } : null);
  }

  const tables = [];
  let block = [];
  const flush = () => {
    if (block.length >= minRows) {
      const t = buildBorderless(block);
      if (t) tables.push(t);
    }
    block = [];
  };
  for (const c of cand) {
    if (!c) { flush(); continue; }
    const prev = block[block.length - 1];
    if (prev && c.line.bbox.y0 - prev.line.bbox.y1 > Math.max(prev.lh, c.lh) * 2.2) flush();
    block.push(c);
  }
  flush();
  return tables;
}

/** Gộp các dòng cùng độ cao (OCR thường tách cột bảng thành khối riêng) */
function mergeRows(lines) {
  const ls = lines.filter((l) => l.words.length).map((l) => {
    const ws = l.words;
    const bbox = { x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)), x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)) };
    return { words: ws, bbox, cy: (bbox.y0 + bbox.y1) / 2, h: bbox.y1 - bbox.y0 };
  }).sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const l of ls) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.cy - l.cy) < Math.min(r.h, l.h) * 0.5) {
      r.words = [...r.words, ...l.words];
      r.bbox = { x0: Math.min(r.bbox.x0, l.bbox.x0), y0: Math.min(r.bbox.y0, l.bbox.y0), x1: Math.max(r.bbox.x1, l.bbox.x1), y1: Math.max(r.bbox.y1, l.bbox.y1) };
    } else rows.push({ ...l });
  }
  return rows;
}

function toChunk(ws) {
  return {
    words: ws, x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)),
    y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)),
  };
}

function buildBorderless(block) {
  // Hợp các khoảng x của cụm chữ -> cột
  const intervals = block.flatMap((b) => b.chunks.map((c) => [c.x0, c.x1])).sort((a, b) => a[0] - b[0]);
  const lh = median(block.map((b) => b.lh));
  const cols = [];
  for (const [a, b] of intervals) {
    const last = cols[cols.length - 1];
    if (last && a <= last[1] + lh * 0.8) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  if (cols.length < 2) return null;
  // Mỗi cột phải có dữ liệu ở ít nhất một nửa số dòng
  const colOf = (c) => cols.findIndex(([a, b]) => (c.x0 + c.x1) / 2 >= a && (c.x0 + c.x1) / 2 <= b);
  const counts = new Array(cols.length).fill(0);
  for (const b of block) for (const c of b.chunks) counts[colOf(c)]++;
  if (counts.filter((n) => n >= block.length * 0.5).length < 2) return null;
  // Hai cột văn bản dài (bố cục 2 cột) không phải bảng
  const chunkWords = block.flatMap((b) => b.chunks.map((c) => c.words.length));
  if (chunkWords.reduce((s, k) => s + k, 0) / chunkWords.length > 6) return null;

  const xs = [cols[0][0] - 4];
  for (let i = 1; i < cols.length; i++) xs.push((cols[i - 1][1] + cols[i][0]) / 2);
  xs.push(cols[cols.length - 1][1] + 4);
  const ys = [block[0].line.bbox.y0 - 4];
  for (let i = 1; i < block.length; i++) ys.push((block[i - 1].line.bbox.y1 + block[i].line.bbox.y0) / 2);
  ys.push(block[block.length - 1].line.bbox.y1 + 4);

  const cells = [];
  block.forEach((b, r) => {
    for (let c = 0; c < cols.length; c++) {
      const ws = b.chunks.filter((ch) => colOf(ch) === c).flatMap((ch) => ch.words);
      ws.forEach((w) => { w.inTable = true; });
      cells.push({ r, c, rs: 1, cs: 1, x0: xs[c], y0: ys[r], x1: xs[c + 1], y1: ys[r + 1], words: ws, text: wordsToText(ws) });
    }
  });
  return {
    kind: 'borderless', rows: block.length, cols: cols.length, xs, ys, cells,
    bbox: { x0: xs[0], y0: ys[0], x1: xs[xs.length - 1], y1: ys[ys.length - 1] },
  };
}

/** Bảng -> ma trận 2 chiều (ô gộp lặp lại nội dung ở ô đầu, ô sau rỗng) */
export function tableToMatrix(table) {
  const m = Array.from({ length: table.rows }, () => new Array(table.cols).fill(''));
  for (const c of table.cells) m[c.r][c.c] = c.text;
  return m;
}
