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

/**
 * adj965l（**用户 2026-10-15 实报**：「代码块预览设置里取消了水印启用、点保存到谱面、
 * 提示"已写入谱面"，保存笔记后重开，水印还开着」）：**写回该走哪条路**——纯判据。
 *
 * 由来（真因）：宿主 `writeSource` 原来只判"有没有一个指向这份笔记的 MarkdownView"，
 * 于是**阅读模式**下也走编辑器那条路；而阅读模式里那个 editor **不是这份文件的活动缓冲区**
 * （`replaceRange` 不报错、也写不进文件）⇒ 只更新了插件自己缓存的那份源码（预览当场变好看了）
 * ⇒ 提示"已写入谱面"，**文件一个字没动**，重开就回来了 ✗。插件自己在「打开源码」那处
 * 就因为同一个原因先 `setState({mode:'source'})` 再动编辑器（见 `main.ts` 的 `openInObsidianEditor`）。
 *
 * 现在把"能不能用编辑器"这条判据**独立成纯函数**：只有"同一个文件 **且** 视图确实处于可编辑模式"
 * 才走编辑器（保留撤销栈），其余一律走**整文件事务写**（阅读模式、别的笔记、无视图都在此列）。
 *
 * @param mode 视图模式（Obsidian `MarkdownView.getMode()`：`'source'` = 实时预览/源码，`'preview'` = 阅读）
 * @param viewPath 当前活动 MarkdownView 对应的文件路径（没有视图则传 null/undefined）
 * @param sourcePath 这份代码块所在的笔记路径
 */
export function writeRoute(mode: string | null | undefined, viewPath: string | null | undefined, sourcePath: string): 'editor' | 'file' {
  if (viewPath === null || viewPath === undefined || viewPath !== sourcePath) return 'file'
  // 只有可编辑模式才认编辑器；`preview`（阅读）以及未知取值一律走整文件事务写 —— 宁可慢一点，也不能假成功
  return mode === 'source' ? 'editor' : 'file'
}
