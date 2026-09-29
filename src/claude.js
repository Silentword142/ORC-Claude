// Chế độ nhận dạng bằng Claude (API của Anthropic): gửi ảnh trang, nhận về
// cấu trúc JSON (đoạn văn, bảng, sơ đồ) rồi chuyển sang định dạng kết quả
// chung của app để dùng lại toàn bộ phần hiển thị/xuất file.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { nearestOutlinePoint } from './core/diagram.js';

// Giá USD / 1 triệu token (đầu vào, đầu ra) để ước tính chi phí
export const MODELS = {
  'claude-opus-5-5': { label: 'Opus 5.5 (chính xác nhất)', in: 4, out: 20 },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5 (rẻ hơn ~2 lần)', in: 2, out: 10 },
};

const Box = z.array(z.number()).describe('[x0, y0, x1, y1] theo thang 0–1000 của chiều rộng/cao ảnh');

const PageSchema = z.object({
  blocks: z.array(z.object({
    type: z.enum(['heading', 'paragraph', 'list', 'table', 'diagram', 'other']),
    bbox: Box,
    text: z.string().describe('Nội dung chữ (heading/paragraph/list/other). Giữ nguyên xuống dòng; mỗi mục danh sách một dòng. Để trống với table/diagram.'),
    level: z.number().describe('Cấp tiêu đề 1–6 với heading, 0 với loại khác'),
    rows: z.array(z.array(z.object({
      text: z.string(),
      rowspan: z.number(),
      colspan: z.number(),
    }))).describe('Chỉ với table: các hàng, mỗi hàng là các ô theo thứ tự trái→phải; ô bị ô gộp phía trên che thì KHÔNG liệt kê lại. Để [] với loại khác.'),
    nodes: z.array(z.object({
      id: z.string(),
      shape: z.enum(['rect', 'rounded', 'ellipse', 'circle', 'diamond', 'parallelogram', 'other']),
      text: z.string(),
      bbox: Box,
    })).describe('Chỉ với diagram: các hình/nút. Để [] với loại khác.'),
    edges: z.array(z.object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
      arrow: z.enum(['forward', 'backward', 'both', 'none']).describe('forward = mũi tên chỉ vào "to"'),
    })).describe('Chỉ với diagram: các đường nối giữa nút. Để [] với loại khác.'),
  })),
});

const SYSTEM = `Bạn là công cụ OCR và phân tích bố cục tài liệu có độ chính xác rất cao.
Nhiệm vụ: chép lại TOÀN BỘ nội dung trong ảnh trang tài liệu, đúng từng chữ, đúng dấu tiếng Việt, đúng số liệu, theo thứ tự đọc tự nhiên.
Quy tắc:
- Chép nguyên văn, không tóm tắt, không sửa lỗi chính tả của bản gốc, không thêm nội dung không có trong ảnh. Chữ không đọc được ghi [?].
- Mỗi khối (tiêu đề, đoạn văn, danh sách, bảng, sơ đồ) là một phần tử trong "blocks", kèm bbox xấp xỉ theo thang 0–1000.
- Bảng: dựng đúng cấu trúc hàng/cột, dùng rowspan/colspan cho ô gộp; mọi hàng phải có tổng colspan bằng nhau khi tính cả các ô bị gộp từ hàng trên.
- Sơ đồ/lưu đồ: mỗi hình là một node (kèm hình dạng, chữ bên trong, bbox), mỗi đường nối/mũi tên là một edge (kèm nhãn nếu có). Chữ nằm trong sơ đồ không chép lại thành đoạn văn riêng.
- Hình ảnh/ảnh chụp không có chữ thì bỏ qua; biểu đồ số liệu thì chép các số liệu, nhãn thành "other".
- Nếu có "Lớp chữ PDF" kèm theo, dùng nó để đối chiếu chính tả/số liệu nhưng bố cục phải theo ảnh.`;

let client = null, clientKey = '';
function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    // Gọi thẳng từ trình duyệt bằng API key của chính người dùng (app tĩnh, không có máy chủ riêng)
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
    clientKey = apiKey;
  }
  return client;
}

/** Canvas -> JPEG base64, cạnh dài tối đa maxSide px */
function canvasToBase64(canvas, maxSide = 2000) {
  const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  let c = canvas;
  if (s < 1) {
    c = document.createElement('canvas');
    c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
  }
  return c.toDataURL('image/jpeg', 0.92).split(',')[1];
}

/**
 * Quét một trang bằng Claude. Trả về { result, usage, costUsd }.
 * pdfText: chữ lấy từ lớp chữ PDF (nếu có) để đối chiếu.
 */
