import './styles.css';
import { analyzePage, buildLines } from './core/analyze.js';
import {
  tableToHTML, tableToCSV, tableToMarkdown, diagramToSVG, diagramToDrawio, diagramToMermaid,
  pageToMarkdown, pageToPlainText, pageToFlowHTML, reconstructPageHTML, RECON_CSS, esc,
} from './core/export.js';
import { ocrPage, ocrRegion, setOcrLogger } from './ocr.js';
import { fileKind, imagePage, pdfPages, docxDocument, htmlDocument, deskewCanvas } from './loaders.js';
import { scanWithClaude, MODELS } from './claude.js';

const $ = (s) => document.querySelector(s);
const state = { items: [], running: false, seq: 0 };

// ---------- Nhập tệp ----------
const drop = $('#drop');
const fileInput = $('#fileInput');
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (!drop.contains(e.target)) addFiles([...e.dataTransfer.files]); });
window.addEventListener('paste', (e) => {
  if (e.target.closest && e.target.closest('textarea, [contenteditable="true"]')) return;
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) {
    e.preventDefault();
    addFiles(files.map((f, k) => new File([f], f.name && f.name !== 'image.png' ? f.name : `Ảnh dán ${++state.seq}${k ? '-' + k : ''}.png`, { type: f.type })));
  }
});

async function addFiles(files) {
  for (const file of files) {
    const kind = fileKind(file);
    try {
      if (kind === 'image') addPage(await imagePage(file, file.name));
      else if (kind === 'pdf') {
        const pages = await pdfPages(file, file.name);
        pages.forEach(addPage);
      } else if (kind === 'docx' || kind === 'html') {
        const doc = kind === 'docx' ? await docxDocument(file) : await htmlDocument(await file.text(), file.name);
        state.items.push({ id: uid(), type: 'doc', name: file.name, doc, status: 'done' });
        doc.pages.forEach(addPage);
      } else if (kind === 'text') {
        const text = await file.text();
        state.items.push({ id: uid(), type: 'doc', name: file.name, doc: { text, html: `<pre>${esc(text)}</pre>`, tables: [], pages: [] }, status: 'done' });
      } else toast(`Không hỗ trợ định dạng: ${file.name}`);
    } catch (err) {
      console.error(err);
      toast(`Lỗi đọc ${file.name}: ${err.message}`);
    }
  }
  renderList();
  renderResults();
}

function addPage(page) {
  state.items.push({ id: uid(), type: 'page', name: page.name, page, status: 'pending', result: null, imageUrl: null });
}
const uid = () => Math.random().toString(36).slice(2, 10);

$('#btnClear').addEventListener('click', () => {
  if (state.running) return;
  state.items.forEach((it) => it.imageUrl && URL.revokeObjectURL(it.imageUrl));
  state.items = [];
  renderList(); renderResults();
});

function renderList() {
  const ul = $('#pageList');
  if (!state.items.length) {
    ul.innerHTML = '<li class="empty">Chưa có tệp nào.</li>';
  } else {
    const label = { pending: 'chờ', run: 'đang quét…', done: 'xong', err: 'lỗi' };
    ul.innerHTML = state.items.map((it) => `<li><span class="name" title="${esc(it.name)}">${it.type === 'doc' ? '📄 ' : ''}${esc(it.name)}</span><span class="st ${it.status}">${it.status === 'done' && it.result ? `xong${it.result.meanConfidence != null && it.result.source === 'ocr' ? ` · ${it.result.meanConfidence}%` : it.result.source === 'pdf-text' ? ' · lớp chữ PDF' : it.result.source === 'claude' ? ' · Claude' : ''}` : label[it.status]}</span></li>`).join('');
  }
  $('#btnRun').disabled = state.running || !state.items.some((it) => it.type === 'page' && it.status !== 'done');
}

