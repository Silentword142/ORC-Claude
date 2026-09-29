// Chuyển kết quả phân tích sang các định dạng: HTML, CSV, Markdown,
// SVG, draw.io (diagrams.net) và trang dựng lại.
import { shapePolygon } from './diagram.js';
import { tableToMatrix } from './table.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function tableToHTML(table, { editable = false, style = '' } = {}) {
  const grid = Array.from({ length: table.rows }, () => []);
  for (const c of table.cells) grid[c.r].push(c);
  const ce = editable ? ' contenteditable="true"' : '';
  const rows = grid.map((cells) => '<tr>' + cells.sort((a, b) => a.c - b.c).map((c) => {
    const span = (c.rs > 1 ? ` rowspan="${c.rs}"` : '') + (c.cs > 1 ? ` colspan="${c.cs}"` : '');
    return `<td${span}${ce} data-r="${c.r}" data-c="${c.c}">${esc(c.text).replace(/\n/g, '<br>')}</td>`;
  }).join('') + '</tr>');
  return `<table class="ocr-table"${style ? ` style="${style}"` : ''}>${rows.join('')}</table>`;
}

export function tableToCSV(table, sep = ',') {
  return tableToMatrix(table).map((row) => row.map((v) => {
    const s = String(v);
    return /[",\n;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(sep)).join('\r\n');
}

export function tableToMarkdown(table) {
  const m = tableToMatrix(table).map((row) => row.map((v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
  if (!m.length) return '';
  const head = m[0], body = m.slice(1);
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** Chia chữ thành các dòng vừa độ rộng (ước lượng theo số ký tự) */
function wrap(text, maxWidth, fontSize) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * 0.55)));
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + w).trim().length > maxChars && line) { out.push(line); line = w; }
      else line = (line + ' ' + w).trim();
    }
    if (line) out.push(line);
  }
  return out;
}

let markerSeq = 0;

