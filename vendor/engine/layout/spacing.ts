/**
 * engine/layout/spacing.ts — 音符修饰符层级与间距常量（adj60 集中管理）
 *
 * **层级规则（adj714 用户主规则，见 `AGENTS.md` 五·10）**：修饰符从音符往上/往下各有固定层级，
 * 叠加时以**「音符与修饰符的墨迹不重叠」为主要原则**，层级之间留 `LAYER_GAP`、层内 `INNER_GAP`。
 *
 * ```
 *   音符往上（由低到高）              音符往下（由近到远）
 *   ① 高八度点                      ① 减时线
 *   ② 本音符修饰符（波音/顿音/颤音/注释）
 *   ③ 跨音符修饰符（连音线、渐强渐弱）
 *   ④ 跨小节/章节修饰符（跳房子、反复）  ② 低八度点 → ③ 其它
 * ```
 *
 * - 层级顺序的唯一表述 = `MODIFIER_LAYERS_ABOVE` / `MODIFIER_LAYERS_BELOW`；
 * - 每层的纵向落点 = `octaveDotY`/`octaveTopY`（①）、`beamY`/`beamBottomY`（下方①）、
 *   `lowDotY`（下方②）、`slurApexY`（③，**按弧顶**不是弦）；渲染与布局**共用同一函数**；
 * - 净空判断用 `layerSeparationViolation`（机器闸门，smoke 里有成对断言）。
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

// ---- 小节线修饰符记号（`&ty` 大跳跃 / `&hs` 花 S；画在小节线正上方）----
/**
 * `&ty`（大跳跃 `𝄌`）**基础字号**（px；渲染端 `font-size`）。
 *
 * 历史：`adj130` 引入 Unicode `U+1D10C`；`adj131` 调大并下移靠近小节线；
 * `adj182` 定为 `16×s×1.2`，且**记号下端与小节线上端（`yTop`）齐平**；
 * `adj183`/`adj184` 又按"自身高度百分比"微调纵向落点（净 +10%）。
 *
 * `adj723h`（用户三轮口径，最终）：**只把高度放大 1.25 倍，宽度保持原样**。
 * 因此"字号"（同时决定宽与高）**回到 `adj182` 的原值**，
 * 横向维持原宽由 `TY_WIDTH_SCALE` 说明、纵向 1.25 倍由 `TY_HEIGHT_SCALE` 用 `transform` 单独拉伸
 * —— `font-size` 一刀切会让宽度也跟着变大，正是用户此前说"效果不对"的原因。
 */
export const TY_FONT_SIZE = (noteSize: number): number => {
  const s = noteScaleOf(noteSize)
  return Math.max(14, Math.round(16 * s * 1.2))
}

/**
 * `&ty` 的**横向**缩放（相对 `TY_FONT_SIZE`）：`1` = 宽度保持原样（用户口径「宽度不调整」）。
 *
 * 之所以要有它：`font-size` 同时决定宽与高，若靠字号放大高度，宽度会一起变大。
 * 故宽度固定为 1、高度单独拉伸（见 `TY_HEIGHT_SCALE`）。
 */
export const TY_WIDTH_SCALE = 1

/**
 * `&ty` 的**纵向**缩放：高度为原（`adj182`）的多少倍（用户口径）。
 *
 * 沿革：`adj723h` 定为 **1.25**（用户："&ty 高度调整 1.25 倍"）；
 * 期间曾按"还要高些"试过 1.5，用户随即澄清「**还要上移一点，不是要高度增加**」⇒ **回到 1.25**，
 * "上移"改由 `TY_BAR_GAP`（间距）实现。
 *
 * 渲染端以**基线**为不动点纵向拉伸（记号长在基线上方），于是：
 *  · 记号**高度** ×本值；
 *  · **宽度不变**；
 *  · **墨迹下端**由 `TY_BAR_GAP` 决定（拉伸不动下端，见 `tyBaselineY`）。
 */
export const TY_HEIGHT_SCALE = 1.25

/**
 * `&ty` **墨迹下端到小节线上端（`yTop`）的间距**（px，**正 = 记号在小节线之上**）。
 *
 * 沿革：旧写法 `y = yTop + 0.35×fs`（按"记号下端 ≈ `y + 0.15×fs`"反推）。
 * `adj723h` 先后试过"+2px"、"1px"、"0"，用户随后：
 * 「**&ty 还要上移一点**，……与小节线的墨迹间距 **0.5px** 试试」⇒ `0.5`；
 * `adj723t`：「**之前调整的 `&ty` 再往上调整 2px**」⇒ **`0.5 + 2 = 2.5`**。
 *
 * ⚠ 这里刻意选用**绝对 px** 而非按字号缩放：用户是按"看起来的间隙"给的数，
 * 与字号无关（与 `VOLTA_BAR_GAP` 等同类常量一致）。
 */
