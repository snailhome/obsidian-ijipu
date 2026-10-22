/**
 * engine/dynamic/frame.ts — `frameAt(t)`：给一个时刻，算出这一帧画什么
 *
 * 这是整条视频链路唯一的"时间 → 画面"入口：预览用它、出片用它、将来 H5 也用它。
 * 三条硬约束（违反任何一条都会让导出的视频不可复现）：
 *
 *  1. **纯函数**：不读时钟、不读 DOM、不用随机数。同一个 t 必须给出同一帧。
 *  2. **不依赖上一帧**：滚动量由 `t` 直接算出，不是"上一帧 + 增量"。
 *  3. **半开区间**：`[t0, t1)`，相邻两拍边界只命中后一拍。
 *
 * 帧率换算也放这里（`frameTimeMs` / `frameIndexAt`），因为"第 n 帧对应第几毫秒"必须只有一处定义——
 * 出片端按 `n` 数帧、预览端按 `t` 播放，两边用同一个公式才不会越走越偏。
 */
import type { FlowView, Frame, FrameRect, RectTrack } from './types'

/** 第 n 帧的时间（ms）。用 `n*1000/fps` 而不是累加 `1000/fps`，避免浮点误差越滚越大 */
export function frameTimeMs(n: number, fps: number): number {
  return (n * 1000) / fps
}

/** 某个时刻落在第几帧（向下取整；`+1e-9` 吸收 `frameTimeMs` 的浮点尾差） */
export function frameIndexAt(tMs: number, fps: number): number {
  return Math.floor((tMs * fps) / 1000 + 1e-9)
}

/** 最后一个 `t0 ≤ t` 的下标（没有则 -1） */
function lastStartedIndex(track: RectTrack, tMs: number): number {
  const { rects } = track
  let lo = 0
  let hi = rects.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rects[mid].t0 <= tMs) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** 覆盖 `tMs` 的矩形下标（半开区间；按 t0 升序） */
function activeIndices(track: RectTrack, tMs: number): number[] {
  const { rects, maxSpanMs } = track
  const out: number[] = []
  for (let i = lastStartedIndex(track, tMs); i >= 0; i--) {
    if (rects[i].t0 + maxSpanMs < tMs) break
    if (tMs < rects[i].t1) out.push(i)
  }
  out.reverse()
  return out
}

/**
 * 行在视口里居中时的滚动量。
 *
 * **允许为负**：条带比视口短时（短曲子就一两行），把整条带在视口里居中，
 * 而不是贴着顶端、下半屏全白。`scrollY = 行顶 − 这个值` 照常成立。
 */
export function scrollYOfRow(view: FlowView, rowIndex: number): number {
  const row = view.rows[rowIndex]
  if (!row) return 0
  const bandH = row.srcBottom - row.srcTop
  if (view.stripHeight <= view.viewH) return -(view.viewH - view.stripHeight) / 2
  const maxScroll = view.stripHeight - view.viewH
  const want = row.stripY + bandH / 2 - view.viewH / 2
  return Math.max(0, Math.min(want, maxScroll))
}

/**
 * 出帧。
 *
 * - 有正在发声的矩形 ⇒ 以**最后开始的那一条**所在行为准（同拍多声部时就是同一行）；
 * - 处在空隙（休止/反复跳转的瞬间）⇒ 以**最近一条已开始**的为准，画面停在原行，
 *   不会在休止处突然跳走；
 * - 高亮块按各自所在行平移成条带坐标；不同行同时发声时各归各的行，不会互相错位。
 */
export function frameAt(view: FlowView, track: RectTrack, tMs: number): Frame {
  if (view.rows.length === 0 || track.rects.length === 0) {
    return { t: tMs, row: 0, scrollY: 0, rects: [] }
  }
  const active = activeIndices(track, tMs)
  const anchor = active.length > 0 ? active[active.length - 1] : lastStartedIndex(track, tMs)
  const rowIdx = anchor >= 0 && view.rectRow[anchor] >= 0 ? view.rectRow[anchor] : 0
  const scrollY = scrollYOfRow(view, rowIdx)

  const rects: FrameRect[] = []
  for (const i of active) {
    const r = track.rects[i]
    const ri = view.rectRow[i]
    const row = view.rows[ri]
    if (!row) continue
    rects.push({
      x: r.x,
      y: row.stripY + (r.y - row.srcTop),
      w: r.w,
      h: r.h,
      voice: r.voice,
      group: r.group,
      ...(r.instrument !== undefined ? { instrument: r.instrument } : {}),
      ...(r.playVoice !== undefined ? { playVoice: r.playVoice } : {}),
    })
  }
  return { t: tMs, row: rowIdx, scrollY, rects }
}