// ---------- Chạy nhận dạng ----------
// ---------- Bộ nhận dạng: offline (Tesseract) hoặc Claude ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* bỏ qua */ } },
};
$('#optModel').innerHTML = Object.entries(MODELS).map(([id, m]) => `<option value="${id}">${m.label}</option>`).join('');
$('#optEngine').value = store.get('orc.engine') || 'local';
$('#optModel').value = store.get('orc.model') || 'claude-opus-5-5';
if (store.get('orc.apiKey')) { $('#apiKey').value = store.get('orc.apiKey'); $('#rememberKey').checked = true; }
const syncEngine = () => {
  const claude = $('#optEngine').value === 'claude';
  $('#claudeOpts').hidden = !claude;
  $('#localOpts').hidden = claude;
  store.set('orc.engine', $('#optEngine').value);
};
syncEngine();
$('#optEngine').addEventListener('change', syncEngine);
$('#optModel').addEventListener('change', () => store.set('orc.model', $('#optModel').value));
const syncKey = () => store.set('orc.apiKey', $('#rememberKey').checked && $('#apiKey').value.trim() ? $('#apiKey').value.trim() : null);
$('#apiKey').addEventListener('change', syncKey);
$('#rememberKey').addEventListener('change', syncKey);

const opt = () => ({
  engine: $('#optEngine').value,
  apiKey: $('#apiKey').value.trim(),
  model: $('#optModel').value,
  langs: $('#optLang').value,
  tables: $('#optTables').checked,
  diagrams: $('#optDiagrams').checked,
  deskew: $('#optDeskew').checked,
  cellOcr: $('#optCellOcr').checked,
  forceOcr: $('#optForceOcr').checked,
});

$('#btnRun').addEventListener('click', run);

