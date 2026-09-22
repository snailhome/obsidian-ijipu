/**
 * engine/measures.ts — **小节时值校验**（adj594，用户要求）
 *
 * 用户口径（原话）："脚本应能检查小节的时值，对不符合时值长度的小节有告警，如一个 4/4 的小节，
 * 一个小节总长度应为 4 拍，如果有一个小节不等于 4 拍，则应告警，也要考虑到临时节拍的情况
 * 如果有 `"p:2/4"`，则该小节开始的小节为 2 拍，直到遇到下一个临时节拍，类推"。
 *
 * 规则（与 `docs/SYNTAX.md` 的口径一致）：
 *  · 每小节的"应有拍数"来自拍号：默认取描述头 `P:`（`4/4` → 4 拍；`6/8` → 6 拍），没写 `P:` 时按 **4/4**；
 *  · **临时拍号**写在小节线后的备注里（`|"p:2/4"`）——**从这条小节线之后的小节开始**生效，
 *    并**一直延续**到下一个临时拍号（跨行也延续；多声部各声部各自延续，与各自的书写一致）；
 *  · 一个小节的合计 = 带时值元素之和（音符 / 休止 / 增时线），减时线、附点、平均连音组
 *    都按引擎既有的 `tokenDuration()` 口径计算（连音组用 `tupletDur` 覆盖值）；
 *  · **不计入**的东西（都不是"占拍"的音符）：`&hx`（呼吸记号，adj375 明确"槽位长度不变"）、
 *    `&zkh`/`&ykh`（括号）、渐强渐弱、乐器切换、跳房子标记；
 *  · 倚音（`1[65]` / `1[h65]`）**不额外计拍**——按 adj489 它占用主音符的时值（向邻居借），
 *    不改变小节的书写时值合计。
 *
 * adj595（用户要求）：**每个声部的首小节只查"整数拍"**——弱起/不完全小节允许短于拍号
 * （`1 |` = 1 拍、`1 2 |` = 2 拍都合法），但 3.5 拍这种"半拍"仍告警。其余小节照旧必须等于拍号。
 *
 * 本模块为**纯函数**（零 React/DOM），解析器在 `parseJps()` 末尾调用，把结果并入 `ParseResult.errors`
 * （severity = `warning`：谱面仍能正常渲染/播放，只是提醒"这一小节跟拍号对不上"）。
 */
import type { MusicLine, MusicToken, ParseError, ParseResult } from './types'
import { errAt } from './parser/errors'
import { tokenDuration } from './duration'

/** 拍数比较的浮点容差（`3/2` vs `1.5` 这类二进制小数误差） */
export const MEASURE_BEATS_EPSILON = 1e-6

/** 没写 `P:` 时的默认每小节拍数（4/4） */
export const DEFAULT_METER_BEATS = 4

/** 带时值元素：音符 / 休止 / 增时线（缩写成一个小判定，四处共用） */
type DurationalToken = Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>
function isDurational(t: MusicToken): t is DurationalToken {
  return t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
}

/**
 * 拍号文本 → 每小节拍数（分子）。
 * `4/4` → 4；`6/8 (2/4)` → 6（取**第一个**分数，辅助拍号在括号里不参与）；
 * `2/2` → 2。无法解析 → null。
 */
export function meterBeatsOf(meter: string | undefined | null): number | null {
  if (!meter) return null
  const m = /(\d+)\s*\/\s*(\d+)/.exec(meter)
  if (!m) return null
  const beats = Number(m[1])
  return Number.isFinite(beats) && beats > 0 ? beats : null
}

/**
 * 小节线备注里的**临时拍号**：`p:2/4` → 2；`p: 3/4 渐慢` → 3；没有 → null。
 * 大小写不敏感（`P:2/4` 也认），前后可有其它文字。
 */
export function inlineMeterBeats(comment: string | undefined): number | null {
  if (!comment) return null
  const m = /p\s*:\s*(\d+)\s*\/\s*(\d+)/i.exec(comment)
  if (!m) return null
  const beats = Number(m[1])
  return Number.isFinite(beats) && beats > 0 ? beats : null
}

/** 小节备注里临时拍号的原文（用于告警文案；没有则返回 null） */
export function inlineMeterText(comment: string | undefined): string | null {
  if (!comment) return null
  const m = /p\s*:\s*(\d+)\s*\/\s*(\d+)/i.exec(comment)
  return m ? `${m[1]}/${m[2]}` : null
}

/** 一个小节的时值合计（拍） */
export function measureBeatsOf(tokens: readonly MusicToken[]): number {
  let sum = 0
  for (const t of tokens) {
    if (isDurational(t)) sum += tokenDuration(t)
  }
  return sum
}

