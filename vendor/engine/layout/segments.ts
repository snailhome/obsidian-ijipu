/**
 * engine/layout/segments.ts — 临时段（`{bz … }` / `{dsb … }`）的**拍位包络**计算（adj427）
 *
 * 语义（依据用户规范 + 图 1/图 2 反推验证）：
 *  - 临时段是**叠加**：出现在曲行中间时**不占主旋律时值**（对主旋律时间轴贡献 0 拍），
 *    段后的 token 从段前同一拍位继续。
 *  - **包络** = `[段所在拍位, 段所在拍位 + 段自身总拍数)`；用户规则「bz 段总宽 =
 *    包裹范围主旋律拍数」即：段内内容按比例映射到该宽度内，段内**小节线**按段内自身
 *    拍位推进后映射到包络内的相对位置。
 *
 * 用图 1 示例验证：`3 4 | {bz 1 2 3 4 | 5 6 7 1'} 5 6 7 1' | 1' 7 6 5 | 5 5`
 *  - `3 4` 占拍 0~2 → 段出现在**拍位 2**
 *  - 段内 8 个音（各 1 拍）= 8 拍 → **包络 [2, 10)**
 *  - 主旋律在 [2, 10) 内恰为 `5 6 7 1' | 1' 7 6 5`（8 拍）—— 即 dsb 的**下层声部**
 *  - 主旋律包络外剩余 `5 5`
 *
 * 本模块只做**纯计算**（零 React/DOM/浏览器 API），layout 与 render 共用；
 * 关键行为在 `scripts/smoke.mts` 有断言。
 */
import type { MusicToken } from '../types'
import { tokenDuration } from '../duration'
import {
  DIGIT_HEIGHT_RATIO,
  LAYER_GAP,
  SLUR_W,
  octaveDotY,
  DOT_R,
  noteScaleOf,
  beamBottomY,
  lowDotY,
  NOTE_BASELINE_RATIO,
  SEGMENT_LAYER_CLEARANCE,
  SLUR_SAG_MAX,
} from './spacing'

/** 计时 token 联合（音符 / 休止符 / 节奏符）——由下方 isDurational 收窄 */
export type DurationalToken = Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>

/** 可计时的 token 种类判定（音符 / 休止符 / 节奏符）——类型谓词，便于调用处自动收窄 */
export function isDurational(t: MusicToken): t is DurationalToken {
  return t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
}

/** 一段 token 序列的总拍数（只累加计时 token；段对时间的贡献为 0，天然跳过） */
export function tokensBeats(tokens: MusicToken[]): number {
  let sum = 0
  for (const t of tokens) if (isDurational(t)) sum += tokenDuration(t)
  return sum
}

/** 段内小节线的**拍位**列表（按段内自身拍位从 0 起推进）——供「段内小节线按自身拍位映射」 */
export function segmentBarBeats(tokens: MusicToken[]): number[] {
  const out: number[] = []
  let beat = 0
  for (const t of tokens) {
    if (t.kind === 'barline') {
      out.push(beat)
      continue
    }
    if (isDurational(t)) beat += tokenDuration(t)
  }
  return out
}

/** 一个临时段的包络信息 */
export interface SegmentInfo {
  /** 段类型：bz 临时伴奏 / dsb 临时多声部 / tp 替谱段（adj629，来自歌词行 `{tp … }`） */
  type: 'bz' | 'dsb' | 'tp'
  /**
   * adj629：**替谱段专属**——替代的是第几遍（1 起，= 所属歌词行的序号）。
   * 只有 `type === 'tp'` 时有值；播放端据此按遍次替换主旋律。
   */
  pass?: number
  /** adj629d：替谱段的源码坐标（歌词行号 / 该行内第几个 `{tp}`）——id 命名空间用，见 `tpNoteIndexBase` */
  tpLine?: number
  tpVariant?: number
  /** 段头（open）token 在 token 序列中的下标 */
  openIndex: number
  /** 段结束（close）token 下标；-1 = 未闭合（tokenizer 兜底路径） */
  closeIndex: number
  /** 包络起始拍（段出现处的主旋律拍位） */
  startBeat: number
  /** 段自身总拍数（= 包络长度） */
  beats: number
  /** 段内 token（段头 token 的 children） */
  tokens: MusicToken[]
  /** 段内小节线拍位（相对段起点，0 起） */
  barBeats: number[]
}

