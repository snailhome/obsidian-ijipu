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
// adj479：滑音图形的宽高比来自矢量修饰符表（由 scripts/gen-modifier-glyphs.mjs 生成的数据文件）——
// 只共享**图形度量**，不依赖 render 的绘制逻辑
import { MODIFIER_GLYPHS, glyphInkAspect } from '../render/modifierGlyphs'

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
 *
 * adj395：平均连音组（(y...) 的 tupletDur 覆盖）——组内音符的总时值 = tupletDur
 * （= 组总时值 ÷ 组内音符数），不是原始减时线时值。此前本函数只按 diminishCount 算
 * noteDur，导致空间优先布局把 `(y3/ 2/ 1/)` 当成 3×0.5 = 1.5 拍占宽（应 1 拍），
 * 音符越出小节、拍位漂到下一拍（减时线被断开）。现按 tupletDur 等比缩放各分量
 * （保持「减时线条数 / 增时线条数 / 附点」的书写形态不变，仅换算实际时值）。
 */
export function splitNoteDur(t: {
  diminishCount: number
  augmentCount: number
  dots: number
  tupletDur?: number
}): NoteDurSplit {
  const base = 1 / Math.pow(2, t.diminishCount)
  const augCount = t.augmentCount
  if (t.tupletDur !== undefined) {
    // 原始构型总时值（同 tokenDuration，不含覆盖值）→ 缩放到 tupletDur
    let rawDot = base
    let raw = base * (1 + augCount)
    for (let i = 0; i < t.dots; i++) {
      rawDot /= 2
      raw += rawDot
    }
    const k = t.tupletDur / raw
    const noteDur = base * k
    // 附点段吸收浮点余量，保证 noteDur×(1+augCount) + dotDur 精确等于 tupletDur
    const dotDur = t.dots > 0 ? Math.max(0, t.tupletDur - noteDur * (1 + augCount)) : 0
    return { noteDur, augDur: noteDur, augCount, dotDur }
  }
  const noteDur = base
  const augDur = noteDur
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
 * &hx（滑音/呼吸记号，右侧）无时值元素本体宽。
 * adj375：&hx 已独立为标记 token（不再依附音符），但本体宽沿用既有画法——
 * V 形中心到两翼半宽：7s + 2.8s = 9.8×s（保证记号不压到相邻元素）。
 */
export const hxBodyW = (noteSize: number) => 9.8 * noteScaleOf(noteSize)

/**
 * 独立标记符（&zkh/&ykh 括号 / &hx 呼吸记号）本体宽——非时值元素，先扣除再分摊时值宽。
 * adj376：三种标记**统一用基本占宽**（= 括号的 BRACKET_PAD）；`&hx` 的"时值占用"是**演奏概念**
 * （占前一个音符的时值作换气静音，见 playback/sequence.ts），**与排版宽度无关**，
 * 因此不再为它预留 V 形的额外宽度。
 */
export const markBodyW = (_code: 'zkh' | 'ykh' | 'hx', _noteSize: number) => bracketBodyW()

/**
 * adj479：滑音（`&shy` 上滑音 / `&xhy` 下滑音）图形的**墨迹几何**——渲染与布局的唯一来源。
 *
 * 为什么抽到这里：滑音原先是**音符修饰符**，只由 render 摆放、布局端**完全不占宽**。
 * 单声部空间优先有充裕留白（`W` 按比例分摊）时看不出问题；但**多声部块的每拍宽 = 各声部
 * 本体宽的最大值（无留白）**，图形右伸的墨迹就压到后一个数字上（用户报「&shy/&xhy 与音符重叠」）。
 * 现在渲染端按本函数摆放、布局端按 `slideExtraW` 占宽——一份几何两处消费，
 * 避免本项目踩过的「线宽改了一处、占位表没同步」（adj104/adj391 的教训）。
 *
 * 几何（与 adj458 定下的画法一致，数值未变）：先按旧矢量算出**包围盒**（弧线两点 + 箭头尖 + 两翼），
 * 再按**高度**贴合、左缘贴在数字右缘（`x + digitW`），横向占宽随图形自身比例。
 * 返回值为**相对量**：`dx` 相对数字左缘（x）、`dy` 相对音符基线（y，向上为负）。
 */
export function slideGlyphInk(sym: 'shy' | 'xhy', noteSize: number): { dx: number; dy: number; w: number; h: number } {
  const s = noteScaleOf(noteSize)
  const digitW = digitSlotW(noteSize)
  const sz = noteSize * 0.25 // 滑音大小 = 音符的 1/4
  const right = sym === 'shy'
  // 旧矢量的弧线两点（x 相对数字左缘、y 相对基线）
  let x1: number
  let y1: number
  let x2: number
  let y2: number
  if (right) {
    // adj231：上滑音右上角更高（终点 sz×1.4 向上）
    x1 = digitW / 2 + 4 * s
    y1 = -noteSize * 0.4
    x2 = x1 + sz
    y2 = y1 - sz * 1.4
  } else {
    // adj231：下滑音更靠近主音符（弧线缩短 0.8×）+ 整体上移
    x1 = digitW
    y1 = -noteSize * 0.95
    x2 = x1 + sz * 0.8
    y2 = -noteSize * 0.55
  }
  // 箭头（adj119：方向 = 弧线末端切线延伸方向）——只为求包围盒
  const mx = (x1 + x2) / 2
  const tx = x2 - mx
  const ty = y2 - y1
  const tLen = Math.hypot(tx, ty) || 1
  const ux = tx / tLen
  const uy = ty / tLen
  const al = 3 * s // 箭头长度（弧线末端到尖）
  const aw = 2 * s // 开度
  const ay = y2 + uy * al
  const oy = ux * aw
  // 二次贝塞尔的 y 落在控制点凸包内（P1 的 y 同 y1），故 y1/y2 已覆盖曲线纵向范围
  const ys = [y1, y2, ay, y2 + oy, y2 - oy]
  const top = Math.min(...ys)
  const h = Math.max(...ys) - top
  return { dx: digitW, dy: top, w: h * glyphInkAspect(MODIFIER_GLYPHS[sym]), h }
}

/**
 * adj479：滑音图形的**右侧额外占宽**（= 数字槽之外那一截墨迹宽）。
 * 布局端在多声部块内把它计入音符本体宽，让后一个元素让开（单声部留白充裕，行为不变）。
 */
export const slideExtraW = (sym: 'shy' | 'xhy', noteSize: number) => slideGlyphInk(sym, noteSize).w

// ============================================================
// 倚音（adj396：时值规则 + 尾部位置判定；layout / render / playback 共用）
// ============================================================

/**
 * 单个倚音音符的**实际时值**（拍，adj396 用户规范）：
 * 括号内写 n 条减时线 → 实际时值 = 1/2^(n+1) 拍（**比书写时值再减一半**）。
 * 例：`2[3]` → 倚音 1/2 拍；`2[3/]` → 1/4 拍（= 实音符的 `3//`）；`2[3//]` → 1/8 拍。
 * 与渲染规则自洽：倚音减时线条数 = 书写条数 + 1。
 */
export function graceNoteBeats(diminishCount: number): number {
  return 1 / Math.pow(2, diminishCount + 1)
}

/** 倚音音符的形状（只取时值判定所需字段，避免与 token 类型耦合） */
interface GraceShape {
  augmentCount: number
  dots: number
  gracenotes?: { after: boolean; notes: { diminishCount: number }[] }
}

/**
 * 后倚音是否排在音符「时值尾部」（adj396 用户规范）：
 * `3-[h5/]` / `3 -[h5/]` / `3.[h5/]` —— 主音符带**增时线或附点**时，
 * 后倚音画在这些时值元素**之后**（`3 -[h5/]` → 倚音画在 `-` 右侧）；
 * 无增时线也无附点的后倚音仍紧贴数字右上角（既有行为不变）。
 */
export function graceAtTail(t: GraceShape | undefined): boolean {
  if (!t || !t.gracenotes || t.gracenotes.notes.length === 0) return false
  return t.gracenotes.after && (t.augmentCount > 0 || t.dots > 0)
}