async function run() {
  if (state.running) return;
  state.running = true;
  const o = opt();
  if (o.engine === 'claude' && !o.apiKey) {
    state.running = false;
    $('#apiKey').focus();
    return toast('Hãy nhập API key của Anthropic để dùng chế độ Claude.');
  }
  const todo = state.items.filter((it) => it.type === 'page' && it.status !== 'done');
  const prog = $('#progress');
  prog.hidden = false;
  let done = 0, frac = 0;
  const setProg = (msg) => {
    $('#progressBar').style.width = `${Math.round(((done + frac) / todo.length) * 100)}%`;
    if (msg) $('#progressText').textContent = msg;
  };
  setOcrLogger((m) => {
    if (m.status === 'recognizing text') { frac = 0.2 + m.progress * 0.6; setProg(); }
    else if (m.status && /load|init/.test(m.status)) setProg(`Khởi tạo OCR: ${m.status}${m.progress ? ` ${Math.round(m.progress * 100)}%` : ''}`);
  });
  renderList();
  let cost = 0;
  const finish = (it) => { done++; frac = 0; setProg(); renderList(); renderResults(); void it; };
  const saveImage = async (it, canvas) => {
    it.imageUrl && URL.revokeObjectURL(it.imageUrl);
    it.imageUrl = URL.createObjectURL(await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85)));
  };

  if (o.engine === 'claude') {
    // Gửi song song tối đa 3 trang để nhanh hơn
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const it = todo[next++];
        it.status = 'run'; renderList();
        setProg(`Claude đang đọc ${it.name}…`);
        try {
          const { canvas, words } = await it.page.render({ forceOcr: false });
          const pdfText = words ? buildLines(words).map((l) => l.words.map((w) => w.text).join(' ')).join('\n') : null;
          const r = await scanWithClaude(canvas, { apiKey: o.apiKey, model: o.model, pdfText });
          it.result = r.result;
          cost += r.costUsd;
          await saveImage(it, canvas);
          it.status = 'done';
        } catch (err) {
          console.error(err);
          it.status = 'err';
          toast(`Lỗi khi quét ${it.name}: ${err.message}`);
        }
        finish(it);
        setProg(`Đã xong ${done}/${todo.length} trang · chi phí ước tính ≈ $${cost.toFixed(3)}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
    setProg(`Hoàn tất ${todo.length} trang · chi phí ước tính ≈ $${cost.toFixed(3)} (Claude ${MODELS[o.model]?.label || o.model})`);
    state.running = false;
    renderList();
    return;
  }

  for (const it of todo) {
    it.status = 'run'; frac = 0; renderList();
    const tag = `[${done + 1}/${todo.length}] ${it.name}`;
    try {
      setProg(`${tag}: đọc trang…`);
      let { canvas, words } = await it.page.render({ forceOcr: o.forceOcr });
      if (!words && o.deskew) {
        const r = deskewCanvas(canvas);
        canvas = r.canvas;
        if (r.angle) setProg(`${tag}: đã chỉnh nghiêng ${r.angle.toFixed(1)}°`);
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      it.result = await analyzePage(
        { width: canvas.width, height: canvas.height, rgba, words },
        {
          tables: o.tables, diagrams: o.diagrams,
          progress: (m) => setProg(`${tag}: ${m}`),
          ocr: (img, x) => ocrPage(img, o.langs, x?.psm),
          cellOcr: o.cellOcr,
          ocrRegion: (img, rect) => ocrRegion(img, rect, o.langs),
        },
      );
      it.result.textHeight = medianHeight(it.result.words);
      await saveImage(it, canvas);
      it.status = 'done';
    } catch (err) {
      console.error(err);
      it.status = 'err';
      toast(`Lỗi khi quét ${it.name}: ${err.message}`);
    }
    finish(it);
  }
  setProg(`Hoàn tất ${todo.length} trang.`);
  state.running = false;
  renderList();
}

const diagramsOf = (r) => (r ? r.diagrams || (r.diagram ? [r.diagram] : []) : []);

function medianHeight(words) {
  const h = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  return h.length ? h[h.length >> 1] : 20;
}

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  if (b.dataset.tab === 'recon') renderRecon();
  if (b.dataset.tab === 'overlay') renderOverlay();
}));
const activeTab = () => document.querySelector('.tabs button.active').dataset.tab;

// ---------- Hiển thị kết quả ----------
const doneItems = () => state.items.filter((it) => it.status === 'done' && (it.type === 'doc' || it.result));

function renderResults() {
  renderText();
  renderTables();
  renderDiagrams();
  if (activeTab() === 'recon') renderRecon();
  if (activeTab() === 'overlay') renderOverlay();
}

function renderText() {
  const items = doneItems();
  const multi = items.length > 1;
  const parts = items.map((it) => {
    const body = it.type === 'doc' ? it.doc.text : pageToPlainText(it.result);
    return multi ? `===== ${it.name} =====\n${body}` : body;
  });
  $('#textOut').value = parts.join('\n\n');
  const words = items.reduce((s, it) => s + (it.result ? it.result.words.length : 0), 0);
  $('#textMeta').textContent = items.length ? `${items.length} mục · ${words} từ nhận dạng` : '';
}

function allTables() {
  const out = [];
  for (const it of doneItems()) {
    const list = it.type === 'doc' ? it.doc.tables : it.result.tables;
    list.forEach((t, i) => out.push({ it, t, i }));
  }
  return out;
}

function renderTables() {
  const list = allTables();
  $('#cntTables').textContent = list.length;
  const box = $('#tablesOut');
  if (!list.length) { box.innerHTML = '<p class="hint">Chưa có bảng nào. Bảng có đường kẻ và bảng căn cột đều được hỗ trợ.</p>'; return; }
  const kindLabel = { ruled: 'có kẻ khung', borderless: 'không kẻ khung', document: 'từ tài liệu' };
  box.innerHTML = '';
  list.forEach(({ it, t, i }) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${esc(it.name)} · Bảng ${i + 1}<small>${t.rows}×${t.cols} · ${kindLabel[t.kind] || ''}</small></h3>
      <div class="toolbar">
        <button type="button" data-a="csv">Tải CSV</button>
        <button type="button" data-a="xls">Tải Excel</button>
        <button type="button" data-a="md">Sao chép Markdown</button>
        <button type="button" data-a="tsv">Sao chép (dán vào Excel)</button>
        <span class="meta">Bấm vào ô để sửa</span>
      </div>
      <div class="scroll">${tableToHTML(t, { editable: true })}</div>`;
    card.querySelector('table').addEventListener('input', (e) => {
      const td = e.target.closest('td');
      const cell = t.cells.find((c) => c.r === +td.dataset.r && c.c === +td.dataset.c);
      if (cell) cell.text = td.innerText.replace(/\n$/, '');
    });
    const base = `${stem(it.name)}-bang-${i + 1}`;
    card.querySelector('.toolbar').addEventListener('click', (e) => {
      const a = e.target.dataset.a;
      if (a === 'csv') download(`${base}.csv`, '\ufeff' + tableToCSV(t), 'text/csv;charset=utf-8');
      if (a === 'xls') download(`${base}.xls`, excelHTML(t), 'application/vnd.ms-excel');
      if (a === 'md') copy(tableToMarkdown(t));
      if (a === 'tsv') copy(tableToCSV(t, '\t'));
    });
    box.appendChild(card);
  });
}