/** 主旋律中一个计时 token 的拍位跨度 */
export interface MainSpan {
  token: DurationalToken
  /** token 在 token 序列中的下标 */
  index: number
  /** 起始拍 */
  startBeat: number
  /** 拍数 */
  beats: number
}

/**
 * 计算曲行内全部临时段的包络信息（按源码顺序）。
 *
 * 段对主旋律时间轴贡献 **0 拍**——因此段后的 token 与段前的拍位连续；
 * `Map<openIndex, SegmentInfo>` 形式便于 layout 在遇到段 token 时 O(1) 取用。
 */
export function computeSegments(tokens: MusicToken[]): SegmentInfo[] {
  const out: SegmentInfo[] = []
  let beat = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'segment') {
      if (t.dir === 'open') {
        const children = t.children ?? []
        // close 配对：tokenizer 保证 open 紧邻 close；此处只探一步，不跨越其它 token
        const next = tokens[i + 1]
        const closeIndex = next && next.kind === 'segment' && next.dir === 'close' && next.type === t.type ? i + 1 : -1
        out.push({
          type: t.type,
          ...(t.pass !== undefined ? { pass: t.pass } : {}), // adj629：替谱段带遍次
          ...(t.tpLine !== undefined ? { tpLine: t.tpLine } : {}), // adj629d：替谱段的源码坐标
          ...(t.tpVariant !== undefined ? { tpVariant: t.tpVariant } : {}),
          openIndex: i,
          closeIndex,
          startBeat: beat,
          beats: tokensBeats(children),
          tokens: children,
          barBeats: segmentBarBeats(children),
        })
      }
      continue // 段不占主旋律拍位
    }
    if (isDurational(t)) beat += tokenDuration(t)
  }
  return out
}

/**
 * 主旋律的计时 token 跨度表（**跳过临时段**——段不占主旋律拍位）。
 *
 * 用途：
 *  - 取包络内主旋律音（dsb **下层声部**；bz 则用于确认叠加对象）；
 *  - 主旋律 x 坐标与包络 x 区间对齐（layout）。
 */
export function mainSpans(tokens: MusicToken[]): MainSpan[] {
  const out: MainSpan[] = []
  let beat = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!isDurational(t)) continue
    const beats = tokenDuration(t)
    out.push({ token: t, index: i, startBeat: beat, beats })
    beat += beats
  }
  return out
}

/** 取与 [from, to) 有交集的计时 token 跨度（dsb 下层声部 / 包络内取音） */
export function mainSpansInRange(spans: MainSpan[], from: number, to: number): MainSpan[] {
  return spans.filter((s) => s.startBeat < to - 1e-9 && s.startBeat + s.beats > from + 1e-9)
}

/** 段内相对拍位 → 包络内相对比例（钳制到 [0,1]；totalBeats ≤ 0 时返回 0） */
export function beatRatio(beatInSegment: number, totalBeats: number): number {
  if (totalBeats <= 0) return 0
  return Math.min(1, Math.max(0, beatInSegment / totalBeats))
}

// ============================================================
// adj668：临时段给**所在视觉行**带来的纵向余量
// ============================================================

/** 一个视觉行因临时段而需要的纵向余量（px，均 ≥ 0） */
export interface SegmentRowExtra {
  /** **行顶之上**还需要的高度——段层上层（`{dsb}` 上声部 / `{bz}` 伴奏层）会伸出行顶 */
  up: number
  /** 段层墨迹的**底缘**相对"行音符基线"的偏移（px，正值向下；只算 `{dsb}` 的下层声部，`{bz}` 为 0） */
  botInk: number
  /**
   * adj670：本行段层实际采用的**纵向间距**（`{dsb}` = 上下两层间距）。
   * 它是 `max(用户设置, 容纳两层内容所需的最小值)`（见 `segmentMinGap`）——
   * 供调用方算 `segH`（大括号高度）等派生量，避免与 `up`／`botInk` 用两套值。
   */
  gap: number
}

