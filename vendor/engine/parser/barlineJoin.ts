/**
 * engine/parser/barlineJoin.ts — 两条 barline 的合并规则（adj1323）
 *
 * 用户口径（2026-11-23 定稿）：
 *  - 行首默认是隐式隐藏小节线；行首写出来的 barline 都要并到上一行末；
 *  - `||` 在合并时按“结束”看（`||` 就是 `:|`），所以 `||` + `|:` → `:|:`；
 *  - `:||:` 文本会先解析成 `:|` + `|:`，再并成 `:|:`；
 *  - `| |` 只留一根；
 *  - 同一行内相邻的 barline、跨行交界处的 barline，都用这一份规则。
 *
 * 注意：这里只改**合并后的类型**，不改单独写 `||` 的播放语义——
 * 单独 `||` 仍是终止线（不回跳）；只有它与 `|:` 合并成 `:|:` 时才进入反复结构。
 */
import type { BarlineMark, BarlineToken, BarlineType } from '../types'

/** 一条 barline 的语义位（只在合并时用） */
interface BarlineSemantics {
  /** 反复开始 */
  rs: boolean
  /** 反复结束（`||` / `||/` 也算结束） */
  re: boolean
  /** 双线开始（`||:`），用于保留 `||:` 这个字形 */
  startDouble: boolean
  /** 实心双线（`||`），结束线里优先保留 */
  endSolid: boolean
  /** 细双线（`||/`），结束线里次选 */
  endThin: boolean
  /** 隐藏（`|/` / `|*`） */
  hidden: boolean
  /** 隐藏但占位（`|*`） */
  space: boolean
}

function semanticsOf(type: BarlineType): BarlineSemantics {
  const rs = type === '|:' || type === '||:' || type === ':|:'
  const re = type === ':|' || type === ':|:' || type === '||' || type === '||/'
  return {
    rs,
    re,
    startDouble: type === '||:',
    endSolid: type === '||',
    endThin: type === '||/',
    hidden: type === '|/' || type === '|*',
    space: type === '|*',
  }
}

/**
 * 两条 barline 合并后的类型。
 *
 * 优先级按用户给的“反复/结束/双线 > `|` > `|/`、`|*`”，再补：
 *  - 有开始有结束 → `:|:`；
 *  - 只有开始 → `||:`（任一侧本来写的是 `||:`）否则 `|:`；
 *  - 只有结束 → 有 `:|` 保 `:|`，否则有 `||` 保 `||`，否则 `||/`；
 *  - 都隐藏 → `|*` 优先，否则 `|/`；
 *  - 其余 → `|`。
 */
export function joinBarlineTypes(a: BarlineType, b: BarlineType): BarlineType {
  const x = semanticsOf(a)
  const y = semanticsOf(b)
  const rs = x.rs || y.rs
  const re = x.re || y.re
  if (rs && re) return ':|:'
  if (rs) return x.startDouble || y.startDouble ? '||:' : '|:'
  if (re) {
    if (a === ':|' || b === ':|') return ':|'
    if (x.endSolid || y.endSolid) return '||'
    if (x.endThin || y.endThin) return '||/'
    return '|'
  }
  if (x.hidden && y.hidden) return x.space || y.space ? '|*' : '|/'
  return '|'
}

/** `comment` 里是否写了临时拍号 `p:2/4`（用于合并冲突告警） */
function meterOf(comment: string | undefined): string | null {
  if (!comment) return null
  const m = /p\s*:\s*(\d+)\s*\/\s*(\d+)/i.exec(comment)
  return m ? `${m[1]}/${m[2]}` : null
}

function joinComments(a: string | undefined, b: string | undefined): string | undefined {
  const out: string[] = []
  // 行首/右侧那条先写，阅读顺序与用户源码一致
  for (const c of [b, a]) {
    const t = c?.trim()
    if (!t) continue
    if (!out.includes(t)) out.push(t)
  }
  return out.length === 0 ? undefined : out.join(' ')
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 把 `b`（后一条/行首那条）并进 `a`（前一条/上一行末那条）。
 *
 * @returns 合并后的 token（`pos` 取 `a`，`raw` 取两条拼接以保留 `[`/`]` 顺序）与告警文本
 */
export function joinBarlineTokens(
  a: Extract<BarlineToken, { kind: 'barline' }>,
  b: Extract<BarlineToken, { kind: 'barline' }>,
): { token: Extract<BarlineToken, { kind: 'barline' }>; warnings: string[] } {
  const warnings: string[] = []
  let type = joinBarlineTypes(a.type, b.type)

  // 转调：以后一条（行首侧）为准；两条都有且不同要告警
  let keyChange = b.keyChange ?? a.keyChange
  if (a.keyChange && b.keyChange && !sameJson(a.keyChange, b.keyChange)) {
    warnings.push('两条小节线上写了不同的转调（`d:`），已保留后一条')
  }

  // 跳房子起点：后一条优先；都有且注释不同要告警
  const voltaStart = b.voltaStart ?? a.voltaStart
  if (a.voltaStart && b.voltaStart) {
    const ca = a.voltaStart.comment ?? ''
    const cb = b.voltaStart.comment ?? ''
    if (ca !== cb) warnings.push('两条小节线各带一个跳房子起点，已保留后一条')
  }

  const comment = joinComments(a.comment, b.comment)
  const ma = meterOf(a.comment)
  const mb = meterOf(b.comment)
  if (ma && mb && ma !== mb) warnings.push(`两条小节线写了不同的临时拍号（${ma} / ${mb}），已保留后一条的备注`)

  const marks: BarlineMark[] = []
  for (const m of [...(a.marks ?? []), ...(b.marks ?? [])]) {
    if (!marks.includes(m)) marks.push(m)
  }

  /**
   * 隐藏线承载了要“看得见”的东西（修饰符/转调/临时拍号）时升级为 `|`：
   * `|/` 零占位，记号会叠在音符上；`|*` 虽然占位，但转调/拍号分数需要线的落点。
   * 这条只影响**显式写了属性的隐藏线**，普通隐藏线仍是隐藏。
   */
  if (type === '|/' || type === '|*') {
    if (marks.length > 0 || keyChange || comment) type = '|'
  }

  const token: Extract<BarlineToken, { kind: 'barline' }> = {
    kind: 'barline',
    type,
    pos: a.pos,
    // 播放端只从 raw 里取 `[`/`]` 的先后顺序；拼接保留两条线的顺序
    raw: `${a.raw}${b.raw}`,
  }
  if (marks.length > 0) token.marks = marks
  if (voltaStart) token.voltaStart = voltaStart
  if (a.voltaEnd || b.voltaEnd) token.voltaEnd = true
  if (a.voltaEndSlash || b.voltaEndSlash) token.voltaEndSlash = true
  // 只有两侧都是纯 `[` 才保留 voltaOnly；和真实小节线合并后它就不是“纯注释”了
  if (a.voltaOnly && b.voltaOnly) token.voltaOnly = true
  if (keyChange) token.keyChange = keyChange
  if (comment) token.comment = comment
  return { token, warnings }
}
