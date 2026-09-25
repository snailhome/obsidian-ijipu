/**
 * engine/layout/spacing.ts — 音符修饰符层级与间距常量（adj60 集中管理）
 *
 * 层级规则（间距统一 LAYER_GAP，层内元素间距 INNER_GAP）：
 *  - 音符下方：数字 → 减时线层 → 低八度点层（先减时线、后低八度点，固定顺序）
 *  - 音符上方：数字 → 高八度点层 → 装饰符号/注释/连音线（高八度点最优先；
 *    其余按修饰符书写顺序从下往上依次排，未说明的顺序默认如此，后续可再调整）
 *  - 同层内多个元素（多个八度点 / 多条减时线）中心距 INNER_GAP
 *
 * 修改间距只需改本文件常量，全部渲染/布局自动生效。
 */

import type { BarlineType } from '../types'

// ---- 基础度量 ----
/** 数字字高与字号的比值（雅黑实测 ≈0.8em） */
export const DIGIT_HEIGHT_RATIO = 0.8
/** 数字底距基线的偏移（descender 估算，px） */
export const DIGIT_BOTTOM = 2

// ---- 层级与层内间距 ----
/**
 * 间距统一为「空白间距」语义：两实体中心距 = 上实体半高 + 下实体半高 + 空白。
 * 层级之间空白 LAYER_GAP；同层元素之间空白 INNER_GAP。
 */
/** 层级之间空白间距（px）：音符↔修饰层、修饰层↔修饰层
 *  （注：享用于减时线/低八度点/连音线等；音符上方修饰层专属更小间距见 render 的 symLayerGap，adj338） */
export const LAYER_GAP = 2
/** 同层级内部元素之间空白间距（px）：八度点之间、减时线之间（adj61 由 1.5 收为 1） */
export const INNER_GAP = 1.5

// ---- 元素尺寸 ----
/** 八度点半径（px，adj104 由 1.7 调小） */
export const DOT_R = 1.5
/** 附点圆点半径（px，adj71：独立常量，默认 2，随音符字号缩放） */
export const DOT_R_DOT = 2
/** 减时线横线高（px，adj104 由 1 调小） */
export const BEAM_H = 0.8
/** 高八度点层内垂直间距（px，adj104：原 INNER_GAP 1.5 调小，仅高八度点之间） */
export const OCTAVE_DOT_GAP = 1.2

// ---- 小节线 ----
/** 反复点相对小节线中心垂直偏移（上下各 ±，px） */
export const BARLINE_DOT_OFF = 4
/** 小节线反复点半径设计值（px，adj58 曾调小至 1.5、adj104 再调小至 1.2；实际 ×s） */
export const BARLINE_DOT_R = 1.2
/** 小节线反复点与最近细线的水平空白设计值（px，adj104 由 1.5 调小；实际 ×s） */
export const BARLINE_DOT_GAP = 1.2
/** 小节线细线宽（px，adj391 用户规则由 0.9 调为 1；线宽不随字号，避免占位连锁） */
export const BARLINE_W_THIN = 1
/** 小节线粗线宽（px，adj391 用户规则由 1.4 调为 2；线宽不随字号） */
export const BARLINE_W_THICK = 2
/**
 * 线与线的水平间距（px，adj391）：恢复 adj55 的 1px 原意——
 * adj104 缩小线宽时"线左缘固定、右缘内收"，使线与线间距意外变成 1.2。
 */
export const BARLINE_LINE_GAP = 1

/** 线组元素：line 给相对线组中心的左缘偏移与宽、dot 给相对线组中心的圆心偏移 */
export interface BarlineGeometry {
  lines: { off: number; w: number }[]
  dots: number[]
  /** 线组总宽（设计值，s=1）：布局占位与"右缘 = 中心 + total/2"均以此为准 */
  total: number
}

/**
 * 各类型小节线的元素序列（左→右）。
 * `|*` 与 `|` 同序：**不绘制但占位**；`|/` 空序：不绘制也不占位。
 */
