/**
 * engine/layout/measureMap.ts — 「全局小节号 + 拍位」的**唯一口径**（纯函数）
 *
 * 布局给的 `PlacedToken.barIndex` 是**曲行内**编号（每行从 0 起），而用户说的是"整份谱的第 27 小节"
 * ⇒ 必须先按曲行累加出全局小节号。这套换算原来写在 CLI 里（`packages/ijipu-cli/src/cli.ts`），
 * 现在搬到引擎：**界面（标记段下拉显示 `段1 [ 33:1 - 34:2 ]`）与命令行（`--from 33:1`）必须同一口径**，
 * 否则两边数出来的"第 33 小节"会差一位（AGENTS §五·9 的"数值口径必须同源"）。
 *
 * 只取**主旋律、可发声**的音符：段层（`{bz}`/`{dsb}`/`{tp}`）与休止符不算"某一拍的那个音"，
 * 否则同一拍会命中好几个 id。
 */
import type { ScoreLayout } from '../types'
// adj1101：id 字符串走中立模块（`layout → playback` 是反向依赖，不能用）
import { noteIdStringOf } from '../ids'

/** 拍位比较的容差（浮点拍位：3.5 拍这种） */
export const BEAT_EPS = 1e-6

export type ScoreSpotNote = {
  id: string
  /** 全局小节号（1 起） */
  bar: number
  /** 小节内累积拍（0 起，与引擎 `PlacedToken.beatPos` 同口径） */
  beatPos: number
  y: number
}

/**
 * 把谱面摊平成"全局小节号 + 拍位"的音符表。
 *
 * @param opts.includeRests 连带**休止符**一起收（标记段的端点可能点在休止符上；展示用需要它，
 *   `--from/--to` 换算**不能**收——见 `resolveBarBeatRange` 里"只取可发声音符"的口径）
 */
export function flattenScoreNotes(
  layout: ScoreLayout,
  opts: { includeRests?: boolean } = {},
): ScoreSpotNote[] {
  /** 参与"行内几小节"统计的只有**可发声的主旋律音**（与 `--from/--to` 同一口径，含休止符会推移行偏移） */
  const isMain = (n: { segment?: unknown }): boolean => n.segment === undefined
  const barsByRow = new Map<string, number>()
  for (const page of layout.pages) {
    for (const n of page.notes) {
      if (!isMain(n) || !n.playable) continue
      const key = `${page.index}:${n.id.group}`
      const need = n.barIndex + 1
      if (need > (barsByRow.get(key) ?? 0)) barsByRow.set(key, need)
    }
  }

  // 行序按**数字**排（字符串排序会把 "0:10" 排到 "0:2" 前面）
  const offset = new Map<string, number>()
  let totalBars = 0
  const rowKeys = Array.from(barsByRow.keys()).sort((a, b) => {
    const [pa, ga] = a.split(':').map(Number)
    const [pb, gb] = b.split(':').map(Number)
    return pa !== pb ? pa - pb : ga - gb
  })
  for (const key of rowKeys) {
    offset.set(key, totalBars)
    totalBars += barsByRow.get(key) ?? 0
  }

  const out: ScoreSpotNote[] = []
  for (const page of layout.pages) {
    for (const n of page.notes) {
      // 主旋律音；`includeRests` 时连休止符一起收（标记段端点可能点在休止符上，展示用）
      if (!isMain(n) || (!n.playable && opts.includeRests !== true)) continue
      const key = `${page.index}:${n.id.group}`
      const base = offset.get(key)
      // 找不到行偏移（极少数畸形版面）：跳过而不是算成第 1 小节 —— 错位比缺失更难查
      if (base === undefined) continue
      out.push({ id: noteIdStringOf(n.id), bar: base + n.barIndex + 1, beatPos: n.beatPos, y: n.y })
    }
  }
  /**
   * 模块级"总小节数"的副产物已去掉（引擎不存状态）：需要总数的调用方自己从结果里取
   * `Math.max(...notes.map((n) => n.bar))`；`resolveBarBeatRange` 内部就地算。
   */
  return out.sort((a, b) =>
    a.bar !== b.bar ? a.bar - b.bar : Math.abs(a.beatPos - b.beatPos) > BEAT_EPS ? a.beatPos - b.beatPos : a.y - b.y,
  )
}

/** `flattenScoreNotes` 结果里的总小节数 */
export function totalBarsOf(notes: readonly ScoreSpotNote[]): number {
  return notes.reduce((mx, n) => Math.max(mx, n.bar), 0)
}

/**
 * 这个音符 id 在当前排版里**存在吗**（含段层音符）。
 *
 * 用途（adj1102）：标记段的终点是"点音符"记下来的 ⇒ 只要它在排版里存在、却在播放序列里没有事件，
 * 就说明**被连音线/同音合并并进了前一个音**（不是"标记失效"）。调用方据此告诉
 * `resolvePracticeRange`：按"紧邻的前一个音"去配，**不要**退到"夹到序列末尾"（那会配出跨好几遍的怪区间）。
 */
