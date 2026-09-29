// Kiểm thử chế độ Claude với API giả lập (không tốn tiền, không cần key):
// kiểm tra yêu cầu gửi đi đúng dạng và kết quả JSON được dựng lại đúng.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--port', String(4200 + Math.floor(Math.random() * 700))], { cwd: root, stdio: 'pipe' });
const baseUrl = await new Promise((res, rej) => {
  let buf = '';
  server.stdout.on('data', (d) => { buf += d; const m = buf.replace(/\x1b\[[0-9;]*m/g, '').match(/Local:\s+(http\S+)/); if (m) res(m[1]); });
  server.on('exit', (c) => rej(new Error(`vite preview thoát (mã ${c})`)));
});

const fake = {
  blocks: [
    { type: 'heading', bbox: [40, 20, 600, 60], text: 'Báo cáo kết quả học tập', level: 1, rows: [], nodes: [], edges: [] },
    { type: 'paragraph', bbox: [40, 80, 950, 110], text: 'Đây là văn bản mẫu tiếng Việt.', level: 0, rows: [], nodes: [], edges: [] },
    { type: 'table', bbox: [40, 130, 900, 330], text: '', level: 0, nodes: [], edges: [], rows: [
      [{ text: 'Họ và tên', rowspan: 1, colspan: 1 }, { text: 'Lớp', rowspan: 1, colspan: 1 }, { text: 'Điểm', rowspan: 1, colspan: 1 }],
      [{ text: 'Nguyễn Văn An', rowspan: 1, colspan: 1 }, { text: '10A1', rowspan: 2, colspan: 1 }, { text: '8.5', rowspan: 1, colspan: 1 }],
      [{ text: 'Trần Thị Bình', rowspan: 1, colspan: 1 }, { text: '9.0', rowspan: 1, colspan: 1 }],
      [{ text: 'Trung bình', rowspan: 1, colspan: 2 }, { text: '8.75', rowspan: 1, colspan: 1 }],
    ] },
    { type: 'diagram', bbox: [100, 400, 900, 950], text: '', level: 0, rows: [], nodes: [
      { id: 'a', shape: 'ellipse', text: 'Bắt đầu', bbox: [300, 400, 500, 460] },
      { id: 'b', shape: 'diamond', text: 'Hợp lệ?', bbox: [280, 550, 520, 680] },
      { id: 'c', shape: 'rounded', text: 'Trả lại', bbox: [650, 580, 850, 650] },
    ], edges: [
      { from: 'a', to: 'b', label: '', arrow: 'forward' },
      { from: 'c', to: 'b', label: 'Không', arrow: 'backward' },
    ] },
  ],
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  let request = null;
  await page.route('https://api.anthropic.com/**', async (route) => {
    request = { url: route.request().url(), headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
    const json = JSON.stringify(fake);
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const body = [
      ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: request.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2500, output_tokens: 0 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: json.slice(0, 200) } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: json.slice(200) } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1500 } }),
      ev('message_stop', {}),
    ].join('');
    await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body });
  });
  await page.goto(baseUrl);
  await page.selectOption('#optEngine', 'claude');
  await page.fill('#apiKey', 'sk-ant-test');

  const fx = await browser.newPage({ viewport: { width: 960, height: 1200 } });
  await fx.goto('file://' + join(root, 'tests/fixtures/sample.html'));
  const png = await fx.screenshot({ fullPage: true });
  await fx.close();

  const r = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const app = window.__ocrApp;
    await app.addFiles([new File([bytes], 'mau.png', { type: 'image/png' })]);
    await app.run();
    const res = app.state.items[0].result;
    return {
      status: app.state.items[0].status, source: res?.source,
      text: document.querySelector('#textOut').value,
      table: res?.tables[0] && res.tables[0].cells.map((c) => [c.r, c.c, c.rs, c.cs, c.text]),
      diagram: res?.diagrams[0] && { shapes: res.diagrams[0].shapes.map((s) => [s.type, s.text]), edges: res.diagrams[0].connectors.map((c) => [c.from, c.to, c.arrowEnd, c.arrowStart]), labels: res.diagrams[0].labels.map((l) => l.text) },
      progress: document.querySelector('#progressText').textContent,
    };
  }, png.toString('base64'));
  console.log(JSON.stringify(r, null, 1));

  // Yêu cầu gửi đi
  assert.ok(request, 'đã gọi API');
  assert.equal(request.body.model, 'claude-opus-5-5');
  assert.equal(request.headers['x-api-key'], 'sk-ant-test');
  assert.match(request.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(request.body.fallbacks, 'default');
  assert.equal(request.body.thinking.type, 'adaptive');
  assert.equal(request.body.output_config.format.type, 'json_schema');
  assert.equal(request.body.messages[0].content[0].type, 'image');

  // Kết quả dựng lại
  assert.equal(r.status, 'done');
  assert.equal(r.source, 'claude');
  assert.match(r.text, /Báo cáo kết quả học tập/);
  assert.deepEqual(r.table.find((c) => c[4] === '10A1').slice(0, 4), [1, 1, 2, 1]);
  assert.deepEqual(r.table.find((c) => c[4] === '9.0').slice(0, 4), [2, 2, 1, 1]);
  assert.deepEqual(r.table.find((c) => c[4] === 'Trung bình').slice(0, 4), [3, 0, 1, 2]);
  assert.deepEqual(r.diagram.shapes.map((s) => s[0]), ['ellipse', 'diamond', 'rounded']);
  assert.deepEqual(r.diagram.edges, [['s1', 's2', true, false], ['s2', 's3', true, false]]);
  assert.deepEqual(r.diagram.labels, ['Không']);
  assert.match(r.progress, /\$0\.040/);

  await page.click('[data-tab="diagrams"]');
  await page.waitForSelector('.diagram-view svg');
  await page.screenshot({ path: join(root, 'tests/output-claude-diagram.png') });
  await page.click('[data-tab="recon"]');
  await page.screenshot({ path: join(root, 'tests/output-claude-recon.png') });
  console.log('\nE2E CLAUDE OK');
} finally {
  await browser.close();
  server.kill();
}