const BARLINE_SEQ: Record<BarlineType, ({ kind: 'line'; w: number } | { kind: 'dot' })[]> = {
  '|': [{ kind: 'line', w: BARLINE_W_THIN }],
  '||': [
    { kind: 'line', w: BARLINE_W_THIN },
    { kind: 'line', w: BARLINE_W_THICK },
  ],
  '||/': [
    { kind: 'line', w: BARLINE_W_THIN },
    { kind: 'line', w: BARLINE_W_THIN },
  ],
  '||:': [
    { kind: 'line', w: BARLINE_W_THIN },
    { kind: 'line', w: BARLINE_W_THIN },
    { kind: 'dot' },
  ],
  '|:': [{ kind: 'line', w: BARLINE_W_THICK }, { kind: 'line', w: BARLINE_W_THIN }, { kind: 'dot' }],
  ':|': [{ kind: 'dot' }, { kind: 'line', w: BARLINE_W_THIN }, { kind: 'line', w: BARLINE_W_THICK }],
  ':|:': [
    { kind: 'dot' },
    { kind: 'line', w: BARLINE_W_THIN },
    { kind: 'line', w: BARLINE_W_THICK },
    { kind: 'line', w: BARLINE_W_THIN },
    { kind: 'dot' },
  ],
  '|*': [{ kind: 'line', w: BARLINE_W_THIN }],
  '|/': [],
}

/**
 * 小节线线组几何（adj391）：**线组整体以小节线中心 x 对称**（渲染与布局占位共用这一份定义）。
 *
 * 此前渲染里写死一套偏移、布局里另写一份总宽表，两处靠人工同步——adj104 缩小线宽时只改了
 * 渲染（且"左缘固定"），占位表仍按旧线宽算，于是线组整体偏左、预留宽度比实际宽 0.2~3px
 * （`||` 的线间距也从注释里的 1px 变成 1.2px）。现在只有这一处定义，改线宽/间距自动全链路一致。
 *
 * 间距规则：线与线 `BARLINE_LINE_GAP`；线与点、点与线 `BARLINE_DOT_GAP`（点径 `BARLINE_DOT_R×2`，
 * 设计值 s=1，实际绘制时点的半径按字号缩放、线宽不缩放）。
 */
export function barlineGeometry(type: BarlineType): BarlineGeometry {
  const seq = BARLINE_SEQ[type] ?? []
  const dotD = BARLINE_DOT_R * 2
  const gapBefore = (i: number): number =>
    seq[i - 1]?.kind === 'dot' || seq[i]?.kind === 'dot' ? BARLINE_DOT_GAP : BARLINE_LINE_GAP

  let total = 0
  for (let i = 0; i < seq.length; i++) {
    if (i > 0) total += gapBefore(i)
    const it = seq[i]
    if (it) total += it.kind === 'dot' ? dotD : it.w
  }

  const lines: { off: number; w: number }[] = []
  const dots: number[] = []
  let cursor = -total / 2 // 从左缘起累加，起点取 -total/2 → 整体对称
  for (let i = 0; i < seq.length; i++) {
    if (i > 0) cursor += gapBefore(i)
    const it = seq[i]
    if (!it) continue
    if (it.kind === 'dot') {
      dots.push(cursor + dotD / 2)
      cursor += dotD
    } else {
      lines.push({ off: cursor, w: it.w })
      cursor += it.w
    }
  }
  return { lines, dots, total }
}

/** 小节线线组总宽（px，设计值）：布局占位用（等价 `barlineGeometry(type).total`） */
export const barlineTotalW = (type: BarlineType): number => barlineGeometry(type).total
/**
 * 小节线两侧净间距（px，adj314 用户规则：按 1/4 音符字体宽度——
 * 不随音符占宽(W)放大，宽松时避免"空上加空"、压缩时仍区分小节；
 * 运行时按 noteSize 计算，间距随字号比例缩放）。
 */
export const barlinePad = (noteSize: number): number => noteSize / 4
/** 跳房子线距小节线上端间距（px；adj73：比线下方元素最高点（小节线上端）高 8px） */
export const VOLTA_BAR_GAP = 8
/** 跳房子 + 修饰（抬高）每级间距（px） */
export const VOLTA_RAISE = 2
/** 渐强渐弱 hairpin（尖括号）上下张开半高（px，与连音线弧高近似；实际 ×s 随音符字号） */
export const DYN_HALF_H = 4
/** 跳房子注释（番号）字号与音符字号的比值（adj71：音符高度的 0.4） */
export const VOLTA_COMMENT_FONT_RATIO = 0.4

// ---- 注释 ----
/** 歌词注释字号与歌词字号的比值（0.8×18≈14） */
export const COMMENT_FONT_RATIO = 0.8
/** 音符注释字号与音符字号的比值（adj62：音符字体高度的一半，0.5×18=9） */
export const NOTE_COMMENT_FONT_RATIO = 0.3
/**
 * 音符注释抬升/降低每级位移（px，adj392）：紧接注释引号后的 `+`/`-` 各算一级，
 * `+` 向上（抬升）、`-` 向下（降低），与跳房子 `[+`/`[-`、连音线 `(+`/`(-` 同一套记法与步长。
 */
