/**
 * engine/linear/ball.ts — 定位色块上的**跳跳球**（adj1258）
 *
 * 与 `dynamic/ball.ts` 的区别：那颗球**跟着音符跑**（落点是当前色块）；
 * 这颗球的 **x 是固定**的（就在定位色块中心），只在 y 上跳 ——
 * 因为谱面在往左走，色块不动，球当然也不动。
 *
 * 一眼看得懂的行为（与现有球同一套手感，用户 2026-11-08 要求「参考现有跳跳球」）：
 *   · 每拍落地一次，落地 = 拍点 + `landOffsetBeats`（沿用 `BALL_LANDING_TIMING`，晚 1/20 拍）；
 *   · 落地后**压扁保持** `dwell`，再弹起（不是碰一下就飞）；
 *   · 弹起高度 = 色块高度 × `hopScale`（缺省 2 倍）。
 *
 * 纯函数：只吃 `t`，不读时钟 ⇒ 预览与出片必然一致。
 */
import { BALL_LANDING_TIMING, BALL_SQUASH_Y, type BallTiming } from '../dynamic/ball'

export interface StripBallOptions {
  /** 一拍的毫秒数 */
  beatMs: number
  /** 色块上沿 y（画面坐标） */
  blockTop: number
  /** 球半径（像素） */
  radius?: number
  /** 弹起高度（像素；缺省 = 半径 × 4） */
  hopPx?: number
  timing?: BallTiming
}

export interface StripBall {
  /** 球心 y（画面坐标） */
  y: number
  /** 压扁程度 0~1（1 = 刚落地那一下） */
  squash: number
  /** 是否在"落地保持"段 */
  dwelling: boolean
}

/**
 * `t` 时刻球在哪。
 *
 * 时间轴口径：第 i 次落地 = `(i + landOffsetBeats) × beatMs`（i 从 0 起）。
 * 取"最近一次已发生的落地"，据此算压扁或飞行 —— 所以整条曲线是**周期的、连续的**。
 */
export function stripBallAt(tMs: number, o: StripBallOptions): StripBall {
  const beat = Math.max(30, o.beatMs)
  const timing = o.timing ?? BALL_LANDING_TIMING
  const offsetBeats = timing.landOffsetBeats ?? 0
  const dwellMs = Math.min(timing.dwellMaxMs ?? 140, Math.max(0, timing.dwellRatio ?? 0.16) * beat)
  const r = o.radius ?? 8
  const hop = o.hopPx ?? r * 4

  /** 球停在块上的球心 y（未压扁时） */
  const restY = o.blockTop - r * (1 - BALL_SQUASH_Y * 0.5)

  const rel = tMs - offsetBeats * beat
  const idx = Math.floor(rel / beat)
  const landAt = (idx + offsetBeats) * beat
  const since = tMs - landAt

  // 曲首之前：先停在块上（不凭空从天上掉下来）
  if (since < 0) return { y: restY, squash: 0, dwelling: true }

  // 落地保持：压扁从 1 衰减到 0
  if (since < dwellMs) {
    const q = dwellMs <= 0 ? 1 : since / dwellMs
    const squash = 1 - q
    return { y: restY + BALL_SQUASH_Y * r * 0.5 * squash, squash, dwelling: true }
  }

  // 飞行：抛物线，u=0 起跳、u=1 落地
  const span = beat - dwellMs
  const u = Math.min(1, Math.max(0, (since - dwellMs) / Math.max(1, span)))
  return { y: restY - hop * 4 * u * (1 - u), squash: 0, dwelling: false }
}
