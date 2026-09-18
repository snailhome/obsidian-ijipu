/**
 * engine/playback/ornaments.ts — 波音（mordent）的演奏时值（adj502，用户规范）
 *
 * ## 口径（用户 2026-09-18 确认）
 *
 * 波音与倚音同源：**时值从主音符里"匀"出来，总时值守恒**。区别在起奏方向——
 * 波音**从主音开始**（先弹主音再波动），倚音是**先弹装饰音再进主音**。
 *
 * | 记号 | 演奏顺序 | 占用 | 每个短音 |
 * |---|---|---|---|
 * | `&sby` 单上波音 | 主 → 上邻 → 主 | ≈ P/4 | P/8 |
 * | `&xby` 单下波音 | 主 → 下邻 → 主 | ≈ P/4 | P/8 |
 * | `&sby+` 复上波音 | 主 → 上邻 → 主 → 上邻 → 主 | ≈ P/2 | P/8 |
 * | `&xby+` 复下波音 | 主 → 下邻 → 主 → 下邻 → 主 | ≈ P/2 | P/8 |
 *
 * 三条要点：
 * 1. **每个短音 = `P/8`**（不是"占 P/4"再除）——所以单波音占 P/4、复波音占 P/2（用户给的范围 1/3~1/2 的上界），
 *    而两者的**波动速度一致**（复只是多波一下），音乐上最自然；`P` 是**主音符谱面时值**（含增时线/附点）。
 * 2. **绝对夹紧 `[45ms, 110ms]`**：拍速快 → `P/8` 自动变小（"快板弹得非常紧"）；长音符/附点音上
 *    短音**不再跟着变长**，占比自然掉下来（"长音符占比可以更小"）。
 * 3. **不抢太多**：装饰部分最多占 `P/2`（保证主音至少保留一半、重音仍在主音上）。超了就
 *    ① 复波音**降级为单波音**（极短音符上双波音本来也弹不出来），② 仍超时按比例压缩（允许低于 45ms——
 *    "塞得进去"优先于"够长"）。
 *
 * ## 不变式（`mordentPlan` 的契约，smoke 有断言）
 * - `shortMs × steps.length + heldMs === principalMs`（守恒：波音 + 缩短的主音 = 主音原时值）
 * - `heldMs >= principalMs / 2`（主音永远保留大部分时值）
 * - `steps` 只含**短音**（收尾按住的主音不在其中）
 *
 * ## 音高
 * 邻音取**调内二度**（随调号走），**不继承主音的临时变音**（`#4&sby` 的上邻音是 `5` 而非 `#5`）；
 * `7` 的上邻音上翻八度（`1'`）、`1` 的下邻音下翻八度（`7,`）。要半音邻音就直接把实际音写出来
 * （对应用户说的"现代记谱"——写出来就按谱面精确演奏）。
 */

/** 波音类型（`+` = 复波音） */
export type MordentKind = 'sby' | 'xby' | 'sby+' | 'xby+'

/** 波音短音的音级来源：`P` 主音 / `U` 上邻音 / `L` 下邻音 */
export type OrnamentStep = 'P' | 'U' | 'L'

/** 波音编码全集（供文档/输入条/断言对齐） */
export const MORDENT_SYMBOLS: readonly MordentKind[] = ['sby', 'xby', 'sby+', 'xby+']

/** 短音时值的绝对下限（再快就不是"音"了，也给采样起音留时间） */
export const ORNAMENT_SHORT_MIN_MS = 45
/** 短音时值的绝对上限（长音符上不让波音变"慢"——占比自然更小） */
export const ORNAMENT_SHORT_MAX_MS = 110
/** 短音时值相对主音符的比例（P/8 ⇒ 单波音占 P/4、复波音占 P/2） */
export const ORNAMENT_SHORT_RATIO = 1 / 8

/** 从音符的 `symbols` 里取出波音类型；同时写了 `&sby` 与 `&sby+` 时按**复波音**处理。 */
export function mordentOf(symbols: readonly string[] | undefined): MordentKind | null {
  if (!symbols || symbols.length === 0) return null
  for (const s of MORDENT_SYMBOLS) {
    if (s.endsWith('+') && symbols.includes(s)) return s
  }
  for (const s of MORDENT_SYMBOLS) {
    if (!s.endsWith('+') && symbols.includes(s)) return s
  }
  return null
}

/** 单个短音的时值（ms）：`clamp(P/8, 45, 110)` */
export function mordentShortMs(principalMs: number): number {
  return Math.min(ORNAMENT_SHORT_MAX_MS, Math.max(ORNAMENT_SHORT_MIN_MS, principalMs * ORNAMENT_SHORT_RATIO))
}

/** 音级 1-7（与音符 token 的 `pitch` 同域，供 `pitchToName` 直接消费） */
export type PitchDegree = 1 | 2 | 3 | 4 | 5 | 6 | 7

/**
 * 邻音音级（调内二度 + 八度回卷）：
 * 上波音取上一级、下波音取下一级；`7` 上翻八度、`1` 下翻八度。
 * @returns `octave` = 需要叠加到主音符 `octaveShift` 上的偏移（-1 / 0 / +1）
 */
export function neighborDegree(pitch: number, up: boolean): { pitch: PitchDegree; octave: number } {
  if (up) return pitch >= 7 ? { pitch: 1, octave: 1 } : { pitch: (pitch + 1) as PitchDegree, octave: 0 }
  return pitch <= 1 ? { pitch: 7, octave: -1 } : { pitch: (pitch - 1) as PitchDegree, octave: 0 }
}

/** 波音计划：短音序列 + 每个短音时长 + 收尾按住的主音时长 */
export interface MordentPlan {
  steps: OrnamentStep[]
  shortMs: number
  heldMs: number
}

/**
 * 求波音的演奏计划。契约见文件头「不变式」。
 * @param principalMs 主音符**发声时值**（前倚音扣完后的剩余；无倚音即谱面时值）
 * @param kind 波音类型
 */
export function mordentPlan(principalMs: number, kind: MordentKind): MordentPlan {
  if (!(principalMs > 0)) return { steps: [], shortMs: 0, heldMs: Math.max(0, principalMs) }
  const up = kind === 'sby' || kind === 'sby+'
  const isDouble = kind.endsWith('+')
  const dir: OrnamentStep = up ? 'U' : 'L'
  let steps: OrnamentStep[] = isDouble ? ['P', dir, 'P', dir] : ['P', dir]
  let shortMs = mordentShortMs(principalMs)
  const maxBudget = principalMs / 2
  if (shortMs * steps.length > maxBudget) {
    // ① 复波音降级为单波音（极短音符上双波音弹不出来）
    if (steps.length === 4 && shortMs * 2 <= maxBudget) {
      steps = ['P', dir]
    } else {
      // ② 仍放不下 → 按比例压缩（允许低于下限："塞得进去"优先）
      shortMs = maxBudget / steps.length
    }
  }
  const heldMs = principalMs - shortMs * steps.length
  return { steps, shortMs, heldMs }
}
