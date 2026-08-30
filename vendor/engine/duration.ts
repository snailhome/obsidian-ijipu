/**
 * engine/duration.ts — 时值计算
 *
 * 简谱时值规则（V1.0 手册）：
 *  基础时值 = 1 拍（一个数字）；
 *  每条增时线 "-" +1 拍；
 *  n 条减时线 "/" 时值 ÷2^n；
 *  附点 "." 每次 +50%（双附点 1.75 倍）。
 */
export interface DurationParts {
  augmentCount: number
  diminishCount: number
  dots: number
}

/** 计算拍数（平均连音组 (y...) 用 tupletDur 覆盖） */
export function tokenDuration(t: DurationParts & { tupletDur?: number }): number {
  if (t.tupletDur !== undefined) return t.tupletDur
  let d = (1 + t.augmentCount) / Math.pow(2, t.diminishCount)
  let extra = d
  for (let i = 0; i < t.dots; i++) {
    extra /= 2
    d += extra
  }
  return d
}

/** 毫秒数（给定每分钟拍数 BPM） */
export function durationMs(t: DurationParts, bpm: number): number {
  return (tokenDuration(t) * 60000) / bpm
}
