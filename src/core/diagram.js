// Phát hiện sơ đồ (lưu đồ, sơ đồ khối): hình khép kín (chữ nhật, bo góc,
// elip, thoi, bình hành, đa giác), đường nối/mũi tên và chữ gắn kèm.
// Ý tưởng chính: hình khép kín tạo ra "lỗ" nền không nối với biên ảnh.
import { connectedComponents, dilate, median } from './imageproc.js';
import { wordsToText } from './table.js';

const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;

export function detectDiagram(bin, width, height, words, tables = []) {
  const n = width * height;
  const hMed = median(words.map((w) => w.y1 - w.y0)) || 20;

  // 1. Mặt nạ đồ họa = mực trừ chữ và bảng
  const g = bin.slice();
  const clearRect = (x0, y0, x1, y1) => {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(width - 1, Math.ceil(x1)); y1 = Math.min(height - 1, Math.ceil(y1));
    for (let y = y0; y <= y1; y++) g.fill(0, y * width + x0, y * width + x1 + 1);
  };
  for (const t of tables) clearRect(t.bbox.x0 - 4, t.bbox.y0 - 4, t.bbox.x1 + 4, t.bbox.y1 + 4);
  // Xóa chữ: chỉ xóa các thành phần mực nằm gọn trong khung một từ, nhờ đó
  // viền hình không bị xóa nhầm khi OCR sinh "từ rác" đè lên đường viền.
  {
    const { labels, comps } = connectedComponents(g, width, height);
    const kill = new Uint8Array(comps.length + 1);
    // bỏ qua "từ" nghi là đường kẻ bị OCR nhầm (|, l, —…)
    const boxes = words
      .filter((w) => w.y1 - w.y0 < hMed * 4 && (w.y1 - w.y0) < (w.x1 - w.x0) * 4 && /[\p{L}\p{N}]/u.test(w.text))
      .map((w) => [w.x0 - 3, w.y0 - 3, w.x1 + 3, w.y1 + 3]);
    // lưới thô để tra cứu nhanh khung từ
    const cell = Math.max(32, Math.round(hMed * 3));
    const gw = Math.ceil(width / cell), grid = new Map();
    boxes.forEach((b, k) => {
      for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) {
        for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) {
          const key = gy * gw + gx;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(k);
        }
      }
    });
    const maxChar = hMed * 1.8;
    for (const c of comps) {
      if (c.x1 - c.x0 > maxChar * 2.5 || c.y1 - c.y0 > maxChar) continue; // quá dài để là ký tự
      const cand = grid.get(Math.floor(c.y0 / cell) * gw + Math.floor(c.x0 / cell)) || [];
      for (const k of cand) {
        const b = boxes[k];
        if (c.x0 >= b[0] && c.y0 >= b[1] && c.x1 <= b[2] && c.y1 <= b[3]) { kill[c.id] = 1; break; }
      }
    }
    for (let i = 0; i < n; i++) if (kill[labels[i]]) g[i] = 0;
  }
  // Bỏ nhiễu nhỏ
  {
    const { labels, comps } = connectedComponents(g, width, height);
    const small = new Uint8Array(comps.length + 1);
    for (const c of comps) if (c.area < 12 && Math.max(c.x1 - c.x0, c.y1 - c.y0) < 8) small[c.id] = 1;
    for (let i = 0; i < n; i++) if (small[labels[i]]) g[i] = 0;
  }

  // 2. Tìm lỗ (vùng nền khép kín)
  const closed = dilate(g, width, height, 1);
  const { labels: holeLabels, comps: bgComps } = connectedComponents(closed, width, height, { conn8: false, value: 0 });
  const minW = Math.max(24, hMed * 1.2), minH = Math.max(16, hMed * 0.9);
  const shapes = [];
  for (const c of bgComps) {
    if (c.x0 === 0 || c.y0 === 0 || c.x1 === width - 1 || c.y1 === height - 1) continue;
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (bw < minW || bh < minH || c.area < minW * minH * 0.4) continue;
    if (bw * bh > n * 0.7) continue;
    const s = classifyHole(c, holeLabels, width, bin);
    if (s) shapes.push(s);
  }
  // Quan hệ lồng nhau
  for (const s of shapes) {
    let best = null;
    for (const o of shapes) {
      if (o === s) continue;
      if (o.x0 <= s.x0 && o.y0 <= s.y0 && o.x1 >= s.x1 && o.y1 >= s.y1 && (!best || o.area < best.area)) best = o;
    }
    s.parent = best ? best.id : null;
  }

  // 3. Xóa viền hình để còn lại đường nối
  const lines = g.slice();
  for (const s of shapes) {
    const pad = s.stroke / 2 + 3;
    const x0 = Math.max(0, Math.floor(s.x0 - pad)), x1 = Math.min(width - 1, Math.ceil(s.x1 + pad));
    const y0 = Math.max(0, Math.floor(s.y0 - pad)), y1 = Math.min(height - 1, Math.ceil(s.y1 + pad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        if (lines[i] && outlineDistance(s, x, y) <= pad) lines[i] = 0;
      }
    }
  }

  // 4. Đường nối
  const connectors = [];
  const { labels: ll, comps: lc } = connectedComponents(lines, width, height);
  const pix = new Map();
  for (const c of lc) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (Math.max(bw, bh) < Math.max(12, hMed * 0.6) || c.area < 8) continue;
    if (c.area / (bw * bh) > 0.55 && Math.min(bw, bh) > 6) continue; // khối đặc (logo, ảnh)
    // ký tự còn sót (OCR bỏ qua chữ trong hình) nằm gọn trong một hình
    if (Math.max(bw, bh) < hMed * 2 && shapes.some((s) => c.x0 > s.ix0 + s.stroke && c.x1 < s.ix1 - s.stroke && c.y0 > s.iy0 + s.stroke && c.y1 < s.iy1 - s.stroke)) continue;
    pix.set(c.id, []);
  }
  for (let i = 0; i < n; i++) {
    const arr = pix.get(ll[i]);
    if (arr) arr.push(i);
  }
  let cid = 0;
  // Mặt nạ đồ họa (viền hình + đường nối) để tách chữ nhãn khi OCR lại
  const graphicMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (g[i] && !lines[i]) graphicMask[i] = 1;
  for (const [id, arr] of pix) {
    const conn = buildConnector(arr, width, shapes, lines, ll, id, hMed);
    if (conn && (conn.from || conn.to) && conn.from !== conn.to) {
      connectors.push({ id: `e${++cid}`, ...conn });
      for (const i of arr) graphicMask[i] = 1;
    }
  }

  if (!(shapes.length >= 2 || (shapes.length >= 1 && connectors.length))) return null;

  // 5. Gán chữ vào hình (hình trong cùng chứa tâm từ)
  for (const s of shapes) s.words = [];
  const free = [];
  for (const w of words) {
    if (w.inTable) continue;
    const px = cx(w), py = cy(w);
    let best = null;
    for (const s of shapes) {
      if (px > s.ix0 && px < s.ix1 && py > s.iy0 && py < s.iy1 && outlineInside(s, px, py) && (!best || s.area < best.area)) best = s;
    }
    if (best) { best.words.push(w); w.inShape = true; } else free.push(w);
  }
  for (const s of shapes) s.text = wordsToText(s.words);

  // Khung bao sơ đồ
  const pts = [...shapes.flatMap((s) => [[s.x0, s.y0], [s.x1, s.y1]]), ...connectors.flatMap((c) => c.points)];
  let bbox = {
    x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])),
  };
  // Nhãn tự do nằm trong vùng sơ đồ
  const m = hMed * 1.5;
  const lb = (w) => w.lineBox || w;
  const labelWords = free.filter((w) => lb(w).x0 >= bbox.x0 - m && lb(w).x1 <= bbox.x1 + m).filter((w) => cx(w) > bbox.x0 - m && cx(w) < bbox.x1 + m && cy(w) > bbox.y0 - m && cy(w) < bbox.y1 + m);
  // Nhãn phải nằm gần như trọn trong vùng sơ đồ (loại dòng văn bản thường chạy ngang qua)
  const labels = groupLabels(labelWords, hMed).filter((l) => {
    const ix = Math.max(0, Math.min(l.x1, bbox.x1 + m) - Math.max(l.x0, bbox.x0 - m));
    const iy = Math.max(0, Math.min(l.y1, bbox.y1 + m) - Math.max(l.y0, bbox.y0 - m));
    return ix * iy >= (l.x1 - l.x0) * (l.y1 - l.y0) * 0.8 && /[\p{L}\p{N}]/u.test(l.text);
  });
  for (const l of labels) {
    l.words.forEach((w) => { w.inDiagram = true; });
    bbox = { x0: Math.min(bbox.x0, l.x0), y0: Math.min(bbox.y0, l.y0), x1: Math.max(bbox.x1, l.x1), y1: Math.max(bbox.y1, l.y1) };
  }
  shapes.forEach((s) => s.words.forEach((w) => { w.inDiagram = true; }));
  const d = { bbox, shapes, connectors, labels, textHeight: hMed };
  Object.defineProperty(d, 'graphicMask', { value: graphicMask, enumerable: false });
  return d;
}