export const TY_BAR_GAP = 2.5

/**
 * `&ty` **基线 → 墨迹下端**的偏移（em 的倍数；**正 = 墨迹下端在基线之下**）。
 *
 * ⚠ 这个量一直是**估算**，而估算错了"间距 0"就老是差一截（本轮为此白改了四版）。
 * 现在用**真实像素扫描**标定（`noteSize=13 ⇒ fs=14、ky=1.25`；扫描窗口避开小节线本身的抗锯齿）：
 *
 * ```
 * 基线 y（attrY）      = 145.41
 * 实测记号墨迹         = 133.25 → 139.25（高 6.0px）
 * 目标：墨迹下端应落在 yTop = 141  ⇒ 还差 1.75px
 * 初始值 0.252（由未含 transform 的布局盒推得：152.23 − 148.7 = 3.53px = 0.252×fs）
 * ⇒ 标定后 = 0.252 + 1.75 / (14 × 1.25) = **0.352**
 * ```
 *
 * 渲染端据此反推基线：`y = yTop + TY_BAR_GAP + TY_INK_BOTTOM_EM × fs × ky`
 * ⇒ 记号墨迹下端落在 `yTop + TY_BAR_GAP`（= 0，即**与小节线上端齐平**）。
 *
 * 另注：`𝄌` 是 `U+1D10C` 音乐符号，需要音乐字体（Bravura / Finale Maestro / Noto Music …）。
 * 实测这些字体在环境里**都不可用**（各字体测得宽度完全相同 ⇒ 回退到系统符号字体），
 * 故字形观感依机器而异；本常量是按"当前回退字形"实测标定的，换机器可能需微调。
 */
export const TY_INK_BOTTOM_EM = 0.352

/**
 * `&ty` 记号的**文字基线 y**（渲染端 `y=` 属性）。
 *
 * `y = yTop − TY_BAR_GAP + TY_INK_BOTTOM_EM × fs × ky`
 * ⇒ 墨迹下端落在 `yTop − TY_BAR_GAP`（**在线上端之上** `TY_BAR_GAP`）。
 *
 * ⚠ 符号方向：SVG 的 **y 越小越靠上**，故"上移"是**减** `TY_BAR_GAP`。
 * 本轮一开始写成 `+`，那会让记号反而**下调**（与"上移"相反）。
 *
 * 常量 `TY_INK_BOTTOM_EM` 已按"最终缩放后的墨迹位移"实测标定，故**不要再单独乘一次 `ky`**。
 *
 * 抽成函数而非在渲染端内联：**渲染端与断言消费同一个式子**（`六之二·4`「数值口径必须同源」）——
 * 本轮连续多次对不上（把 `ky` 乘重、符号写反），根因就是"渲染端一份、断言各写一份"。
 */
export const tyBaselineY = (yTop: number, noteSize: number): number =>
  yTop - TY_BAR_GAP + TY_INK_BOTTOM_EM * TY_FONT_SIZE(noteSize) * TY_HEIGHT_SCALE

/** `&hs`（花 S `𝄋`）字号（px；`adj129` 引入、`adj182` 定为 `12×s`） */
export const HS_FONT_SIZE = (noteSize: number): number => Math.max(10, Math.round(12 * noteScaleOf(noteSize)))
/** 渐强渐弱 hairpin（尖括号）上下张开半高（px，与连音线弧高近似；实际 ×s 随音符字号） */
export const DYN_HALF_H = 4
/** 跳房子注释（番号）字号与音符字号的比值（adj71：音符高度的 0.4） */
export const VOLTA_COMMENT_FONT_RATIO = 0.4

// ---- 注释 ----
/** 歌词注释字号与歌词字号的比值（0.8×18≈14） */
export const COMMENT_FONT_RATIO = 0.8

/**
 * adj672：**歌词注释**（`C: 一"副歌" 二` 里那个 `"副歌"`）的字号。
 *
 * 渲染与布局避让必须用同一把尺子（布局要按它估宽、才能判断"放不放得下"）。
 */
export const lyricCommentFontSize = (geciSize: number) => Math.max(9, Math.round(geciSize * COMMENT_FONT_RATIO))

/**
 * adj672：歌词注释的**墨迹宽估算**——汉字按 1 字宽、拉丁/数字按 0.55 字宽。
 *
 * 注释是宿主字体渲染的自由文本，`getBBox` 在布局阶段拿不到；这里用"足够准的估算"即可：
 * 避让只需要知道"大概多宽"，宁可按上限估（估宽 → 更早触发上下错开，不会压字）。
 */