/**
 * adj670（用户口径）：「`{dsb}` 上下两层之间**必须放得下**上层声部的减时线 + 下层声部的连音线」。
 *
 * 为什么不能只信 `segmentRowGap.dsb`（默认 22）：两层净空 = `间距 − 数字高`（22 − 10.4 ≈ 11.6px），
 * 而下层连音线自数字顶再往上要占 `层距 + 描边 + 垂度(≤9)` ≈ 11.4px，**再加**上层的减时线层
 * （`//` 是十六分音符 ⇒ 2 条线，层底距基线 5.1px）⇒ 必然相撞。撞了只有两条路：把弧线翻到下方
 * （用户明确否掉：「连音线是在下面的**反转的**」）或**把间距撑开**。这里选后者。
 */
export function segmentMinGap(
  seg: SegmentInfo,
  rowTokens: MusicToken[],
  noteSize: number,
  clearance: number,
): number {
  const s = noteScaleOf(noteSize)
  /** 上层（段内容）的墨迹**下缘**（相对上层基线，正值向下） */
  let upperBottom = 0
  for (const t of seg.tokens) {
    if (!isDurational(t)) continue
    const dc = t.kind === 'note' ? (t.diminishCount ?? 0) : 0
    if (dc > 0) upperBottom = Math.max(upperBottom, beamBottomY(0, dc, noteSize))
    const oct = t.kind === 'note' ? t.octaveShift : 0
    if (oct < 0) upperBottom = Math.max(upperBottom, lowDotY(0, -oct - 1, dc, noteSize) + DOT_R * s)
  }
  /** 下层（包络内的主旋律）墨迹**顶**相对下层基线的距离（正值） */
  let lowerTop = noteSize * DIGIT_HEIGHT_RATIO
  let hasSlur = false
  {
    let beat = 0
    for (const t of rowTokens) {
      if (t.kind === 'segment') continue
      if (isDurational(t)) {
        if (beat >= seg.startBeat - 1e-9 && beat < seg.startBeat + seg.beats - 1e-9) {
          const oct = t.kind === 'note' ? t.octaveShift : 0
          if (oct > 0) {
            // 高八度点层顶（相对基线）
            lowerTop = Math.max(lowerTop, noteSize * DIGIT_HEIGHT_RATIO - (octaveDotY(0, oct - 1, noteSize) - DOT_R * s))
          }
        }
        beat += tokenDuration(t)
        continue
      }
      // 连音线 token：出现在它所覆盖的那些音符**之前**，落在包络内（**开区间**——恰好落在
      // 包络终点上的那条连音线属于**下一段**，闭区间会让相邻两段都误判成"有连音线"）
      if (t.kind === 'slur' && beat >= seg.startBeat - 1e-9 && beat < seg.startBeat + seg.beats - 1e-9) hasSlur = true
    }
  }
  if (hasSlur) {
    lowerTop = Math.max(lowerTop, noteSize * DIGIT_HEIGHT_RATIO + LAYER_GAP * s + (SLUR_W * s) / 2 + SLUR_SAG_MAX + SLUR_W / 2)
  }
  return upperBottom + lowerTop + clearance
}

/**
 * adj668（用户要求）：「临时多声部通常只涉及部分行，**应该就这些行增加行间距**以容纳多出来的层，
 * 其它行不受影响」。
 *
 * 为什么必须这么做：`{dsb}` 的上层声部基线 = `行基线 − 间距/2`、还要加上高八度点与连音线，
 * 实测**伸出"行顶"约 11.7px**。此前布局把这部分当作"叠加"直接**外溢**到相邻行的地盘
 * （上一行的歌词区 / 下一行的内容），于是只能靠"抬跳房子线"这类补丁到处救火。
 * 现在把它算成**本行的高度预算**：`up` 记在本行之前、下方余量记在本行之后，后续行整体下移
 * ——只有含段层的行会变高。
 *
 * 口径（相对行音符基线，`y` 为负表示在上方）：
 *  · 段层基线：`{dsb}` = `−间距/2`（上下各半，整块与主旋律居中）；`{bz}` = `−间距`（只在上方）；
 *  · 段层墨迹顶 = min(数字顶、最高高八度点顶、大括号顶、段层连音线弧顶)；
 *  · `up` = 行顶（`−1.1×字号`）减该墨迹顶；
 *  · `botInk` = 下层声部墨迹底（连音线一律画在上方 ⇒ 不再有"翻到下方"的弧底）。
 *
 * adj670：间距取 `max(用户设置, segmentMinGap(...))`——**"不重叠"优先于"用户把间距调小"**，
 * 调大仍然生效（它只是个下限）。
 *
 * `{tp}` 不在这里算——替谱层有自己的一套（`tpGeometry`，挂在歌词行上方）。
 */
