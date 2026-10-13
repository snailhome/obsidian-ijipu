/**
 * paraIndent.ts — `adj917`：**嵌入块 / 代码块 与同上下文段落文字的"左对齐 + 同宽"**
 *
 * ## 用户报的问题
 * 「jps嵌入块与其它段落的对齐不一致，请调整嵌入块与其它段落的左对齐、宽度一致」。
 *
 * ## 真因（读码 + 真实 `app.css` + 用户库实测，见 `docs/` 与提交说明）
 * 我们的嵌入容器是**块级盒**（`embed.ts` 给宿主容器加 `.ijipu-embed`，`styles.css` 里
 * `display: block`；宿主 `app.css` 也有 `.internal-embed:not(.image-embed) { display: block }`），
 * 而**段落文字的左缘会被 `text-indent` 右移** —— `text-indent` 是**可继承**属性，却**只作用于行盒**，
 * 对块级子盒无效。用户库里启用的片段 `首行缩进.css` 正是：
 *
 *   ```css
 *   .markdown-preview-section p { text-indent: 2em }                    ＝ 阅读视图
 *   .markdown-source-view.mod-cm6 .cm-line:not(…) { text-indent: 2em }   ＝ 实时预览
 *   ```
 *
 * 无头浏览器实测（仿 Obsidian fixture + 真实 `app.css` + Minimal 主题 + 用户片段，视图宽 974）：
 *  · 段落盒 `x=32  宽=895`（右缘 927）；**段落文字首行起点 `x=64`**（2em = 32px）；
 *  · 我们的嵌入盒 `x=32  宽=895` ⇒ 比文字**左出 32px、宽出 32px**（用户看到的就是"块比段落更靠左、更宽"）。
 *
 * ## 口径（本文件只做"量"，样式在 `styles.css` 的 `.ijipu-para-indent`）
 * 嵌入块 / 代码块**跟随同上下文段落文字的缩进**：左缘与文字首行同一条线，右缘仍与段落盒右缘同线
 * （宽度 = 文字那一行的宽度）⇒ 这正是用户要的"左对齐、宽度一致"。
 * **上下文没有缩进时一律 0**（默认情况）⇒ 对别的主题 / 别的库**零影响**。
 */
/**
 * "段落样"的元素（按"最可能是用户说的那段文字"排序）：
 *  · `.cm-line` —— 实时预览里的一行（用户片段就是缩进它）；
 *  · `.el-p > p` —— 阅读视图里 Obsidian 给每个段落套的 `.el-p` 里的 `<p>`（用户诊断实测的祖先链）；
 *  · `p` —— 兜底（更老的宿主版本 / 别的渲染路径）。
 */
const PARA_SELECTOR = '.cm-line, .el-p > p, p'
/** 往上找"同上下文"的容器：阅读视图的 sizer / 实时预览的 `.cm-content` / 笔记嵌入内部 */
const SCOPE_SELECTOR = '.markdown-preview-sizer, .cm-content, .markdown-embed-content'
/** 小于这个量（px）就当"没有缩进"（不足 1px 的偏移没有视觉意义，也不值得动样式） */
const MIN_INDENT_PX = 1
/** 同上下文最多看几个"段落样"元素（第一个量不到缩进时往后看） */
const MAX_PARA_PROBE = 3

/**
 * `getComputedStyle().textIndent` 的值 ⇒ px（**纯函数**，冒烟直接跑）。
 *
 * 实测（Chrome）：`text-indent: 2em` 的**计算值**是 `'32px'`（长度单位已被绝对化），
 * 只有**百分比**会保持 `'10%'` 原样 ⇒ 这里只认 `px` 与 `%` 两种形态：
 *  · `'32px'` ⇒ 32；`'10%'`（作用域宽 800）⇒ 80；
 *  · **负值**（悬挂缩进 `text-indent: -2em` ⇒ `'-32px'`）⇒ **0**：我们的块不能跑到段落盒外面去；
 *  · 认不出的写法 / `NaN` / 不足 1px ⇒ 0（**宁可不偏移，也不猜** —— 偏移错了比不偏移更糟）。
 */
export function indentPxOf(value: string, scopeWidth: number): number {
  const m = /^(-?[\d.]+)(px|%)?$/.exec(value.trim())
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return 0
  const px = m[2] === '%' ? (n / 100) * (scopeWidth > 0 ? scopeWidth : 0) : n
  if (!Number.isFinite(px) || px < MIN_INDENT_PX) return 0
  // 小数留两位（盒模型按小数算，但写进自定义属性时保持短）
  return Math.round(px * 100) / 100
}

/**
 * 取"同上下文段落文字"的左缩进（px）。
 *
 * ① 先看**自己算出来的** `textIndent` —— 它是可继承属性：阅读视图里我们的容器就在 `<p>` 内
 *    （用户诊断实测祖先链 `span.internal-embed < p < div.el-p`）⇒ 直接继承到段落的首行缩进 ✓；
 * ② 实时预览里容器是 `.cm-content` 的**兄弟**（块级 widget，不在 `.cm-line` 里）⇒ 继承不到 ⇒
 *    回头看同一上下文里最靠前的几个"段落样"元素（`PARA_SELECTOR`）。
 *
 * 量不到（脱离文档 / 上下文没有缩进）一律 0。**不做任何写入**，调用方拿到值自己决定要不要动样式。
 */
export function paragraphIndentOf(el: HTMLElement): number {
  const scope = el.closest<HTMLElement>(SCOPE_SELECTOR) ?? el.parentElement
  const width = scope?.clientWidth ?? 0
  const own = indentPxOf(window.getComputedStyle(el).textIndent, width)
  if (own > 0) return own
  if (!scope) return 0
  const paras = Array.from(scope.querySelectorAll<HTMLElement>(PARA_SELECTOR)).slice(0, MAX_PARA_PROBE)
  for (const p of paras) {
    const px = indentPxOf(window.getComputedStyle(p).textIndent, width)
    if (px > 0) return px
  }
  return 0
}