export async function scanWithClaude(canvas, { apiKey, model, pdfText, onProgress }) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: canvasToBase64(canvas) } },
  ];
  if (pdfText) content.push({ type: 'text', text: `Lớp chữ PDF (tham khảo):\n${pdfText.slice(0, 30000)}` });
  content.push({ type: 'text', text: 'Hãy chép lại toàn bộ trang này theo đúng lược đồ JSON.' });

  let response;
  try {
    // Dùng streaming để không bị giới hạn thời gian với trang dài
    const stream = getClient(apiKey).beta.messages.stream({
      model,
      max_tokens: 32000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: betaZodOutputFormat(PageSchema) },
      // Nếu mô hình từ chối, API tự chạy lại trên mô hình dự phòng phù hợp
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    });
    if (onProgress) stream.on('text', () => onProgress());
    response = await stream.finalMessage();
  } catch (err) {
    throw new Error(explainError(err));
  }
  if (response.stop_reason === 'refusal') throw new Error('Claude từ chối xử lý trang này.');
  if (response.stop_reason === 'max_tokens') throw new Error('Trang quá dài, kết quả bị cắt. Hãy tách trang/ảnh nhỏ hơn.');
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Không đọc được kết quả JSON từ Claude.');
  const price = MODELS[model] || MODELS['claude-opus-5-5'];
  const u = response.usage;
  const costUsd = ((u.input_tokens + (u.cache_creation_input_tokens || 0)) * price.in + u.output_tokens * price.out) / 1e6;
  return { result: toResult(parsed, canvas.width, canvas.height), usage: u, costUsd };
}

