/**
 * engine/highlight/jpsProblems.ts — **错误/告警 → 源码位置的"块"换算**（纯逻辑，零 DOM）
 *
 * 存在理由（用户 2026-10 要求）：「预览渲染、播放、源码格式化、源码高亮、**错误信息显示提示**等共性的功能
 * 都可以独立到引擎层面」，并且「应用端也应同样处理」。
 *
 * 现状：解析器早就在引擎里产出带 `line`/`col`/`message`/`hint` 的问题列表；
 * 但"**把 col 归到它所在的音符块**"（好给那一段画红外框/橙框）这件事，此前**应用与插件各写了一遍**
 * —— 正是"两套口径会漂移"的老毛病。这里把它收进引擎，两端共用：
 *  · 应用编辑器：命中块包 `<span class="hl-err-block">`（HTML 渲染）；
 *  · Obsidian 插件：命中区间打 CM6 `Decoration.mark`。
 *
 * 口径（与应用 `highlightCodeWrapped` 完全一致）：块 = **空格/制表符分隔的一段**；
 * `col` 相对"行头之后的内容"（`Q:`/`C:` 等命令头之后），换算时补上"前导空白 + 行头长度"。
 */
import type { ParseError } from '../types'
import { jpsHeaderOf } from './jpsHighlight'

/** 单个错误/告警在**行内**的块区间（`line` 为 1-based；`from`/`to` 相对该行、0-based 半开） */
export type JpsBlockMark = {
  line: number
  from: number
  to: number
  severity: 'error' | 'warning'
}

/** 该问题的严重级别（`ParseError.severity` 只有 error/warning，缺省按 error） */
export function jpsSeverityOf(issue: Pick<ParseError, 'severity'>): 'error' | 'warning' {
  return issue.severity === 'warning' ? 'warning' : 'error'
}

/**
 * 把 `col`（相对行头之后的内容）换算成"所在块"的**行内绝对区间** `[from, to)`。
 *
 * 返回 `null` 表示定位不到（空行、纯空白、越界）—— 调用方应退化为"只标整行"。
 */
export function jpsBlockSpan(raw: string, col: number): [number, number] | null {
  const trimmed = raw.trim()
  const lead = raw.length - trimmed.length
  const head = jpsHeaderOf(trimmed)
  /**
   * 行头之后**还要跳过空白**：`ParseError.col` 与应用 `BlockMarks` 的 col 都是
   * "相对行头之后那段内容"（`Q: 1 2 …` 里的 `1` 是 col 0），应用侧此前是靠加 `restLead` 抵消的。
   * 这里统一在引擎里抵消 ⇒ 两端都不用再各自补偏移。
   */
  let base = lead + (head ? head.headLen : 0)
  const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t'
  while (base < raw.length && isSpace(raw[base])) base++
  const at = base + Math.max(0, col)
  if (at > raw.length) return null
  /**
   * ⚠ 必须与应用的判据**逐字等价**：应用是"`c >= 块起点 && c < 块终点`"，所以
   * **落在空白上 / 落在行尾之后**的 col **不属于任何块** ⇒ 返回 null（调用方退化为只标整行）。
   * 早期版本会"吸附到前一个块"，那会让两端对同一份错误画出不同的框。
   */
  if (at >= raw.length || isSpace(raw[at])) return null
  let from = at
  while (from > base && !isSpace(raw[from - 1])) from--
  let to = at
  while (to < raw.length && !isSpace(raw[to])) to++
  if (to <= from) return null
  return [from, to]
}

/**
 * 整篇：把问题列表换算成块区间列表（供两端直接消费）。
 *
 * 同一行同一块上既有错误又有告警时**错误优先**（与应用"红 > 橙"一致）；重复块只留一条。
 */
export function jpsBlockMarks(source: string, issues: readonly ParseError[]): JpsBlockMark[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const seen = new Map<string, JpsBlockMark>()
  for (const issue of issues) {
    const raw = lines[issue.line - 1]
    if (raw === undefined) continue
    const span = jpsBlockSpan(raw, issue.col)
    if (!span) continue
    const severity = jpsSeverityOf(issue)
    const key = `${issue.line}:${span[0]}:${span[1]}`
    const prev = seen.get(key)
    if (prev && (prev.severity === 'error' || severity === 'warning')) continue
    seen.set(key, { line: issue.line, from: span[0], to: span[1], severity })
  }
  return [...seen.values()].sort((a, b) => a.line - b.line || a.from - b.from)
}