export function hasNoteId(layout: ScoreLayout, id: string): boolean {
  for (const page of layout.pages) {
    for (const n of page.notes) {
      if (noteIdStringOf(n.id) === id) return true
    }
  }
  return false
}

/** 音符 id 的尾巴（`_组号_序号`）——预览与播放排版不同时页号/声部号可能变 */
function tailOfId(id: string): string {
  const m = /^(\d+)_(\d+)_(\d+)_(\d+)$/.exec(id)
  return m ? `_${m[3]}_${m[4]}` : id
}

/**
 * 音符 id → 全局小节号 + 拍位（标记段下拉显示用；找不到给 `null`）。
 *
 * 先精确匹配，再退到"组号 + 序号"（与 `resolvePracticeRange` 的宽松匹配同一口径）——
 * 标记是**预览**排版时记下的，而这里可能用**播放**排版来查。
 */
export function measureSpotOf(
  layout: ScoreLayout,
  id: string,
  opts: { includeRests?: boolean } = {},
): ScoreSpotNote | null {
  return spotOfIn(flattenScoreNotes(layout, opts), id)
}

/**
 * 同上，但音符表由调用方给（一次摊平、多次查——界面上有 N 个标记时不必摊平 2N 次）。
 */
export function spotOfIn(notes: readonly ScoreSpotNote[], id: string): ScoreSpotNote | null {
  const exact = notes.find((n) => n.id === id)
  if (exact !== undefined) return exact
  const tail = tailOfId(id)
  return notes.find((n) => n.id.endsWith(tail)) ?? null
}

export type BarBeatRange = {
  startId: string
  endId: string
  /** 给用户看的定位说明（"第 27 小节第 3 拍 → …"），出错时也用它 */
  startLabel: string
  endLabel: string
  totalBars: number
}

/**
 * 把用户写的两个拍位换算成**音符 id**（`render -t mp4` 的段落）。
 *
 * 口径（逐条都是刻意选的）：
 *  · 起点：该小节**第一个不早于**这一拍的音符（拍位落在音符中间 ⇒ 取这个音符，符合"从这拍开始"）；
 *  · 终点：这一拍那个音符的**前一个**音符 —— 用户说"到 50:1"，意思是**到第 50 小节第 1 拍为止**，
 *    不该把第 50 小节的第一个音也带进来；这样 `--from 27:3 --to 50:1` 正好是"第 27 小节第 3 拍
 *    到第 49 小节末尾"；
 *  · 两个位置都按**乐谱顺序**（不做反复展开）：反复遍次由 `--pass` 在放映时挑（与界面标记段同一套）。
 *
 * @returns 成功给 id 与说明；失败给 `error`（原文可直接打到终端）
 */
export function resolveBarBeatRange(
  layout: ScoreLayout,
  from: { bar: number; beat: number },
  to: { bar: number; beat: number },
): BarBeatRange | { error: string } {
  const notes = flattenScoreNotes(layout)
  const totalBars = totalBarsOf(notes)

  /**
   * 找一个位置的**下标**。
   * 找不到时把"这一小节实际有哪些拍"说出来 —— 只报"没有第 9 拍"用户仍不知道该怎么改。
   */
  const locate = (
    spot: { bar: number; beat: number },
    which: string,
  ): { index: number; note: ScoreSpotNote } | { error: string } => {
    if (spot.bar > totalBars) {
      return { error: `${which}：谱面只有 ${totalBars} 个小节，没有第 ${spot.bar} 小节` }
    }
    const inBar = notes.filter((n) => n.bar === spot.bar)
    if (inBar.length === 0) {
      return { error: `${which}：第 ${spot.bar} 小节没有可发声的音符（只有休止符？）` }
    }
    const target = spot.beat - 1
    const idx = notes.findIndex((n) => n.bar === spot.bar && n.beatPos >= target - BEAT_EPS)
    if (idx < 0) {
      const last = inBar[inBar.length - 1].beatPos + BEAT_EPS
      const span = Number.isInteger(last) ? String(last) : last.toFixed(2)
      return { error: `${which}：第 ${spot.bar} 小节最后停在 ${span} 拍，没有第 ${spot.beat} 拍` }
    }
    return { index: idx, note: notes[idx] }
  }

  const a = locate(from, '--from')
  if ('error' in a) return a
  const b = locate(to, '--to')
  if ('error' in b) return b
  if (b.index <= a.index) {
    return { error: `--to 必须在 --from 之后（现在两者落在同一个音上：${a.note.id}）` }
  }

  /**
   * 终点取"目标音符的前一个"。
   *
   * 如果目标就是全谱第一个音，说明这一段是空的：如实报错，而不是悄悄导出一整曲。
   */
  const endIdx = b.index - 1
  if (endIdx < a.index) {
    return { error: '结束位置之前没有音符：这一段是空的（--to 请往后写一点）' }
  }
  return {
    startId: a.note.id,
    endId: notes[endIdx].id,
    startLabel: `第 ${from.bar} 小节第 ${from.beat} 拍`,
    endLabel: `第 ${to.bar} 小节第 ${to.beat} 拍之前`,
    totalBars,
  }
}
