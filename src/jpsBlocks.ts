/**
 * jpsBlocks.ts — 扫描 markdown 源码里的 ```jps 围栏块（**纯函数**，不依赖 Obsidian / DOM）
 *
 * 用户要求（原话）：「**jps 代码块**应同时应用自动格式化、脚本颜色高亮和错误提示功能，
 * 与手机版 jps 文件的源码编辑模式一致」。
 *
 * 三项能力都需要先回答同一个问题：**"这一行是不是落在某个 ```jps 代码块里？"**
 *  · 着色：只给围栏内的行上 iJipu 的 token 配色（绝不碰笔记里其它 markdown 文本）；
 *  · 错误提示：把围栏**内**的正文交给引擎 `parseJps`，行号再偏移回**文档行号**；
 *  · 自动格式化：光标离开的那一行若在块内，才按引擎 `formatLine` 规范化。
 * 于是把"围栏扫描"做成一个纯函数放这里，三处共用同一份口径（避免各写一遍再漂 —— 见 E-2026-378）。
 *
 * 口径（对齐 CommonMark，取对用户最合理的那一支）：
 *  · 开栏行：` ```jps ` / ` ``` jps ` / 前后可有空白；info string 允许 `jps` 后面还有别的词
 *    （例如 ` ```jps title=xx `，Obsidian 也这么认）；围栏字符 ` 与 `~` 都支持，长度 ≥3；
 *  · 闭栏行：**同种字符**、长度 ≥ 开栏长度、其后只有空白；
 *  · **未闭合**的围栏按 CommonMark 处理：**一直延伸到文档末尾**（这样用户敲了 ` ```jps ` 还没写收尾时，
 *    着色/错误提示就已经生效，而不是"什么都没发生"）；
 *  · **缩进**：开栏行最多允许 3 个空格（4 个空格是缩进代码块，不是围栏）；正文的行首缩进原样保留；
 *  · 嵌套/连续围栏按顺序配对，不递归。
 */

/** 一个 ```jps 代码块在**文档里的行号范围**（1-based，闭区间） */
export type JpsBlockRange = {
  /** 开栏行（```jps 这一行） */
  fenceStart: number
  /** 闭栏行；未闭合时为 `null`（表示延伸到文档末尾） */
  fenceEnd: number | null
  /** 正文第一行（= fenceStart + 1） */
  bodyStart: number
  /** 正文最后一行（1-based，闭区间）；未闭合时 = 文档最后一行 */
  bodyEnd: number
  /** 正文文本（各正文行用 `\n` 连接；不含围栏行） */
  body: string
}

/** 开栏：≤3 空格缩进 + (` 或 ~)×3 以上 + 可空白 + `jps`（其后可有别的 info 词） */
const OPEN_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*jps\b[^\n]*$/
/** 闭栏：≤3 空格缩进 + 同种字符×≥开栏长度 + 其后仅空白（长度在配对时再校验） */
const CLOSE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/

/**
 * 扫描文档里所有 ```jps 代码块（按行号升序）。
 *
 * @param source 整篇文档（`\r\n` 会先规范化成 `\n`，行号按规范化后的行算）
 */
export function jpsBlockRanges(source: string): JpsBlockRange[] {
  const text = source.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const out: JpsBlockRange[] = []
  let i = 0
  while (i < lines.length) {
    const m = OPEN_RE.exec(lines[i])
    if (!m) {
      i++
      continue
    }
    const fenceChar = m[2][0]
    const fenceLen = m[2].length
    const fenceStart = i + 1 // 1-based
    let j = i + 1
    let fenceEnd: number | null = null
    while (j < lines.length) {
      const c = CLOSE_RE.exec(lines[j])
      if (c && c[2][0] === fenceChar && c[2].length >= fenceLen) {
        fenceEnd = j + 1
        break
      }
      j++
    }
    // 未闭合 ⇒ 正文延伸到文末（CommonMark）
    const bodyStart = fenceStart + 1
    const bodyEnd = fenceEnd === null ? lines.length : fenceEnd - 1
    const bodyLines = bodyStart <= bodyEnd ? lines.slice(bodyStart - 1, bodyEnd) : []
    out.push({ fenceStart, fenceEnd, bodyStart, bodyEnd, body: bodyLines.join('\n') })
    i = fenceEnd === null ? lines.length : fenceEnd
  }
  return out
}

/** 某一行（1-based）落在哪个 jps 块里？不在任何块里返回 `null`（围栏行**也算**在块内 —— 便于整块标注） */
export function jpsBlockOfLine(blocks: readonly JpsBlockRange[], line: number): JpsBlockRange | null {
  for (const b of blocks) {
    const last = b.fenceEnd ?? b.bodyEnd
    if (line >= b.fenceStart && line <= last) return b
  }
  return null
}

/** 某一行是否落在 jps 块的**正文**里（用于自动格式化：围栏行不该被格式化） */
export function isJpsBodyLine(blocks: readonly JpsBlockRange[], line: number): boolean {
  for (const b of blocks) if (line >= b.bodyStart && line <= b.bodyEnd) return true
  return false
}