export const lyricCommentWidth = (text: string, fontSize: number) =>
  [...text].reduce((acc, ch) => acc + (/\p{Script=Han}/u.test(ch) ? fontSize : fontSize * 0.55), 0)

/**
 * adj672（用户要求）：「歌词的注释，也以**不与歌词重叠**为宜，否则**前后两歌词之间**调整注释的位置
 * 到不重叠，如果无法不重叠，则再**上下调整**」。
 *
 * 这是歌词注释与**所属歌词字左缘**之间的默认净距（注释右缘 → 该字左缘）。
 * 也是"在前后两字之间的空档里右对齐"时贴住本字的间距。
 */
export const LYRIC_COMMENT_GAP = 3
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
/**
 * adj632：倚音**右侧**修饰符（`&shy`/`&xhy`）的墨迹与「下一个倚音数字」之间的净距（px，实际 ×倚音缩放因子 gs）。
 * 只在「该倚音确有右侧修饰」时才把下一个槽位推开——无修饰时仍走 adj103 的紧凑间距 `GRACE_SLOT_RATIO_MULTI`。
 */
export const GRACE_MARK_GAP = 1

// ---- adj632b：倚音修饰符的**尺寸尺子**（用户要求：记号要随倚音变小，别比倚音还大） ----
/**
 * **修饰符字号 / 记号所属音符字号**的设计比例 = `10 / 18`。
 *
 * 主音符的 `&tu`/`&die`/`&da` 就是按它算字号（渲染端 `SYM_FS = Math.round(10 × s)`，
 * 那个 `round` 是绘制取整、不是设计值）。倚音上的同名记号**沿用同一把尺子**：
 * `倚音记号字号 = 倚音字号 × SYM_FONT_RATIO` —— 记号随倚音一起等比缩小。
 *
 * 依据：用户示例图（`6/[5/&tu]`）实测 T 墨迹高 13px、倚音数字 **5** 墨迹高 24px，比值 **0.542**；
 * 按本式算（T 墨迹 0.76em ÷ 数字墨迹 0.785em × 10/18）得 **0.538**，与示例图逐像素吻合。
 * （adj632 首版把字号取成 `gSize`——CJK 字形「又/扌」几乎填满字身框，看起来就比倚音数字还大。）
 */
export const SYM_FONT_RATIO = 10 / 18

/**
 * adj723p：**修饰符"让位量"查表**——连音线为"本音符修饰符"让开多少（单位 ×`s`）。
 *
 * ## 为什么必须查表
 * 旧口径一律让 `10×s + LAYER_GAP×s`（`10×s` 是**符号字号**、不是墨迹高）⇒ 用户反复报
 * 「抬得过高、间距较大」；本轮先改成单个常量（用户确认间距可用），但那对各类符号**必然有偏**：
 * 修饰符有两类几何——
 * · **矢量图形**（`MODIFIER_GLYPHS`：波音 / 滑音 / 延长记号）：渲染端 `glyphMarkup()`
 *   把源紧包围盒按 `translate(tx,ty) scale(s)` 对齐到目标框
 *   （`s = w / g.box.w`、`ty = y - g.box.y*s`）⇒ **目标框的 `y` 就是墨迹顶**，
 *   墨迹高 = `g.box.h × s`；
 * · **文字记号**（颤音 `tr` / `cy` 等）：`<text>` 字号 `SYM_FS = 10×s`，墨迹高按字身比估。
 *
 * 表值 = **墨迹高**（`glyphMarkup` 保证墨迹顶 = 目标框顶，故无需再加"顶距"项）。
 *
 * ⚠ 与 `MODIFIER_GLYPHS[].box` **同源**：改图形、或改宽度算式（`mordentInkW` 的 `9 / 13.5×s`）
 * 都要重算此表——`smoke` 里有一条断言按 `box` 现算并与本表比对，防止悄悄失配。
 */
export const MARK_INK_H_RATIO: Readonly<Record<string, number>> = {
  /** 上波音：`951.6×349.91`，目标宽 `9×s` ⇒ 高 `349.91 × 9/951.6 = 3.309×s` */
  sby: (349.91 * 9) / 951.6,
  /** 下波音：`951.6×363.16` */
  xby: (363.16 * 9) / 951.6,
  /** 复上波音（3.5 齿）：`1003.8×264.78`，目标宽 `13.5×s` */
  'sby+': (264.78 * 13.5) / 1003.8,
  /** 复下波音：`1003.8×410.26` */
  'xby+': (410.26 * 13.5) / 1003.8,
  /** 上滑音：`755.98×684.72` */
  shy: (684.72 * 9) / 755.98,
  /** 下滑音：`729.81×716.92` */
  xhy: (716.92 * 9) / 729.81,
  /** 延长记号：`524.6×278.2` */
  yc: (278.2 * 9) / 524.6,
}