export const NOTE_COMMENT_RAISE = 2
/** 文字 descender 与字号比值（SVG 基线下方延伸，估算 0.2em） */
export const DESC_RATIO = 0.2

// ---- 方框小节序号（adj625，用户要求） ----
/**
 * 方框小节序号的几何。
 *
 * 用户口径：
 *  · 字号与「**倚音音符**」一样大（`max(6×s, note_size × GRACE_SIZE_RATIO)`，与渲染倚音同一算式；
 *    `s = noteScaleOf(note_size)`，有下限、随字号等比，两处不会各写一份而漂移）；
 *  · adj625b（用户要求）：**序号连同方框整体按 3/4 显示** ⇒ 字号 / 框内空隙 / 框线宽一律 ×0.75
 *    （框宽由这三者与数字位数推出，故一并缩）。`BAR_NUMBER_BOTTOM_GAP` 是"离小节线多高"的
 *    **定位**间隙、不属于"序号 + 方框"的尺寸，保持不变。
 * 位置：**小节线底缘下方**（`BOTTOM_GAP` 起）画外框，数字用 `dominant-baseline="central"` 框内居中。
 */
export const BAR_NUMBER_BOTTOM_GAP = 1.5
/** adj625b：序号（数字 + 方框）整体缩放比例 */
export const BAR_NUMBER_SCALE = 0.75
/** 外框四周内空隙（px；已含 3/4 缩放） */
export const BAR_NUMBER_PAD = 1.5 * BAR_NUMBER_SCALE
/** 外框线宽（px；已含 3/4 缩放） */
export const BAR_NUMBER_STROKE = 0.8 * BAR_NUMBER_SCALE
/** 序号与**倚音音符**同字号，再整体 ×3/4：`max(6×s, note_size × 0.5) × 0.75` */
export const barNumberFontSize = (noteSize: number): number =>
  Math.max(6 * noteScaleOf(noteSize), noteSize * GRACE_SIZE_RATIO) * BAR_NUMBER_SCALE
/** 外框高度（含线宽，px） */
export const barNumberBoxH = (noteSize: number): number =>
  barNumberFontSize(noteSize) + BAR_NUMBER_PAD * 2 + BAR_NUMBER_STROKE
/**
 * 外框宽度（px）：按数字位数自适应（等宽估算 0.62em，与数字槽同比例），
 * 但不小于框高（一位数时是个方框）。
 * 布局端要用它给「多声部块首」那条空隙留位（见 `placeVoiceBlock`），渲染端画框同源。
 */
export const barNumberBoxW = (n: number, noteSize: number): number =>
  Math.max(barNumberBoxH(noteSize), String(n).length * barNumberFontSize(noteSize) * 0.62 + BAR_NUMBER_PAD * 2)
/** 多声部块首序号需要的「大括号与音符之间」净空隙（框宽 + 左右各 1px 净距 + 括号自身 3px 厚） */
export const barNumberGapNeed = (n: number, noteSize: number): number => barNumberBoxW(n, noteSize) + 5
/**
 * adj625c（用户要求）：**序号算在曲部行自己的空间里，显隐不得影响排版** ⇒
 * 不再为它预留任何纵向空间（既不抬高行高、也不把词部下移）。
 *
 * 依据（默认配置、note_size 13）：小节线底缘在曲部行内有 ≈4.6px 余量，其下还有
 * 「曲下间距 `height_quci`（默认 15px）」/「行尾间距 `height_ciqu`（默认 20px）」——
 * 3/4 缩后的方框（≈7.7px）加上 1.5px 间隙整段落在这段空隙里，**不压歌词、也不越到下一行**。
 * 与「小节线备注」等既有"线下方文字"同一处置（都不参与行高计算）。
 */

// ---- 连音线 ----
/** 连音线线宽（px，adj150：由 1 减小到 0.8） */
export const SLUR_W = 0.8
/** 连音线嵌套抬升（每层，px） */
export const SLUR_NEST_RAISE = 5
/** 平均连音组数字字号与音符字号的比值（adj89：默认 0.2×noteSize，可调整） */
export const TUPLET_NUM_RATIO = 0.2
/** 平均连音组数字字形宽与字号比值（adj222：与音符数字槽同比例 0.62em） */
export const TUPLET_NUM_W_RATIO = 0.62
/** 平均连音组数字背景矩形四周空隙（px，adj222：紧贴文字即可，连线与字不重叠） */
export const TUPLET_LABEL_PAD = 1

