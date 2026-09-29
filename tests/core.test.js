// Kiểm thử thuật toán lõi trên ảnh tổng hợp (không cần trình duyệt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binarize, estimateSkew } from '../src/core/imageproc.js';
import { detectLines, detectRuledTables, detectBorderlessTables, tableToMatrix } from '../src/core/table.js';
import { detectDiagram } from '../src/core/diagram.js';
import { buildLines } from '../src/core/analyze.js';
import { diagramToDrawio, diagramToMermaid, diagramToSVG, tableToCSV } from '../src/core/export.js';

function canvas(w, h) {
  const g = new Uint8Array(w * h).fill(255);
  const px = (x, y) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) g[y * w + x] = 0; };
  const thick = (x, y, t) => { for (let i = 0; i < t; i++) for (let j = 0; j < t; j++) px(x + i - (t >> 1), y + j - (t >> 1)); };
  const line = (x0, y0, x1, y1, t = 2) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let k = 0; k <= n; k++) thick(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, t);
  };
  const rect = (x0, y0, x1, y1, t = 2) => { line(x0, y0, x1, y0, t); line(x1, y0, x1, y1, t); line(x1, y1, x0, y1, t); line(x0, y1, x0, y0, t); };
  const ellipse = (cx, cy, a, b, t = 2) => { for (let k = 0; k < 2000; k++) { const u = (k / 2000) * Math.PI * 2; thick(cx + a * Math.cos(u), cy + b * Math.sin(u), t); } };
  const diamond = (cx, cy, a, b, t = 2) => { line(cx, cy - b, cx + a, cy, t); line(cx + a, cy, cx, cy + b, t); line(cx, cy + b, cx - a, cy, t); line(cx - a, cy, cx, cy - b, t); };
  const arrowHead = (x, y, dir) => { // tam giác đặc hướng xuống (dir='down') hoặc sang phải
    for (let k = 0; k < 14; k++) for (let j = -k * 0.5; j <= k * 0.5; j++) dir === 'down' ? px(x + j, y - 14 + k) : px(x - 14 + k, y + j);
  };
  // "chữ": khối đậm giả lập ký tự để có mực trong ô
  const text = (x, y, wpx, hpx) => { for (let i = 0; i < wpx; i += 6) for (let yy = y; yy < y + hpx; yy++) { px(x + i, yy); px(x + i + 1, yy); } };
  const bin = () => binarize(g, w, h);
  return { g, w, h, line, rect, ellipse, diamond, arrowHead, text, bin };
}

const word = (text, x0, y0, x1, y1) => ({ text, x0, y0, x1, y1, conf: 95 });

test('bảng có kẻ, có ô gộp', () => {
  const c = canvas(800, 500);
  // 4 cột x 4 hàng; hàng 0 cột 0-1 gộp; cột 3 hàng 1-2 gộp
  const xs = [50, 230, 410, 590, 750], ys = [60, 130, 200, 270, 340];
  c.line(xs[0], ys[0], xs[4], ys[0]); c.line(xs[0], ys[4], xs[4], ys[4]);
  c.line(xs[0], ys[0], xs[0], ys[4]); c.line(xs[4], ys[0], xs[4], ys[4]);
  c.line(xs[0], ys[1], xs[4], ys[1]);
  c.line(xs[0], ys[2], xs[3], ys[2]); // không kẻ qua cột 3 -> gộp dọc
  c.line(xs[0], ys[3], xs[4], ys[3]);
  c.line(xs[1], ys[1], xs[1], ys[4]); // không kẻ ở hàng 0 -> gộp ngang
  c.line(xs[2], ys[0], xs[2], ys[4]);
  c.line(xs[3], ys[0], xs[3], ys[4]);
  const words = [word('Tiêu', 100, 85, 150, 105), word('đề', 160, 85, 190, 105), word('B', 480, 85, 500, 105),
    word('X', 650, 225, 670, 245), word('1', 120, 155, 135, 175), word('2', 300, 295, 315, 315)];
  const bin = c.bin();
  const tables = detectRuledTables(detectLines(bin, c.w, c.h), words, c.w, c.h);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.rows, 4); assert.equal(t.cols, 4);
  const m = tableToMatrix(t);
  assert.equal(m[0][0], 'Tiêu đề');
  assert.equal(m[0][2], 'B');
  assert.equal(m[1][3], 'X');
  assert.equal(m[1][0], '1');
  assert.equal(m[3][1], '2');
  const merged = t.cells.find((x) => x.r === 0 && x.c === 0);
  assert.equal(merged.cs, 2);
  const vmerged = t.cells.find((x) => x.r === 1 && x.c === 3);
  assert.equal(vmerged.rs, 2);
  assert.match(tableToCSV(t), /Tiêu đề/);
});

