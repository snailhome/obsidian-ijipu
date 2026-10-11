/**
 * imageSave.ts — 手机端「保存图片到谱面同目录」的**纯逻辑**（adj873，用户 2026-10-11 要求）
 *
 * ## 为什么单独一个文件
 * 手机端**写不了剪贴板图片**（宿主 WebView 没有 `ClipboardItem` / `navigator.clipboard.write`）
 * ⇒ 手机上把 `⋯ 更多 → 图片出口` 从「复制」改成「**保存到谱面同目录**」（`<谱名>.png`），桌面不变。
 *
 * 这一文件只管"**存成什么名字**"这件纯逻辑（不碰 `obsidian`、不碰 DOM）：
 *  · `scorePngBase()`：参考路径（`.jps` 文件视图/嵌入 = 谱面文件；代码块 = 宿主笔记）→ **谱名**；
 *  · `uniquePngName()`：同目录**重名就递增后缀**（`<谱名>.png` → `<谱名>-2.png` → `<谱名>-3.png` …）
 *    —— **绝不静默覆盖** ✗（用户点名要求）。
 *
 * 真正落盘（`vault.createBinary`）在 `main.ts` 的 `saveScoreImage()` 里；
 * 拆成纯函数是为了让冒烟能**直接跑**它的边界（而不是只对源码做字符串匹配）。
 */

/**
 * 参考路径 → **谱名**（不含扩展名）。
 *
 * · `.jps` 文件视图 / `![[x.jps]]` 嵌入 ⇒ `库/曲谱集/小星星.jps` → `小星星`；
 * · ```jps 代码块 ⇒ 宿主笔记 `库/曲谱集/练习.md` → `练习`（代码块没有自己的文件，
 *   与既有「导出 PNG / SVG」命令的口径一致：用宿主笔记的基名）；
 * · 取不到 / 空 ⇒ `score`（**绝不**产出一个 `.png` 这种隐藏文件 ✗）。
 */
export function scorePngBase(referencePath: string | undefined): string {
  const p = (referencePath ?? '').replace(/\\/g, '/')
  const name = p.slice(p.lastIndexOf('/') + 1)
  const base = name.replace(/\.[^./]+$/, '').trim()
  return base === '' ? 'score' : base
}

/** 保存图片的扩展名（一处定义：菜单文案、文件名、冒烟断言都读它） */
export const IMAGE_EXT = '.png'

/**
 * 在**同目录已存在的文件名**里挑一个不冲突的 `<谱名>.png`（纯函数，供冒烟断言）。
 *
 * 口径（用户 2026-10-11）：重名就加 `-2`、`-3`…（**不许静默覆盖**已有图片 ✗）。
 *  · 取**第一个空位**（不是"已有数量 + 1"）：删掉中间某个之后不会又撞上已占用的名字；
 *  · 比较按**小写**：Windows / macOS 上 `小星星.PNG` 与 `小星星.png` 是同一个文件；
 *  · 一万个都占满（实际不可能）⇒ 退化成时间戳，仍然**不覆盖**任何文件。
 */
export function uniquePngName(existing: readonly string[], base: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  const first = `${base}${IMAGE_EXT}`
  if (!taken.has(first.toLowerCase())) return first
  for (let i = 2; i < 10000; i++) {
    const name = `${base}-${i}${IMAGE_EXT}`
    if (!taken.has(name.toLowerCase())) return name
  }
  return `${base}-${Date.now()}${IMAGE_EXT}`
}
