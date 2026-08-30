/**
 * engine/layout/spaceLayout.ts — 空间优先型布局（adj283）
 *
 * 空间优先与时值优先的本质区别：宽度分配单位从「小节→拍」改为「元素」。
 *  - 带时值元素：音符块、每条增时线；各自占宽 = 本体宽 + (时值/总时值)×可分配宽。
 *  - 附点：依附于「其前面最近那个带时值元素」（音符块或增时线），不单独占全局剩余宽；
 *    与该元素合并成 1.5 倍时值占宽段，段内三段留空式分散对齐（把增时线也视作音符，
 *    即模型 V2：附点依附逻辑对音符/增时线统一）。
 *  - 非时值元素：小节线块、&zkh/&ykh 曲部括号；宽度 = 本体宽 + 间距（默认 1/2 音符宽）。
 *
 * 本文件为 P1：先沉淀「本体宽度模型 + 时值拆分」这两个最基础、最不易变的部分，
 * 供后续 P2（每元素时值宽度分配/放置）、P3（断行）、P4（layoutScore 分流）、
 * P5（多声部）复用。均为纯函数，零 React/DOM 依赖。
 */
import { DOT_R_DOT, BRACKET_PAD, noteScaleOf } from './spacing'
import { tokenDuration } from '../duration'

// ============================================================
// 时值拆分
// ============================================================

/** 一个音符拆成空间优先「带时值元素」后的时值分量 */
export interface NoteDurSplit {
  /** 音符块基础时值（不含增时线/附点）：1 / 2^diminishCount */
  noteDur: number
  /** 每条增时线时值（与音符块基础时值相同） */
  augDur: number
  /** 增时线条数 */
  augCount: number
  /** 附点总增量时值（双附点为 0.75×noteDur×(1+augCount)，见 tokenDuration） */
  dotDur: number
}

/**
 * 拆分一个音符的时值为空间优先所需的各分量，保证合计 = tokenDuration(t)。
 * 依据：tokenDuration 把增时线并入 (1+augment)/2^dc，附点再按 ×1.5/×1.75 递增。
 * 故 noteDur×(1+augCount) = 基础含增时线时值，dotDur = tokenDuration − 基础含增时线时值。
 * 注意：平均连音组（tupletDur 覆盖）暂不在此拆分，由后续 P 阶段另处理。
 */
export function splitNoteDur(t: {
  diminishCount: number
  augmentCount: number
  dots: number
}): NoteDurSplit {
  const noteDur = 1 / Math.pow(2, t.diminishCount)
  const augDur = noteDur
  const augCount = t.augmentCount
  const total = tokenDuration(t)
  const dotDur = Math.max(0, Math.round((total - noteDur * (1 + augCount)) * 1e6) / 1e6)
  return { noteDur, augDur, augCount, dotDur }
}

// ============================================================
// 本体宽度（各元素不发生水平重叠的最小宽度）
// ============================================================

/** 音符数字槽宽（0.62×noteSize，与既有时值优先一致） */
export const digitSlotW = (noteSize: number) => noteSize * 0.62

/** 附点本体的圆点直径宽（2×DOT_R_DOT×s） */
export const dotBodyW = (noteSize: number) => 2 * DOT_R_DOT * noteScaleOf(noteSize)

/** 增时线符本体宽（建议 = 一个数字槽，后续可按显示效果调） */
export const augBodyW = (noteSize: number) => noteSize * 0.62

/** 上/下滑音符块本体宽（暂按数字槽 + 依附修饰额外宽，滑音语法敲定后再细分） */
export const slideBodyW = (noteSize: number) => noteSize * 0.62

/** &zkh/&ykh 曲部括号本体宽（非时值元素，沿用既有占位） */
export const bracketBodyW = () => BRACKET_PAD

/**
 * 音符块本体宽 = 数字槽宽 + 依附的带水平占宽修饰元素（前/后倚音、滑音等）额外宽。
 * @param graceExtra 依附修饰额外宽（前倚音向左、后倚音/滑音向右扩展；0 = 纯数字）
 */
export function noteBodyW(noteSize: number, graceExtra = 0): number {
  return digitSlotW(noteSize) + graceExtra
}

/** 不带时值元素的默认间距 = 1/2 音符宽（仅用于它与其它元素之间；行首尾贴边的小节线除外） */
export const nonDurGap = (noteSize: number) => noteSize * 0.5

/**
 * 音符变音角标（#/$/=/♯/♭/♮）本体宽（左扩展，画在数字左侧上方）。
 * 参考描述头 keyline（D: 调式）处升降号占宽 ♯/♭ = 7.62（13px 半角基准，随字号缩放）。
 * 否则空间优先下角标会向左越界与前一个音符重叠。
 */
export const accidentalBodyW = (noteSize: number) => 7.62 * (noteSize / 13)

/**
 * &hx（滑音箭头，右侧）无时值元素本体宽：依附其前面的带时值元素之后。
 * 与渲染一致——hx 中心偏移 7×s（noteScaleOf）、V 形两翼半宽 3.5×s×0.8，
 * 故占位 = 7s + 2.8s = 9.8×s（保证箭头不压到下一个音符）。
 */
export const hxBodyW = (noteSize: number) => 9.8 * noteScaleOf(noteSize)