/** 文字类修饰符的墨迹高（×`s`）：`<text font-size="10×s">` 按字身比 `0.72` 估 ⇒ `7.2×s` */
export const MARK_TEXT_INK_H_RATIO = 10 * 0.72

/** 单个修饰符的**墨迹高**（×`s`；不含 `LAYER_GAP`）。未知符号退回文字类估值——宁可略松 */
export function markInkHRatio(sym: string): number {
  return MARK_INK_H_RATIO[sym] ?? MARK_TEXT_INK_H_RATIO
}

/**
 * adj723n：连音线为修饰符让位的**总高度**（= 墨迹高 + `LAYER_GAP`），供 `slurYFor` 消费。
 *
 * 旧口径一律 `10×s + LAYER_GAP×s`（`10×s` 是**符号字号**）⇒ 用户报「明显抬得过高、间距较大」；
 * 本轮一度改成单个常量 `6×s`（用户确认"间距可以"），但各类符号墨迹高不同 ⇒ 现改为**查表**：
 * `让位量 = markInkHRatio(sym) + LAYER_GAP`（比例形式，调用方再 `× s`）。
 */
export function markReserveRatio(sym: string): number {
  return markInkHRatio(sym) + LAYER_GAP
}

/**
 * adj723m：（**已被 `markReserveRatio()` 取代**，保留常量仅供对照与回退）
 * 每个"本音符修饰符"占的纵向高度的**单值近似**（`6×s`；实测 `sby` 的墨迹高只有 `3.31×s`）。
 *
 * ## 为什么不能只用它
 * `slurYFor` 原来每个修饰符按整层 `10×s + LAYER_GAP×s ≈ 8.67px` 让位（`10×s` 是
 * **符号字号**，不是墨迹高）。用户例 `(1/ (1&sby)- | 1)` 实测：波音**墨迹顶**距音符中心
 * 只有 `2s + 0.95×fs = 8.31px`。按整层让位 ⇒ 连线被多抬 **≈ 8.4px**
 * ⇒ 用户报「**明显抬得过高、间距较大**」。
 *
 * ## 取值（与渲染端几何同源，按**渲染出的 SVG 坐标**反推）
 * 渲染端：`<g transform="translate(cx, wy) scale(K)">`，`K = fs/1024`、`fs = 10×s`、
 * `wy = symY − 2×s`（图形**中心**，`symY` 是文字基线）；`sby` 的 path 在源坐标 `y ∈ [327.15, 677.06]`。
 * ⇒ 墨迹顶的 **SVG y** = `wy + K × 327.15`，而该音符数字的基线 `y`（`symY` 以它为基准）。
 *
 * 实测（用户例 `noteSize=13`、`symY=154.3`）：`wy = 136.9`、`K = 0.006831`
 * ⇒ 波音目标框顶 = 该字形的**墨迹顶**（`glyphMarkup` 按紧包围盒对齐）。
 *
export const MARK_STACK_RATIO = 6

/**
 * adj632b：**数字墨迹**的字形度量（YaHei 粗体 Chrome `measureText` 实测，100px 基准；随字号等比）。
 *
 * 为什么要量墨迹而不是用数字槽：用户对倚音右侧滑音提了三条——
 * 「大小与倚音音符一样大 / 与倚音音符水平 / 紧跟倚音音符」，
 * 三条都得按**数字墨迹**算（槽宽 0.62em 比墨迹宽 0.1~0.27em，用槽算就会"离得远"、纵向对不齐）。
 * 字体是用户可配的 `shuzi_font`，这里按默认无衬线栈的实测值近似（同 `META_GLYPH_W` 的既有做法）。
 */
export const DIGIT_INK_ASC_RATIO = 0.765
/** 数字墨迹 descent / 字号（实测 0~0.02，取 0.02） */
export const DIGIT_INK_DESC_RATIO = 0.02
/** 逐数字墨迹宽 / 字号（实测 1→0.35、2→0.52、3→0.49、4→0.60、5→0.48、6→0.54、7→0.54） */
export const DIGIT_INK_W_RATIO: Record<string, number> = {
  '1': 0.35,
  '2': 0.52,
  '3': 0.49,
  '4': 0.6,
  '5': 0.48,
  '6': 0.54,
  '7': 0.54,
}
/** 数字**墨迹高** = 数字顶到底（asc + desc）× 字号；默认字号下 ≈ 0.785em */
export const digitInkH = (noteSize: number) => (DIGIT_INK_ASC_RATIO + DIGIT_INK_DESC_RATIO) * noteSize
/** 数字**墨迹宽**（按具体数字取表；未知回退 0.48） */
export const digitInkW = (digit: string, noteSize: number) => (DIGIT_INK_W_RATIO[digit] ?? 0.48) * noteSize

