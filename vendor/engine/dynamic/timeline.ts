/**
 * engine/dynamic/timeline.ts — 动态谱「时间轴」：把播放序列拍段收成可查询的矩形轨道
 *
 * 一句话：**`PlaySequence` → `RectTrack`**。之后 `rectsActiveAt(track, t)` 就能回答
 * "这一刻页面上哪几块在亮"。
 *
 * ## 时间口径（与试听逐值一致，改这里就要同步改 `PlaybackDialog`）
 *
 * ```ts
 * const beatMs = 60000 / bpm
 * t0 = e.atMs + seg.beat * beatMs   // seg.beat = 段起点相对事件起点的拍偏移
 * t1 = t0 + seg.beats * beatMs      // 每段 ≤ 1 拍（引擎保证）
 * ```
 *
 * 为什么不用 `e.durationMs` 一把梭：一拍可能被拆成多段（连音合并、跨声部），
 * 每段有自己的 `beat/beats`；用事件时长会让段与段重叠、色块乱跳（`adj299/300` 修的就是这个）。
 *
 * ## 为什么是"扁平矩形"而不是"每拍一个镜头"
 *
 * 同一拍可能同时响多个声部（`{bz}` 伴奏 / `{dsb}` 第二声部）。扁平存储 = 一个声部一条，
 * 查询时一次取回，不会出现"合并时把某个声部吃掉"的情况。代价是查询要按 `t0` 排序 + 回溯，
 * 已在 `buildRectTrack` 里预计算 `maxSpanMs` 兜住。
 */
import type { PlaySequence } from '../playback/sequence'
import type { RectTrack, TimedRect } from './types'

/**
 * 默认矩形上沿 = 音符基线 − 1.6×字号、下沿 = 基线 + 0.6×字号。
 * 与 `playback/playhead.ts` 的默认口径一致（引擎给出 `yTopMin/yBottomMax` 时以它为准）。
 */
export const RECT_ABOVE_RATIO = 1.6
export const RECT_BELOW_RATIO = 0.6

/** 建轨参数 */
export interface RectTrackOptions {
  /** 音符字号（决定默认矩形的上下沿；缺省 18，与预览默认一致） */
  noteSize?: number
}

/**
 * 稳定比较：`t0` → 页 → y → x → 声部。
 * 为什么要排到这么细：视频要求"同一时刻多次渲染结果一致"，排序里留相等键会让顺序随引擎实现漂移。
 */
function compareRects(a: TimedRect, b: TimedRect): number {
  return (
    a.t0 - b.t0 ||
    a.pageIndex - b.pageIndex ||
    a.y - b.y ||
    a.x - b.x ||
    a.voice - b.voice ||
    a.group - b.group
  )
}

/**
 * `PlaySequence` → `RectTrack`。
 *
 * 只收**带 `playheadSegs` 的事件**：没有拍段的事件（如纯休止、纯时值记号）在谱面上没有可亮的块，
 * 硬造一个会亮到空白处。零/负时长的段也丢弃（除零、异常数据兜底），否则会被"当前时刻"命中。
 */
export function buildRectTrack(seq: PlaySequence, opts: RectTrackOptions = {}): RectTrack {
  const nSize = opts.noteSize ?? 18
  const bpm = seq.bpm > 0 ? seq.bpm : 60
  const beatMs = 60000 / bpm
  const rects: TimedRect[] = []
  let segCount = 0

  for (const e of seq.events) {
    const segs = e.playheadSegs
    if (!segs || segs.length === 0) continue
    for (const s of segs) {
      segCount++
      const dur = s.beats * beatMs
      if (!(dur > 0)) continue
      const t0 = e.atMs + s.beat * beatMs
      const yTop = s.yTopMin ?? s.y - RECT_ABOVE_RATIO * nSize
      const yBottom = s.yBottomMax ?? s.y + RECT_BELOW_RATIO * nSize
      rects.push({
        t0,
        t1: t0 + dur,
        pageIndex: s.pageIndex,
        x: s.x,
        y: yTop,
        w: s.width,
        h: Math.max(1, yBottom - yTop),
        baselineY: s.y,
        voice: s.voice,
        group: s.group,
        ...(s.instrument !== undefined ? { instrument: s.instrument } : {}),
        ...(s.playVoice !== undefined ? { playVoice: s.playVoice } : {}),
        ...(s.gain !== undefined ? { gain: s.gain } : {}),
      })
    }
  }

  rects.sort(compareRects)

  let maxSpanMs = 0
  let startMs = 0
  let endMs = 0
  if (rects.length > 0) {
    startMs = rects[0].t0
    endMs = rects[0].t1
    for (const r of rects) {
      const span = r.t1 - r.t0
      if (span > maxSpanMs) maxSpanMs = span
      if (r.t0 < startMs) startMs = r.t0
      if (r.t1 > endMs) endMs = r.t1
    }
  }
  return { rects, maxSpanMs, startMs, endMs, segCount }
}

/**
 * 取 `tMs` 时刻**正在发声**的全部矩形（半开区间 `[t0, t1)`，按 `t0` 升序返回）。
 *
 * 算法：二分到"最后一个 `t0 ≤ t`"，再往回扫；某条的 `t0` 已早于 `t - maxSpanMs` 就停
 * （再往前不可能有还活着的）。返回新数组，调用方可以随便改。
 *
 * 半开区间是刻意的：相邻两拍首尾相接时，t 落在边界上只会命中后一条，不会两条同时亮。
 */
export function rectsActiveAt(track: RectTrack, tMs: number): TimedRect[] {
  const { rects, maxSpanMs } = track
  if (rects.length === 0) return []
  // 二分：第一个 t0 > tMs 的位置
  let lo = 0
  let hi = rects.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rects[mid].t0 <= tMs) lo = mid + 1
    else hi = mid
  }
  const out: TimedRect[] = []
  for (let i = lo - 1; i >= 0; i--) {
    const r = rects[i]
    if (r.t0 + maxSpanMs < tMs) break
    if (tMs < r.t1) out.push(r)
  }
  out.reverse()
  return out
}
