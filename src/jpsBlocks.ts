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
  /**
   * adj839（用户 2026-10-11 定稿）：**块级缩放参数** `z`（写在 info string，见下 ✓）。
   *
   * 用户给的分界（我完全同意 ✓）：
   *  · **`# jps-config` = 谱面自身设置**（随谱走、由谱面配置对话框生成、用户不必记写法 ✓）；
   *  · **块级参数 `z=` = 与笔记配合的呈现**（这个块在笔记里怎么摆 ✓）—— 两者职责不重叠 ✓。
   *
   * 取值语义：
   *  · 缺省 / `z=100` ⇒ **100%（自然尺寸）**：1 个 viewBox 单位 = 1 CSS px ✓
   *    （即"页面视图下的 1px 基准" ✓ ⇒ 音符大小与页面视图**一致** ✓，不再被拉伸放大 ✗）；
   *  · `z=<数字>` ⇒ 百分比（`z=150` = 150% ✓）；
   *  · **`z=*`** ⇒ **自适应笔记宽度**（= 本功能上线前的行为 ✓，按容器铺满 ✓）。
   */
  zoom: number | 'auto'
}

/**
 * 从开栏行的 **info string** 里解析 `z`（adj839 ✓）。
 * 规则：找 `z=<值>` 形态的独立词 ✓；`*` ⇒ `'auto'` ✓；数字（1–1000）⇒ 该百分比 ✓；
 * 缺省/非法 ⇒ **100**（自然尺寸 ✓，也是用户定的默认 ✓）。
 * 纯函数 ✓ ⇒ 可直接断言（见冒烟 `adj839`）。
 */
/**
 * 代码块参数（语言名后面那串）的**分隔与边界规则**（`adj870`，用户 2026-10-11 追问"参数之间用什么分隔"后定死）：
 *
 * · **主推空格分隔**：```` ```jps m=p z=150 ```` ✓ / ```` ```jps z=150 m=p ```` ✓（顺序任意 ✓）
 * · **容忍** `,` `;` `|` 作分隔（有人习惯写 `m=p,z=150` ⇒ 也认 ✓，免得"写了没反应"）
 * · **键名与取值都大小写不敏感**（`M=S` / `m=SCORE` 都认 ✓）
 * · **重复键：先出现者胜**（`exec` 取第一个匹配 ✓，可预测）
 * · **认不出的键/值一律忽略，不改变行为**（`m=x` ⇒ 当没写 ⇒ 用缺省「谱面」；`z=abc` ⇒ 当没写 ⇒ 100%）✓
 * · **连写不算参数** ✗：`z=150m=p` 两个都不认（否则"粘在一起"会静默变成别的模式）
 *
 * 两个参数（`m` / `z`）共用这一套边界 ⇒ 改规则只改这里一处。
 */
const PARAM_BEFORE = '(?:^|[\\s,;|])'
const PARAM_AFTER = '(?=[\\s,;|]|$)'

/**
 * `m=` 的取值表（`adj870`，用户 2026-10-11 定稿：「以减少歧义的方式来」）：
 *
 * | 写法 | 模式 | 界面文字 |
 * |---|---|---|
 * | `p` / `page` | `page` | 整页 |
 * | `w` / `width` | `full` | **满宽** |
 * | `s` / `score` | `score` | 谱面 |
 *
 * ⚠ **刻意不接受 `full`** ✗ —— 英文里 `full` 既可读成"满宽"也可读成 "full page"（整页），
 * 正是歧义的来源；而**内部 id 仍叫 `full`**（CSS 类 / `ViewMode` / 按钮 dataset 都是它，
 * 那是代码内部的事，不对外暴露）。写了 `full` ⇒ `modeOfInfo` 返回 `undefined`，
 * 并由 `modeParamWarning()` 给出**明确提示**（不静默退化成「谱面」✗）。
 */
export function modeOfInfo(infoLine: string): 'page' | 'full' | 'score' | undefined {
  const m = new RegExp(`${PARAM_BEFORE}m=([A-Za-z]{1,6})${PARAM_AFTER}`, 'i').exec(infoLine)
  if (m === null) return undefined
  const v = m[1].toLowerCase()
  if (v === 'p' || v === 'page') return 'page'
  if (v === 'w' || v === 'width') return 'full'
  if (v === 's' || v === 'score') return 'score'
  return undefined
}

/**
 * `m=` 写得有问题时给人一句**能照着改**的话（没问题返回 `null`）。
 *
 * 为什么单独一个函数：`modeOfInfo` 只回答"用哪个模式"，"为什么没用上"要说给人听 ——
 * 尤其 `m=full` 这种**有歧义所以拒绝**的情况，静默退化成「谱面」是最坏结果 ✗（用户会以为参数生效了）。
 * 调用方负责**每个代码块只提示一次**（渲染会反复调用）。
 */
export function modeParamWarning(infoLine: string): string | null {
  const m = new RegExp(`${PARAM_BEFORE}m=([A-Za-z]{1,6})${PARAM_AFTER}`, 'i').exec(infoLine)
  if (m === null) return null
  const v = m[1].toLowerCase()
  if (v === 'p' || v === 'page' || v === 'w' || v === 'width' || v === 's' || v === 'score') return null
  if (v === 'full')
    return '`m=full` 有歧义（既可读作"满宽"也可读作"整页"），已忽略；满宽请写 `m=w`，整页请写 `m=p`'
  return `认不出显示模式 \`m=${m[1]}\`，已忽略；可用 \`m=p\`（整页）/ \`m=w\`（满宽）/ \`m=s\`（谱面）`
}

export function zoomOfInfo(infoLine: string): number | 'auto' {
  const m = new RegExp(`${PARAM_BEFORE}z=(\\*|\\d{1,4})${PARAM_AFTER}`, 'i').exec(infoLine)
  if (m === null) return 100
  if (m[1] === '*') return 'auto'
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 1 || n > 1000) return 100
  return n
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
    out.push({ fenceStart, fenceEnd, bodyStart, bodyEnd, body: bodyLines.join('\n'), zoom: zoomOfInfo(lines[fenceStart - 1]) })
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