/**
 * adj645：变音角标（`#` / `b` / `♮`）的**墨迹**度量（正常字重，Edge/Chrome 像素扫描实测，
 * 200px 基准 → 比值；默认无衬线栈 `'Microsoft YaHei', 'SimHei', 'Segoe UI', sans-serif`）。
 *
 * 为什么必须按**墨迹**而不是**字宽**（同 `E-2026-328` 的教训）：
 *  · 角标画在数字**左侧**、独占一段空隙，它真实占的只有墨迹那点宽度；按 advance 算会多留一条缝
 *    （`#` advance 0.638em vs 墨迹 0.600em，`b` 0.639 vs 0.515，`♮` 更是 **1.000 vs 0.355**）；
 *  · `♮`（U+266E）在本字体栈里落到**全角 CJK 字形**：advance 整 1em、墨迹只有 0.355em 且**居中**
 *    （左偏 lsb 0.325em）——按 advance 定位会把墨迹推到数字身上（实测会压进数字 0.8px）。
 *
 * 交叉校验：同一份实测里粗体数字墨迹宽 1→0.34、2→0.51、3→0.485、4→0.60、5→0.48、6→0.535、7→0.535，
 * 与上表 `DIGIT_INK_W_RATIO`（0.35/0.52/0.49/0.60/0.48/0.54/0.54）逐项吻合 ⇒ 量测环境与既有基准同一套字体。
 */
export const ACC_INK_W_RATIO: Record<'#' | 'b' | '♮', number> = { '#': 0.6, b: 0.515, '♮': 0.355 }
/** 角标墨迹**左偏** / 角标字号（定位用：`pen = 墨迹右缘 − 墨迹宽 − 左偏`） */
export const ACC_INK_LSB_RATIO: Record<'#' | 'b' | '♮', number> = { '#': 0.015, b: 0.08, '♮': 0.325 }

/**
 * adj647（用户要求"墨迹来源也统一"）：**宿主实测的角标字形度量**。
 *
 * 值一律是**相对角标字号的比值**（宿主在任意参考字号上量，除以该字号即得）——引擎再乘角标字号，
 * 于是与字号设置解耦。宿主没给 / 给得不合理 ⇒ 退回上面的内置常量表（默认字体栈实测基准）。
 *
 * 为什么让宿主给：引擎零 DOM、拿不到字形度量，而 `shuzi_font` 是用户可配的——`♮` 在有些字体里是
 * 全角字形（字宽 1em、墨迹 0.355em 且居中）、有些是窄字形；常量表只覆盖默认栈（与 `DIGIT_INK_W_RATIO`
 * 同一取舍）。宿主一次性实测三个字形即可（`canvas.measureText` 的 `actualBoundingBoxLeft/Right`：
 * `inkW = right + left`、`lsb = −left`）。
 */
export interface AccidentalGlyphInk {
  /** 墨迹宽（比值） */
  inkW: number
  /** 墨迹左偏：墨迹左缘相对笔位（比值，一般 ≥0） */
  lsb: number
}
/** 逐字形的宿主实测度量（可只给一部分字形，其余用常量表） */
export type AccidentalInkMetrics = Partial<Record<'#' | 'b' | '♮', AccidentalGlyphInk>>

/**
 * adj647：实测值的**合理性闸门**——比值必须有限且落在合理区间，否则视为无效、退回常量表
 * （同 adj638 对 `wAcc`/`accInkRight` 的"不合理就拒绝补偿"）。
 */
export const isValidAccidentalInk = (v: AccidentalGlyphInk | undefined): v is AccidentalGlyphInk =>
  !!v &&
  Number.isFinite(v.inkW) &&
  Number.isFinite(v.lsb) &&
  v.inkW > 0.05 &&
  v.inkW <= 2 &&
  v.lsb >= -0.5 &&
  v.lsb <= 1

/** 取生效度量：**宿主实测优先**（合理时），否则退回内置常量表 */
export const accidentalInkOf = (glyph: '#' | 'b' | '♮', ink?: AccidentalInkMetrics): AccidentalGlyphInk => {
  const m = ink?.[glyph]
  return isValidAccidentalInk(m) ? m : { inkW: ACC_INK_W_RATIO[glyph], lsb: ACC_INK_LSB_RATIO[glyph] }
}

