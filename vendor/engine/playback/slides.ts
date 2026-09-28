/**
 * engine/playback/slides.ts — 滑音的演奏（上滑音 `&shy` / 下滑音 `&xhy`，adj636，用户说明）
 *
 * ## 用户说明（原话要点）
 * 滑音与打音/叠音最大的不同是"**线状**"——"依靠手指在音孔上逐渐滚动或抹动，让音高平滑地过渡，
 * 中间没有断痕"；"**上滑音**是从一个较低的音，平滑地向上滑到目标音"、"**下滑音**……从一个较高的音，
 * 平滑地向下滑到目标音"；举例"从 5 上滑到 6，实际听到的是 **5 → 5# → 6** 这样一个**连续渐变**的过程，
 * 而不是直接跳到 6"、"从 6 下滑到 5，实际听到的是 **6 → 5# → 5**"。
 *
 * ## 口径（用户 adj636 确认）
 * **两种记号都当成"从上／下一个音滑进本音"**：
 *  · `&shy` 一律**从下方**滑进被标记的这个音、`&xhy` 一律**从上方**滑进它；
 *  · 起点 = 该音在滑动方向上的**调内二度**邻音（与波音/打音/叠音**同一套邻音规则**，含八度回卷；
 *    由调用方用 `neighborDegree` + `pitchToName` 求出后传进来）——于是
 *    C 调的 `6&shy` = `5 → 5# → 6`、`5&xhy` = `6 → 5# → 5`，**正好是用户举的两个例子**；
 *  · 滑音**不改变任何音符的时值**：滑行只占本音符的**开头**，到达本音音高后一直按住到本音符结束。
 *
 * ## 为什么用"半音阶梯"实现
 * 播放序列的事件模型里每个事件 = 一次 noteOn（`atMs` + `durationMs` + 音名），没有音高滑行字段，
 * 三个消费端（在线合成 / 采样器 / MIDI·WAV 导出）都按同一个模型走。用**逐半音的极短事件**
 * 逼近滑行有三个好处：① 三个消费端**都不用改**；② 导出 MIDI 就是一条**滑音（glissando）**，
 * 与听到的一致；③ 用户举的例子本身就是"5 → 5# → 6"这种半音级描述。
 * 每格时长 `clamp(P/8, 30, 60)ms` 且整段滑行**最多占 P/2**（与装饰音同一预算不变式）——
 * "逐渐、缓慢"但不拖，且保证本音自己的音高至少按住一半。
 */

/** 滑音类型：`shy` 上滑音（从下方滑进）/ `xhy` 下滑音（从上方滑进） */
export type SlideKind = 'shy' | 'xhy'

/** 滑音编码全集（供文档/输入条/断言对齐） */
export const SLIDE_SYMBOLS: readonly SlideKind[] = ['shy', 'xhy']

/** 半音格的时长相对主音符的比例（P/8） */
export const SLIDE_STEP_RATIO = 1 / 8
/** 半音格的绝对下限（ms；再快就听不出"滑"的过程了） */
export const SLIDE_STEP_MIN_MS = 30
/** 半音格的绝对上限（ms；长音符上不让滑行拖成"两拍"） */
export const SLIDE_STEP_MAX_MS = 60

/**
 * 从音符的 `symbols` 里取出滑音类型（`&shy` 与 `&xhy` 同写时取上滑音——与 `MORDENT_SYMBOLS` 同序优先）。
 */
export function slideOf(symbols: readonly string[] | undefined): SlideKind | null {
  if (!symbols || symbols.length === 0) return null
  for (const s of SLIDE_SYMBOLS) {
    if (symbols.includes(s)) return s
  }
  return null
}

/** 单个半音格的时长（ms）：`clamp(P/8, 30, 60)` */
export function slideStepMs(principalMs: number): number {
  return Math.min(SLIDE_STEP_MAX_MS, Math.max(SLIDE_STEP_MIN_MS, principalMs * SLIDE_STEP_RATIO))
}

/** 滑音计划（见文件头"口径"；`steps` **不含**到达本音的那一格，到达后由主音事件按住） */
export interface SlidePlan {
  /** 阶梯第一格的音名 = 本音在滑动方向上的调内二度邻音 */
  from: string
  /** 逐半音的阶梯音名（按演奏顺序；不含到达格） */
  steps: string[]
  /** 每一格的时长（ms） */
  stepMs: number
  /** 到达本音音高的时刻（相对本音符起点，ms）＝ `steps.length × stepMs` */
  arrivedMs: number
  /** 到达后按住本音的时长（ms）＝ `P − arrivedMs`（恒 ≥ P/2） */
  heldMs: number
}

/**
 * 求滑音计划。
 *
 * @param fromMidi  起点音（本音在滑动方向上的**调内二度**邻音）的 MIDI 音符号
 * @param toMidi    本音（被标记音符）的 MIDI 音符号
 * @param principalMs 本音符**发声时值**（前倚音扣完后的剩余；无倚音即谱面时值）
 * @param nameOf    MIDI 音符号 → 音名（由 `midi.ts` 的 `midiToPitchName` 提供，避免两份音名表）
 */
export function slidePlan(
  fromMidi: number,
  toMidi: number,
  principalMs: number,
  nameOf: (midi: number) => string,
): SlidePlan {
  const from = nameOf(fromMidi)
  if (!(principalMs > 0) || fromMidi === toMidi) {
    return { from, steps: [], stepMs: 0, arrivedMs: 0, heldMs: Math.max(0, principalMs) }
  }
  const dir = toMidi > fromMidi ? 1 : -1
  const semis = Math.abs(toMidi - fromMidi)
  // 每格时长：设计值夹紧，再取"整段滑行 ≤ P/2"的预算上限（同装饰音的 P/2 不变式）
  const stepMs = Math.min(slideStepMs(principalMs), principalMs / 2 / semis)
  const steps: string[] = []
  for (let k = 0; k < semis; k++) steps.push(nameOf(fromMidi + dir * k))
  const arrivedMs = semis * stepMs
  return { from, steps, stepMs, arrivedMs, heldMs: principalMs - arrivedMs }
}
