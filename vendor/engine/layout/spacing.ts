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
/** 小节线细线宽设计值（px，adj104 由 1.1 调小；线宽不随字号，避免占位连锁） */
export const BARLINE_W_THIN = 0.9
/** 小节线粗线宽设计值（px，adj104 由 1.8 调小；线宽不随字号） */
export const BARLINE_W_THICK = 1.4
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
/** 文字 descender 与字号比值（SVG 基线下方延伸，估算 0.2em） */
export const DESC_RATIO = 0.2

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
