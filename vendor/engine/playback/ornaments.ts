/**
 * engine/playback/ornaments.ts — **演奏型装饰音**的时值（波音 adj502 / 打音·叠音 adj635）
 *
 * 两大族共用一套骨架：**若干短音 + 收尾按住的主音**，且都满足"总时值守恒、主音保留一半以上"。
 * 区别只在**短音序列**与**短音有多短**。
 *
 * ## 一、波音（mordent，adj502，用户规范）
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
 * ## 不变式（`mordentPlan` / `portPlan` 的契约，smoke 有断言）
 * - `shortMs × steps.length + heldMs === principalMs`（守恒：装饰短音 + 缩短的主音 = 主音原时值）
 * - `heldMs >= principalMs / 2`（主音永远保留大部分时值）
 * - `steps` 只含**短音**（收尾按住的主音不在其中）
 *
 * ## 音高
 * 邻音取**调内二度**（随调号走），**不继承主音的临时变音**（`#4&sby` 的上邻音是 `5` 而非 `#5`）；
 * `7` 的上邻音上翻八度（`1'`）、`1` 的下邻音下翻八度（`7,`）。要半音邻音就直接把实际音写出来
 * （对应用户说的"现代记谱"——写出来就按谱面精确演奏）。
 *
 * ## 二、打音 / 叠音（竹笛、葫芦丝的传统装饰音，adj635，用户说明）
 * 见 `PortKind` 上方那段注释（用户对两种技法的原话说明）。
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

// ============================================================
// adj635：竹笛 / 葫芦丝的传统装饰音——打音 `&da` / 叠音 `&die`
// ============================================================

/**
 * adj635（用户说明，原话见下）：
 *
 * · **叠音 `&die`**——"在吹出一个主音之前，先快速吹奏一个**上方相邻的音**（通常是二度音），
 *   并迅速滑到主音上，类似一个极快的上倚音""听起来像是从上面'压'下来"；
 *   "如果要吹 1 的叠音，实际效果近似于极快地吹出 2 → 1" ⇒ 步骤 **`U → P`**。
 * · **打音 `&da`**——"在主音发出后，用手指在本音下方的音孔上快速、有力地'打'一下，形成一个
 *   **极短的下方二度音**""干净利落，不带滑音""常用来把两个相同的音断开，做到'音断意连'"；
 *   "如果要吹 1 的打音，实际效果近似于 1 → 7 → 1，其中 7 非常短促" ⇒ 步骤 **`P → L → P`**。
 *
 * 口径（与波音同一套骨架，只把"辅助音有多短"调小）：
 * 1. **辅助音 = `clamp(P/16, 30, 70)ms`**——用户明确"辅助音占的时值极小，否则听起来就会显得拖沓、
 *    变成普通的倚音了"，故取波音短音（`P/8`、45–110ms）的**一半量级**；
 * 2. **最多占 `P/2`**（同一不变式：主音保留一半以上，重音与"音断意连"的落点都在主音上）；
 * 3. **总时值守恒**：`shortMs × steps.length + heldMs === P`，且**只从本音符自己的时值里匀**——
 *    叠音的上邻音占本音符**开头**、主音顺延（同 adj623 的前倚音口径，不向前一个音符借）。
 *
 * 叠音的邻音方向是"上"（`U`）、打音是"下"（`L`），与波音一样取**调内二度**、
 * 不继承主音的临时变音（`7` 上翻八度、`1` 下翻八度）。
 */
export type PortKind = 'da' | 'die'

/** 打音 / 叠音编码全集（供文档/输入条/断言对齐） */
export const PORT_SYMBOLS: readonly PortKind[] = ['da', 'die']

/** 辅助音时值相对主音符的比例（P/16 ⇒ 约为波音短音的一半，"极小"） */
export const ORNAMENT_PORT_RATIO = 1 / 16
/** 辅助音的绝对下限（ms；再短就听不出"打"的那一下了） */
export const ORNAMENT_PORT_MIN_MS = 30
/** 辅助音的绝对上限（ms；长音符上不让辅助音变"拖"，占比自然更小） */
export const ORNAMENT_PORT_MAX_MS = 70

/** 单个辅助音的时值（ms）：`clamp(P/16, 30, 70)` */
export function portShortMs(principalMs: number): number {
  return Math.min(ORNAMENT_PORT_MAX_MS, Math.max(ORNAMENT_PORT_MIN_MS, principalMs * ORNAMENT_PORT_RATIO))
}

/** 从音符的 `symbols` 里取出打音/叠音类型（`&da` 与 `&die` 同写时按 `&da` 处理——与 `MORDENT_SYMBOLS` 同序优先） */
export function portOf(symbols: readonly string[] | undefined): PortKind | null {
  if (!symbols || symbols.length === 0) return null
  for (const s of PORT_SYMBOLS) {
    if (symbols.includes(s)) return s
  }
  return null
}

/**
 * 求打音 / 叠音的演奏计划（契约与 `mordentPlan` 完全相同：守恒、主音保留 ≥ P/2、`steps` 只含短音）。
 * @param principalMs 主音符**发声时值**（前倚音扣完后的剩余；无倚音即谱面时值）
 * @param kind 打音 `da` / 叠音 `die`
 */
export function portPlan(principalMs: number, kind: PortKind): MordentPlan {
  if (!(principalMs > 0)) return { steps: [], shortMs: 0, heldMs: Math.max(0, principalMs) }
  // 叠音：上方邻音起奏（U → P）；打音：主音极短起奏 → 下方邻音 → 主音按住（P → L → P）
  let steps: OrnamentStep[] = kind === 'die' ? ['U'] : ['P', 'L']
  let shortMs = portShortMs(principalMs)
  const maxBudget = principalMs / 2
  if (shortMs * steps.length > maxBudget) {
    // 塞不下就按比例压缩（允许低于下限——"塞得进去"优先，同波音的兜底）
    shortMs = maxBudget / steps.length
    if (shortMs <= 0) {
      steps = []
      shortMs = 0
    }
  }
  const heldMs = principalMs - shortMs * steps.length
  return { steps, shortMs, heldMs }
}

// ============================================================
// 统一入口：**演奏型装饰**（波音 + 打音/叠音）
// ============================================================

/** 演奏型装饰的编码全集（波音 + 打音/叠音） */
export type OrnamentKind = MordentKind | PortKind

/** 编排上的优先级（同时写多个时取靠前的这一个；`ornamentOf` 的契约） */
export const ORNAMENT_SYMBOLS: readonly OrnamentKind[] = [...MORDENT_SYMBOLS, ...PORT_SYMBOLS]

/**
 * 从音符的 `symbols` 里取出**演奏型装饰**的类型；没有返回 null。
 *
 * 优先级（用户没说的情形，这里定死并写进文档）：**波音 > 打音 > 叠音**——
 * 它们都要求"重新起奏 + 极短辅助音"，同时写没有可叠加的音乐含义；
 * 让波音优先可保证既有谱面（`&sby`）的行为不因新增打音/叠音而改变。
 */
export function ornamentOf(symbols: readonly string[] | undefined): OrnamentKind | null {
  return mordentOf(symbols) ?? portOf(symbols)
}

/** 求演奏型装饰的计划（波音走 `mordentPlan`、打音/叠音走 `portPlan`；契约见文件头「不变式」） */
export function ornamentPlan(principalMs: number, kind: OrnamentKind): MordentPlan {
  return kind === 'da' || kind === 'die' ? portPlan(principalMs, kind) : mordentPlan(principalMs, kind)
}