function explainError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'API key không hợp lệ.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'API key không có quyền dùng mô hình này.';
  if (err instanceof Anthropic.RateLimitError) return 'Vượt giới hạn tốc độ/hạn mức của tài khoản API, thử lại sau.';
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit|balance/i.test(err.message)) return 'Tài khoản API hết tiền (credit). Nạp thêm tại console.anthropic.com.';
    return `Yêu cầu không hợp lệ: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Không kết nối được tới api.anthropic.com (kiểm tra mạng).';
  if (err instanceof Anthropic.APIError) return `Lỗi API ${err.status}: ${err.message}`;
  return err.message || String(err);
}

/** Chuyển JSON của Claude sang cấu trúc kết quả chung của app */
export function toResult(parsed, W, H) {
  const px = (b) => {
    const [a = 0, c = 0, d = 1000, e = 1000] = Array.isArray(b) ? b : [];
    const x0 = Math.max(0, Math.min(a, d)) * W / 1000, x1 = Math.min(1000, Math.max(a, d)) * W / 1000;
    const y0 = Math.max(0, Math.min(c, e)) * H / 1000, y1 = Math.min(1000, Math.max(c, e)) * H / 1000;
    return { x0, y0, x1: Math.max(x1, x0 + 4), y1: Math.max(y1, y0 + 4) };
  };
  const blocks = [], tables = [], diagrams = [];
  const lineHeights = [];
  for (const b of parsed.blocks) {
    const bbox = px(b.bbox);
    if (b.type === 'table' && b.rows.length) {
      const t = buildTable(b.rows, bbox);
      tables.push(t);
      blocks.push({ type: 'table', table: t, bbox });
    } else if (b.type === 'diagram' && b.nodes.length) {
      const d = buildDiagram(b, bbox, px);
      diagrams.push(d);
      blocks.push({ type: 'diagram', diagram: d, bbox: d.bbox });
    } else if (b.text && b.text.trim()) {
      const text = b.type === 'heading' ? b.text.trim() : b.text.replace(/\s+$/g, '');
      const ls = text.split('\n');
      const lh = (bbox.y1 - bbox.y0) / ls.length;
      lineHeights.push(lh);
      blocks.push({
        type: 'para', kind: b.type, level: b.level, text,
        lines: ls.map((t, i) => ({ text: t, bbox: { x0: bbox.x0, x1: bbox.x1, y0: bbox.y0 + i * lh, y1: bbox.y0 + (i + 1) * lh } })),
        bbox,
      });
    }
  }
  lineHeights.sort((a, b) => a - b);
  const textHeight = lineHeights.length ? Math.min(lineHeights[lineHeights.length >> 1], H / 25) : H / 60;
  for (const d of diagrams) {
    // Cỡ chữ trong sơ đồ theo kích thước hình để chữ luôn nằm gọn trong hình
    const hs = d.shapes.map((s) => s.y1 - s.y0).sort((a, b) => a - b);
    d.textHeight = Math.min(textHeight * 0.9, (hs[hs.length >> 1] || textHeight) * 0.28);
  }
  return {
    width: W, height: H, words: [], lines: [], tables, diagram: diagrams[0] || null, diagrams, blocks,
    source: 'claude', meanConfidence: null, textHeight,
  };
}

function buildTable(rows, bbox) {
  const cells = [], occ = [];
  let cols = 0;
  rows.forEach((row, r) => {
    occ[r] = occ[r] || [];
    let c = 0;
    for (const cell of row) {
      while (occ[r][c]) c++;
      const rs = Math.max(1, Math.round(cell.rowspan) || 1), cs = Math.max(1, Math.round(cell.colspan) || 1);
      for (let i = 0; i < rs; i++) { occ[r + i] = occ[r + i] || []; for (let j = 0; j < cs; j++) occ[r + i][c + j] = 1; }
      cells.push({ r, c, rs, cs, text: cell.text.trim(), words: [] });
      c += cs;
      cols = Math.max(cols, c);
    }
  });
  const nRows = Math.max(rows.length, occ.length);
  const xs = Array.from({ length: cols + 1 }, (_, i) => bbox.x0 + ((bbox.x1 - bbox.x0) * i) / cols);
  const ys = Array.from({ length: nRows + 1 }, (_, i) => bbox.y0 + ((bbox.y1 - bbox.y0) * i) / nRows);
  for (const c of cells) {
    c.rs = Math.min(c.rs, nRows - c.r);
    c.cs = Math.min(c.cs, cols - c.c);
    Object.assign(c, { x0: xs[c.c], x1: xs[c.c + c.cs], y0: ys[c.r], y1: ys[c.r + c.rs] });
  }
  return { kind: 'claude', rows: nRows, cols, xs, ys, cells, bbox };
}

function buildDiagram(b, bbox, px) {
  const typeMap = { circle: 'ellipse', other: 'rect' };
  const shapes = b.nodes.map((n, i) => {
    const r = px(n.bbox);
    return {
      id: `s${i + 1}`, key: n.id, type: typeMap[n.shape] || n.shape, text: n.text.trim(),
      ...r, ix0: r.x0, iy0: r.y0, ix1: r.x1, iy1: r.y1, stroke: 2, area: (r.x1 - r.x0) * (r.y1 - r.y0),
      skew: n.shape === 'parallelogram' ? (r.x1 - r.x0) * 0.15 : 0, words: [],
    };
  });
  const byKey = new Map(shapes.map((s) => [s.key, s]));
  const center = (s) => [(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2];
  const connectors = [], labels = [];
  b.edges.forEach((e, i) => {
    let a = byKey.get(e.from), c = byKey.get(e.to);
    if (!a || !c || a === c) return;
    let fwd = e.arrow === 'forward' || e.arrow === 'both', back = e.arrow === 'backward' || e.arrow === 'both';
    if (back && !fwd) { [a, c] = [c, a]; [fwd, back] = [true, false]; }
    const [ax, ay] = center(a), [cx, cy] = center(c);
    // Hai hình thẳng hàng theo trục -> đường thẳng trục; ngược lại nối tâm-tâm
    const alignedV = Math.max(a.x0, c.x0) < Math.min(a.x1, c.x1);
    const alignedH = Math.max(a.y0, c.y0) < Math.min(a.y1, c.y1);
    let p, q;
    if (alignedV && !alignedH) {
      const x = (Math.max(a.x0, c.x0) + Math.min(a.x1, c.x1)) / 2;
      p = [x, cy > ay ? a.y1 : a.y0]; q = [x, cy > ay ? c.y0 : c.y1];
    } else if (alignedH && !alignedV) {
      const y = (Math.max(a.y0, c.y0) + Math.min(a.y1, c.y1)) / 2;
      p = [cx > ax ? a.x1 : a.x0, y]; q = [cx > ax ? c.x0 : c.x1, y];
    } else {
      p = nearestOutlinePoint(a, cx, cy); q = nearestOutlinePoint(c, ax, ay);
    }
    connectors.push({ id: `e${i + 1}`, from: a.id, to: c.id, arrowEnd: fwd, arrowStart: back, points: [p, q], stroke: 2, orthogonal: alignedV !== alignedH });
    if (e.label && e.label.trim()) {
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      const w = Math.max(40, e.label.length * 9);
      labels.push({ text: e.label.trim(), x0: mx + 6, y0: my - 22, x1: mx + 6 + w, y1: my - 4 });
    }
  });
  const all = [...shapes, ...labels];
  const box = all.length ? {
    x0: Math.min(bbox.x0, ...all.map((s) => s.x0)), y0: Math.min(bbox.y0, ...all.map((s) => s.y0)),
    x1: Math.max(bbox.x1, ...all.map((s) => s.x1)), y1: Math.max(bbox.y1, ...all.map((s) => s.y1)),
  } : bbox;
  shapes.forEach((s) => delete s.key);
  return { bbox: box, shapes, connectors, labels, textHeight: 20 };
}