export function segmentRowExtra(
  segsInRow: SegmentInfo[],
  rowTokens: MusicToken[],
  noteSize: number,
  gapOf: (type: 'bz' | 'dsb' | 'tp') => number,
): SegmentRowExtra {
  const s = noteScaleOf(noteSize)
  /** 段层连音线画在段层音符**上方**时额外占的高度（弧垂度上限 + 层距 + 描边） */
  const slurExtra = LAYER_GAP * s + (SLUR_W * s) / 2 + SLUR_SAG_MAX + SLUR_W / 2
  let up = 0
  let botInk = 0
  let gap = 0
  for (const sg of segsInRow) {
    if (sg.type === 'tp') continue
    // adj670：间距 = max(用户设置, 容纳两层内容所需的最小值)
    const dy = Math.max(gapOf(sg.type), segmentMinGap(sg, rowTokens, noteSize, SEGMENT_LAYER_CLEARANCE))
    gap = Math.max(gap, dy)
    const baseOff = sg.type === 'dsb' ? -dy / 2 : -dy
    let maxOct = 0
    let hasSlur = false
    for (const t of sg.tokens) {
      if (t.kind === 'note' && t.octaveShift > maxOct) maxOct = t.octaveShift
      if (t.kind === 'slur') hasSlur = true
    }
    let topInk = baseOff - noteSize * DIGIT_HEIGHT_RATIO
    if (maxOct > 0) topInk = Math.min(topInk, octaveDotY(baseOff, maxOct - 1, noteSize) - DOT_R * s)
    // 大括号顶（它的设计口径本就比数字顶更高，取更保守者）
    topInk = Math.min(topInk, baseOff - noteSize * 1.15)
    if (hasSlur) topInk -= slurExtra
    up = Math.max(up, -noteSize * NOTE_BASELINE_RATIO - topInk)
    if (sg.type === 'dsb') {
      botInk = Math.max(botInk, dy / 2 + noteSize * 0.3)
    }
  }
  return { up, botInk, gap }
}

// ============================================================
// adj445：段内音符 / 段内小节线的 **id 命名空间编码**
// ============================================================

/**
 * 为什么段内音符需要独立命名空间：
 * 临时段对主旋律时间轴贡献 **0 拍**，段内音符**不在** Q 行的「全局音符序号」流里
 * （`cursorMap.codePosToNoteId` 逐 token 计数得到的主旋律序号与段内音符完全无关）。
 * 因此段内音符的 id 必须由「组号 + 段头 token 下标 + 段内时值序号」三元组编码，
 * 才能由 id **反推源码位置**（光标联动的两个方向都要用），也能与主旋律序号彻底隔离。
 *
 * 编码：`SEG_NOTE_ID_BASE + 组号×1e6 + 段头下标×1e3 + 段内时值序号`
 *  - 组号跨距 1e6 ⇒ 同一组内段头下标（<1000）与段内时值数（<1000）都不会越界；
 *  - 小节线另用 `SEG_BAR_ID_BASE` 一段，两个命名空间互不重叠；
 *  - 与主旋律 id（0 起递增的小整数）天然隔离。
 *
 * 注意（历史缺陷）：adj427～adj444 的旧编码是 `900000 + 组号×1000 + 段头下标×10 + 序号`，
 * 「段头下标×10」的跨距只有 10 ⇒ **段内时值 token 超过 10 个时相邻段就会撞号**
 * （`{bz 1 2 3 4 5 6 7 8 | 1' 2' 3' 4'}` 这类 12 音段极常见），撞号会让
 * 「按 id 高亮/定位」命中错误音符。此处一并修正。
 */
export const SEG_NOTE_ID_BASE = 1e12
export const SEG_BAR_ID_BASE = 5e12
/** 组号跨距（一组/一行内的段 id 区块） */
export const SEG_ID_GROUP_STRIDE = 1e6
/** 段头 token 下标跨距（一组内的各段 id 区块） */
export const SEG_ID_OPEN_STRIDE = 1e3

