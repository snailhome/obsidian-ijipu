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

/** 全角宽字：汉字 / 假名 / 谚文 / 注音 / 全角标点（这些字体的推进量正好 1em） */
const WIDE_CHAR_RE = /[\u3000-\u303f\uff00-\uffef]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u
/** 组合附加符（宽度并入前一个字，自己不算宽） */
const COMBINING_RE = /\p{M}/u
/** emoji 基础码位：图形字符 + 区域指示符（🇨🇳 由两个区域指示符拼成） */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u
/** 窄标点（实测 '.' = 0.24em，'!' / ':' 同族；留一点余量） */
const NARROW_PUNCT = ".,:;'!|()[]{}/\\-\"`~"

/**
 * 估算一段描述头文字的宽（单位与字号同）。
 *
 * 估算只用于「label 列有多宽 / value 列有多宽」这两个**列宽**；label 的实际拉伸由 SVG 的
 * `textLength` 强制到精确宽度，所以估算误差只影响列宽取整，不影响"每行 label 等宽"这件事。
 *
 * adj1308（用户实报）：原来"非 CJK 一律 0.55em"把 **emoji 也算成 0.55em**——
 * `蜗牛🐌 制谱` 的 label 列只算出 2.55em，而真浏览器（Chrome headless，本引擎默认字体栈，
 * 12px）实测 `蜗牛🐌` = 40.48（其中 🐌 单独 = 16.48 = **1.373em**）⇒ `textLength` 比自然宽
 * 还小，`lengthAdjust="spacing"` 只能发**负字距** ⇒ 字形互相压住（emoji 压到「制谱」上）。
 *
 * 所以口径改成**宁宽勿窄**：估大只是标签拉得开一点，估小才是肉眼可见的缺陷。
 * · emoji（含变体选择符 / 肤色修饰 / ZWJ 组合）：整簇算 `1.5em`
 * · 汉字 / 假名 / 谚文 / 注音 / 全角标点：`1em`
 * · ASCII 分档：`M W m w % @ &` = 1.0、其它大写 0.75、小写 0.62、数字 0.6、
 *   空格 0.3、窄标点 0.35
 * · 其它（西里尔、希腊、带音标拉丁…）：0.62
 */
export function authorGlyphW(text: string, size: number): number {
  const chars = [...text]
  let w = 0
  let i = 0
  while (i < chars.length) {
    const ch = chars[i] as string
    const cp = ch.codePointAt(0) as number
    if (EMOJI_RE.test(ch)) {
      // 一个 emoji「簇」：往后的变体选择符 / 肤色修饰 / ZWJ 连接都归它，仍只算一个字宽
      i++
      while (i < chars.length) {
        const ncp = (chars[i] as string).codePointAt(0) as number
        if (ncp === 0xfe0e || ncp === 0xfe0f || (ncp >= 0x1f3fb && ncp <= 0x1f3ff)) {
          i++
          continue
        }
        if (ncp === 0x200d && i + 1 < chars.length) {
          i += 2
          continue
        }
        break
      }
      w += size * 1.5
      continue
    }
    // 孤立的变体选择符 / 组合符：宽度已经算在前一个字里
    if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff) || COMBINING_RE.test(ch)) {
      i++
      continue
    }
    w += WIDE_CHAR_RE.test(ch) ? size : size * latinEm(cp)
    i++
  }
  return w
}

/** ASCII / 拉丁字符的经验字宽（em 倍数）；一律取"不窄于实测"，见 `authorGlyphW` 的说明 */
function latinEm(cp: number): number {
  if (cp === 0x20) return 0.3 // 空格实测 0.296
  if (cp >= 0x30 && cp <= 0x39) return 0.6 // 数字
  const ch = String.fromCodePoint(cp)
  if ('MWmw%@&'.includes(ch)) return 1 // 宽字母（M 实测 0.977）
  if (cp >= 0x41 && cp <= 0x5a) return 0.75 // 其它大写
  if (cp >= 0x61 && cp <= 0x7a) return 0.62 // 小写
  if (NARROW_PUNCT.includes(ch)) return 0.35 // 窄标点
  return 0.62
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