export function diagramToSVG(d, { padding = 20, standalone = true, theme = {} } = {}) {
  // id marker riêng cho mỗi SVG: nhiều SVG cùng trang không tham chiếu nhầm nhau
  const mid = `arr${++markerSeq}`;
  const stroke = theme.stroke || '#1f2937', fill = theme.fill || '#ffffff', text = theme.text || '#111827';
  const ox = d.bbox.x0 - padding, oy = d.bbox.y0 - padding;
  const W = Math.round(d.bbox.x1 - d.bbox.x0 + padding * 2), H = Math.round(d.bbox.y1 - d.bbox.y0 + padding * 2);
  const fs = Math.max(10, Math.round(d.textHeight * 0.9));
  const T = (x, y) => `${(x - ox).toFixed(1)},${(y - oy).toFixed(1)}`;
  const parts = [];
  parts.push(`<defs><marker id="${mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${stroke}"/></marker></defs>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${theme.bg || '#ffffff'}"/>`);
  const shapes = [...d.shapes].sort((a, b) => b.area - a.area); // hình lớn vẽ trước
  for (const s of shapes) {
    const sw = Math.max(1.5, Math.min(4, s.stroke));
    const common = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" data-id="${s.id}"`;
    if (s.type === 'rect') parts.push(`<rect x="${(s.x0 - ox).toFixed(1)}" y="${(s.y0 - oy).toFixed(1)}" width="${(s.x1 - s.x0).toFixed(1)}" height="${(s.y1 - s.y0).toFixed(1)}" ${common}/>`);
    else if (s.type === 'rounded') {
      const r = Math.min(s.x1 - s.x0, s.y1 - s.y0) * 0.2;
      parts.push(`<rect x="${(s.x0 - ox).toFixed(1)}" y="${(s.y0 - oy).toFixed(1)}" width="${(s.x1 - s.x0).toFixed(1)}" height="${(s.y1 - s.y0).toFixed(1)}" rx="${r.toFixed(1)}" ${common}/>`);
    } else if (s.type === 'ellipse') parts.push(`<ellipse cx="${((s.x0 + s.x1) / 2 - ox).toFixed(1)}" cy="${((s.y0 + s.y1) / 2 - oy).toFixed(1)}" rx="${((s.x1 - s.x0) / 2).toFixed(1)}" ry="${((s.y1 - s.y0) / 2).toFixed(1)}" ${common}/>`);
    else parts.push(`<polygon points="${shapePolygon(s).map((p) => T(p[0], p[1])).join(' ')}" ${common}/>`);
  }
  for (const c of d.connectors) {
    const me = c.arrowEnd ? ` marker-end="url(#${mid})"` : '';
    const ms = c.arrowStart ? ` marker-start="url(#${mid})"` : '';
    parts.push(`<polyline points="${c.points.map((p) => T(p[0], p[1])).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${Math.max(1.5, Math.min(4, c.stroke))}"${me}${ms}/>`);
  }
  const textEl = (str, x, y, maxW) => {
    const lines = wrap(str, maxW, fs);
    const lh = fs * 1.2, y0 = y - ((lines.length - 1) * lh) / 2;
    return `<text x="${(x - ox).toFixed(1)}" y="${(y0 - oy).toFixed(1)}" font-size="${fs}" font-family="Arial, sans-serif" fill="${text}" text-anchor="middle" dominant-baseline="middle">${lines.map((l, i) => `<tspan x="${(x - ox).toFixed(1)}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('')}</text>`;
  };
  for (const s of d.shapes) {
    if (!s.text) continue;
    const inner = s.type === 'diamond' ? 0.6 : s.type === 'ellipse' ? 0.75 : 0.92;
    parts.push(textEl(s.text, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, (s.x1 - s.x0) * inner));
  }
  for (const l of d.labels) parts.push(textEl(l.text, (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2, Math.max(l.x1 - l.x0, fs * 6) * 1.2));
  const body = parts.join('\n');
  return standalone
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${body}\n</svg>`
    : { body, W, H };
}

/** Xuất định dạng .drawio để chỉnh sửa tiếp trong diagrams.net */
export function diagramToDrawio(d) {
  const ox = d.bbox.x0 - 20, oy = d.bbox.y0 - 20;
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const style = {
    rect: 'rounded=0;whiteSpace=wrap;html=1;',
    rounded: 'rounded=1;whiteSpace=wrap;html=1;',
    ellipse: 'ellipse;whiteSpace=wrap;html=1;',
    diamond: 'rhombus;whiteSpace=wrap;html=1;',
    parallelogram: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;',
    polygon: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;',
  };
  const fs = Math.max(10, Math.round(d.textHeight * 0.9));
  const geo = (x, y, w, h) => `<mxGeometry x="${Math.round(x - ox)}" y="${Math.round(y - oy)}" width="${Math.round(w)}" height="${Math.round(h)}" as="geometry"/>`;
  for (const s of [...d.shapes].sort((a, b) => b.area - a.area)) {
    const st = style[s.type] + `fontSize=${fs};` + (s.type === 'parallelogram' ? `size=${Math.round(Math.abs(s.skew || 0))};` : '');
    cells.push(`<mxCell id="${s.id}" value="${esc(s.text || '').replace(/\n/g, '&lt;br&gt;')}" style="${st}" vertex="1" parent="1">${geo(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0)}</mxCell>`);
  }
  for (const c of d.connectors) {
    const st = `${c.orthogonal ? 'edgeStyle=orthogonalEdgeStyle;' : ''}rounded=0;html=1;endArrow=${c.arrowEnd ? 'block' : 'none'};startArrow=${c.arrowStart ? 'block' : 'none'};endFill=1;startFill=1;`;
    const src = c.from ? ` source="${c.from}"` : '', tgt = c.to ? ` target="${c.to}"` : '';
    const [a, b] = [c.points[0], c.points[c.points.length - 1]];
    const mid = c.points.slice(1, -1).map((p) => `<mxPoint x="${Math.round(p[0] - ox)}" y="${Math.round(p[1] - oy)}"/>`).join('');
    cells.push(`<mxCell id="${c.id}" style="${st}" edge="1" parent="1"${src}${tgt}><mxGeometry relative="1" as="geometry"><mxPoint x="${Math.round(a[0] - ox)}" y="${Math.round(a[1] - oy)}" as="sourcePoint"/><mxPoint x="${Math.round(b[0] - ox)}" y="${Math.round(b[1] - oy)}" as="targetPoint"/>${mid ? `<Array as="points">${mid}</Array>` : ''}</mxGeometry></mxCell>`);
  }
  d.labels.forEach((l, i) => {
    cells.push(`<mxCell id="t${i + 1}" value="${esc(l.text)}" style="text;html=1;align=center;verticalAlign=middle;fontSize=${fs};" vertex="1" parent="1">${geo(l.x0 - 4, l.y0 - 4, l.x1 - l.x0 + 8, l.y1 - l.y0 + 8)}</mxCell>`);
  });
  return `<mxfile host="ORC-Claude"><diagram name="Sơ đồ" id="ocr"><mxGraphModel grid="1" gridSize="10" guides="1" arrows="1" connect="1" page="1"><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

/** Sơ đồ -> văn bản mô tả (dạng Mermaid) */
export function diagramToMermaid(d) {
  const lab = (s) => (s.text || s.id).replace(/["\n]/g, ' ');
  const node = (s) => {
    const t = lab(s);
    switch (s.type) {
      case 'diamond': return `${s.id}{"${t}"}`;
      case 'ellipse': return `${s.id}(["${t}"])`;
      case 'rounded': return `${s.id}("${t}")`;
      case 'parallelogram': return `${s.id}[/"${t}"/]`;
      default: return `${s.id}["${t}"]`;
    }
  };
  const out = ['flowchart TD'];
  for (const s of d.shapes) out.push('  ' + node(s));
  for (const c of d.connectors) {
    if (!c.from || !c.to) continue;
    let [a, b, fwd, back] = [c.from, c.to, c.arrowEnd, c.arrowStart];
    if (back && !fwd) { [a, b] = [b, a]; [fwd, back] = [true, false]; }
    out.push(`  ${a} ${fwd && back ? '<-->' : fwd ? '-->' : '---'} ${b}`);
  }
  return out.join('\n');
}

export function pageToMarkdown(result) {
  return result.blocks.map((b) => {
    if (b.type === 'para') return b.text;
    if (b.type === 'table') return tableToMarkdown(b.table);
    return '```mermaid\n' + diagramToMermaid(b.diagram) + '\n```';
  }).join('\n\n');
}

export function pageToPlainText(result) {
  return result.blocks.map((b) => {
    if (b.type === 'para') return b.text;
    if (b.type === 'table') return tableToMatrix(b.table).map((r) => r.map((v) => v.replace(/\n/g, ' ')).join('\t')).join('\n');
    const d = b.diagram;
    return [...d.shapes.map((s) => s.text).filter(Boolean), ...d.labels.map((l) => l.text)].join('\n');
  }).join('\n\n');
}

/** HTML "dòng chảy" (dùng cho xuất Word/HTML) */
export function pageToFlowHTML(result) {
  return result.blocks.map((b) => {
    if (b.type === 'para') return `<p>${esc(b.text).replace(/\n/g, '<br>')}</p>`;
    if (b.type === 'table') return tableToHTML(b.table, { style: 'border-collapse:collapse' }).replace(/<td/g, '<td style="border:1px solid #444;padding:4px 6px;vertical-align:top"');
    return diagramToSVG(b.diagram);
  }).join('\n');
}

/** Dựng lại trang theo đúng vị trí: chữ, bảng, sơ đồ */
export function reconstructPageHTML(result) {
  const parts = [];
  for (const b of result.blocks) {
    if (b.type === 'para') {
      for (const l of b.lines) {
        const h = l.bbox.y1 - l.bbox.y0;
        parts.push(`<div class="rl" style="left:${l.bbox.x0}px;top:${l.bbox.y0}px;width:${l.bbox.x1 - l.bbox.x0}px;height:${h}px;font-size:${Math.round(h * 0.85)}px;line-height:${h}px">${esc(l.text)}</div>`);
      }
    } else if (b.type === 'table') {
      const t = b.table;
      const cells = t.cells.map((c) => {
        const border = t.kind === 'ruled' ? 'border:1.5px solid #333;' : '';
        const lines = c.text.split('\n').length || 1;
        const fs = Math.max(9, Math.min((result.textHeight || 24) * 0.8, ((c.y1 - c.y0) / lines) * 0.6));
        return `<div class="rc" style="left:${c.x0 - t.bbox.x0}px;top:${c.y0 - t.bbox.y0}px;width:${c.x1 - c.x0}px;height:${c.y1 - c.y0}px;${border}font-size:${fs.toFixed(0)}px">${esc(c.text).replace(/\n/g, '<br>')}</div>`;
      }).join('');
      parts.push(`<div class="rt" style="left:${t.bbox.x0}px;top:${t.bbox.y0}px;width:${t.bbox.x1 - t.bbox.x0}px;height:${t.bbox.y1 - t.bbox.y0}px">${cells}</div>`);
    } else {
      const d = b.diagram;
      const pad = 20;
      parts.push(`<div class="rd" style="left:${d.bbox.x0 - pad}px;top:${d.bbox.y0 - pad}px">${diagramToSVG(d, { padding: pad, theme: { bg: 'transparent', fill: 'none' } })}</div>`);
    }
  }
  return `<div class="recon" style="width:${result.width}px;height:${result.height}px">${parts.join('')}</div>`;
}

export const RECON_CSS = `.recon{position:relative;background:#fff;color:#111;font-family:Arial,sans-serif;overflow:hidden}
.recon .rl{position:absolute;white-space:pre;overflow:visible}
.recon .rt{position:absolute}.recon .rc{position:absolute;box-sizing:border-box;padding:2px 4px;overflow:hidden;line-height:1.2;margin-left:-0.75px;margin-top:-0.75px}
.recon .rd{position:absolute}`;