/** 角标字号 = 音符字号 × 此比率（render 一直用 `12 × s`，s = 字号/18） */
export const ACCIDENTAL_FONT_RATIO = 12 / 18

/**
 * adj646：**角标 ↔ 相邻字符的净距**——描述头调号（`D: C#`）与音符变音（`3#`）**共用这一条规则**。
 *
 * `0.2px @ 13px 基准，随所在字号等比`（所在字号 = 调号行的 `miaoshu_size` / 音符行的 `note_size`）。
 * 描述头那条是 `adj638` 用户四轮口径定下来的（"就 0.2px"），本次把音符变音也并到同一条上：
 * 它此前用的是 `0.05 × 角标字号`（13px 音符下 0.43px，是描述头的 **2.4 倍**）——两处都是"角标紧贴邻字"，
 * 没有理由差一倍多。统一后 13px 字号下两处净距都是 **0.2px**（角标字号不同 ⇒ em 比略有差异，可忽略）。
 */
export const ACC_GAP_PX = 0.2
/** 净距的基准字号（调号/音符的默认字号） */
export const ACC_GAP_BASE_SIZE = 13
/** 角标与相邻字符的净距（`contextSize` = 该行的字号：调号行 / 音符行） */
export const accidentalGap = (contextSize: number) => ACC_GAP_PX * (contextSize / ACC_GAP_BASE_SIZE)

/** 倚音修饰符字号 = 记号所属音符字号 × `SYM_FONT_RATIO` */
export const markFontSize = (noteSize: number) => noteSize * SYM_FONT_RATIO
/** adj632b：倚音右侧滑音记号**紧贴**数字墨迹右缘的净距（px，× 倚音缩放因子 gs） */
export const GRACE_MARK_HUG_GAP = 1

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

// ---- 临时多声部段（adj667：{dsb … } 的大括号横向几何）----
/**
 * adj667（用户口径「元素布局时不得重叠，除非明确要重叠」）：`{dsb … }` 大括号的**理想横向宽高比**。
 *
 * 大括号用填充图形（`public/icons/大括号.svg`）：它是**填充**字形，粗细与形状是同一个轮廓，
 * 等比铺满段高会越看越像一坨黑；要"细"只能**横向收**。`0.1 × 段高` 是唯一旋钮——
 * 调大更饱满、调小更细（用户 adj671 口径：由 0.12 调到 **0.1**）。
 *
 * ⚠️ 这只是**理想值**：真实宽度由布局按"两侧邻居的墨迹边界"钳制（见 `layout/index.ts`
 * 的 `placeSegmentOverlays`），空间不足时变窄，**绝不允许越出去压到相邻音符**。
 * 布局与渲染共用本常量（渲染不再自己按高度算）。
 */
export const SEGMENT_BRACE_ASPECT = 0.1

/** adj667：大括号墨迹的**最小宽度**（再窄就看不出来了；此时宁可略微靠近但绝不越界） */
export const SEGMENT_BRACE_MIN_W = 1.6

/**
 * adj668：**行内"行顶 → 音符基线"的比例**（行顶 = 基线 − 该比例 × 字号）。
 *
 * 数值与布局既有写法一致（`m.noteSize * 1.1`，见 `placeMusicRow*` 的 `barNoteY`）。
 * 抽出来是因为"临时段的纵向余量"必须按**同一把尺子**判断"是否伸出了行顶/行底"，
 * 两处各写一个 1.1 早晚会漂。
 */
export const NOTE_BASELINE_RATIO = 1.1

/** adj668：**行内"音符基线 → 曲部下沿"的比例**（= 曲部行高 `1.7×字号` − 行顶偏移） */
export const NOTE_BOTTOM_RATIO = 0.6

/**
 * adj667：大括号墨迹与相邻元素墨迹之间的**净距上限**（px）。
 * 空间富余时按此留白；空间紧张时**先让净距、再压括号宽度**（保证不重叠优先）。
 */
export const SEGMENT_BRACE_INK_GAP = 0.5

/**
 * adj699：跳房子线与"下方最高墨迹"（连音线弧顶 / 高八度点顶 / 数字顶）之间的间距（px）。
 *
 * 用户口径：「跳房子线与连音线的顶端、高八度点等其它修饰符的**墨迹顶端**间距 **2px** 为宜」。
 * 与字号无关（固定像素），故不乘 `noteScaleOf`。
 */
