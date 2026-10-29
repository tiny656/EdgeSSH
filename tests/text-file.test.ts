import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINARY_SNIFF_BYTES,
  MAX_TEXT_FILE_SIZE,
  TextFileError,
  assertTextFileSize,
  decodeTextFile,
  hasBinaryPrefix,
} from '../src/backend/text-file.ts';
import {
  MAX_EDITOR_FILE_SIZE,
  editorLanguageFor,
  extensionOf,
  isEditableTextFile,
  isMarkdownFile,
} from '../frontend/src/file-language.ts';

test('扩展名映射到编辑器语言，未知扩展名按纯文本处理', () => {
  const cases: Record<string, string> = {
    'app.js': 'javascript', 'app.jsx': 'javascript', 'app.mjs': 'javascript', 'app.cjs': 'javascript',
    'main.ts': 'typescript', 'view.tsx': 'typescript',
    'theme.css': 'css', 'theme.scss': 'css', 'theme.less': 'css',
    'index.html': 'html', 'package.json': 'json',
    'compose.yml': 'yaml', 'compose.yaml': 'yaml',
    'README.md': 'markdown', 'notes.markdown': 'markdown',
    'deploy.sh': 'shell', 'deploy.bash': 'shell',
    'main.py': 'python', 'schema.sql': 'sql', 'config.xml': 'xml',
    'sshd.ini': 'plain', 'nginx.conf': 'plain', 'Cargo.toml': 'plain',
    'access.log': 'plain', 'notes.txt': 'plain',
    'archive.zip': 'plain', 'photo.png': 'plain', 'Makefile': 'plain', '.env': 'plain',
  };
  for (const [name, language] of Object.entries(cases)) {
    assert.equal(editorLanguageFor(name), language, name);
  }
});

test('扩展名大小写不敏感，路径中的点不影响识别', () => {
  assert.equal(editorLanguageFor('APP.JS'), 'javascript');
  assert.equal(editorLanguageFor('dir.with.dots/file.main.ts'), 'typescript');
  assert.equal(extensionOf('/root/APP.JS'), 'js');
  assert.equal(extensionOf('no-extension'), '');
  assert.equal(extensionOf('.bashrc'), '');
});

test('可编辑白名单只覆盖文本扩展名，markdown 单独识别', () => {
  assert.equal(isEditableTextFile('README.md'), true);
  assert.equal(isEditableTextFile('main.ts'), true);
  assert.equal(isEditableTextFile('notes.txt'), true);
  assert.equal(isEditableTextFile('archive.zip'), false);
  assert.equal(isEditableTextFile('photo.png'), false);
  assert.equal(isEditableTextFile('Makefile'), false);
  assert.equal(isMarkdownFile('README.md'), true);
  assert.equal(isMarkdownFile('main.ts'), false);
});

test('前端编辑器上限与后端一致', () => {
  assert.equal(MAX_EDITOR_FILE_SIZE, MAX_TEXT_FILE_SIZE);
});

test('二进制判定只看前 8 KiB 的 NUL 字节', () => {
  const text = new TextEncoder().encode('hello world');
  assert.equal(hasBinaryPrefix(text), false);
  const withNul = new Uint8Array([104, 105, 0, 104]);
  assert.equal(hasBinaryPrefix(withNul), true);
  const lateNul = new Uint8Array(BINARY_SNIFF_BYTES + 16).fill(0x61);
  lateNul[lateNul.length - 1] = 0;
  assert.equal(hasBinaryPrefix(lateNul), false);
});

test('超过 2 MiB 的文本被拒绝', () => {
  const tooLarge = new Uint8Array(MAX_TEXT_FILE_SIZE + 1);
  assert.throws(() => decodeTextFile(tooLarge), (error: unknown) => {
    assert.ok(error instanceof TextFileError);
    assert.equal(error.reason, 'too-large');
    return true;
  });
  assert.doesNotThrow(() => assertTextFileSize(MAX_TEXT_FILE_SIZE));
  assert.doesNotThrow(() => assertTextFileSize(null));
  assert.throws(() => assertTextFileSize(MAX_TEXT_FILE_SIZE + 1), (error: unknown) => {
    assert.ok(error instanceof TextFileError);
    assert.equal(error.reason, 'too-large');
    return true;
  });
});

test('二进制与非法 UTF-8 分别给出可读原因', () => {
  assert.throws(() => decodeTextFile(new Uint8Array([1, 2, 0, 4])), (error: unknown) => {
    assert.ok(error instanceof TextFileError);
    assert.equal(error.reason, 'binary');
    return true;
  });
  assert.throws(() => decodeTextFile(new Uint8Array([0xff, 0xfe, 0x41])), (error: unknown) => {
    assert.ok(error instanceof TextFileError);
    assert.equal(error.reason, 'encoding');
    return true;
  });
});

test('合法 UTF-8（含中文）正常解码', () => {
  const bytes = new TextEncoder().encode('# 标题\nconst a = 1;\n');
  assert.equal(decodeTextFile(bytes), '# 标题\nconst a = 1;\n');
  assert.equal(decodeTextFile(new Uint8Array(0)), '');
});