/** `Q1"女声": ` 这类前缀的长度——token 的 `pos` 是"行内容内偏移"，加上它才是整行列号 */
function contentPrefixLen(raw: string): number {
  const trimmed = raw.trim()
  const m = /^Q\d*(?:"[^"]*")?\s*:\s*/.exec(trimmed)
  return m ? m[0].length : 0
}

/** 拍数显示（去掉浮点噪声：3.5 → "3.5"、4 → "4"、3.333333 → "3.33"） */
function fmtBeats(v: number): string {
  const r = Math.round(v * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r)
}

/**
 * 逐行（逐声部）校验小节时值，返回**告警**列表（不抛异常、不改动入参）。
 *
 * 每行内部按小节线切分；行尾未闭合的部分也算一个小节（与排版口径一致：一个 Q 行末尾
 * 没有 `|` 时那一截就是一节）。空小节（这个小节里一个带时值元素都没有）跳过——
 * 多声部里某一行的填充空小节不该报"时值不符"。
 *
 * adj594：拍号与小节号都**按声部延续**——临时拍号 `|"p:2/4"` 一直到该声部的下一个临时
 * 拍号为止；同一旋律折成多行 `Q:`（同一声部号）时小节号继续累加，不按行重来。
 */
export function checkMeasureBeats(result: ParseResult): ParseError[] {
  const out: ParseError[] = []
  const headerBeats = meterBeatsOf(result.header.meter) ?? DEFAULT_METER_BEATS
  const headerText = result.header.meter?.trim() || `${DEFAULT_METER_BEATS}/4`
  /** 各声部各自的当前拍数 / 拍号文本（临时拍号按声部分别延续） */
  const voiceMeter = new Map<number, { beats: number; text: string; measureNo: number }>()

  for (const line of result.lines as MusicLine[]) {
    if (line.kind !== 'music') continue
    const cur = voiceMeter.get(line.voice) ?? { beats: headerBeats, text: headerText, measureNo: 0 }
    let beats = cur.beats
    let meterText = cur.text
    const prefixLen = contentPrefixLen(line.raw)
    let measure: MusicToken[] = []
    let firstTok: MusicToken | null = null
    // adj594：小节号**按声部累加**（不按行重来）——同一旋律折成多行 `Q:` 时，
    // 第二行的第一小节是「第 N+1 小节」而不是又从「第 1 小节」开始。
    let measureNo = cur.measureNo

    const flush = (): void => {
      if (measure.length === 0) return
      measureNo += 1
      const sum = measureBeatsOf(measure)
      /**
       * adj595（用户要求）：**首小节只查"整数拍"**——弱起（不完全小节）可以短于拍号
       * （`1 |` 1 拍、`1 2 |` 2 拍都合法），但不能出现 3.5 拍这种"半拍"（通常是漏写/多写时值）。
       * 其余小节仍必须等于当前拍号。
       */
      const isFirst = measureNo === 1
      const ok = isFirst
        ? Math.abs(sum - Math.round(sum)) <= MEASURE_BEATS_EPSILON
        : Math.abs(sum - beats) <= MEASURE_BEATS_EPSILON
      if (!ok) {
        const at = firstTok ?? measure[0]
        const message = isFirst
          ? `首（弱起）小节共 ${fmtBeats(sum)} 拍，不是整数拍`
          : `第 ${measureNo} 小节共 ${fmtBeats(sum)} 拍，与拍号 ${meterText}（每小节 ${beats} 拍）不符`
        const hint = isFirst
          ? `弱起小节要写成**整数拍**（如 1 拍 \`1 |\`、2 拍 \`1 2 |\`）；` +
            `不想弱起就把这一小节补满 ${beats} 拍（加增时线 \`-\` 或减时线 \`/\`）`
          : `把这一小节补成 ${beats} 拍（加增时线 \`-\` 或减时线 \`/\`），或改拍号：整曲改描述头 \`P: ${beats}/4\`；` +
            `只改这一小节起用**临时拍号**——把它前面的小节线写成 \`|"p:${beats}/4"\`（延续到下一个临时拍号）`
        out.push(errAt(message, line.pos.line, prefixLen + (typeof at.pos === 'number' ? at.pos : 0), 'warning', hint))
      }
      measure = []
      firstTok = null
    }

    for (const t of line.tokens) {
      if (t.kind === 'barline') {
        flush()
        // 这条小节线上的临时拍号：从**下一个小节**开始生效（与 docs/SYNTAX.md 示例一致）
        const inline = inlineMeterBeats(t.comment)
        if (inline !== null) {
          beats = inline
          meterText = inlineMeterText(t.comment) ?? `${inline}/4`
        }
        continue
      }
      if (!isDurational(t)) continue // 记号/括号/乐器/临时段不参与小节时值
      if (!firstTok) firstTok = t
      measure.push(t)
    }
    flush() // 行尾未闭合的小节
    voiceMeter.set(line.voice, { beats, text: meterText, measureNo })
  }

  return out
}