export const VOLTA_INK_GAP = 2
/**
 * adj670（用户口径：「(1'// 7// 6//) (6// 6/) 这部分的连音线是在下面的**反转的**」）：
 * `{dsb}` 上下两层之间**必须容纳**的内容 = 上层声部的**减时线层底** + 下层声部连音线的**弧顶**。
 * 于是布局要按需把 `segmentRowGap.dsb` **撑到这个下限**（否则连音线只能翻到下方，用户不接受）。
 *
 * 本常量是"上层墨迹底 与 下层弧顶"之间还要留的净距。
 */
export const SEGMENT_LAYER_CLEARANCE = 2

/** 连音线垂度（弧高）的**下限**：极窄连音线不至于细成一条看不见的线（adj649） */
export const SLUR_SAG_MIN = 2.5
/**
 * 连音线垂度（弧高）的**上限**：`垂度 = clamp(跨度 × 0.28, SLUR_SAG_MIN, SLUR_SAG_MAX)`（adj649）。
 *
 * adj670：布局算"`{dsb}` 两层最小间距"时拿它当**保守上界**——那时还不知道连音线的实际跨度
 * （x 方向要等放置完），只能按最大垂度预留，宁可略松也不让弧顶压到上层减时线。
 */
export const SLUR_SAG_MAX = 9

/**
 * adj713/adj714：**连音线垂度** `sag = clamp(跨度 × 0.28, SLUR_SAG_MIN, SLUR_SAG_MAX)`。
 *
 * 为什么必须是公共纯函数（`AGENTS` 六之二·4「数值口径必须同源」）：
 *  · 渲染端 `renderSlur` 用它算贝塞尔控制点（`M x1 y Q mid (y − sag) x2 y`）；
 *  · 布局端要按**弧顶**（= `y − sag/2`，二次贝塞尔 `t = 0.5`）算"与下一层的净空"——
 *    用户口径（`AGENTS` 五·10）要求**跨音符修饰符层**让开高八度点与本音符修饰符。
 * 两处若各写一份公式，"净空够不够"就会两边算出不同答案（本项目已复发多次）。
 */
export const slurSagOf = (span: number): number =>
  Math.max(SLUR_SAG_MIN, Math.min(SLUR_SAG_MAX, span * 0.28))

/** adj714：连音线**弧顶** y（二次贝塞尔 `t = 0.5` ⇒ `y − sag/2`）——层级净空判断只用它 */
export const slurApexY = (y: number, x1: number, x2: number): number => y - slurSagOf(Math.abs(x2 - x1)) / 2

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

/**
 * 低八度点：第 i 个点 cy（点顶距数字底或减时线层底 LAYER_GAP×scale；dc=0 表示无减时线）
 */
export const lowDotY = (y: number, i: number, dc: number, noteSize: number) => {
  const s = noteScaleOf(noteSize)
  const top =
    dc > 0 ? beamBottomY(y, dc, noteSize) + LAYER_GAP * s : digitBottomY(y, noteSize) + LAYER_GAP * s
  return top + DOT_R * s + i * (DOT_R * 2 + INNER_GAP) * s
}

// ============================================================
// 修饰符「层级栈」（adj714，用户口径；见 AGENTS 五·10）
// ============================================================

/**
 * adj714（用户 2026-10 给出的**主规则**，见 `AGENTS.md` 五·10）：
 * 音符的修饰符从音符往上/往下各有**固定层级**，叠加时以
 * **「音符与修饰符的墨迹不重叠（不覆盖）」为主要原则**，层级之间适当留白（`LAYER_GAP`）。
 *
 * ```
 *   音符往上（由低到高）        音符往下（由近到远）
 *   ① octave    高八度点        ① beam      减时线
 *   ② noteMark  本音符修饰符    ② lowDot    低八度点
 *   ③ spanMark  跨音符修饰符    ③ belowMark 其它下方修饰符
 *   ④ section   跨小节/章节修饰符
 * ```
 *
 * 本常量是**层级顺序的唯一表述**（AGENTS 六之二·4「数值口径必须同源」）：
 * 布局端与渲染端都从这里取顺序，不许各自现排。
 */
export const MODIFIER_LAYERS_ABOVE = ['octave', 'noteMark', 'spanMark', 'section'] as const
export const MODIFIER_LAYERS_BELOW = ['beam', 'lowDot', 'belowMark'] as const
export type ModifierLayerAbove = (typeof MODIFIER_LAYERS_ABOVE)[number]
export type ModifierLayerBelow = (typeof MODIFIER_LAYERS_BELOW)[number]