function excelHTML(t) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>${
    tableToHTML(t).replace(/<td/g, '<td style="border:.5pt solid #000;vertical-align:top;mso-number-format:\'\\@\'"')}</body></html>`;
}

function renderDiagrams() {
  const list = doneItems().flatMap((it) => diagramsOf(it.result).map((d) => ({ it, d })));
  $('#cntDiagrams').textContent = list.length;
  const box = $('#diagramsOut');
  if (!list.length) { box.innerHTML = '<p class="hint">Chưa có sơ đồ nào. Hỗ trợ lưu đồ/sơ đồ khối: hình chữ nhật, bo góc, elip, thoi, bình hành, mũi tên và đường gấp khúc.</p>'; return; }
  box.innerHTML = '';
  for (const { it, d } of list) {
    const svg = diagramToSVG(d);
    const mermaid = diagramToMermaid(d);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${esc(it.name)}<small>${d.shapes.length} hình · ${d.connectors.length} đường nối · ${d.labels.length} nhãn</small></h3>
      <div class="toolbar">
        <button type="button" data-a="svg">Tải SVG</button>
        <button type="button" data-a="png">Tải PNG</button>
        <button type="button" data-a="drawio">Tải draw.io (sửa tiếp)</button>
        <button type="button" data-a="mmd">Sao chép Mermaid</button>
      </div>
      <div class="split">
        <figure><figcaption>Ảnh gốc</figcaption><img alt="Vùng sơ đồ gốc" /></figure>
        <figure><figcaption>Vẽ lại</figcaption><div class="diagram-view">${svg}</div></figure>
      </div>
      <details><summary>Mã Mermaid</summary><pre class="code">${esc(mermaid)}</pre></details>`;
    cropImage(it.imageUrl, d.bbox, 20).then((url) => { card.querySelector('img').src = url; });
    const base = `${stem(it.name)}-so-do`;
    card.querySelector('.toolbar').addEventListener('click', async (e) => {
      const a = e.target.dataset.a;
      if (a === 'svg') download(`${base}.svg`, svg, 'image/svg+xml');
      if (a === 'png') download(`${base}.png`, await svgToPng(svg), 'image/png');
      if (a === 'drawio') download(`${base}.drawio`, diagramToDrawio(d), 'application/xml');
      if (a === 'mmd') copy(mermaid);
    });
    box.appendChild(card);
  }
}

function renderRecon() {
  const box = $('#reconOut');
  const list = doneItems().filter((it) => it.result);
  if (!list.length) { box.innerHTML = '<p class="hint">Chưa có kết quả.</p>'; return; }
  const overlay = $('#reconOverlay').checked;
  const avail = Math.max(280, (box.clientWidth || 800) - 26); // trừ lề của thẻ
  box.innerHTML = `<style>${RECON_CSS}</style>`;
  for (const it of list) {
    const r = it.result;
    const s = Math.min(1, avail / r.width);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${esc(it.name)}</h3><div class="recon-box" style="width:${r.width * s}px;height:${r.height * s}px">
      <div class="recon-wrap" style="width:${r.width}px;height:${r.height}px;transform:scale(${s})">
        ${overlay ? `<img class="under" src="${it.imageUrl}" alt="">` : ''}${reconstructPageHTML(r)}
      </div></div>`;
    box.appendChild(card);
  }
}
$('#reconOverlay').addEventListener('change', renderRecon);

async function renderOverlay() {
  const box = $('#overlayOut');
  const list = doneItems().filter((it) => it.result);
  if (!list.length) { box.innerHTML = '<p class="hint">Chưa có kết quả.</p>'; return; }
  box.innerHTML = '';
  for (const it of list) {
    const r = it.result;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${esc(it.name)}<small>${r.source === 'pdf-text' ? 'lớp chữ PDF' : r.source === 'claude' ? 'Claude AI · vị trí khối là xấp xỉ' : `OCR · độ tin cậy TB ${r.meanConfidence ?? '-'}%`}</small></h3>`;

    const cv = document.createElement('canvas');
    cv.className = 'overlay-canvas';
    const s = Math.min(1, 1600 / r.width);
    cv.width = r.width * s; cv.height = r.height * s;
    card.appendChild(cv);
    box.appendChild(card);
    const img = await loadImg(it.imageUrl);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    ctx.scale(s, s);
    const box2 = (b, color, lw = 2) => { ctx.strokeStyle = color; ctx.lineWidth = lw / s; ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); };
    for (const w of r.words) box2(w, 'rgba(59,130,246,.7)', 1);
    // Chế độ Claude không có khung từng từ: vẽ khung đoạn văn
    for (const b of r.blocks) if (r.source === 'claude' && b.type === 'para') box2(b.bbox, 'rgba(59,130,246,.8)', 2);
    for (const t of r.tables) { box2(t.bbox, '#16a34a', 3); t.cells.forEach((c) => box2(c, 'rgba(22,163,74,.5)', 1)); }
    for (const dg of diagramsOf(r)) {
      for (const sh of dg.shapes) box2(sh, '#f59e0b', 3);
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 3 / s;
      for (const c of dg.connectors) {
        ctx.beginPath();
        c.points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
    }
  }
}

