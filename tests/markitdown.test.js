import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function hasMarkItDown(pyExe) {
  try {
    execFileSync(pyExe, ['-c', 'import markitdown'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('MarkItDown Python Service CLI chuyển đổi HTML và bảng sang Markdown', (t) => {
  const pyExe = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : (fs.existsSync('.venv/Scripts/python.exe') ? '.venv/Scripts/python.exe' : 'python3');
  if (!hasMarkItDown(pyExe)) {
    t.skip('Bỏ qua kiểm thử MarkItDown vì chưa cài gói Python markitdown trong môi trường hiện tại');
    return;
  }

  const script = 'scripts/markitdown_service.py';
  const tempFile = 'tests/fixtures/sample_test.html';

  fs.mkdirSync('tests/fixtures', { recursive: true });
  fs.writeFileSync(tempFile, '<h1>Tiêu đề thử nghiệm</h1><p>Nội dung <b>đậm</b> và <i>nghiêng</i>.</p><table><tr><th>Cột A</th><th>Cột B</th></tr><tr><td>1</td><td>2</td></tr></table>', 'utf-8');

  try {
    const stdout = execFileSync(pyExe, [script, 'convert', tempFile], { encoding: 'utf-8' });
    const res = JSON.parse(stdout);
    assert.equal(res.success, true);
    assert.ok(res.markdown.includes('# Tiêu đề thử nghiệm'), 'Chứa heading');
    assert.ok(res.markdown.includes('**đậm**'), 'Chứa bold');
    assert.ok(res.markdown.includes('| Cột A | Cột B |'), 'Chứa bảng Markdown');
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test('MarkItDown hỗ trợ định dạng .doc (Word 97-2003 / HTML-doc)', (t) => {
  const pyExe = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : (fs.existsSync('.venv/Scripts/python.exe') ? '.venv/Scripts/python.exe' : 'python3');
  if (!hasMarkItDown(pyExe)) {
    t.skip('Bỏ qua kiểm thử MarkItDown vì chưa cài gói Python markitdown');
    return;
  }

  const tempDoc = 'tests/fixtures/sample_legacy.doc';
  fs.mkdirSync('tests/fixtures', { recursive: true });
  fs.writeFileSync(tempDoc, '<html><body><h1>Nghị định 96/2026/NĐ-CP</h1><p>Nội dung văn bản.</p></body></html>', 'utf-8');

  try {
    const stdout = execFileSync(pyExe, ['scripts/markitdown_service.py', 'convert', tempDoc], { encoding: 'utf-8' });
    const res = JSON.parse(stdout);
    assert.equal(res.success, true);
    assert.ok(res.markdown.includes('Nghị định 96/2026/NĐ-CP'), 'Đọc được tiêu đề từ file .doc');
  } finally {
    if (fs.existsSync(tempDoc)) fs.unlinkSync(tempDoc);
  }
});