// ---- 水平元素占位 ----
/** 左右括号（&zkh/&ykh）占位宽度（px，adj64：非时值元素，先扣除再分摊时值宽） */
export const BRACKET_PAD = 5
/** 水平元素（音符块/增时线/附点/括号/小节线等）之间最小间距 */
export const H_GAP = 2
/** 附点圆心与数字右缘的净间距（adj317：多声部 space 显式 dot 段位置；设计值 18 号字基准，实际 × 主音符缩放因子 s）。
 *  旧实现直接写 `noteSize * 0.2`，本常量统一在 spacing.ts 便于调整。 */
export const DOT_AFTER_DIGIT_GAP = (noteSize: number) => 0.2 * noteScaleOf(noteSize) * 18
// = noteSize * 0.2（与原值一致）；noteSize=13 → ≈2.6px，noteSize=18 → 3.6px

// ---- 倚音（adj103：以下设计值均为 18 号字基准，实际使用一律 ×主音符缩放因子 s） ----
/** 倚音字号与主音符字号比值（adj105：0.4 → 0.5） */
export const GRACE_SIZE_RATIO = 0.5
/** 倚音数字槽宽与字号比值（同数字槽宽比例） */
export const GRACE_SLOT_RATIO = 0.62
/** 倚音多音符（≥2 个）时数字间占宽与字号比值（adj103：缩小多音符间距，0.62 → 0.5） */
export const GRACE_SLOT_RATIO_MULTI = 0.5
/** 倚音减时线间距设计值（px，adj100 由 1.8 减小；实际 ×s） */
export const GRACE_BEAM_GAP = 1.2
/** 倚音减时线/连接弧线线宽设计值（px，adj97；实际 ×s） */
export const GRACE_LINE_W = 0.6

// ---- 临时叠加段（adj428：{bz … } / {dsb … } 上下层纵向间距；adj629：加 {tp … }）----
/**
 * 临时段上下两行之间的纵向间距（px）。
 *  - **bz**：主旋律行基线 `row.y` 不动，段层整体抬到 `row.y − segmentRowGap.bz`。
 *  - **dsb**：主旋律在包络内下移 `segmentRowGap.dsb / 2`，段层抬 `segmentRowGap.dsb / 2`，
 *           两层中线对齐 `row.y`（整块居中）。
 *  - **tp**（adj629 替谱段）：**主旋律不动**，层画在「它所属那条歌词行」的**上方**
 *           （`歌词行基线 − segmentRowGap.tp`），并让该歌词行及其后各歌词行整体下移，
 *           腾出这段空间——这样"第 2 遍的词"下面紧跟着的就是"第 2 遍的音"。
 *
 * 默认 22 px ≈ `note_size × 1.7`（13 号字基准，与 adj427 原硬编码一致；改字号不自动按比例缩放，
 * 由 `PageConfig.segmentRowGap` 显式覆盖）。`adj64` 精神：改间距集中在本文件。
 */
export const SEGMENT_ROW_GAP_DEFAULT = { bz: 22, dsb: 22, tp: 14 } as const

/**
 * adj629b（用户要求）：**临时叠加层（`{bz}` / `{dsb}` / `{tp}`）的纵向高度压缩比**。
 *
 * 口径（用户明确）：**字号不变**，只把整层**纵向压扁**到 2/3 —— 数字还是原来的字号，
 * 但八度点层、减时线层、附点等"层高"与它们到基线的距离都按此比例压缩，
 * 整层看起来"扁一些"，一眼能区分"这是另一层 / 另一遍的内容"。
 *
 * 实现：布局照常算**未压扁**的坐标；渲染端用 `<g transform="translate(0, y(1−k)) scale(1, k)">`
 * 以**层基线**为不动点做纵向压缩（见 `render/index.ts` 的 `segmentYScaleWrap`）。
 */
export const SEGMENT_LAYER_YSCALE = 2 / 3