/** 第 `group` 组第 `openIndex` 个段头对应的**段内音符** id 基值（+ 段内时值序号 = 音符 id） */
export function segmentNoteIndexBase(group: number, openIndex: number): number {
  return SEG_NOTE_ID_BASE + group * SEG_ID_GROUP_STRIDE + openIndex * SEG_ID_OPEN_STRIDE
}

/** 第 `group` 组第 `openIndex` 个段头对应的**段内小节线** id 基值（+ 段内小节线序号） */
export function segmentBarIndexBase(group: number, openIndex: number): number {
  return SEG_BAR_ID_BASE + group * SEG_ID_GROUP_STRIDE + openIndex * SEG_ID_OPEN_STRIDE
}

// ============================================================
// adj629d：**替谱段（`{tp … }`，写在歌词行里）的 id 命名空间**
// ============================================================

/**
 * 为什么替谱段要单独一套 id：它的段头 token 是**解析期注入**到曲行 token 流里的，
 * `openIndex` 是"注入后的下标"——**源码侧（cursorMap 只重新分词 `Q:` 行）复现不出来**，
 * 于是"点谱面跳脚本 / 点音符跳过去试听"两条路都断（用户报）。
 *
 * 改用源码可推导的三元组：`组号 + 歌词行号 + 该行内第几个 {tp} + 段内时值序号`：
 *  - 歌词行号 = 该 `C…:` 行在所属曲行歌词列表里的序号（= 第几遍）；
 *  - 行内序号 = 同一行里第几个 `{tp … }`（一行可以有多处替谱）。
 * 范围：`SEG_TP_NOTE_ID_BASE`(9e12) 起，与段层（1e12）/段层小节线（5e12）互不重叠。
 */
export const SEG_TP_NOTE_ID_BASE = 9e12
/** 一行内最多 10 处 `{tp … }`（`lineIdx×10 + variantIdx` 的跨距） */
export const SEG_TP_ID_VARIANT_STRIDE = 10

/** 第 `group` 组、第 `lineIdx` 条歌词行、该行第 `variantIdx` 个 `{tp}` 的段内音符 id 基值 */
export function tpNoteIndexBase(group: number, lineIdx: number, variantIdx: number): number {
  return (
    SEG_TP_NOTE_ID_BASE +
    group * SEG_ID_GROUP_STRIDE +
    (lineIdx * SEG_TP_ID_VARIANT_STRIDE + variantIdx) * SEG_ID_OPEN_STRIDE
  )
}

/** 替谱段音符 id 判定 + 解码；非替谱段 id 返回 null */
export function decodeTpNoteId(
  index: number,
): { group: number; lineIdx: number; variantIdx: number; durSeq: number } | null {
  if (!Number.isFinite(index) || index < SEG_TP_NOTE_ID_BASE) return null
  const off = index - SEG_TP_NOTE_ID_BASE
  const group = Math.floor(off / SEG_ID_GROUP_STRIDE)
  const rest = off % SEG_ID_GROUP_STRIDE
  const mid = Math.floor(rest / SEG_ID_OPEN_STRIDE)
  return {
    group,
    lineIdx: Math.floor(mid / SEG_TP_ID_VARIANT_STRIDE),
    variantIdx: mid % SEG_TP_ID_VARIANT_STRIDE,
    durSeq: rest % SEG_ID_OPEN_STRIDE,
  }
}

/** 段内音符 id 判定 + 解码；非段内音符 id（含段内小节线）返回 null */
export function decodeSegmentNoteId(
  index: number,
): { group: number; openIndex: number; durSeq: number } | null {
  if (!Number.isFinite(index) || index < SEG_NOTE_ID_BASE || index >= SEG_BAR_ID_BASE) return null
  const off = index - SEG_NOTE_ID_BASE
  const group = Math.floor(off / SEG_ID_GROUP_STRIDE)
  const rest = off % SEG_ID_GROUP_STRIDE
  return {
    group,
    openIndex: Math.floor(rest / SEG_ID_OPEN_STRIDE),
    durSeq: rest % SEG_ID_OPEN_STRIDE,
  }
}