// ---------- Xuất văn bản ----------
document.querySelector('[data-panel="text"] .toolbar').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const items = doneItems();
  if (!items.length) return toast('Chưa có kết quả.');
  const name = items.length === 1 ? stem(items[0].name) : 'ket-qua-quet';
  if (act === 'copyText') copy($('#textOut').value);
  if (act === 'dlTxt') download(`${name}.txt`, $('#textOut').value, 'text/plain;charset=utf-8');
  if (act === 'dlMd') download(`${name}.md`, items.map((it) => (items.length > 1 ? `## ${it.name}\n\n` : '') + (it.type === 'doc' ? it.doc.text : pageToMarkdown(it.result))).join('\n\n'), 'text/markdown;charset=utf-8');
  if (act === 'dlDoc' || act === 'dlHtml') {
    const body = items.map((it) => (items.length > 1 ? `<h2>${esc(it.name)}</h2>` : '') + (it.type === 'doc' ? it.doc.html : pageToFlowHTML(it.result))).join('\n<hr>\n');
    const html = `<!doctype html><html${act === 'dlDoc' ? ' xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"' : ''}><head><meta charset="utf-8"><title>${esc(name)}</title><style>body{font-family:Arial,sans-serif;line-height:1.5}table{border-collapse:collapse;margin:8px 0}td{border:1px solid #444;padding:4px 6px}</style></head><body>${body}</body></html>`;
    if (act === 'dlDoc') download(`${name}.doc`, '\ufeff' + html, 'application/msword');
    else download(`${name}.html`, html, 'text/html;charset=utf-8');
  }
});

document.querySelector('[data-act="dlRecon"]').addEventListener('click', () => {
  const list = doneItems().filter((it) => it.result);
  if (!list.length) return toast('Chưa có kết quả.');
  const pages = list.map((it) => `<section><h2 style="font:14px Arial;color:#555">${esc(it.name)}</h2>${reconstructPageHTML(it.result)}</section>`).join('');
  download('trang-dung-lai.html', `<!doctype html><html><head><meta charset="utf-8"><title>Trang dựng lại</title><style>body{background:#eee;margin:20px}section{margin-bottom:30px}.recon{box-shadow:0 2px 8px rgba(0,0,0,.2);margin:auto}${RECON_CSS}</style></head><body>${pages}</body></html>`, 'text/html;charset=utf-8');
});

// ---------- Tiện ích ----------
function stem(n) { return n.replace(/\.[^.]+$/, '').replace(/\s+—\s+/g, '-').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'ket-qua'; }

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Đã sao chép.'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast('Đã sao chép.');
  }
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2800);
}

function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

async function cropImage(url, b, pad) {
  const img = await loadImg(url);
  const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad);
  const x1 = Math.min(img.width, b.x1 + pad), y1 = Math.min(img.height, b.y1 + pad);
  const c = document.createElement('canvas');
  c.width = x1 - x0; c.height = y1 - y0;
  c.getContext('2d').drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

async function svgToPng(svg) {
  const img = await loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  const c = document.createElement('canvas');
  c.width = img.width * 2; c.height = img.height * 2;
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

// Trạng thái ngoại tuyến + service worker (bản build)
function netStatus() {
  const claude = $('#optEngine').value === 'claude';
  $('#netStatus').textContent = claude
    ? (navigator.onLine ? 'Chế độ Claude: ảnh được gửi tới Anthropic' : 'Ngoại tuyến — chế độ Claude cần mạng')
    : (navigator.onLine ? 'Chế độ offline: dữ liệu không rời khỏi máy bạn' : 'Đang ngoại tuyến — vẫn dùng được');
}
$('#optEngine').addEventListener('change', netStatus);
window.addEventListener('online', netStatus);
window.addEventListener('offline', netStatus);
netStatus();
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
}

// Dùng cho kiểm thử tự động
window.__ocrApp = { state, addFiles, run };