/**
 * adj629e（用户要求）：**替谱行与其下方那条歌词行的默认间距**（px）。
 *
 * 三条虚线的分工（用户明确）：
 *  · 歌词行 1 的虚线 → 歌词区与上方曲部的间距（`height_quci`）；
 *  · 歌词行 2 及以后的虚线 → 歌词行之间的间距（`height_cici`，A）；
 *  · 替谱行虚线 → **替谱行与其下方歌词行的间距**（`segmentRowGap.tp`，本常量）。
 *
 * 几何：替谱层挂在其下方歌词行之上（`层基线 = 歌词行基线 − tp`）⇒ **拖 tp 动的是替谱层**；
 * 替谱层另按自己的高度 B 把该歌词行整行推下去 ⇒ 有替谱时歌词行间距 = A + B。
 */
export const TP_LAYER_TOP_GAP_DEFAULT = 7

/**
 * adj629k（用户要求「替谱两端的括号与音符之间要留一点间距，不紧贴」）：
 * **替谱层自动圆括号与首/末音符的间距**。
 *
 * 为什么比通用的 `nonDurGap`（0.5×字号）大：替谱段常从**小节线**起（锚点音就在小节线右侧
 * 只有 `barInset` 的一点余量），按通用间距算出来的括号会被"小节线内侧"钳制回去、压在数字上
 * （实测左括号右缘越过首音左缘 1.7px ⇒ 看起来 `(4` 紧贴）。替谱层画在自己的一行里
 * （曲行之下、歌词行之上），括号往左越出小节线也不会压到别的东西，所以单给一个更大的间距。
 */
export const TP_BRACKET_GAP = (noteSize: number) => noteSize * 0.75

// ============================================================
// 位置计算（纯函数，供 render / layout 共用）
// ============================================================

/**
 * 曲部缩放因子（adj69）：音符修饰符尺寸 = 设计值(18号) × 缩放因子。
 * 以曲部 note_size、词部 geci_size 为基准，18 号字 scale=1 外观不变；
 * 字号调大后八度点/附点/减时线/倚音/小节线等按同比率放大，保持比例协调。
 */
export const noteScaleOf = (size: number) => size / 18

/** 数字顶 y（基线 y - 字高，随字号） */
export const digitTopY = (y: number, noteSize: number) => y - noteSize * DIGIT_HEIGHT_RATIO

/** 数字底 y（基线 y + DIGIT_BOTTOM×scale，随字号） */
export const digitBottomY = (y: number, noteSize: number) =>
  y + DIGIT_BOTTOM * noteScaleOf(noteSize)

/** 高八度点：第 i 个点 cy（点底距数字顶 LAYER_GAP×scale，层内点空白 OCTAVE_DOT_GAP×scale，adj104） */
export const octaveDotY = (y: number, i: number, noteSize: number) => {
  const s = noteScaleOf(noteSize)
  return y - noteSize * DIGIT_HEIGHT_RATIO - (LAYER_GAP + DOT_R) * s - i * (DOT_R * 2 + OCTAVE_DOT_GAP) * s
}

/** 高八度点层顶 y（n 个点时的最高点顶，供上层装饰/连音线定位） */
export const octaveTopY = (y: number, n: number, noteSize: number) => {
  const s = noteScaleOf(noteSize)
  return y - noteSize * DIGIT_HEIGHT_RATIO - (LAYER_GAP + DOT_R * 2) * s - (n - 1) * (DOT_R * 2 + OCTAVE_DOT_GAP) * s
}

/** 减时线：第 level 条横线顶 y（第一条距数字底 LAYER_GAP×scale，层内线空白 INNER_GAP×scale） */
export const beamY = (y: number, level: number, noteSize: number) => {
  const s = noteScaleOf(noteSize)
  return y + (DIGIT_BOTTOM + LAYER_GAP) * s + (level - 1) * (BEAM_H + INNER_GAP) * s
}

/** 减时线层底 y（dc 条时的最下方线底，供低八度点层定位） */
export const beamBottomY = (y: number, dc: number, noteSize: number) => {
  const s = noteScaleOf(noteSize)
  return y + (DIGIT_BOTTOM + LAYER_GAP) * s + (dc - 1) * (BEAM_H + INNER_GAP) * s + BEAM_H * s
}

/** 低八度点：第 i 个点 cy（点顶距数字底或减时线层底 LAYER_GAP×scale；dc=0 表示无减时线） */
export const lowDotY = (y: number, i: number, dc: number, noteSize: number) => {
  const s = noteScaleOf(noteSize)
  const top =
    dc > 0 ? beamBottomY(y, dc, noteSize) + LAYER_GAP * s : digitBottomY(y, noteSize) + LAYER_GAP * s
  return top + DOT_R * s + i * (DOT_R * 2 + INNER_GAP) * s
}