/** 某音符上方各修饰层的**墨迹顶** y（由低到高；`null` = 该层没有元素） */
export interface NoteModifierGeometry {
  /** 该音符的画音基线 y */
  y: number
  /** 高八度点个数（0 = 无） */
  octaves: number
  /** 本音符修饰符（波音/顿音/颤音/注释…）的**墨迹高**（0 = 无，按 `LAYER_GAP` 直接叠） */
  noteMarkInkH: number
  /** 跨音符修饰符（连音线弧顶 / 渐强渐弱的**墨迹高**） */
  spanMarkInkH: number
  /** 跨小节修饰符（跳房子线）的**墨迹高** */
  sectionInkH: number
}

/**
 * 按层级栈自下而上算出**每层墨迹顶**的 y（adj714）。
 *
 * 语义：第 ① 层紧贴音符；其后每层的**底**都在上一层**顶**之上 `LAYER_GAP`。
 * 返回的 `top` 是"该层最高元素的墨迹顶"，供再上一层与"行顶预算"使用。
 */
export function modifierLayerTops(g: NoteModifierGeometry, noteSize: number): Record<ModifierLayerAbove, number | null> {
  const s = noteScaleOf(noteSize)
  const gap = LAYER_GAP * s
  let cursor = octaveTopY(g.y, Math.max(1, g.octaves), noteSize)
  const octave = g.octaves > 0 ? cursor : null
  if (g.octaves > 0) cursor -= gap
  else cursor = digitTopY(g.y, noteSize) - gap
  const noteMark = g.noteMarkInkH > 0 ? cursor : null
  if (g.noteMarkInkH > 0) cursor -= g.noteMarkInkH + gap
  const spanMark = g.spanMarkInkH > 0 ? cursor : null
  if (g.spanMarkInkH > 0) cursor -= g.spanMarkInkH + gap
  const section = g.sectionInkH > 0 ? cursor : null
  return { octave, noteMark, spanMark, section }
}

/**
 * adj714：层级顺序的**机器闸门**——校验"上一层墨迹底 ≥ 下一层墨迹顶 + `LAYER_GAP`"。
 *
 * 供 smoke 断言直接调用：传入实测的相邻两层边界，返回违反量（≤ 0 = 合规）。
 * 之所以做成纯函数：层级的正确性是**跨元素**的（漏一层就整段错位），
 * 靠人眼看图很容易漏（连音线垂度那次就是这么漏掉的）。
 */
export function layerSeparationViolation(lowerInkTop: number, upperInkBottom: number, noteSize: number): number {
  return upperInkBottom - (lowerInkTop - LAYER_GAP * noteScaleOf(noteSize))
}

// ============================================================
// 谱尾说明（`S:`）的行位置
// ============================================================

/** 说明文字的行高比例（行距 = 说明字号 × 此值；同一段内换行与不同 `S:` 段共用） */
export const NOTES_LINE_H_RATIO = 1.4

/** 末行文字**字底**距下边距线的余量（px）——"紧靠"但不压线 */
export const NOTES_BOTTOM_GAP = 2

/** 字形下伸比例（CJK/拉丁混排取 0.15em，够容纳数字与汉字的下缘） */
export const NOTES_DESCENT_RATIO = 0.15

/**
 * adj630b（用户要求「`S:` 应紧靠右下边距线，并随右边距线和下边距线调整」）：
 * **谱尾说明的行基线**——整块**自下而上**排，**末行贴下边距线**，往上逐行退 `字号×1.4`。
 *
 * 为什么是"末行贴线"而不是"首行离线 24px 往下排"：后者在多行（或多段、或超宽换行）时会一路
 * **越过下边距线**跑出页面（旧实现 `height − margin_bottom − 24 + i×1.4×字号` 就是这个形状），
 * 而"整块靠右下角"的正确读法是**块底贴着下边距线、往上长**。
 *
 * 渲染端（`render/index.ts`）与预览端拖拽基准（`PreviewPane.tsx`）**共用本函数**，
 * 保证"页面自带的默认位置"与"拖拽偏移的零点"是同一个数（否则一拖就跳）。
 *
 * @param pageH        页高（pt）
 * @param marginBottom 下边距
 * @param nSize        说明字号（`notes_size`，缺省随描述头）
 * @param row          该子行在**整块**里的序号（0 起，跨 `S:` 段与换行子行连续编号）
 * @param totalRows    整块子行总数（决定首行往上退多少）
 */
export function notesRowBaseline(o: {
  pageH: number
  marginBottom: number
  nSize: number
  row: number
  totalRows: number
}): number {
  const lineH = o.nSize * NOTES_LINE_H_RATIO
  const bottom = o.pageH - o.marginBottom - NOTES_BOTTOM_GAP - o.nSize * NOTES_DESCENT_RATIO
  return bottom - (Math.max(1, o.totalRows) - 1 - o.row) * lineH
}
