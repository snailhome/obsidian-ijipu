/**
 * engine/linear/xmap.ts — 单行谱的「时刻 → 横坐标」（adj1258）
 *
 * 条带是**分段线性**的：每个 `StripRun` 内部 x 与时间成比例，段与段之间首尾相接。
 * 所以查一个时刻的位置 = 二分找到所在段 + 段内线性插值。
 *
 * 为什么要单独一层：滚动位置（定位色块要对准当前音）、相机/预览、断言都读它；
 * 只允许这一个口径，不许渲染端自己再按 `t × 像素` 现算（那样密集小节就会偏）。
 */
import type { LinearStrip } from './types'

/** 落在哪一段（-1 = 在所有段之外） */
export function stripRunAt(strip: LinearStrip, tMs: number): number {
  const runs = strip.runs
  if (runs.length === 0) return -1
  if (tMs < runs[0].t0) return -1
  let lo = 0
  let hi = runs.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (runs[mid].t0 <= tMs) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * `t` 时刻谱面走到哪（条带坐标 x）。
 *
 * ## 口径（`adj1285`，用户 2026-11-09 晚复核后定稿）
 *
 * > 「合成音演奏到哪个音符，谱子应相应的音符移到定位色块处，这个音形要对齐」
 *
 * 所以按**音**落位：`strip.onsets[k]` 是第 k 个发声起点（和弦算一个）的时刻与谱面位置；
 * 两个相邻起点之间**匀速**走过去 ⇒ **每个音在它开始发声的那一刻正好压在定位色块上**。
 *
 * ## 走过的三次错（都记在方案 §6.15，别再回退）
 *
 * · `adj1282` 按"音符"插值，但跨度用**本音时值**、且 `strip.ts` 把不足一拍的时值钳成 1 拍
 *   ⇒ 八分慢 2 倍、十六分慢 **4 倍**（用户「合成音走了 8 拍、谱子才走 2 拍」）；
 * · `adj1284` 改成"按拍匀速"，16 分音符段里第 2/3/4 个音会被**匀速滑过去**，
 *   用户仍看到"音形没对齐"；
 * · 现在：起点表（`onsets`）由 `strip.ts` 一次建好，插值区间 = 相邻起点，时值不再参与。
 */
export function stripXAt(strip: LinearStrip, tMs: number): number {
  const on = strip.onsets
  if (on.length === 0) {
    // 兜底（历史数据/空条带）：仍按段内 x ∝ t，绝不返回 NaN
    const runs = strip.runs
    if (runs.length === 0) return 0
    if (tMs <= runs[0].t0) return runs[0].x0
    const last = runs[runs.length - 1]
    if (tMs >= last.t1) return last.x1
    const r = runs[Math.max(0, stripRunAt(strip, tMs))]
    const span = r.t1 - r.t0
    if (span <= 0) return r.x0
    const f = Math.min(1, Math.max(0, (tMs - r.t0) / span))
    return r.x0 + (r.x1 - r.x0) * f
  }
  if (tMs <= on[0].t) return on[0].x
  const lastIdx = on.length - 1
  if (tMs >= on[lastIdx].t) return on[lastIdx].x
  // 二分：最后一个 t <= tMs 的起点
  let lo = 0
  let hi = lastIdx
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (on[mid].t <= tMs) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const span = Math.max(1, on[ans + 1].t - on[ans].t)
  const f = Math.min(1, Math.max(0, (tMs - on[ans].t) / span))
  return on[ans].x + (on[ans + 1].x - on[ans].x) * f
}

/** 条带总时长（= 最后一段的结束时刻） */
export function stripEndMs(strip: LinearStrip): number {
  const runs = strip.runs
  return runs.length === 0 ? 0 : runs[runs.length - 1].t1
}
