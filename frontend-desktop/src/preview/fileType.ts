export type PreviewType =
  | 'image' | 'markdown' | 'docx' | 'excel'
  | 'code' | 'text' | 'pdf' | 'pptx' | 'html' | 'drawio' | 'binary'

// Draw.io 图表：精确扩展名路由（大小写不敏感）。.xml 不在此列——它是通用格式，
// 继续按代码预览；只有显式 .drawio/.dio 才进只读图预览（设计决策 2）。
const DRAWIO_EXTS = new Set(['drawio', 'dio'])

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'])
const MD_EXTS = new Set(['md', 'markdown'])
const DOCX_EXTS = new Set(['docx'])
const EXCEL_EXTS = new Set(['xlsx', 'xls', 'csv'])
const PDF_EXTS = new Set(['pdf'])
const PPTX_EXTS = new Set(['pptx'])
// 纯文本（无语法高亮）。含无扩展名文件的文件名键（license/readme/…）与常见 dotfile 的伪扩展名
// （.gitignore→gitignore）。数据/字幕/文档源文本一律按纯文本渲染。
const TEXT_EXTS = new Set([
  'txt', 'log', 'rst', 'tex', 'bib', 'srt', 'vtt', 'env',
  'jsonl', 'ndjson', 'tsv',
  'gitignore', 'dockerignore', 'gitattributes', 'npmrc', 'editorconfig',
  'license', 'readme', 'authors', 'notice', 'changelog', 'copying',
])
const HTML_EXTS = new Set(['html', 'htm'])

// Maps file extension (或无扩展名文件的文件名键) -> highlight.js language id。
// 不在 highlight.js common 包内的 id（powershell/dos/dockerfile/terraform/dart/…）会命中
// CodeViewer 的 getLanguage 兜底 → 走 highlightAuto,仍按代码渲染,只是自动识别语言。
export const CODE_LANGS: Record<string, string> = {
  py: 'python', js: 'javascript', ts: 'typescript',
  jsx: 'javascript', tsx: 'typescript', sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  cfg: 'ini', ini: 'ini', conf: 'ini', properties: 'ini',
  css: 'css', scss: 'scss', less: 'less', xml: 'xml', vue: 'xml',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', mm: 'objectivec', php: 'php', rb: 'ruby',
  pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', sql: 'sql',
  dart: 'dart', scala: 'scala', groovy: 'groovy', gradle: 'groovy',
  ps1: 'powershell', bat: 'dos', cmd: 'dos',
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', mk: 'makefile', cmake: 'cmake',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql',
  diff: 'diff', patch: 'diff', tf: 'terraform', hcl: 'terraform',
}

export function getExt(p: string): string {
  const name = (p.split(/[/\\]/).pop() ?? p).toLowerCase()
  if (name.includes('.')) return name.split('.').pop() ?? ''
  // 无扩展名文件（Dockerfile / Makefile / LICENSE 等）用文件名本身作键,交给下面的表匹配。
  return name
}

export function fileType(ext: string): PreviewType {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (MD_EXTS.has(ext)) return 'markdown'
  if (DOCX_EXTS.has(ext)) return 'docx'
  if (EXCEL_EXTS.has(ext)) return 'excel'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (PPTX_EXTS.has(ext)) return 'pptx'
  if (HTML_EXTS.has(ext)) return 'html'
  if (DRAWIO_EXTS.has(ext)) return 'drawio'
  if (ext in CODE_LANGS) return 'code'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}
