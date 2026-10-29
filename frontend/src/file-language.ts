/**
 * 在线编辑器的文件类型判定：扩展名 → 高亮语言，以及是否属于可编辑的文本白名单。
 * 语言包本身在 file-editor 里按需 import，这里只做纯映射，方便单测。
 */

export type EditorLanguage =
  | 'javascript' | 'typescript' | 'css' | 'html' | 'json' | 'markdown'
  | 'shell' | 'python' | 'sql' | 'xml' | 'yaml' | 'plain';

/** 与后端 MAX_TEXT_FILE_SIZE 保持一致。 */
export const MAX_EDITOR_FILE_SIZE = 2 * 1024 * 1024;

// 白名单即映射表：只登记能安全当文本打开的扩展名；其余一律走下载。
const languages = new Map<string, EditorLanguage>([
  ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['ts', 'typescript'], ['tsx', 'typescript'],
  ['css', 'css'], ['scss', 'css'], ['less', 'css'],
  ['html', 'html'],
  ['json', 'json'],
  ['yml', 'yaml'], ['yaml', 'yaml'],
  ['md', 'markdown'], ['markdown', 'markdown'],
  ['sh', 'shell'], ['bash', 'shell'],
  ['py', 'python'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['ini', 'plain'], ['conf', 'plain'], ['toml', 'plain'], ['log', 'plain'], ['txt', 'plain'],
]);

const markdownExtensions = new Set(['md', 'markdown']);

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function isEditableTextFile(name: string): boolean {
  return languages.has(extensionOf(name));
}

export function isMarkdownFile(name: string): boolean {
  return markdownExtensions.has(extensionOf(name));
}

/** 白名单内没有登记具体语言的扩展名一律按纯文本高亮。 */
export function editorLanguageFor(name: string): EditorLanguage {
  return languages.get(extensionOf(name)) ?? 'plain';
}
