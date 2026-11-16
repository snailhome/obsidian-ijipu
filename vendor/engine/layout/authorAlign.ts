/**
 * engine/layout/authorAlign.ts — 作者（`Z:` 行）「两端对齐」的纯几何（adj1304）
 *
 * ## 用户要求（2026-11-16）
 *
 * 「在谱面设置里添加一个 **作者两端对齐** 选项，对于多个描述头 `Z` 的内容，
 *  对**最后一个空格前面**的内容进行两端对齐；注意，`Z` 部分**整体是右对齐到右边距**的，
 *  只有描述 `Z` 的最后一个空格前的字符部分才按**最长字符行**进行两端对齐。」
 *
 * 落地口径（逐条对应）：
 * 1. **只动最后一个空格之前的那一段**：`"作曲 张三"` ⇒ label=`作曲`、value=`张三`；
 *    没有空格（或空格在行首）⇒ label 为空、value 是整行。
 * 2. **label 列宽 = 所有 label 里最长的一行**（"最长字符行"）；渲染端用 SVG 的
 *    `textLength` + `lengthAdjust="spacing"` 把每行 label **拉伸到该宽度**（真正的两端对齐，
 *    不靠引擎估宽逐字摆）。
 * 3. **整行仍然右对齐到右边距**：value 用 `text-anchor="end"` 钉在原来的右边界上（与旧版一致）；
 *    label 的右缘 = 右边界 − **最宽 value** − 半字间隙 ⇒ 各行的 label 因此左/右都对齐。
 *
 * 这里只算"列宽与间隙"，渲染在 `render/index.ts`；纯函数 ⇒ smoke 可直接断言。
 */

/** 一行作者拆成的两段（label = 最后一个空格之前；value = 之后） */
export interface AuthorLine {
  label: string
  value: string
}

/**
 * 把一条 `Z:` 文本按**最后一个空格**拆成「标签 / 值」。
 *
 * · 首尾空白先去掉（与渲染端旧行为一致：空格只是分隔符，不参与排版）；
 * · 找不到空格、或空格在行首 ⇒ 没有标签，整行都是值；
 * · 连续多个空格按**最后一个**算（前面的空格归 label 尾部，会被 trim）。
 */
export function splitAuthorLine(line: string): AuthorLine {
  const text = line.trim()
  const i = text.lastIndexOf(' ')
  if (i <= 0) return { label: '', value: text }
  return { label: text.slice(0, i).trimEnd(), value: text.slice(i + 1).trimStart() }
}

/**
 * 估算一段描述头文字的宽（单位与字号同）。
 *
 * 估算只用于「label 列有多宽 / value 列有多宽」这两个**列宽**；label 的实际拉伸由 SVG 的
 * `textLength` 强制到精确宽度，所以估算误差只影响列宽取整，不影响"每行 label 等宽"这件事。
 * 取法与布局端歌词的 `charW` 同口径：CJK / 全角标点 = 1em，其余 = 0.55em。
 */
export function authorGlyphW(text: string, size: number): number {
  let w = 0
  for (const ch of text) {
    w += /[\u3000-\u303f\uff00-\uffef]|\p{Script=Han}/u.test(ch) ? size : size * 0.55
  }
  return w
}

/** 一整组作者行的对齐结果（列宽 + 行数据） */
export interface AuthorAlign {
  rows: AuthorLine[]
  /** label 列宽 = 最长 label（"最长字符行"）；没有 label 时为 0 */
  labelW: number
  /** value 列宽 = 最宽 value（用来把 label 列整体左移，保证 Z 块右缘仍贴右边距） */
  valueW: number
  /** label 与 value 之间的间隙（半字；与 `"作曲 张三"` 里那个空格观感一致） */
  gap: number
  /** 这一组里是否真有 label（没有就退回旧版"整行右对齐"的渲染） */
  hasLabel: boolean
}

/**
 * 计算一组作者行的对齐列宽（纯函数）。
 *
 * @param authors  描述头里的多条 `Z:` 原文（顺序 = 谱面从上到下）
 * @param fontSize 作者字号（渲染端用的 `max(9, miaoshu_size - 1)`）
 */
export function alignAuthorLines(authors: readonly string[], fontSize: number): AuthorAlign {
  const rows = authors.map(splitAuthorLine)
  const labelW = rows.reduce((m, r) => Math.max(m, authorGlyphW(r.label, fontSize)), 0)
  const valueW = rows.reduce((m, r) => Math.max(m, authorGlyphW(r.value, fontSize)), 0)
  return { rows, labelW, valueW, gap: fontSize * 0.5, hasLabel: labelW > 0 }
}
