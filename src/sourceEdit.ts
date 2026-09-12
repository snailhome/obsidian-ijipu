/**
 * sourceEdit.ts — 写回源码的纯函数（零 Obsidian 依赖，可单测）
 *
 * 「⚙ 排版」对话框保存时要把新的 `# jps-config` 行落到**当前曲谱**：
 *  - ```jps 代码块：替换**笔记里该代码块的正文**（块内的 .jps 源码）
 *  - `.jps` 文件视图：直接替换整个文件内容
 * 两种情况都归结为"在整篇文本上替换一个行区间"，抽成纯函数便于用 Node 断言。
 */

/** 判断 Obsidian 链接串是否指向 .jps：去掉 `#子标题`/`|别名|尺寸` 后再看后缀 */
export function jpsLinkpath(rawSrc: string): string | null {
  const p = rawSrc.split('#')[0].split('|')[0].trim()
  return /\.jps$/i.test(p) ? p : null
}

/**
 * 替换代码块正文：保留第 `lineStart` 行（开栅栏）与第 `lineEnd` 行（闭栅栏），
 * 用 `body` 覆盖二者之间的内容。行号为 0 基（与 Obsidian `getSectionInfo` 一致）。
 * 区间非法时**原样返回**（宁可不动，也不要写坏用户笔记）。
 */
export function replaceCodeBlockBody(fileText: string, lineStart: number, lineEnd: number, body: string): string {
  const text = fileText.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return fileText
  if (lineStart < 0 || lineEnd >= lines.length || lineEnd <= lineStart) return fileText
  // 只切正文行；末尾空行归一（避免每次保存都堆积空行）
  const bodyLines = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  return [...lines.slice(0, lineStart + 1), ...bodyLines, ...lines.slice(lineEnd)].join('\n')
}

/** 取代码块正文（区间内的原始内容）；区间非法返回 null */
export function codeBlockBody(fileText: string, lineStart: number, lineEnd: number): string | null {
  const lines = fileText.replace(/\r\n/g, '\n').split('\n')
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return null
  if (lineStart < 0 || lineEnd >= lines.length || lineEnd <= lineStart) return null
  return lines.slice(lineStart + 1, lineEnd).join('\n')
}
