// Sao chép worker, lõi WASM, dữ liệu ngôn ngữ của Tesseract và tài nguyên pdf.js vào public/
// để ứng dụng chạy hoàn toàn offline, không phụ thuộc CDN.
import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'tesseract');

mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

cpSync(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js'));

const coreDir = join(nm, 'tesseract.js-core');
for (const f of readdirSync(coreDir)) {
  if (/^tesseract-core.*\.(js|wasm)$/.test(f)) cpSync(join(coreDir, f), join(out, 'core', f));
}

for (const lang of ['vie', 'eng']) {
  const src = join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
  if (!existsSync(src)) throw new Error(`Thiếu dữ liệu ngôn ngữ: ${src}`);
  cpSync(src, join(out, 'lang', `${lang}.traineddata.gz`));
}
// Tài nguyên của pdf.js (bảng mã CMap, phông chuẩn, bộ giải mã WASM, ICC)
const pdfOut = join(root, 'public', 'pdfjs');
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = join(nm, 'pdfjs-dist', d);
  if (existsSync(src)) cpSync(src, join(pdfOut, d), { recursive: true });
}
console.log('Đã sao chép tài nguyên Tesseract và pdf.js vào public/');
