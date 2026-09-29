// Kiểm thử đầu-cuối: dựng ảnh/PDF mẫu bằng Chromium, nạp vào app và
// kiểm tra kết quả nhận dạng. Chạy: npm run build && npm run test:e2e
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--port', String(4200 + Math.floor(Math.random() * 700))], { cwd: root, stdio: 'pipe' });
const baseUrl = await new Promise((res, rej) => {
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d;
    const m = buf.replace(/\x1b\[[0-9;]*m/g, '').match(/Local:\s+(http\S+)/);
    if (m) res(m[1]);
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  server.on('exit', (c) => rej(new Error(`vite preview thoát (mã ${c})`)));
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // Tạo ảnh "scan" và PDF có lớp chữ từ tệp HTML mẫu
  const fx = await browser.newPage({ viewport: { width: 960, height: 1200 } });
  await fx.goto('file://' + join(root, 'tests/fixtures/sample.html'));
  const png = await fx.screenshot({ fullPage: true });
  const pdf = await fx.pdf({ format: 'A4', printBackground: true });
  await fx.close();

  await page.goto(baseUrl);
  const runWith = async (name, type, buf) => {
    await page.evaluate(async ({ name, type, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const app = window.__ocrApp;
      app.state.items.length = 0;
      await app.addFiles([new File([bytes], name, { type })]);
      await app.run();
    }, { name, type, b64: buf.toString('base64') });
    return page.evaluate(() => window.__ocrApp.state.items.filter((i) => i.result).map((i) => {
      const r = i.result;
      return {
        source: r.source, conf: r.meanConfidence,
        text: r.blocks.filter((b) => b.type === 'para').map((b) => b.text).join('\n'),
        tables: r.tables.map((t) => ({ kind: t.kind, rows: t.rows, cols: t.cols, cells: t.cells.map((c) => [c.r, c.c, c.rs, c.cs, c.text]) })),
        diagram: r.diagram && {
          shapes: r.diagram.shapes.map((s) => [s.type, s.text]),
          edges: r.diagram.connectors.map((c) => [c.from && r.diagram.shapes.find((s) => s.id === c.from).text, c.to && r.diagram.shapes.find((s) => s.id === c.to).text, c.arrowStart, c.arrowEnd]),
          labels: r.diagram.labels.map((l) => l.text),
        },
      };
    }));
  };

  for (const [name, type, buf] of [['mau.png', 'image/png', png], ['mau.pdf', 'application/pdf', pdf]]) {
    const t0 = Date.now();
    const res = await runWith(name, type, buf);
    console.log(`\n=== ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
    console.log(JSON.stringify(res, null, 1).slice(0, 5000));
    const r = res[0];
    assert.ok(r, 'có kết quả');
    assert.match(r.text, /văn bản mẫu tiếng Việt/i);
    const table = r.tables.find((t) => t.kind === 'ruled');
    assert.ok(table, 'tìm thấy bảng');
    assert.equal(table.rows, 4); assert.equal(table.cols, 4);
    const cell = (rr, cc) => table.cells.find((c) => c[0] === rr && c[1] === cc)?.[4];
    assert.match(cell(1, 0), /^Nguyễn Văn ?An$/);
    assert.equal(cell(2, 3), '8.5');
    assert.equal(table.cells.find((c) => c[0] === 3 && c[1] === 0)[3], 2, 'ô gộp "Trung bình"');
    assert.ok(r.diagram, 'tìm thấy sơ đồ');
    const types = r.diagram.shapes.map((s) => s[0]).sort();
    assert.deepEqual(types, ['diamond', 'ellipse', 'rect', 'rect', 'rounded']);
    assert.equal(r.diagram.edges.filter((e) => e[0] && e[1] && e[3] && !e[2]).length, 4, '4 mũi tên nối hình');
  }

  await page.click('[data-tab="diagrams"]');
  await page.waitForSelector('.diagram-view svg');
  await page.screenshot({ path: join(root, 'tests/output-diagrams.png'), fullPage: false });
  await page.click('[data-tab="recon"]');
  await page.screenshot({ path: join(root, 'tests/output-recon.png') });
  await page.click('[data-tab="tables"]');
  await page.screenshot({ path: join(root, 'tests/output-tables.png') });
  console.log('\nE2E OK');
} finally {
  await browser.close();
  server.kill();
}