/** Phân loại hình dạng của một lỗ dựa trên biên dạng độ rộng theo hàng */
function classifyHole(c, labels, width, bin) {
  const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
  const rows = [];
  for (let y = c.y0; y <= c.y1; y++) {
    let l = -1, r = -1;
    const row = y * width;
    for (let x = c.x0; x <= c.x1; x++) if (labels[row + x] === c.id) { l = x; break; }
    for (let x = c.x1; x >= c.x0; x--) if (labels[row + x] === c.id) { r = x; break; }
    if (l < 0) continue;
    const t = ((y - c.y0 + 0.5) / bh) * 2 - 1;
    rows.push({ y, t, l, r, w: (r - l + 1) / bw, c: ((l + r) / 2 - (c.x0 + c.x1) / 2) / bw });
  }
  if (rows.length < 5) return null;
  const avg = (f, lo, hi) => {
    const sel = rows.filter((r) => Math.abs(r.t) >= lo && Math.abs(r.t) <= hi);
    return sel.length ? sel.reduce((s, r) => s + f(r), 0) / sel.length : 0;
  };
  const err = (model, lo = 0, hi = 0.95) => avg((r) => Math.abs(r.w - model(r.t)), lo, hi);

  // Độ dày nét viền: đo độ dài dải mực theo phương ngang (từ mép trái của lỗ)
  // và phương dọc (từ mép trên); lấy trung vị nhỏ hơn để ít bị ảnh hưởng bởi
  // cạnh xiên (elip, thoi).
  const run = (x, y, dx, dy) => {
    let k = 0;
    while (k < 4 && !bin[(y + dy * k) * width + x + dx * k]) k++; // bỏ qua khe do giãn nở
    let n = 0;
    while (n < 40 && bin[(y + dy * (k + n)) * width + x + dx * (k + n)]) n++;
    return n;
  };
  const hr = rows.filter((r) => Math.abs(r.t) < 0.9).map((r) => run(r.l - 1, r.y, -1, 0)).filter((v) => v > 0);
  const vr = [];
  for (let x = c.x0; x <= c.x1; x += Math.max(1, Math.floor(bw / 60))) {
    const u = ((x - c.x0 + 0.5) / bw) * 2 - 1;
    if (Math.abs(u) > 0.9) continue;
    for (let y = c.y0; y <= c.y1; y++) {
      if (labels[y * width + x] === c.id) { const v = run(x, y - 1, 0, -1); if (v > 0) vr.push(v); break; }
    }
  }
  const est = [hr.length && median(hr), vr.length && median(vr)].filter(Boolean);
  const stroke = est.length ? Math.max(1, Math.min(...est)) : 1;

  const eRect = err(() => 1, 0, 0.7);
  const eRectEnds = avg((r) => r.w, 0.88, 1);
  const eEll = err((t) => Math.sqrt(Math.max(0, 1 - t * t)));
  const eDia = err((t) => 1 - Math.abs(t));
  // Bình hành: độ rộng gần như không đổi, tâm dịch tuyến tính
  const bottomRows = rows.filter((r) => r.t > 0.6 && r.t < 0.9);
  const topRows = rows.filter((r) => r.t < -0.6 && r.t > -0.9);
  const shift = bottomRows.length && topRows.length
    ? bottomRows.reduce((s, r) => s + r.c, 0) / bottomRows.length - topRows.reduce((s, r) => s + r.c, 0) / topRows.length : 0;
  const wStd = Math.sqrt(avg((r) => (r.w - avg((q) => q.w, 0, 0.9)) ** 2, 0, 0.9));

  let type;
  if (eRect < 0.04 && eRectEnds > 0.93) type = 'rect';
  else if (eRect < 0.05 && avg((r) => r.w, 0, 0.4) > 0.97) type = 'rounded';
  else if (Math.abs(shift) > 0.08 && wStd < 0.05) type = 'parallelogram';
  else if (eEll < 0.06 && eEll <= eDia) type = 'ellipse';
  else if (eDia < 0.07) type = 'diamond';
  else type = 'polygon';

  // Tọa độ theo đường tâm nét viền
  const e = 1 + stroke / 2;
  const s = {
    id: `s${c.id}`, type, stroke,
    ix0: c.x0, iy0: c.y0, ix1: c.x1, iy1: c.y1,
    x0: c.x0 - e, y0: c.y0 - e, x1: c.x1 + e, y1: c.y1 + e, area: bw * bh,
  };
  if (type === 'parallelogram') s.skew = -shift * (s.x1 - s.x0); // >0: nghiêng phải (đỉnh lệch phải)
  if (type === 'polygon') {
    // Lấy mẫu biên trái/phải để vẽ lại đường bao
    const step = Math.max(1, Math.floor(rows.length / 24));
    const left = [], right = [];
    for (let i = 0; i < rows.length; i += step) { left.push([rows[i].l - e, rows[i].y]); right.push([rows[i].r + e, rows[i].y]); }
    const last = rows[rows.length - 1];
    left.push([last.l - e, last.y]); right.push([last.r + e, last.y]);
    s.points = simplify([...left, ...right.reverse()], Math.max(2, stroke));
  }
  return s;
}