test('bảng không kẻ khung', () => {
  const words = [];
  const rows = [['Tên', 'Tuổi', 'Lớp'], ['An', '12', '6A'], ['Bình', '13', '7B'], ['Chi', '12', '6C']];
  rows.forEach((r, i) => r.forEach((t, j) => words.push(word(t, 100 + j * 250, 100 + i * 40, 100 + j * 250 + t.length * 14, 124 + i * 40))));
  const lines = buildLines(words);
  const tables = detectBorderlessTables(lines);
  assert.equal(tables.length, 1);
  assert.deepEqual(tableToMatrix(tables[0]), rows);
});

test('văn bản thường không bị nhận nhầm thành bảng', () => {
  const words = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 10; j++) words.push(word('chữ', 50 + j * 60, 50 + i * 30, 50 + j * 60 + 45, 70 + i * 30));
  assert.equal(detectBorderlessTables(buildLines(words)).length, 0);
});

test('sơ đồ: hình chữ nhật, thoi, elip, mũi tên', () => {
  const c = canvas(900, 900);
  c.ellipse(450, 100, 110, 45);            // Bắt đầu
  c.line(450, 145, 450, 230); c.arrowHead(450, 232, 'down');
  c.rect(330, 232, 570, 332);              // Xử lý
  c.line(450, 332, 450, 430); c.arrowHead(450, 432, 'down');
  c.diamond(450, 512, 130, 80);            // Điều kiện
  c.line(580, 512, 720, 512); c.line(720, 512, 720, 690); c.arrowHead(720, 692, 'down'); // gấp khúc
  c.rect(620, 692, 820, 782);              // Kết thúc
  const words = [word('Bắt', 410, 90, 445, 112), word('đầu', 452, 90, 490, 112),
    word('Xử', 420, 272, 445, 294), word('lý', 452, 272, 478, 294),
    word('Đúng?', 420, 502, 482, 524), word('Kết', 690, 727, 725, 749), word('thúc', 730, 727, 770, 749),
    word('Có', 640, 485, 665, 505)];
  const bin = c.bin();
  const d = detectDiagram(bin, c.w, c.h, words, []);
  assert.ok(d, 'phải phát hiện sơ đồ');
  const types = d.shapes.map((s) => s.type).sort();
  assert.deepEqual(types, ['diamond', 'ellipse', 'rect', 'rect']);
  const byText = Object.fromEntries(d.shapes.map((s) => [s.text, s]));
  assert.ok(byText['Bắt đầu'] && byText['Xử lý'] && byText['Đúng?'] && byText['Kết thúc']);
  const edge = (a, b) => d.connectors.find((e) => e.from === byText[a].id && e.to === byText[b].id && e.arrowEnd && !e.arrowStart);
  assert.ok(edge('Bắt đầu', 'Xử lý'), 'mũi tên Bắt đầu -> Xử lý');
  assert.ok(edge('Xử lý', 'Đúng?'), 'mũi tên Xử lý -> Đúng?');
  const bend = edge('Đúng?', 'Kết thúc');
  assert.ok(bend, 'mũi tên gấp khúc Đúng? -> Kết thúc');
  assert.equal(bend.points.length, 3);
  assert.deepEqual(d.labels.map((l) => l.text), ['Có']);
  assert.match(diagramToMermaid(d), /-->/);
  assert.match(diagramToDrawio(d), /rhombus/);
  assert.match(diagramToSVG(d), /<svg/);
});

test('ước lượng góc nghiêng', () => {
  const c = canvas(800, 600);
  const ang = (3 * Math.PI) / 180;
  for (let i = 0; i < 12; i++) {
    const y = 60 + i * 40;
    c.line(50, y, 750, y + Math.tan(ang) * 700, 4);
  }
  const a = estimateSkew(c.bin(), c.w, c.h);
  assert.ok(Math.abs(a - 3) < 0.5, `góc ${a}`);
});