/** Đỉnh đa giác của hình (dùng cho vẽ và tính khoảng cách) */
export function shapePolygon(s) {
  const { x0, y0, x1, y1 } = s;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  switch (s.type) {
    case 'diamond': return [[mx, y0], [x1, my], [mx, y1], [x0, my]];
    case 'parallelogram': {
      const k = Math.min(Math.abs(s.skew || 0), (x1 - x0) * 0.45);
      return (s.skew || 0) >= 0
        ? [[x0 + k, y0], [x1, y0], [x1 - k, y1], [x0, y1]]
        : [[x0, y0], [x1 - k, y0], [x1, y1], [x0 + k, y1]];
    }
    case 'polygon': return s.points;
    default: return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Khoảng cách từ điểm tới đường viền hình */
export function outlineDistance(s, x, y) {
  if (s.type === 'ellipse') {
    const a = (s.x1 - s.x0) / 2, b = (s.y1 - s.y0) / 2;
    const dx = x - (s.x0 + s.x1) / 2, dy = y - (s.y0 + s.y1) / 2;
    const f = (dx * dx) / (a * a) + (dy * dy) / (b * b) - 1;
    const grad = 2 * Math.sqrt((dx * dx) / (a ** 4) + (dy * dy) / (b ** 4)) || 1e-6;
    return Math.abs(f) / grad;
  }
  if (s.type === 'rect' || s.type === 'rounded') {
    const mx = (s.x0 + s.x1) / 2, my = (s.y0 + s.y1) / 2;
    const a = (s.x1 - s.x0) / 2, b = (s.y1 - s.y0) / 2;
    const dx = Math.abs(x - mx), dy = Math.abs(y - my);
    if (dx <= a && dy <= b) {
      const d = Math.min(a - dx, b - dy);
      if (s.type === 'rounded') {
        // góc bo: cho phép sai lệch lớn hơn ở góc
        const r = Math.min(a, b) * 0.5;
        if (dx > a - r && dy > b - r) return Math.abs(Math.hypot(dx - (a - r), dy - (b - r)) - r);
      }
      return d;
    }
    return Math.hypot(Math.max(dx - a, 0), Math.max(dy - b, 0));
  }
  const p = shapePolygon(s);
  let d = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
    d = Math.min(d, segDist(x, y, ax, ay, bx, by));
  }
  return d;
}

/** Điểm có nằm trong hình không (dùng cho gán chữ) */
export function outlineInside(s, x, y, strict = false) {
  if (s.type === 'ellipse') {
    const a = (s.x1 - s.x0) / 2, b = (s.y1 - s.y0) / 2;
    const dx = x - (s.x0 + s.x1) / 2, dy = y - (s.y0 + s.y1) / 2;
    return (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1.05;
  }
  if (s.type === 'rect' || s.type === 'rounded') return true;
  const p = shapePolygon(s);
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  // chữ trong hình thoi thường tràn ra gần mép: nới lỏng bằng khung trong
  return inside || (!strict && s.type === 'diamond');
}

/** Điểm gần nhất trên đường viền (để nối đường tới hình) */
export function nearestOutlinePoint(s, x, y) {
  const mx = (s.x0 + s.x1) / 2, my = (s.y0 + s.y1) / 2;
  if (s.type === 'ellipse') {
    const a = (s.x1 - s.x0) / 2, b = (s.y1 - s.y0) / 2;
    const ang = Math.atan2((y - my) / b, (x - mx) / a);
    return [mx + a * Math.cos(ang), my + b * Math.sin(ang)];
  }
  if (s.type === 'rect' || s.type === 'rounded') {
    const px = Math.max(s.x0, Math.min(s.x1, x)), py = Math.max(s.y0, Math.min(s.y1, y));
    if (px > s.x0 && px < s.x1 && py > s.y0 && py < s.y1) {
      const d = [py - s.y0, s.x1 - px, s.y1 - py, px - s.x0];
      const k = d.indexOf(Math.min(...d));
      return [[px, s.y0], [s.x1, py], [px, s.y1], [s.x0, py]][k];
    }
    return [px, py];
  }
  const p = shapePolygon(s);
  let best = null, bd = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
    const q = [ax + t * dx, ay + t * dy];
    const d = Math.hypot(x - q[0], y - q[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function buildConnector(arr, width, shapes, mask, labels, id, hMed) {
  const P = (i) => [i % width, (i / width) | 0];
  const far = (from) => {
    let best = arr[0], bd = -1;
    const [fx, fy] = P(from);
    for (const i of arr) {
      const x = i % width, y = (i / width) | 0;
      const d = (x - fx) ** 2 + (y - fy) ** 2;
      if (d > bd) { bd = d; best = i; }
    }
    return best;
  };
  const a = far(far(arr[0]));
  const b = far(a);
  // Tinh chỉnh đầu mút = trọng tâm các điểm gần đó (tránh chọn nhầm góc mũi tên)
  const refine = (p) => {
    const R = Math.max(5, hMed * 0.35);
    let sx = 0, sy = 0, k = 0;
    for (const i of arr) {
      const x = i % width, y = (i / width) | 0;
      if ((x - p[0]) ** 2 + (y - p[1]) ** 2 <= R * R) { sx += x; sy += y; k++; }
    }
    return [sx / k, sy / k];
  };
  const pa0 = P(a), pb0 = P(b);
  if (Math.hypot(pa0[0] - pb0[0], pa0[1] - pb0[1]) < Math.max(12, hMed * 0.6)) return null;
  let pa = refine(pa0), pb = refine(pb0);
  const xs0 = Math.min(pa[0], pb[0]), xs1 = Math.max(pa[0], pb[0]);
  const ys0 = Math.min(pa[1], pb[1]), ys1 = Math.max(pa[1], pb[1]);

  // Gắn đầu mút vào hình gần nhất
  const snapTol = Math.max(14, hMed * 0.8);
  const attach = (p) => {
    let best = null, bd = Infinity;
    for (const s of shapes) {
      const d = outlineDistance(s, p[0], p[1]);
      if (d < bd && d <= snapTol + s.stroke) { bd = d; best = s; }
    }
    return best;
  };
  const sa = attach(pa), sb = attach(pb);

  // Hình học đường: thẳng, gấp khúc 1 lần hoặc 2 lần (chữ Z)
  const has = (x, y, rad = 3) => {
    for (let yy = Math.max(0, Math.round(y - rad)); yy <= Math.round(y + rad); yy++) {
      for (let xx = Math.max(0, Math.round(x - rad)); xx <= Math.min(width - 1, Math.round(x + rad)); xx++) {
        if (labels[yy * width + xx] === id) return true;
      }
    }
    return false;
  };
  let points;
  const dx = xs1 - xs0, dy = ys1 - ys0;
  const straightOk = () => {
    for (let k = 1; k < 10; k++) {
      const t = k / 10;
      if (!has(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, Math.max(4, hMed * 0.25))) return false;
    }
    return true;
  };
  if (dx < 6 || dy < 6 || straightOk()) {
    points = [pa, pb];
    if (dx < 6) { const x = (pa[0] + pb[0]) / 2; points = [[x, pa[1]], [x, pb[1]]]; }
    else if (dy < 6) { const y = (pa[1] + pb[1]) / 2; points = [[pa[0], y], [pb[0], y]]; }
  } else if (has(pa[0], pb[1]) && has(pa[0], (pa[1] + pb[1]) / 2)) points = [pa, [pa[0], pb[1]], pb];
  else if (has(pb[0], pa[1]) && has((pa[0] + pb[0]) / 2, pa[1])) points = [pa, [pb[0], pa[1]], pb];
  else {
    // Z ngang-dọc-ngang: tìm cột có nhiều mực nhất giữa hai đầu
    let bestX = null, bestCov = 0;
    for (let x = xs0 + 2; x <= xs1 - 2; x++) {
      let cov = 0;
      for (let y = ys0; y <= ys1; y += 2) if (mask[y * width + x]) cov++;
      if (cov > bestCov) { bestCov = cov; bestX = x; }
    }
    let bestY = null, bestCovY = 0;
    for (let y = ys0 + 2; y <= ys1 - 2; y++) {
      let cov = 0;
      for (let x = xs0; x <= xs1; x += 2) if (mask[y * width + x]) cov++;
      if (cov > bestCovY) { bestCovY = cov; bestY = y; }
    }
    const covX = bestCov / (dy / 2 + 1), covY = bestCovY / (dx / 2 + 1);
    if (bestX !== null && covX > 0.7 && covX >= covY) points = [pa, [bestX, pa[1]], [bestX, pb[1]], pb];
    else if (bestY !== null && covY > 0.7) points = [pa, [pa[0], bestY], [pb[0], bestY], pb];
    else points = [pa, pb];
  }

  // Mũi tên: khối mực dày ở gần đầu mút
  const pathLen = points.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
  // Độ dày nét đo ở giữa đoạn dài nhất (không bị mũi tên làm sai lệch)
  let seg = 0;
  for (let i = 1; i < points.length; i++) {
    const L = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (L > Math.hypot(points[seg + 1][0] - points[seg][0], points[seg + 1][1] - points[seg][1])) seg = i - 1;
  }
  const mid = [(points[seg][0] + points[seg + 1][0]) / 2, (points[seg][1] + points[seg + 1][1]) / 2];
  const RM = 6;
  let km = 0;
  for (const i of arr) {
    const x = i % width, y = (i / width) | 0;
    if ((x - mid[0]) ** 2 + (y - mid[1]) ** 2 <= RM * RM) km++;
  }
  const lineStroke = Math.max(1, km ? km / (2 * RM) : arr.length / Math.max(pathLen, 1));
  if (lineStroke > Math.max(8, hMed * 0.5)) return null; // quá dày: không phải đường nối
  const r = Math.max(7, lineStroke * 4, hMed * 0.45);
  const mass = (p) => {
    let k = 0;
    for (const i of arr) {
      const x = i % width, y = (i / width) | 0;
      if ((x - p[0]) ** 2 + (y - p[1]) ** 2 <= r * r) k++;
    }
    return k / (r * lineStroke);
  };
  const ma = mass(pa0), mb = mass(pb0);
  const headA = ma > 1.8 && (ma > mb * 1.4 || mb > 1.8);
  const headB = mb > 1.8 && (mb > ma * 1.4 || ma > 1.8);

  // Kéo đầu mút chạm đúng viền hình
  if (sa) points[0] = snapEnd(sa, points[0], points[1]);
  if (sb) points[points.length - 1] = snapEnd(sb, points[points.length - 1], points[points.length - 2]);

  // Chuẩn hóa: mũi tên đơn luôn nằm ở cuối (from -> to)
  if (headA && !headB) {
    points.reverse();
    return {
      from: sb ? sb.id : null, to: sa ? sa.id : null,
      arrowStart: false, arrowEnd: true, points, stroke: Math.round(lineStroke),
      orthogonal: points.length > 2 || dx < 6 || dy < 6,
    };
  }
  return {
    from: sa ? sa.id : null, to: sb ? sb.id : null,
    arrowStart: headA, arrowEnd: headB, points, stroke: Math.round(lineStroke),
    orthogonal: points.length > 2 || dx < 6 || dy < 6,
  };
}

/** Đưa đầu mút về viền hình, giữ phương ngang/dọc nếu đoạn cuối thẳng trục */
function snapEnd(s, p, q) {
  const n = nearestOutlinePoint(s, p[0], p[1]);
  if (Math.abs(p[0] - q[0]) < 2) return [p[0], n[1]];
  if (Math.abs(p[1] - q[1]) < 2) return [n[0], p[1]];
  return n;
}

export function groupLabels(words, hMed) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const groups = [];
  for (const w of sorted) {
    const g = groups.find((g) => Math.abs(cy(g) - cy(w)) < hMed * 0.6 && w.x0 - g.x1 < hMed * 1.2 && g.x0 - w.x1 < hMed * 1.2);
    if (g) { g.words.push(w); g.x0 = Math.min(g.x0, w.x0); g.x1 = Math.max(g.x1, w.x1); g.y0 = Math.min(g.y0, w.y0); g.y1 = Math.max(g.y1, w.y1); }
    else groups.push({ words: [w], x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
  }
  for (const g of groups) g.text = g.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ');
  return groups;
}

/** Douglas–Peucker */
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}
