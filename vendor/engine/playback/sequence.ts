/**
 * engine/playback/sequence.ts — 播放序列构建（纯函数，可单测）
 *
 * 输入：解析结果 + 排版结果 + 拍速（BPM）
 * 输出：按实际播放顺序展开的事件序列（含反复记号展开）：
 *  - `|:` / `:|`：段内反复（两遍）
 *  - `:|:`：包围式反复（段起点/终点）
 *  - `[ ]` 跳房子：第一遍经过 [ 段，第二遍跳过
 *  - `||` / `||/`：终止线，播放到此结束
 */
import type {
  BarlineMark,
  BarlineType,
  MusicToken,
  ParseResult,
  PlacedBarline,
  PlacedSegmentBracket,
  PlacedToken,
  ScoreLayout,
  ScorePage,
  VoiceBlock,
} from '../types'
import { tokenDuration } from '../duration'
import { parseKey, pitchToName, isJumpOrEndBarline } from '../layout/index'
import { graceGroupBeats, gracePerNoteBeats } from '../layout/spaceLayout'
// adj629d：段层/替谱音符 id 判定（试听"点音符跳过去"要按 id 精确命中事件）
import { decodeSegmentNoteId, decodeTpNoteId } from '../layout/segments'
// adj502/adj635：演奏型装饰（波音 / 打音 / 叠音）的时值——纯函数模块，见其文件头的口径与不变式
// adj636：滑音（上滑音 / 下滑音）的逐半音阶梯——纯函数模块，见 slides.ts
import { ornamentOf, ornamentPlan, neighborDegree } from './ornaments'
import { slideOf, slidePlan } from './slides'
import { midiToPitchName, pitchToMidiNote } from './midi'
import { parseInstrumentRef } from './instruments'

/** adj427：第 2 可用音色的内置默认（用户规格：第 1 = 大钢琴、第 2 = 手风琴） */
const ACCOMP_FALLBACK_INSTRUMENT = '手风琴'
/** adj427：伴奏 / 第二声部的力度倍率（用户规格：重叠的伴奏部分用 0.75） */
const ACCOMP_GAIN = 0.75

/**
 * 解析音符 id（"page_voice_group_index"）为全局音符序号定位起点。
 * 返回 { index }（全局音符索引，按 byIndex 映射）；无法解析返回 null。
 */
function parseStartNoteIdx(id: string): { index: number } | null {
  const parts = id.split('_')
  const index = Number(parts[parts.length - 1])
  return Number.isFinite(index) ? { index } : null
}

/** adj300：播放拍段（每段 ≤1 拍）——色块按拍段滑动；连音合并时后续音符拍段并入事件 */
/** adj429：色块高度**按曲行几何动态定界**（多声部/临时叠加段不再互相覆盖、也不再压到歌词）。
 *  单声部默认 = `[y − 1.6×字号, y + 0.6×字号]`，不传 yTopMin/yBottomMax 即可；
 *  多声部/临时段场景在 `buildPlayheadSegs` 里按相邻声部/上下层的中线算出 → 写到这两个可选字段。 */
export interface PlayheadSeg {
  /** 段起点拍偏移（相对事件起点） */
  beat: number
  /** 段拍数（≤1） */
  beats: number
  pageIndex: number
  x: number
  y: number
  width: number
  voice: number
  group: number
  /** adj427：该事件所用乐器名——色块**按音色着色**（不同音色不同颜色，切换音色时能看到变色） */
  instrument?: string
  /** adj429：色块**上边界**（绝对 y）。未设 = 用默认 `[y − 1.6×字号, y + 0.6×字号]`。 */
  yTopMin?: number
  /** adj429：色块**下边界**（绝对 y）。未设 = 用默认 `[y − 1.6×字号, y + 0.6×字号]`。 */
  yBottomMax?: number
  /** adj432: voice role (inherited from PlacedToken.playVoice) — used by preview layer to color
   *  bz upper = 'accomp' (accompaniment color), dsb lower = 'second' (second-voice color),
   *  dsb upper = 'main' (matches primary). */
  playVoice?: 'accomp' | 'main' | 'second'
  /**
   * adj451：该拍段所属事件的**力度倍率**（与 `PlayEvent.gain` 同源，缺省 1）——
   * 色块轨道与音频事件共用同一个力度变量：目前由 adj427 写入（重叠伴奏/第二声部 0.75），
   * **预留给强弱单（渐强/渐弱 `hairpin`）与力度记号**：后续只要在 `buildPlaySequence` 里给每个事件算出
   * 逐音力度，音频（`schedulePlay` 的 `0.5 × gain`）与色块轨道（本字段）会自动一致，
   * 无需再改数据结构。详见 `layout/hairpins.ts`（记号目前只参与排版，未参与发声）。
   */
  gain?: number
}

export interface PlayEvent {
  placed: PlacedToken
  /** 距开始的延迟（ms） */
  atMs: number
  /** 时值（ms） */
  durationMs: number
  /** 音高覆盖（倚音等装饰音，MIDI 音名；缺省用 placed.audioPitch，adj23） */
  pitch?: string | null
  /** adj257：乐器名（多声部按各自乐器同时演奏；缺省 = 通用音色） */
  instrument?: string
  /**
   * adj427：**力度倍率**（乘在基础增益上；缺省 1）。用户规格：重叠的伴奏/第二声部用 **0.75**。
   * 预留给后续的力度记号（`&mp` 等）扩展使用。
   */
  gain?: number
  /**
   * adj427：该事件的**声部角色**（来自 `PlacedToken.playVoice`）。
   * `'accomp'` / `'second'` = 伴奏 / 第二声部——播放端须让它们**保留自己的音色**，
   * 不被「试听音色」的全局覆盖压掉（否则两个声部会听成同一种音色）。
   */
  playVoice?: 'accomp' | 'main' | 'second'
  /**
   * adj434：该事件的音色是**谱面显式指定**的（来自曲内 `@乐器名@` 切换）。
   *
   * 为什么要这个标记：播放端「试听音色」下拉选定具体音色时会做**全局覆盖**
   * （`SpessaSynthBackend.voiceOverride`），把每个事件自己的音色都压掉——于是谱面里写的
   * `@手风琴@` 在选定试听音色后**完全不生效**（用户报「到 `@手风琴@ 6/` 这里主声部没有
   * 切换为手风琴」）。`@乐器名@` 是**曲内的、局部的、明确的**演奏指示，应当优先于
   * 「全局默认音色」；把它标记出来，播放端据此保留自己的音色。
   * （`Y:` 行与缺省音色**不**标记——「试听音色」仍可覆盖它们，保留试听用途。）
   */
  explicitInstrument?: boolean
  /** adj300：播放拍段轨道（连音合并时含被合并音符的拍段，覆盖完整时值；普通事件 = 音符拍段） */
  playheadSegs?: PlayheadSeg[]
}

export interface PlaySequence {
  events: PlayEvent[]
  totalMs: number
  bpm: number
}

/** 从描述头 J 推断拍速（30~240），无效或缺失默认 70（adj343；函数头注释此前误写 90） */
export function inferBpm(result: ParseResult): number {
  const t = result.header.tempoNum ?? result.header.tempo
  if (t) {
    const n = Number(t)
    if (Number.isFinite(n) && n > 0) {
      return Math.min(240, Math.max(30, Math.round(n)))
    }
  }
  // adj343：无 J 时默认 70 拍/分（有指定以乐谱为准）
  return 70
}

interface SeqItem {
  kind: 'note' | 'bar' | 'instrument' | 'segment'
  note?: PlacedToken
  /** 音符全局索引（slur 区间用；bar 项无） */
  noteIdx?: number
  /** adj301/351：乐器切换指令（@乐器名 / @@）——记录所属声部（voice），多声部各声部独立切换 */
  instr?: { name: string | null; voice: number }
  /**
   * adj427：临时段（`{bz … }` / `{dsb … }`）——**不占主旋律时值**，走到此处只是"打标记"；
   * 段内容的实际事件在**下一个音符事件**处用同一个 `passMs` 补发（⇒ 反复每遍都发声）。
   * adj629：替谱段（`tp`）带 `pass`（= 第几遍），**只在那一遍**补发，其余遍跳过。
   */
  seg?: { voice: number; children: MusicToken[]; type?: 'bz' | 'dsb' | 'tp'; pass?: number }
  bar?: {
    type: BarlineType
    marks?: BarlineMark[]
    voltaStart?: PlacedBarline['voltaStart']
    voltaEnd?: boolean
    /** adj360：|]/ 房子右侧未封闭——该房子延续到其后第一个跳跃小节线(:|)或结束小节线(||) */
    voltaEndSlash?: boolean
    /** adj627/adj665：临时转调指令（小节线引号备注 `"d:<key>"` / `"d:"`）——见走查里的 `curKey` */
    keyChange?: PlacedBarline['keyChange']
  }
}

/**
 * adj429：色块**上下边界**（按曲行几何动态定界）。
 *
 * 旧的硬编码 `[y−1.6×字号, y+0.6×字号]` 在三类场景下出问题（用户报）：
 *  1. **多声部块**：Q1 与 Q2 色块各自按 28.6 px 上下延伸 ⇒ Q1 底部 +7.8 vs Q2 顶部 −20.8
 *     ⇒ **重叠 3.6 px**；用户看到"两个色块黏在一起"。
 *  2. **{dsb … }**：上下两层基线仅差 `dy`（默认 22 px），而每块自身就有 28.6 px 高，
 *     ⇒ **重叠 17.6 px**（一大半）；用户看到"两层只有一个色块"。
 *  3. **{bz … }**：段层在主旋律**上方** dy 距离（默认 22 px），段层色块底 `yUpper+7.8`
 *     与主旋律色块顶 `yRow−20.8` 重叠 6.6 px；同时段层色块顶 `yUpper−20.8` 容易侵入
 *     **上一行**曲部（用户报告过）。
 *
 * 解决：把"曲部的范围"作为色块边界——多声部按 voiceCenters 中线分块；bz/dsb 按段与主旋律
 * （或上下层）的中线分块；最后让色块至少 4 px（不到则隐藏）。色块与色块之间永远留一条细缝，
 * 色块不会侵入歌词区（仍按默认 `+0.6×字号` 不变 —— 7.8 < 15 = quci）。
 *
 * 单位全部用**绝对 y**（与 layout 一致；渲染端原样写 `top/height`）。
 */
function computeColorBounds(
  plc: PlacedToken,
  page: ScorePage,
  voiceBlockByNoteIdx: Map<number, VoiceBlock>,
  noteSize: number,
): { yTopMin: number; yBottomMax: number } | null {
  const y = plc.y
  const TOP_EXT = noteSize * 1.1 // 上方数字 + 减时线 + 一点 padding（1.1 比 1.6 小，bz/dsb 才有空间）
  const BOT_EXT = noteSize * 0.6 // 数字底到 0.6 倍字号（与 adj299 默认一致；不会压到歌词）
  const MID_GAP = 0.5 // 中线两侧的视觉细缝（多声部/dsb 上下层之间留 1 px 总间隙）
  const MIN_H = 4 // 色块最小可见高度（不到就隐藏——返回 null）

  // ① **临时段叠加层音符**：用段与主旋律（或上下层）的中线分块
  // adj429：注意——只有**段内容层（upper）**会在 PlacedToken.segment 上标记 type/layer；
  // dsb 包络内的主旋律（lower）是 main melody 移下去的，`placed.segment` 字段**没有**，
  // 但 `placed.playVoice === 'second'` 是 dsb 下层的明确信号。bz 的下层不变（main melody 不动），
  // 所以 playVoice 仍是 undefined/默认。所以下层识别要分两种：
  //  - upper：通过 `placed.segment.layer === 'upper'`（一定设了）
  //  - dsb lower：通过 `placed.playVoice === 'second'`（main melody 被 shiftEnvelopeDown 后被打上此标记）
  //  - bz 没有"下层"概念（main melody 不动），bz 的下层就是普通主旋律 → 走 ② 多声部 / ③ 单声部路径
  const isDsbUpper = plc.segment?.layer === 'upper' && plc.segment.type === 'dsb'
  const isBzUpper = plc.segment?.layer === 'upper' && plc.segment.type === 'bz'
  /**
   * adj722（用户口径翻转）：`{dsb}` **包络外的主旋律** = 视觉下排，**现在是主声部**
   * （保持主音色、力度 1、主色块），所以**不能再靠 `playVoice === 'second'` 认它**。
   *
   * 新判据 = **`parentY` 有值**：它由 `shiftEnvelopeDown` 只写在"被下移的包络内主旋律"上
   * （`alignLyricsToLowestVoice` 也用同一信号），因此**精确等于"`{dsb}` 的下排"**，
   * 不会把同一 x 区间里、与段内容不对齐的普通主旋律音也误判进来
   * （早前用"落在段 x 区间内"判过，实测把 `00 3'` 这类音也算进去了 ⇒ 色块高度算成 0）。
   */
  const isDsbLower = !plc.segment && plc.parentY !== undefined

  if (isBzUpper) {
    // bz：对侧 = 该 group 的**主旋律基线 row.y**（bz 不移动主旋律）。
    // bz 底部 ≤ 主旋律色块顶（adj299 公式：top = a.y − 1.6×字号；用同样的 1.6×ns 钳制），
    // 这样两个色块**恰好贴在一起**（中间 0 px gap，因为旋律色块顶部就是它"应有的上界"）。
    const melodyY = pageVoiceBaselineOutsideSegment(page, plc.id.group, plc.id.voice)
    if (melodyY === null) return null
    const yTopMin = y - TOP_EXT
    const yBottomMax = Math.min(y + BOT_EXT, melodyY - noteSize * 1.6)
    const h = yBottomMax - yTopMin
    if (h < MIN_H) return null
    return { yTopMin, yBottomMax }
  }
  if (isDsbUpper) {
    /**
     * `{dsb}` **段内容** = 视觉**上排**（`segment.layer === 'upper'`）。
     *
     * adj722：它现在是**副声部**（副音色 + 0.75 + 副色块），视觉位置不变 ⇒ 仍取**上半**。
     *
     * 对侧（下排主声部的基线）= **行基线 `parentY`**（`shiftEnvelopeDown` 写在每一个
     * 包络外主旋律音上）——**不能**再用"该段 x 区间内的上层音符"去反推：
     * 段内容区间之外的音（如 `(1'// 7// 6//) 5/ 6-` 里的 `5/ 6-`）在区间内找不到上层音
     * ⇒ 定界返回 null ⇒ 该段色块退化成"默认单声部高度"（实测 42 段里 17 段如此，
     * 用户看到的就是"这段没有色块/不对"）。
     */
    const rows = dsbRowBaselines(page, plc, noteSize)
    if (rows === null) return null
    const offset = (TOP_EXT - BOT_EXT) / 2
    const midEqual = (rows.upper + rows.lower) / 2 - offset
    const yTopMin = y - TOP_EXT
    const yBottomMax = midEqual
    const h = yBottomMax - yTopMin
    if (h < MIN_H) return null
    return { yTopMin, yBottomMax }
  }
  if (isDsbLower) {
    /**
     * `{dsb}` **包络外的主旋律** = 视觉**下排**，adj722 起是**主声部** ⇒ 色块取**下半**。
     * 两排基线同样取自段括号（与上排**同一把尺子** ⇒ 两块严格相接、等高）。
     */
    const rows = dsbRowBaselines(page, plc, noteSize)
    if (rows === null) return null
    const offset = (TOP_EXT - BOT_EXT) / 2
    const midEqual = (rows.upper + rows.lower) / 2 - offset
    const yTopMin = midEqual
    const yBottomMax = y + BOT_EXT
    const h = yBottomMax - yTopMin
    if (h < MIN_H) return null
    return { yTopMin, yBottomMax }
  }

  // ② **多声部块内的非段音**：按 voiceCenters 中线分块
  const vb = voiceBlockByNoteIdx.get(plc.id.index)
  if (vb && vb.voiceCenters && vb.voiceCenters.length > 1) {
    const vi = vb.voices.findIndex((v: { voice: number; name?: string }) => v.voice === plc.id.voice)
    if (vi >= 0) {
      const yThis = vb.voiceCenters[vi]
      const yPrev = vi > 0 ? vb.voiceCenters[vi - 1] : null
      const yNext = vi < vb.voiceCenters.length - 1 ? vb.voiceCenters[vi + 1] : null
      let yTopMin = yThis - TOP_EXT
      let yBottomMax = yThis + BOT_EXT
      if (yPrev !== null) {
        // 与上方声部的中线为本色块顶（不侵入上方色块）
        yTopMin = Math.max(yTopMin, (yPrev + yThis) / 2 + MID_GAP / 2)
      }
      if (yNext !== null) {
        // 与下方声部的中线为本色块底
        yBottomMax = Math.min(yBottomMax, (yThis + yNext) / 2 - MID_GAP / 2)
      }
      const h = yBottomMax - yTopMin
      if (h < MIN_H) return null
      return { yTopMin, yBottomMax }
    }
  }

  // ③ 单声部默认：不传 bounds → 渲染端走默认 `[y−1.6×字号, y+0.6×字号]`
  return null
}

/**
 * adj429：取该页该 group 在临时段**包络外**的主旋律基线 y。
 *
 * 为什么需要"包络外"：bz 包络外的主旋律不移动，包络内的主旋律保持原行基线（bz 不动主旋律），
 * 所以**任何**主旋律音的 y 都可以作"row.y"；用最近的就行。返回 null 表示这个 group 不在临时段覆盖范围。
 */
function pageVoiceBaselineOutsideSegment(
  page: ScorePage,
  group: number,
  voice: number,
): number | null {
  // 优先取该 voice 的任意一个**非段**音符的 y（无论在不在包络内，bz 不动主旋律，所以都等于 row.y）
  for (const n of page.notes) {
    if (n.id.group === group && n.id.voice === voice && !n.segment) return n.y
  }
  return null
}

/**
 * adj720/adj722：取**本音符所属** `{dsb}` 段的段括号。
 *
 * ⚠️ adj720（用户报「图2 里下层绿色块没有/位置不对」）：**必须按"本音符落在哪一段"取**，
 * 不能取"该页第一段"——同一视觉行可以有**多段 `{dsb}`、各段几何不同**（实测差 2.4px）。
 *
 * 判定：`x` 落在括号区间内（同 x 不同行的段用 group/voice 区分）；多段都命中时取中心最近的。
 */
function dsbSegmentOf(page: ScorePage, plc: PlacedToken): PlacedSegmentBracket | undefined {
  const bars = page.segmentBrackets ?? []
  const cands = bars.filter((s) => s.type === 'dsb' && s.group === plc.id.group && s.voice === plc.id.voice)
  if (cands.length === 0) return undefined
  const inX = cands.filter((s) => plc.x >= s.x1 - 2 && plc.x <= s.x2 + 2)
  if (inX.length === 0) return cands.length === 1 ? cands[0] : undefined
  if (inX.length === 1) return inX[0]
  return inX.reduce((best, s) =>
    Math.abs((s.x1 + s.x2) / 2 - plc.x) < Math.abs((best.x1 + best.x2) / 2 - plc.x) ? s : best,
  )
}

/**
 * adj722：`{dsb}` 两排色块的**上下界**。
 *
 * 两排基线**都从段括号本身取**（不再反推）：
 *  · 上排（段内容）基线 = `sb.yUpper`；
 *  · 下排（包络外主旋律）基线 = `sb.yBottomLower − 0.3×字号`（`yBottomLower` 口径 = 下排墨迹底 + `0.35×字号`）。
 *
 * 为什么不用 `rowSlides`/`parentY` 反推：那条链给的是"**行基点**"，与"段内容实际落在哪"
 * 差 **3.3px**（实测行基点 168.2、两排实际 153.9 / 182.5）⇒ 上下两块各错 3~7px、
 * 两块之间露出缝（`smoke` 的 `Z8d` 报 `contentBot=157.8 vs outsideTop=164.95`、`V3b` 报高度不等）。
 * 而 `parentY` 只在"**段内容区间之外**的主旋律音"上才是唯一可用信息（那时用行基点兜底）。
 */
function dsbRowBaselines(
  page: ScorePage,
  plc: PlacedToken,
  noteSize: number,
): { upper: number; lower: number } | null {
  const sb = dsbSegmentOf(page, plc)
  if (sb?.yUpper === undefined || sb.yBottomLower === undefined) return null
  return { upper: sb.yUpper, lower: sb.yBottomLower - noteSize * 0.3 }
}

/** adj320：构建一个音符的播放拍段——按「时值元素」分块：
 *  · 附图段（el='dot'）与其前一个主音符段**合并为一个色块**（附点不单独分块）；
 *  · 增时线段（el='aug'）**独立一个色块**；纯音符跨拍段（多声部 5--- 无 aug el）各拍一块。
 *  x = 块左缘，width = 至「下一块左缘」（连续）；最后块宽 = to「endX」（下一时值元素左缘或小节线左缘）。
 *  endX 由 buildPlaySequence 传入（同 group 内下一时值元素.x 或小节线.x）。 */
function buildPlayheadSegs(
  plc: PlacedToken,
  startBeat: number,
  endX?: number,
  /** adj429：色块上下边界（按曲行几何动态定界）。缺省 = 默认 `[y−1.6×字号, y+0.6×字号]`。
   *  adj442：另加 `left`（**首个**色块的左边界）——段层按段型取"左小节线 / `{`"。 */
  bounds?: { yTopMin?: number; yBottomMax?: number; left?: number } | null,
): PlayheadSeg[] {
  const base = {
    pageIndex: plc.id.page,
    y: plc.y,
    voice: plc.id.voice,
    group: plc.id.group,
    ...(bounds?.yTopMin !== undefined ? { yTopMin: bounds.yTopMin } : {}),
    ...(bounds?.yBottomMax !== undefined ? { yBottomMax: bounds.yBottomMax } : {}),
  }
  const segs = plc.segments ?? []
  const right = endX ?? (plc.rightX ?? (plc.x + plc.width))
  if (segs.length === 0) {
    return [{ beat: startBeat, beats: plc.duration, x: plc.x, width: Math.max(0, right - plc.x), ...base }]
  }
  // 先分块（dot 并入前一个主音符块；aug/纯 note 各自成块）
  const blocks: { x: number; beats: number; dot: boolean }[] = []
  for (const s of segs) {
    if (s.el === 'dot' && blocks.length > 0) {
      blocks[blocks.length - 1].beats += s.beats
    } else {
      blocks.push({ x: s.x, beats: s.beats, dot: s.el === 'dot' })
    }
  }
  // 算宽度：每块右 = 下一块左（连续）；最后块右 = right
  const out: PlayheadSeg[] = []
  let acc = startBeat
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i]
    const x1 = i < blocks.length - 1 ? blocks[i + 1].x : right
    // adj442：段层**首个色块不从左括号右侧开始、而从起始音符开始**（用户规则）——
    // 音符**左对齐**，重叠区首个音与主旋律对应音本来就对齐，色块从它起步最自然；
    // （右端仍然外扩到段层右界：`&ykh`/右括号是**无时值占宽元素**，末音的色块要覆盖到界。）
    // 注：`bounds.left` 保留在类型里但**不再用于外扩左端**（adj442 首版做了左端外扩，观感不对）。
    const bx = blk.x
    out.push({ beat: acc, beats: blk.beats, x: bx, width: Math.max(0, x1 - bx), ...base })
    acc += blk.beats
  }
  return out
}

/**
 * adj455：谱面里「曲内显式音色切换」（`@乐器名@` / 旧写法 `@乐器名`）的**处数**。
 *
 * 用途：试听选定具体音色时是**全篇统一音色**（见 `buildPlaySequence` 的 `instrumentOverride`），
 * 谱面里的 `@` 切换会被一起覆盖——界面据此提示"谱面里有 N 处 @ 已被试听音色覆盖，
 * 要按谱面音色演奏请选「自动」"，避免用户误判"写了 @ 却不生效"（E-2026-174 同类误判）。
 * `@@`（切回默认乐器，`name === null`）不计入：它没有指定具体音色。
 */
export function countScoreInstrumentSwitches(result: ParseResult): number {
  const countIn = (tokens: readonly MusicToken[]): number => {
    let n = 0
    for (const t of tokens) {
      if (t.kind === 'instrument') {
        if (typeof t.name === 'string' && t.name.trim() !== '') n++
      } else if (t.kind === 'segment') {
        // 临时段（`{bz @手风琴@ … }`）里的切换是**子 token**——同样会被"全篇试听音色"覆盖，必须计入
        n += countIn(t.children ?? [])
      }
    }
    return n
  }
  let n = 0
  for (const g of result.groups) n += countIn(g.music.tokens)
  return n
}

export function buildPlaySequence(
  result: ParseResult,
  layout: ScoreLayout,
  bpm: number,
  startNoteId?: string | null,
  defaultInstrumentRef?: string,
  instrumentOverride?: string,
): PlaySequence {
  // 0. adj88：起始音符定位——双击谱面音符试听时，从该音符（含之后）开始播放；
  //    事件延迟统一减去起点音符的 atMs，使起点音符立即播放
  const startIdxByPage = startNoteId ? parseStartNoteIdx(startNoteId) : null
  // 1. 按全局音符序号索引 PlacedToken
  const byIndex = new Map<number, PlacedToken>()
  for (const page of layout.pages) {
    for (const n of page.notes) byIndex.set(n.id.index, n)
  }
  /**
   * adj427：段层音符的**对象身份**索引（token → 已放置音符）。
   * 临时段的已放置音符与段内 token 是**同一对象引用**（layout 里以 `token: t` 存入），
   * 故可直接按身份取用——不必给 `ScorePage` 增加"段→音符"的映射字段。
   */
  const segPlacedByToken = new Map<MusicToken, PlacedToken>()
  for (const page of layout.pages) {
    for (const n of page.notes) if (n.segment) segPlacedByToken.set(n.token, n)
  }
  /**
   * adj429：按 `token.id.index` 索引该 token 所在的多声部块（若它在某块内）。
   * 直接 `Map<noteIdx, VoiceBlock>`——避免再反查（VoiceBlock 不带 group，notes 不带 voiceBlock 引用）。
   * 单声部音符不在任何 VoiceBlock 里 → 查不到 → 走单声部默认。
   *
   * adj449（用户报「测试多组声部时，到第二组色块跑偏到第一组的位置」）：**必须按"行归属"匹配**。
   * 一页里可以有多组多声部块（声部号会重复出现：第 1 组的 Q1/Q2 与第 2 组的 Q1/Q2），
   * 旧实现只按「本页第一个包含该声部号的块」匹配 ⇒ 第 2 组及之后的所有音符（乃至中间穿插的
   * **单声部**行）都被判成第 1 组的块，`computeColorBounds` 于是拿第 1 组的 `voiceCenters` 定界，
   * 色块整块画到第 1 组那一行去。
   * 判据：块的纵向范围 `[yTop, yBottom]` 必须**包含**本音符（块按行依次排布、互不重叠）；
   * 多个块都命中时取「声部中心离本音符最近」者，避免块间范围相接时的边界含糊。
   */
  const voiceBlockByNoteIdx = new Map<number, VoiceBlock>()
  for (const page of layout.pages) {
    for (const n of page.notes) {
      if (n.segment) continue // 段层音符不在多声部块里
      let best: VoiceBlock | undefined
      let bestDist = Number.POSITIVE_INFINITY
      for (const vb of page.voiceBlocks) {
        const vi = vb.voices.findIndex((v) => v.voice === n.id.voice)
        if (vi < 0) continue
        if (n.y < vb.yTop - 0.01 || n.y > vb.yBottom + 0.01) continue
        const d = Math.abs(n.y - (vb.voiceCenters?.[vi] ?? n.y))
        if (d < bestDist) {
          bestDist = d
          best = vb
        }
      }
      if (best) voiceBlockByNoteIdx.set(n.id.index, best)
    }
  }
  /** adj429：`token.id.index` → `ScorePage` 反查（色块定界时按 page 拿 voiceBlocks / segmentBrackets） */
  const pageByNoteIdx = new Map<number, ScorePage>()
  for (const page of layout.pages) {
    for (const n of page.notes) pageByNoteIdx.set(n.id.index, page)
  }
  /** adj429：色块定界用的字号（与渲染端一致；这里用 pageConfig 的值） */
  const noteSize = layout.config.note_size
  // ★ adj320：每个音符的色块右边界 = 同 group 内下一个时值元素左缘，或该小节线左缘（取先到者）。
  //   使色块「当前时值元素 → 下一时值元素/小节线前」连续覆盖，不依赖显示占宽右缘。
  //   adj427：**必须排除段层音符**——它们与主旋律**同 x**（叠加对齐），若混进来排序，
  //   主旋律音符的"下一个元素"会变成同 x 的那个段层音符（不满足 `> n.x + 1e-3`），
  //   `nextNote` 退化为 Infinity ⇒ 边界只剩小节线 ⇒ **色块被拉长到整个小节**（用户报的现象）。
  //   段层音符的右边界在 emitSegmentEvents 里按「同段内下一个段层音符」单独算。
  const rightEdgeByNoteIdx = new Map<number, number>()
  /**
   * adj439：`(页|曲行|声部)` → 该处**段层右界**（大括号/内容区右缘，取 `segmentBrackets.x2`）。
   * 供 dsb 下层色块钳制用（用户要求"色块都以大括号为界限定占宽"）。
   */
  const segRightByGroupVoice = new Map<string, number>()
  const segLeftByGroupVoice = new Map<string, number>()
  for (const page of layout.pages) {
    for (const sb of page.segmentBrackets ?? []) {
      // adj629：替谱段（tp）不参与 bz/dsb 的色块边界表——它是**另一遍**的内容（不与他人重叠），
      // 混进来会把同组同声部的 bz/dsb 色块边界取 min/max 而改窄/改宽
      if (sb.type === 'tp') continue
      const k = `${page.index}|${sb.group}|${sb.voice}`
      // adj442（用户规则）：色块占宽边界——**bz 以前后小节线为界、dsb 以大括号为界**；
      // 布局端已按段型写入 `blockLeft`/`blockRight`，此处只取用（旧数据无该字段时退回 x1/x2）。
      const right = sb.blockRight ?? sb.x2
      const left = sb.blockLeft ?? sb.x1
      const curR = segRightByGroupVoice.get(k)
      segRightByGroupVoice.set(k, curR === undefined ? right : Math.min(curR, right))
      const curL = segLeftByGroupVoice.get(k)
      segLeftByGroupVoice.set(k, curL === undefined ? left : Math.max(curL, left))
    }
  }
  {
    const byGroupNotes = new Map<number, PlacedToken[]>()
    const byGroupBars = new Map<number, PlacedBarline[]>()
    for (const page of layout.pages) {
      for (const n of page.notes) {
        if (n.segment) continue
        ;(byGroupNotes.get(n.id.group) ?? byGroupNotes.set(n.id.group, []).get(n.id.group)!).push(n)
      }
      for (const b of page.barlines) {
        if (b.segment) continue
        ;(byGroupBars.get(b.id.group) ?? byGroupBars.set(b.id.group, []).get(b.id.group)!).push(b)
      }
    }
    for (const [, notes] of byGroupNotes) {
      const sorted = [...notes].sort((a, b) => a.x - b.x)
      sorted.forEach((n) => {
        // adj722：`edge`（下一个音符的块左缘 / 下一根小节线）**不再参与色块右界**——
        // 它含槽尾留白与布置网格的间隙，会把色块撑到后面那个音符上（见下方 `base` 的说明）。
        const segs = n.segments ?? []
        const lastSeg = segs[segs.length - 1]
        const inkRight = lastSeg ? lastSeg.x + lastSeg.perBeat * lastSeg.beats : (n.rightX ?? n.x + n.width)
        /**
         * adj722（用户报「下面声部色块不正确 / 色块跑到后面的音符上」；AGENTS 五·9「区间一律用**墨迹**算」）：
         *
         * 色块右界 = **本音符自己的墨迹右缘**（`x + width`，即数字槽右缘；含增时线/附点时取更右者），
         * **不再**把 `edge`（下一个音符的**块左缘**）算进来——它多含两样东西：
         *  ① **槽尾留白**（每个音会**右出约 1.0px**）；
         *  ② **布置网格的间隙**（下层音符的 x 由上层网格决定：`5/` 墨迹到 `140.7`、
         *     下一个 `6-` 从 `151.5` 起，中间空 **9.7px**）⇒ 色块宽 19.8px、
         *     **比自己的音符宽出 10.8px、盖到后面那个音符上**（实测数据）。
         *
         * 曾经写成 `Math.max(edge, own)`（"至少占满到下一个音符"）⇒ 就是上面这个缺陷；
         * 现改为**以本音符墨迹为准**（`edge` 只在它更小、且确实需要收窄时不起作用——
         * 即块永远是"一个音一块"）。
         */
        const own = Math.max(n.rightX ?? 0, n.x + n.width, inkRight)
        const base = own
        /**
         * adj439：**重叠区的色块以段层右界（大括号 `}`）为界限**（用户要求）。
         *
         * dsb 下层（包络内的主旋律）若不钳制，右边界会取"**包络外**那个主旋律音的 x"
         * ⇒ 色块越过 `}` 一直盖到下一小节（用户截图：下层绿块从 `5` 跨过 `}` 到最后的 `5` 前）。
         * 上层的段层音符在 `emitSegmentEvents` 里已收在段内容区内（`xContent1` ≤ 大括号内缘），
         * 故这里只对**下层**（包络外主旋律，`parentY !== undefined`）钳制到段层右界 `blockRight`
         * （adj667 起 = 右大括号**墨迹左缘**；旧数据无该字段时退回 `x2`）。
         */
        /**
         * adj722b（用户报「`(1'// 7// 6//) (6// 6/)` 这部分没有色块显示」）：
         * **钳制必须按"本音符所属那一段"取**，不能取"该组所有段的 `min`"。
         *
         * 根因：`segRightByGroupVoice` 对 `(页|组|声部)` 取**所有段的最小右界**
         * （本意是"别越出任何一段"，实际成了"别越出最窄那段"）。实测第 1 行三段 `{dsb}` 的
         * `blockRight` = `151.5 / 303.5 / 530.1`，取 min ⇒ **151.5**，
         * 于是第 2、3 段包络外的主旋律全被钳到 `151.5`，而它们本身 x 已在 `197.6` 之后
         * ⇒ `width = max(0, 151.5 − 197.6) = 0` ⇒ **色块宽度为 0、完全画不出来**
         * （实测 21 个段宽度为 0，正是用户截图里"这一段没有色块"）。
         *
         * 改为用 `dsbSegmentOf` 取**本音符所属段**的 `blockRight`（`adj720` 的同一口径）。
         * 取不到（音符在段内容区间之外、又不在任何段的 x 范围内）时退回组级 min——
         * 那正是"包络之后的主旋律"以外的边界情形，保守钳制不会造成 0 宽（它 x 本来就靠左）。
         */
        const ownPage = pageByNoteIdx.get(n.id.index)
        const ownSeg = ownPage ? dsbSegmentOf(ownPage, n) : undefined
        const segRight =
          n.parentY !== undefined
            ? (ownSeg?.blockRight ?? segRightByGroupVoice.get(`${n.id.page}|${n.id.group}|${n.id.voice}`))
            : undefined
        rightEdgeByNoteIdx.set(n.id.index, segRight !== undefined ? Math.min(base, segRight) : base)
      })
    }
  }
  // adj301/302：全局默认乐器 = 描述头第一个 Y 乐器（name 与试听音色库一致，无则音色库第一个钢琴）。
  // 多声部按声部序号对应 Y 行顺序（Q1→Y[0]、Q2→Y[1]…）；声部比 Y 行多时用全局默认。
  // @乐器名 覆盖声部默认（全局持续直到 @@），@@ 清除覆盖（回声部默认）
  // adj339：Y 行默认乐器支持 `@库id:乐器名["显示名"]`（parseInstrumentRef 剥库前缀/显示名/可选 @），
  // 缺省仍是旧写法（如 `钢琴` / `@小提琴`），路由交给播放端。
  // adjNN：@@ 恢复默认音色 = 第一音色——优先描述头第一个 Y；无 Y 时用调用方传入的「试听音色列表
  // 第一音色」（defaultInstrumentRef）；仍空则回退 ''（播放端路由 → 第一音色库第一音色，钢琴）。
  const yInstruments = result.header.instruments
  const yRef = yInstruments?.[0] ? parseInstrumentRef(yInstruments[0]).ref : ''
  const defaultInstrument = yRef !== '' ? yRef : defaultInstrumentRef?.trim() || ''
  const voiceDefaultOf = (voice: number): string => {
    const y = yInstruments?.[voice - 1]
    return y !== undefined ? parseInstrumentRef(y).ref : defaultInstrument
  }
  /**
   * adj427：临时段（`{bz … }` / `{dsb … }`）重叠区的**第二声部音色**（用户规格）：
   *  「可用音色 第 1 = 大钢琴、第 2 = 手风琴」——优先取脚本第 2 条 `Y:` 行；
   *  没有第 2 条 `Y:` 就用内置默认「手风琴」。
   *  （第 1 可用音色 = 主声部，走上面的 `voiceDefaultOf`；app 侧默认启用列表首位即「大钢琴」。）
   */
  const accompInstrument = (): string => {
    const y1 = yInstruments?.[1]
    if (y1 !== undefined && y1.trim() !== '') return parseInstrumentRef(y1).ref
    return ACCOMP_FALLBACK_INSTRUMENT
  }
  /**
   * adj455：「试听音色」**选定具体音色时 → 全篇统一音色**（用户规格，恢复 adj427/adj434 之前的语义）：
   * 主声部、`{bz}`/`{dsb}` 伴奏/第二声部、曲内 `@乐器名@` 显式切换**全部**改用该音色。
   *
   * 为什么要收在**序列层**而不是播放后端：序列里的 `instrument` 同时喂给
   * ① 音频事件（`schedulePlay` → 后端 program）与 ② 色块轨道（`playheadSegs[].instrument` → 预览色块配色）。
   * 只在后端改，色块会与听到的音色不一致（"音频全是一个音色、色块还是五颜六色"）。
   *
   * 「自动」（`undefined`/空串）时**完全不介入**，仍按既有优先级路由：
   * 曲内 `@乐器名@` > 描述头 `Y:`（按声部）> `defaultInstrumentRef`（启用音色列表第一）> 音色库第一音色。
   */
  const overrideRef = typeof instrumentOverride === 'string' ? instrumentOverride.trim() : ''
  const instOr = (own: string): string => (overrideRef !== '' ? overrideRef : own)

  // 2. 重建交错序列（音符 + 小节线），保持源码顺序
  //    adj88：同时记录连音线 (…) 覆盖的音符区间（open slur → 当前音符起点，close → 终点），
  //    供「相同音高连奏合并时值」使用（如 (2 - | 2/) 的 2 连奏 2.5 拍）
  const seq: SeqItem[] = []
  let noteIdx = 0
  const slurStarts: number[] = []
  const slurRanges: [number, number][] = []
  /**
   * adj375：&hx（呼吸记号）作用的音符全局 index 集合。
   * 规则：取记号**左侧本组内最近的可发声 token**（音符/休止/节奏符）——即"占用前面音符 1/4 时值"；
   * 若记号写在本组最前（左侧没有可发声元素，如 `&hx 6 5` 的行首写法），退化为它**右侧最近**的那个音符。
   */
  const hxBreathNoteIdx = new Set<number>()
  /**
   * adj596（用户反馈「第二组多声部只演奏了第一声部」）：**行内项先按小节切好**，
   * 之后按「单元」拼成 `seq`——多声部单元内**按小节交替**（第 k 小节各声部的内容先齐，
   * 再接该小节线上的一个小节线项），单声部单元照旧按源码顺序。
   *
   * 为什么必须这样：反复（`:|`）的回跳走查是按 `seq` **顺序**推进的。旧实现里同一组的
   * `Q1:`/`Q2:` 两行前后排列 ⇒ 走查到 Q1 行末的 `:|` 时**立刻回跳**，而 Q2 那一行还没走到，
   * 于是"第二组多声部只演奏了第一声部"，要到第二遍才补上（真机实测该声部首个事件晚一整遍）。
   * 按小节交替 + 同一小节线只留一项之后，回跳必然发生在**整小节（各声部）都排完之后**。
   */
  const lineSeqs: { voice: number; bars: { items: SeqItem[]; bar: SeqItem | null }[] }[] = []
  for (const line of result.lines) {
    if (line.kind !== 'music') continue
    const group = result.groups.find((g) => g.music === line)
    if (!group) continue
    {
      const toks = group.music.tokens
      const soundablePos: number[] = [] // 组内可发声 token 的 token 下标（顺序）
      toks.forEach((tk, k) => {
        if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') soundablePos.push(k)
      })
      toks.forEach((tk, k) => {
        if (tk.kind !== 'bracket' || tk.code !== 'hx') return
        let pick = -1
        for (let q = 0; q < soundablePos.length; q++) if (soundablePos[q] < k) pick = q
        if (pick < 0) pick = soundablePos.findIndex((sp) => sp > k)
        if (pick >= 0) hxBreathNoteIdx.add(noteIdx + pick)
      })
    }
    const ls: { voice: number; bars: { items: SeqItem[]; bar: SeqItem | null }[] } = {
      voice: group.music.voice,
      bars: [{ items: [], bar: null }],
    }
    /** 当前正在填的小节格（遇到小节线就开新格） */
    const cell = () => ls.bars[ls.bars.length - 1]
    for (const token of group.music.tokens) {
      if (token.kind === 'slur') {
        if (token.dir === 'open') slurStarts.push(noteIdx)
        else {
          const s = slurStarts.pop()
          if (s !== undefined && noteIdx - 1 > s) slurRanges.push([s, noteIdx - 1])
        }
        continue
      }
      if (token.kind === 'barline') {
        cell().bar = {
          kind: 'bar',
          bar: {
            type: token.type,
            marks: token.marks,
            voltaStart: token.voltaStart,
            voltaEnd: token.voltaEnd,
            voltaEndSlash: token.voltaEndSlash,
            // adj627/adj665：临时转调（小节线引号备注 `"d:..."`）——播放走查据此切调，见 `curKey`
            keyChange: token.keyChange,
          },
        }
        ls.bars.push({ items: [], bar: null })
      } else if (token.kind === 'instrument') {
        // adj301/351：乐器切换指令纳入播放序列（不产生音符事件）——按所属声部（voice）记录，
        // 多声部各声部独立切换乐器（下一组同声部延续）
        cell().items.push({ kind: 'instrument', instr: { name: token.name, voice: group.music.voice } })
      } else if (token.kind === 'segment') {
        // adj427：临时段（{bz … } / {dsb … }）——**不占主旋律时值**，只推进段内的音符序号吗？
        // 不：段内音符是**独立**的（children 各自成事件），主旋律的 noteIdx 完全不受影响。
        // 这里只登记一个"待补发"标记项，实际事件在走查时补发。
        // adj629：替谱段（tp）连同 `pass` 一起登记——播放端据此"第 k 遍才奏"。
        if (token.dir === 'open' && token.children && token.children.length > 0) {
          cell().items.push({
            kind: 'segment',
            seg: { voice: group.music.voice, children: token.children, type: token.type, pass: token.pass },
          })
        }
      } else if (token.kind === 'note' || token.kind === 'rest' || token.kind === 'rhythm') {
        const placed = byIndex.get(noteIdx)
        if (placed) cell().items.push({ kind: 'note', note: placed, noteIdx })
        noteIdx++
      }
    }
    // 收尾那一格既没内容又没小节线（正常的行尾）就丢掉，不为它排一项
    const last = ls.bars[ls.bars.length - 1]
    if (last.items.length === 0 && !last.bar) ls.bars.pop()
    lineSeqs.push(ls)
  }
  /**
   * 合并同一小节线上各声部的小节线项：类型取第一个、`marks` 取并集、
   * 跳房子（volta）字段取首个非空——多声部里同一根线各声部写法一致，合并后只留一项。
   */
  const mergeBarItems = (items: (SeqItem | null)[]): SeqItem | null => {
    const bars = items.filter((it): it is SeqItem => it !== null && it.kind === 'bar' && !!it.bar)
    if (bars.length === 0) return null
    const marks = new Set<BarlineMark>()
    let voltaStart: PlacedBarline['voltaStart']
    let voltaEnd: PlacedBarline['voltaEnd']
    let voltaEndSlash: boolean | undefined
    // adj627：多声部同一根线上的转调指令（各声部写法一致 ⇒ 取首个非空）
    let keyChange: PlacedBarline['keyChange']
    for (const it of bars) {
      const b = it.bar as PlacedBarline
      for (const m of b.marks ?? []) marks.add(m)
      if (voltaStart === undefined) voltaStart = b.voltaStart
      if (voltaEnd === undefined) voltaEnd = b.voltaEnd
      if (voltaEndSlash === undefined) voltaEndSlash = b.voltaEndSlash
      if (keyChange === undefined) keyChange = b.keyChange
    }
    const first = bars[0].bar as PlacedBarline
    return { kind: 'bar', bar: { type: first.type, marks: [...marks], voltaStart, voltaEnd, voltaEndSlash, keyChange } }
  }
  // 组装成 `seq`：单元 = 连续曲行（声部号在本单元内重复即另起单元，与排版同一规则；分页标记也断单元）
  {
    let unit: typeof lineSeqs = []
    let unitVoices = new Set<number>()
    const flushUnit = () => {
      if (unit.length === 0) return
      if (unit.length === 1) {
        const ls = unit[0]
        for (const c of ls.bars) {
          for (const it of c.items) seq.push(it)
          if (c.bar) seq.push(c.bar)
        }
      } else {
        // 多声部单元：按小节交替（各声部第 k 小节的内容先齐，再接这一小节线的一项）
        const nb = Math.max(...unit.map((l) => l.bars.length))
        for (let k = 0; k < nb; k++) {
          for (const ls of unit) {
            const c = ls.bars[k]
            if (!c) continue
            for (const it of c.items) seq.push(it)
          }
          const merged = mergeBarItems(unit.map((ls) => ls.bars[k]?.bar ?? null))
          if (merged) seq.push(merged)
        }
      }
      unit = []
      unitVoices = new Set()
    }
    let cursor = 0
    for (const line of result.lines) {
      if (line.kind === 'pagebreak') {
        flushUnit()
        continue
      }
      if (line.kind !== 'music') continue
      const ls = lineSeqs[cursor++]
      if (!ls) continue
      if (unit.length > 0 && unitVoices.has(ls.voice)) flushUnit()
      unit.push(ls)
      unitVoices.add(ls.voice)
    }
    flushUnit()
  }
  // 音符 → 所在 slur 区间（一个音符可属多层；用于判断相邻音符是否在同一连音线内）
  const slurOf = new Map<number, Set<number>>()
  slurRanges.forEach(([s, e], ri) => {
    for (let k = s; k <= e; k++) {
      const set = slurOf.get(k)
      if (set) set.add(ri)
      else slurOf.set(k, new Set([ri]))
    }
  })
  /**
   * adj651c（用户报「对于跳房子 2 和结束句，因为跨了小节或行，却是按两个半拍演奏」）：
   * **延续类连音线**（跳房子里的孤立 `)`，起点在房子起始小节线之前、终点是该房子首音）。
   *
   * 演奏上它和普通同音连线一样要"并成一个长音"（`(5/ |5/)` = 只起奏一次、时值相加），
   * 但它在**演奏顺序**里两端相邻（第 2 遍跳过房子 1 后，房子 2 的首音紧跟起音）、
   * 在**源码顺序**里隔着一整段旋律 ⇒ 合并判据里的"源码索引相邻 + 同属一弧"认不出来。
   * 所以由排版端把这份（起点, 终点）清单带过来：合并判据认「上一发声音符 = 本音符这条延续线的起点」。
   *
   * 注意：**不并入 `slurRanges`/`slurOf`**——那套是按源码区间铺满的（`[s, e]` 之间每个音符都算"同属一弧"），
   * 把一条跨 40 个音符的延续线铺进去，会让区间内**相邻同音**被误判成连线而合并。
   */
  const contTieStartOf = new Map<number, number>()
  for (const t of layout.continuationTies ?? []) contTieStartOf.set(t.end, t.start)

  // 3. 跳房子配对：voltaStart 的 seq 索引 → 对应 voltaEnd 的 seq 索引
  // adj359：指向 voltaEnd「本小节线」而非其后一位——使 `:|]["2."`（共用一根线：volta1 结束 + volta2 开始）
  // 在跳过 volta1 后仍能处理该线上的 volta2 番号
  /**
   * adj598（用户口径）：**"下一处跳跃或结束"**的小节线判据——
   * 反复线 `:|`/`:|:`、结束线 `||`/`||/`，以及带 `&ds`（跳花 S）/`&dc`（从头反复）/`&fine`（曲终）修饰的线。
   * 未封闭房子 `|["n." … |]/` 的终点就取**其后第一根**这样的线（见下）。
   * adj627b：判据本身抽到了布局端 `isJumpOrEndBarline`——**转调复原（走查里的 `curKey`）与本处房子终点
   * 必须同一口径**，两处各写一份迟早会漂。
   */
  const isJumpOrEndBar = (it: SeqItem): boolean =>
    it.kind === 'bar' && !!it.bar && isJumpOrEndBarline(it.bar)
  const voltaAfter = new Map<number, number>()
  const pendingStarts: number[] = []
  seq.forEach((item, si) => {
    if (item.kind !== 'bar') return
    // 先收尾（voltaEnd 出栈配对）再开新（voltaStart 入栈）——`:|]["2."` 同一根线上
    // 同时有 voltaEnd（结束上一房子）与 voltaStart（开始下一房子）时，若先入栈会把自身配成自己的末尾（死循环）
    if (item.bar?.voltaEnd && pendingStarts.length > 0) {
      const start = pendingStarts.pop()!
      // adj360：未封闭房子（|]/）延续到其后第一个「跳跃小节线 :|/：|:」或「结束小节线 ||/||/」处；
      // 已封闭房子（|]）就以该末尾小节线为界
      // adj598（用户口径，更严格）：未封闭房子是"**演奏到下一个跳跃或结束**"——
      // 除 `:|`/`:|:`/`||`/`||/` 外，**带 `&ds`/`&dc`/`&fine` 修饰的小节线同样算**（见 `isJumpOrEndBar`）。
      // 落到那根线时，它自己的"跳跃/结束"动作照常执行（走查里已按此处理。
      // 旧口径只认反复/结束线型 ⇒ 房子会一路吞到更远的 `:|`，把本不该跳的音乐也吞掉。
      if (item.bar.voltaEndSlash) {
        const ext = seq.findIndex((it, k) => k > si && isJumpOrEndBar(it))
        voltaAfter.set(start, ext >= 0 ? ext : si)
      } else {
        voltaAfter.set(start, si)
      }
    }
    if (item.bar?.voltaStart) pendingStarts.push(si)
  })

  // 3b. adj359：跳跃展开的预计算
  // - 花 S（&hs）位置：&ds 跳到「全曲第一个 hs」之后（hs 通常写在 ds 之前）
  // - 是否有大反复（&dc/&ds）：决定 &fine 是否生效、&ty 是否跳越
  // - 每个 :| 的反复遍数 = 「本段内到该线为止出现的 :| 个数 + 1」
  //   （`|: A :|` 2 遍；`|: A |[1. B :|][2. C :|] D` 该段两个 :| → 3 遍，末遍两 volta 皆跳过）
  const segnoIdx = seq.findIndex((it) => it.kind === 'bar' && it.bar?.marks?.includes('hs'))
  const hasBigRepeat = seq.some(
    (it) => it.kind === 'bar' && (it.bar?.marks?.includes('dc') || it.bar?.marks?.includes('ds')),
  )
  /**
   * adj368：跳房子标签分类——
   *  - `num`：引号注释里有数字（`["1."`/`["2."`）→ 番号 = 该遍才演奏
   *  - `text`：引号注释里有文字但无数字（如 `["结束句"`）→ **末遍**房子（本段后续遍次奏响，见 segMaxPass）
   *  - `none`：无注释 → 按第 1 遍（旧行为：第 2 遍起跳过）
   *
   * adj653（用户要求，**重叠跳房子**）：数字**取全部**而不只是第一个——
   * `["2.3."` 表示「第 2 遍和第 3 遍**共用**这一段房子」（用户原话："这里第二、第三个反复里
   * 跳房子 2 和跳房子 3 的部分是重叠的，以 `["2.3."` 来标记"）。于是 `nums = [2,3]`，
   * 判据从"番号 == 本遍"变成"**本遍 ∈ nums**"。`["1."` 这类单号房子 nums=[1]，行为与旧版一致。
   */
  const voltaLabelOf = (it: SeqItem): { kind: 'num' | 'text' | 'none'; nums: number[] } => {
    const c = it.kind === 'bar' ? it.bar?.voltaStart?.comment : undefined
    if (!c || c.trim() === '') return { kind: 'none', nums: [1] }
    const nums = [...c.matchAll(/\d+/g)].map((m) => Number(m[0]))
    return nums.length > 0 ? { kind: 'num', nums } : { kind: 'text', nums: [] }
  }
  const repeatCountAt = new Map<number, number>()
  {
    let endCount = 0
    seq.forEach((it, k) => {
      if (it.kind !== 'bar') return
      if (it.bar?.type === '|:' || it.bar?.type === '||:') endCount = 0
      if (it.bar?.type === ':|' || it.bar?.type === ':|:') {
        endCount++
        repeatCountAt.set(k, endCount + 1)
      }
    })
  }
  /**
   * adj368：每段「最终遍数」——用于「结束句」这类文字标签房子（无番号可依，语义 = 末遍才奏）。
   * 段 = 最近一个 `|:`（或曲首）起、到下一个 `|:` 之前；段内最后一个 `:|` 的遍数即最终遍数
   * （无 `:|` 则该段只奏 1 遍）。D.S./D.C. 造成的额外遍次 `pass` 更大，同样视为末遍之后 → 奏响。
   */
  const segMaxPass: number[] = new Array(seq.length).fill(1)
  {
    let segStart = 0
    const fill = (from: number, to: number) => {
      let max = 1
      for (let k = from; k < to; k++) {
        const c = repeatCountAt.get(k)
        if (c !== undefined && c > max) max = c
      }
      for (let k = from; k < to; k++) segMaxPass[k] = max
    }
    seq.forEach((it, k) => {
      if (k > segStart && it.kind === 'bar' && (it.bar?.type === '|:' || it.bar?.type === '||:')) {
        fill(segStart, k)
        segStart = k
      }
    })
    fill(segStart, seq.length)
  }

  // 4. 展开反复（支持两层：反复内嵌跳房子）
  // adj258：按 voiceBlocks 分块——多声部块内 group 共享 blockStartMs（同一组 Q1/Q2 同时播放），
  // 跨块顺序累加。单声部 group 不在任何 voiceBlock 内，自成块（blockStartMs = 累加）。
  // adj307：多组多声部（同一 voice 在不同 voiceBlock 多次出现）— 不再用全局 voice→首 group
  // 索引共享（会导致第二组覆盖第一组 ms）；改为按 voiceBlocks 顺序，每个 voice
  // 在该 vb 内取"下一个未处理"的 group 索引，使每组 ms 独立累加、同步正确。
  const beatMs = 60000 / bpm
  const groupStartMs: number[] = new Array(result.groups.length).fill(0)
  const barStartMsInGroup: number[][] = result.groups.map(() => [])
  let totalMs = 0
  {
    let ms = 0
    // 块拍数（块内 max groupBeats：多声部块以"最长声部"为准推进时间）
    const blockBeatsOf = (gis: number[]) => {
      let bb = 0
      for (const gi of gis) {
        let b = 0
        for (const tk of result.groups[gi].music.tokens) {
          if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') b += tokenDuration(tk)
        }
        if (b > bb) bb = b
      }
      return bb
    }
    // 该 group 的 bsMs（按 token 拍累计；同块各 group 小节对齐 → bsMs 一致）
    const bsMsOf = (gi: number) => {
      const bsMs: number[] = []
      let beats = 0
      bsMs.push(0)
      for (const tk of result.groups[gi].music.tokens) {
        if (tk.kind === 'barline') bsMs.push(beats * beatMs)
        else if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') beats += tokenDuration(tk)
      }
      bsMs.push(beats * beatMs)
      return bsMs
    }
    /**
     * adj595（用户要求）：**按源码顺序把曲行切成"块"，再逐块累加时间**。
     *
     * 用户口径（原话）：单声部行（`Q:`）单独用第一音色演奏；紧随其后的 `Q1:`+`Q2:` 组成
     * 一组多声部（两音色**同时**）；再接一组就接在**上一组之后**；再遇到 `Q:` 又回到单声部……
     * 分块规则与排版完全一致（layout 构建 unit 时"声部号在本块内重复即断块"），
     * 并同样在 `---` 分页标记处断块（跨页不该被合成同时发声）。
     *
     * 旧实现是"先遍历所有 voiceBlock、再遍历剩下的单声部 group"，有两个错：
     *  ① **顺序错**：穿插在多声部块之间的单声部行被挪到所有多声部块之后；
     *  ② **配对错**：块内按"该声部下一个未被占用的 group"取行，于是**块前那一行单声部**
     *     （同为声部 1）会被吸进第一个多声部块，两组双声部整体错位
     *     （实测 `Q: … / Q1: … / Q2: … / Q1: … / Q2: … / Q: …` 得到 g0=0、g2=0、g1=2000、g4=2000）。
     */
    let chunk: number[] = []
    let chunkVoices = new Set<number>()
    const flushChunk = (): void => {
      if (chunk.length === 0) return
      const bb = blockBeatsOf(chunk)
      for (const gi of chunk) {
        groupStartMs[gi] = ms
        barStartMsInGroup[gi] = bsMsOf(gi)
      }
      ms += bb * beatMs
      chunk = []
      chunkVoices = new Set()
    }
    for (const line of result.lines) {
      if (line.kind === 'pagebreak') {
        flushChunk()
        continue
      }
      if (line.kind !== 'music') continue
      const gi = result.groups.findIndex((g) => g.music === line)
      if (gi === -1) continue
      const v = result.groups[gi].music.voice
      if (chunk.length > 0 && chunkVoices.has(v)) flushChunk()
      chunk.push(gi)
      chunkVoices.add(v)
    }
    flushChunk()
    totalMs = ms
  }

  const events: PlayEvent[] = []
  let pass = 1 // 当前反复遍次（1 起；决定演奏哪个 volta）
  let repeatStart = 0 // 反复起点（无 |: 时默认从头反复）
  let bigRepeatDone = false // adj359：&dc/&ds 是否已发生过（大反复；之后 &fine 生效、&ty 跳越、dc/ds 不再重复跳）
  let landedByVoltaSkip = -1 // adj359：因跳过某 volta 而落在的小节线索引（该线上不再触发 :| 回跳，只处理其 volta 番号）
  let i = 0
  let guard = 0
  const maxIter = seq.length * 6 // 死循环保护
  // adj361：无缝跳跃——跳跃（回跳/前跳）后从「当前播放时刻」继续，而不是按布局时钟累计。
  // 原 adj282 用 passMs = passEndMs（= 遍偏移 + 该组布局起点 + 整组时长）→ 回跳后整体多等
  // 「本组布局起点 + 整组时长」，且前跳（&ds/&ty/跳房子跳过）不改 passMs 而布局时钟已跳到后面
  // → 跳过段被当成空档 → 出现十几~几十秒延迟。现改为：跳跃时记下待跳时刻 = lastEndMs（当前播放时刻），
  // 下一个事件生成时把 passMs 对齐（使该事件 atMs 正好 = 待跳时刻），所有跳跃皆无缝。
  let passMs = 0
  let lastEndMs = 0 // 已生成事件的最大结束时刻（= 当前播放时刻）
  let pendingJumpMs = -1 // 跳跃后要对齐到的播放时刻（下一个事件落在此刻）
  // adj301/351：@乐器名 覆盖当前乐器——**各声部独立**（多声部 Q1/Q2/Q3 各自延续；@@ 清该声部覆盖回 Y 默认）。
  // adj334：保留原始名（可为 `音色名` 或 `库id:音色名`），由 instrumentToProgram 在播放端路由，
  // 不再压缩成固定 6 种——否则动态采样音色名会丢失。
  const overriddenByVoice = new Map<number, string | null>()
  const keySemitone = parseKey(result.header.key)
  /**
   * adj627/adj665（用户口径，定稿 = Model B）：**临时转调**（小节线引号备注 `"d:<调>"` / `"d:"` 恢复）。
   *
   * 规则：「**转调后，反复/跳跃都继续用转调后的调号；只有再写 `d:<调>` 或 `d:`（恢复）才变**」。
   * ⇒ 调号是**随演奏过程保持的状态**（不是"按谱面书写位置"的静态表）：
   *   - 反复线 `:|` / 跳跃记号 `&ds`/`&dc`/`&ty` 等**都不回描述头调号**（adj627b 那条撤销）；
   *   - 同一小节在不同遍次里可能落在不同调上——这是该口径的**预期**行为（用户已确认）；
   *   - 只有**真正走到**带 `d:` 的小节线才换调 ⇒ 被跳房子/跳越跳过的段落里的 `d:` 不生效。
   *
   * 实现：走查里维护 `curKey`（不是预扫源码顺序的静态表——那种写法会把被跳过段落的 `d:` 也算进去），
   * 每走到一根**小节线**时推进一次；小节自身的音符用"进入该小节时的调号"。
   */
  let curKey = keySemitone
  // adj88：连音线内相同音高连续音符连奏合并——上一个已发事件的音符索引与音高；
  // 当前音符若与上一个音高相同、同属某连音线且中间无音符（索引相邻），则时值并入前一事件
  let lastEventNoteIdx = -1
  let lastEventPitch: string | null | undefined = undefined
  // adj396：上一个音符的**主音符事件**下标（连音合并要并到主音符上，而非其后追加的倚音事件）
  let lastMainEvIdx = -1
  /**
   * adj502/503：上一个音符**携带 `playheadSegs` 的事件**下标（色块归属）。
   * 普通音符 = 主事件（与 `lastMainEvIdx` 相同）；带波音的音符 = **首个波音短音**
   * （波动在开头，色块要与"音符起奏"对齐）⇒ 连音合并追加拍段时要落到这一个上。
   */
  let lastBlockEvIdx = -1
  /**
   * adj396/adj504：上一个音符是否带**后倚音**（`3[h5/]` 这种，倚音占尾部）。
   * 只有它会阻止下一个同音合并进来；**前倚音不影响**（合并只延长主音事件，倚音在开头不受影响）。
   */
  let lastEventHadTailGrace = false
  /**
   * adj375：呼吸换气（&hx）——待结算的事件下标。
   * 语义：`&hx` 占**前面音符**总时值（含同音连音/增时线/附点）的 1/4，且最多 1/2 拍，作为呼吸静音：
   * 该音符的发声时值 = 总时值 − 呼吸量，而**槽位长度不变**（少掉的部分是静音），因此
   * `totalMs`/后续事件位置都不受影响。
   * 结算时机：该事件完成（下一个事件开始）或走查结束——这样连音合并后的总时值也算进基数。
   */
  let breathEvIdx = -1
  const settleBreath = () => {
    if (breathEvIdx < 0) return
    const ev = events[breathEvIdx]
    if (ev) {
      const beats = ev.durationMs / beatMs
      const breathMs = Math.min(beats / 4, 0.5) * beatMs
      ev.durationMs = Math.max(0, ev.durationMs - breathMs)
    }
    breathEvIdx = -1
  }
  /** adj427：待补发的临时段（走到段项时记下，在下一个音符事件处用同一 passMs 补发） */
  let pendingSegment: { voice: number; children: MusicToken[]; type?: 'bz' | 'dsb' | 'tp'; pass?: number } | null = null
  /**
   * adj629k（用户口径：「替谱演奏完应该回到主曲部继续演奏，从第三拍的 1 继续」）：
   * **主旋律某音该不该被替谱静音** = 它的**时值区间**与替谱覆盖区间**有正测度重叠**。
   *
   * 为什么按区间重叠而不是"起点落在替谱区间内"：
   *  · 替谱音常落在主旋律音的**内部**（拍位映射的中间），只看主旋律的起点会漏掉那些音 ⇒
   *    主旋律与替谱**同时发声**（听感就是"跳音"/打架）；
   *  · 反之若把区间终点算大了（旧实现 `r1` 把 1.25 圆成 1.3 ⇒ 末端 2.05），
   *    就会把**紧接在替谱之后**、起点正好等于 2.0 的主旋律音（第 3 拍的 `1-`）也静音掉 ⇒
   *    "替谱演奏完，第三拍的 1 没演奏到"。重叠判据端点相切不算覆盖，正好排除这一档。
   *
   * 坐标用**跨小节线性拍位**（`barStartMsInGroup` 折算），这样替谱音跨小节线时也正确。
   *
   * adj629o（用户报「某几拍没有演奏出来」）：**坐标必须带声部/行号**。
   * 上面这个折算只到"**本组内**的绝对拍"，不含组号——于是"第 3 小节第 1~2 拍"这种坐标
   * 在**所有组里都相等**：某一行（组）里的 `{tp}` 会把**别的行**同拍位区间的主旋律音一起静音
   * （用户实测三条 `Q:` 行各自在"某小节前半"整段不发声，正是撞上了别组替谱覆盖的 `[8,10)`）。
   * 替谱替代的只能是**它自己那一行**，故判据里加上组号。
   */
  const TP_EPS = 1e-6
  const absBeatOf = (g: number, bar: number, beat: number): number =>
    (barStartMsInGroup[g]?.[bar] ?? 0) / beatMs + beat
  const tpSpans: { g: number; from: number; to: number; pass: number }[] = []
  for (const it of seq) {
    if (it.kind !== 'segment' || it.seg?.type !== 'tp') continue
    const passNo = it.seg.pass ?? 2
    for (const t of it.seg.children) {
      if (t.kind !== 'note' && t.kind !== 'rest' && t.kind !== 'rhythm') continue
      const p = segPlacedByToken.get(t)
      if (!p) continue
      const from = absBeatOf(p.id.group, p.barIndex, p.beatPos)
      tpSpans.push({ g: p.id.group, from, to: from + tokenDuration(t), pass: passNo })
    }
  }
  /** 该主旋律音是否被**本遍**的替谱替代（命中则静音）——只在**同一组**内比较 */
  const replacedByTp = (placed: PlacedToken, passNo: number): boolean => {
    if (placed.segment) return false
    const a = absBeatOf(placed.id.group, placed.barIndex, placed.beatPos)
    const b = a + placed.duration
    return tpSpans.some((s) => s.g === placed.id.group && s.pass === passNo && a < s.to - TP_EPS && b > s.from + TP_EPS)
  }
  /** adj427：段层事件的结束时刻（单独累计，**不动 lastEndMs**——它是"当前播放时刻"，动它会破坏反复/跳房子的无缝衔接） */
  let segEndMs = 0
  /**
   * adj427：补发临时段（`{bz … }` / `{dsb … }`）的段层事件。
   *
   * 时间用**传入的 passMs**（= 下一个主旋律音符事件所用的那个）——
   * 段层音符的 `clock` 也由自己的布局坐标算出，故与它所覆盖的主旋律**同刻发声**；
   * 声部角色决定音色与力度：`'main'` = 该声部当前音色 + 力度 1；
   * `'accomp'`（bz 上层）/ `'second'`（dsb 下层）= 第 2 可用音色 + 力度 0.75。
   */
  const emitSegmentEvents = (
    seg: { voice: number; children: MusicToken[]; type?: 'bz' | 'dsb' | 'tp'; pass?: number },
    passMsNow: number,
    /** adj637：本段生效的**调号**（临时转调会变）——段内邻音/滑音阶梯要按它算音高 */
    keyAt: number = keySemitone,
  ): void => {
    // adj427：段层内部色块右边界 = 同段内**下一个段层音符**左缘；最后一个用其占位右缘。
    // （不能沿用主旋律那套 rightEdgeByNoteIdx——它已按设计排除段层音符，避免两套坐标互相污染。）
    const segNotes = seg.children
      .map((t) => segPlacedByToken.get(t))
      .filter((n): n is PlacedToken => n !== undefined)
      .sort((a, b) => a.x - b.x)
    /**
     * adj438：段层**自己的小节线**也要当色块右边界——与主旋律同一规则（adj320：
     * "一个时值元素 = 一个色块，覆盖到**下一时值元素或小节线**前"）。
     *
     * 旧实现只取"同段内下一个段层音符"，于是段内小节线**之前**那个音的色块会**跨过小节线**
     * 一直盖到下一小节第一个音前（用户截图：dsb 上层 `4` 的红色块越过 `|`，看起来像 1.5 拍宽）。
     */
    const segBarXs: number[] = []
    {
      const first = segNotes[0]
      const p0 = first ? pageByNoteIdx.get(first.id.index) : undefined
      if (p0 && first) {
        for (const b of p0.barlines) {
          if (b.segment && b.id.group === first.id.group && b.id.voice === first.id.voice) segBarXs.push(b.x)
        }
        segBarXs.sort((a, b) => a - b)
      }
    }
    const nextSegBarX = (x: number): number => segBarXs.find((v) => v > x + 1e-3) ?? Number.POSITIVE_INFINITY
    /**
     * adj440：段层**右界**（大括号内缘 `/` 内容区右缘，来自 `segmentBrackets.blockRight`）。
     * 用于段内最后一个音的色块右边界——见 `edgeOf` 末尾分支。
     */
    const segBoundKey = segNotes[0] ? `${segNotes[0].id.page}|${segNotes[0].id.group}|${segNotes[0].id.voice}` : ''
    const segRightBound = segNotes[0] ? segRightByGroupVoice.get(segBoundKey) : undefined
    // adj442：段层**左界**（`segLeftByGroupVoice`）**不再用于色块**——用户指出色块应从
    // **起始音符**开始（音符左对齐，重叠区首音本来就对齐），不该从 `{` / 左括号右侧起。
    // 映射仍保留：如需"按段型取左界"的其它用途可直接取用。
    const edgeOf = (n: PlacedToken): number => {
      const i = segNotes.findIndex((m) => m === n)
      const next = i >= 0 && i < segNotes.length - 1 ? segNotes[i + 1].x : Number.POSITIVE_INFINITY
      const own = n.rightX ?? n.x + n.width
      const barX = nextSegBarX(n.x)
      // 小节线是**硬上限**：段层音符的"占位右端"可能越过段内小节线（槽宽含留空），
      // 此时不能再 `max(own)`——否则钳制被盖回去、色块照样跨线。
      if (barX !== Number.POSITIVE_INFINITY) return Math.min(barX, Math.max(next, own))
      if (next === Number.POSITIVE_INFINITY) {
        // adj440：段内**最后一个音**——`&ykh` / 右括号是**无时值占宽元素**（只占宽、不占拍），
        // 所以它后面那段"图形空白"在**时间上仍属于本段末尾**，色块应当延伸到
        // **段层右界（大括号的界限）**，而不是止于内容区右缘 `xContent1`
        // （用户要求：「`&ykh` 不占时值，因此 `1'` 的占宽应该也要到大括号的界限为宜」）。
        return segRightBound !== undefined ? Math.max(segRightBound, own) : own
      }
      return Math.max(next, own)
    }
    /**
     * adj629p（用户报「`(6// 6/)` 是连音，但实际演奏了两个音符」）：
     * **段内同音连音要按"一个长音"奏**——与主旋律 adj89 的合并同口径。
     *
     * 为什么原来没合并：段层事件是这里**逐音 push** 的，没走主旋律那套 `shareSlur` 合并
     * （主旋律靠 `slurOf` + 相邻音符索引），于是 `(6// 6/)` 成了两次起奏。
     * 这里先按段内源码顺序算出"每个时值 token 属于哪几条连音线"（LIFO 配对，与排版端
     * `segNoteOrder` 的配对同一套），发射时把**紧邻、同音高、且同属一条连音线**的段内音并进前一事件。
     * 倚音/波音两侧都不合并（同主旋律 adj396/adj503 的顾虑：合并会盖住倚音、或吞掉波动）。
     */
    const segSlurOf = new Map<number, Set<number>>()
    {
      const stack: { start: number; ri: number }[] = []
      let ri = 0
      let lastDurIdx = -1
      for (let k = 0; k < seg.children.length; k++) {
        const tk = seg.children[k]
        if (tk.kind === 'slur') {
          if (tk.dir === 'open') stack.push({ start: lastDurIdx, ri: ri++ })
          else {
            const st = stack.pop()
            if (st) {
              for (let q = Math.max(0, st.start); q <= lastDurIdx; q++) {
                const set = segSlurOf.get(q)
                if (set) set.add(st.ri)
                else segSlurOf.set(q, new Set([st.ri]))
              }
            }
          }
          continue
        }
        if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') lastDurIdx = k
      }
    }
    let lastSegEvIdx = -1
    let lastSegTokIdx = -1
    let lastSegHadGraceOrOrnament = false
    let lastEmittedDurIdx = -1
    for (let ci = 0; ci < seg.children.length; ci++) {
      const t = seg.children[ci]
      if (t.kind !== 'note' && t.kind !== 'rest' && t.kind !== 'rhythm') continue
      const placed = segPlacedByToken.get(t)
      if (!placed) continue
      const g2 = placed.id.group
      const at2 = passMsNow + groupStartMs[g2] + (barStartMsInGroup[g2][placed.barIndex] ?? 0) + placed.beatPos * beatMs
      const dur2 = (tokenDuration(t) * 60000) / bpm
      const isSec = placed.playVoice === 'accomp' || placed.playVoice === 'second'
      const ov = overriddenByVoice.get(placed.id.voice)
      // adj455：选定试听音色时全篇统一（instOr 包一层，伴奏/第二声部同样跟随）
      const inst2 = instOr(
        isSec
          ? accompInstrument()
          : typeof ov === 'string' && ov.length > 0
            ? parseInstrumentRef(ov).ref
            : voiceDefaultOf(placed.id.voice),
      )
      const gain2 = isSec ? ACCOMP_GAIN : 1
      // adj429：色块按曲行几何动态定界（多声部/临时叠加段不再互相覆盖、也不压歌词）
      const segHeadSegs = buildPlayheadSegs(placed, 0, edgeOf(placed), {
        ...computeColorBounds(placed, pageByNoteIdx.get(placed.id.index)!, voiceBlockByNoteIdx, noteSize),
        // adj442：**左端不外扩**——色块从起始音符开始（见 buildPlayheadSegs 注释）。
        // 原先这里给段内首个音传 `left`，会把色块拉到 `{` / 左括号之前（用户指出观感不对）。
      }).map((s) => ({ ...s, instrument: inst2, playVoice: placed.playVoice, gain: gain2 }))
      // adj635/adj636/adj637：带**演奏型装饰**（波音/打音/叠音）或**滑音**的段内音符同样不能被并进前一个
      //（打音的用途正是"把两个相同的音断开"、滑音并进去滑行就没了；倚音同 adj396 的顾虑）
      const hasGraceOrOrnament =
        t.kind === 'note' &&
        ((t.gracenotes?.notes.length ?? 0) > 0 ||
          ornamentOf(t.symbols) !== null ||
          slideOf(t.symbols) !== null)
      const prevEv = lastSegEvIdx >= 0 ? events[lastSegEvIdx] : undefined
      const curSlurs = segSlurOf.get(ci)
      const prevSlurs = lastSegTokIdx > 0 ? segSlurOf.get(lastSegTokIdx) : undefined
      const sameSlur =
        prevSlurs !== undefined && curSlurs !== undefined && [...prevSlurs].some((r) => curSlurs.has(r))
      /**
       * adj710（用户报「`{dsb}` 的**前两拍没有按双声部演奏**」）：
       * **`{dsb}` 段内的连音合并一律关闭。**
       *
       * 根因：合并（`prevEv.durationMs += dur2`）的本意是"连音线内同音高连奏"，
       * 但它把**后一个音的事件整个吞掉**、那个音的**起奏点就没了**。实测
       * `{dsb (3// 2// 1//) (1// 1/) 7,/ 1- }`：
       *  · 上层 `(1// 1/)` 同音高、同连音线 ⇒ 合并成 `0.643s` 一个音（`1/` 的事件数 **0**）；
       *  · 下层 `(6// 6/)` 音高不同 ⇒ 不合并；
       * ⇒ **两层音符数不再一一对应**，听感上就不是"一个音对一个音的双声部"了
       * （整曲 31 个上层音里 3 个这样丢起奏点）。
       *
       * 为什么只关 `{dsb}`：单声部/多声部块的连音合并是**既有且用户认可**的演奏口径
       * （`(2 - | 2/)` 连成 2.5 拍）；`{bz}`（临时伴奏）是"上方叠层"、不要求逐音对应。
       * 只有 `{dsb}` 的语义是"两个声部上下同拍位**逐音对齐**"。
       */
      const isDsbSegment = seg.type === 'dsb'
      if (
        prevEv !== undefined &&
        ci === lastEmittedDurIdx + 1 && // 紧邻（中间没有别的时值 token）
        !isDsbSegment && // adj710：`{dsb}` 内不合并（合并会让两层音符数不再一一对应）
        !lastSegHadGraceOrOrnament &&
        !hasGraceOrOrnament &&
        sameSlur &&
        placed.audioPitch !== null &&
        placed.audioPitch === prevEv.placed.audioPitch
      ) {
        prevEv.durationMs += dur2
        prevEv.playheadSegs = (prevEv.playheadSegs ?? []).concat(segHeadSegs)
        segEndMs = Math.max(segEndMs, prevEv.atMs + prevEv.durationMs)
        lastSegTokIdx = ci
        lastEmittedDurIdx = ci
        continue
      }
      /**
       * adj637（用户要求「一起补齐以保持一致」）：**段内音符也展开演奏细节**——
       * 段层（`{bz}` / `{dsb}` / `{tp}`）此前只 push 一个整音事件：倚音**不奏**、
       * 演奏型装饰与滑音**不奏**（`&sby` 自 adj502 起就没覆盖段层）。这里按与主旋律
       * **同一套口径**补齐（纯函数 `graceGroupBeats`/`ornamentPlan`/`slidePlan` 全是共用的）：
       *   ① 前倚音依次奏于本音符**开头**、主音顺延；后倚音奏于末尾（时值只从本音符里匀，同 adj623）；
       *   ② 点状装饰（波音/打音/叠音）＝ 若干短音 + 按住的主音；滑音 ＝ 逐半音阶梯 + 按住的主音；
       *   ③ 倚音自身带装饰/滑音时，按 adj633 口径"计划按主音符算、时值整体 × 比率"。
       * 色块仍挂在**本音符的首个非倚音事件**上（与主旋律同一规则：色块与"音符起奏"对齐）。
       */
      const keyAt637 = keyAt
      const notePitch637 = t.kind === 'note' ? pitchToName(t.pitch, t.octaveShift, t.accidental, keyAt637) : null
      const gn637 = t.kind === 'note' ? t.gracenotes : undefined
      const gracePitches637 =
        gn637 && gn637.notes.length > 0
          ? gn637.notes.map((g) => pitchToName(g.pitch, g.octaveShift, g.accidental, keyAt637))
          : []
      const graceGroup637 = gn637 && gn637.notes.length > 0 ? graceGroupBeats(t, dur2 / beatMs) : 0
      const principalBeats637 = dur2 / beatMs
      let graceWindowMs637 = graceGroup637 * beatMs
      let mainMs637 = dur2
      let mainShiftMs637 = 0
      if (gn637 && gn637.notes.length > 0) {
        if (graceGroup637 <= principalBeats637) {
          mainMs637 = (principalBeats637 - graceGroup637) * beatMs
          if (!gn637.after) mainShiftMs637 = graceGroup637 * beatMs
        } else if (!gn637.after) {
          // 与主旋律同一兜底（按现行时值规则已不可达）：窗口压到本音符长度、主音挤成 0
          graceWindowMs637 = principalBeats637 * beatMs
          mainMs637 = 0
          mainShiftMs637 = graceWindowMs637
        } else {
          mainMs637 = principalBeats637 * beatMs
        }
      }
      const mainAt637 = at2 + mainShiftMs637
      const graceNoteMs637 = gracePerNoteBeats(graceWindowMs637 / beatMs, gn637?.notes.length ?? 0) * beatMs
      const ornKind637 = t.kind === 'note' ? ornamentOf(t.symbols) : null
      const ornPlan637 = ornKind637 ? ornamentPlan(mainMs637, ornKind637) : null
      const slideKind637 = t.kind === 'note' && ornKind637 === null ? slideOf(t.symbols) : null
      const preSeq637: { pitchName: string | null; ms: number }[] = []
      let heldMs637 = ornPlan637 ? ornPlan637.heldMs : mainMs637
      if (ornPlan637 && ornPlan637.steps.length > 0 && t.kind === 'note') {
        for (const step of ornPlan637.steps) {
          let nm: string | null = null
          if (step !== 'P') {
            const nb = neighborDegree(t.pitch, step === 'U')
            nm = pitchToName(nb.pitch, t.octaveShift + nb.octave, null, keyAt637)
          }
          preSeq637.push({ pitchName: nm, ms: ornPlan637.shortMs })
        }
      } else if (slideKind637 && t.kind === 'note') {
        const nb = neighborDegree(t.pitch, slideKind637 === 'xhy')
        const fromName = pitchToName(nb.pitch, t.octaveShift + nb.octave, null, keyAt637)
        const plan =
          fromName && notePitch637
            ? slidePlan(pitchToMidiNote(fromName), pitchToMidiNote(notePitch637), mainMs637, midiToPitchName)
            : null
        if (plan && plan.steps.length > 0) {
          for (const p of plan.steps) preSeq637.push({ pitchName: p, ms: plan.stepMs })
          heldMs637 = plan.heldMs
        }
      }
      /** 发一个段内事件（`withSegs` = 携带色块，只给"本音符的首个非倚音事件"） */
      const pushSegEv = (a: number, d: number, p: string | null, withSegs = false) => {
        events.push({
          placed,
          instrument: inst2,
          atMs: a,
          durationMs: d,
          ...(p ? { pitch: p } : {}),
          gain: gain2,
          playVoice: placed.playVoice,
          ...(withSegs ? { playheadSegs: segHeadSegs } : {}),
        })
      }
      /** adj637：段内**单个倚音**的事件（带装饰/滑音时展开，口径同 adj633/adj636：计划按主音符算、整体 ×k） */
      const pushSegGrace = (gi: number, gStartMs: number): void => {
        const g = gn637!.notes[gi]
        const k = mainMs637 > 0 ? graceNoteMs637 / mainMs637 : 0
        const nbOf = (up: boolean) => {
          const nb = neighborDegree(g.pitch, up)
          return pitchToName(nb.pitch, g.octaveShift + nb.octave, null, keyAt637)
        }
        const pre: { pitchName: string | null; ms: number }[] = []
        let held = graceNoteMs637
        const ok = ornamentOf(g.symbols)
        if (ok && k > 0) {
          const plan = ornamentPlan(mainMs637, ok)
          for (const step of plan.steps) pre.push({ pitchName: step === 'P' ? null : nbOf(step === 'U'), ms: plan.shortMs })
          if (plan.steps.length > 0) held = plan.heldMs
        } else {
          const sk = slideOf(g.symbols)
          const toName = gracePitches637[gi]
          const fromName = sk ? nbOf(sk === 'xhy') : null
          const plan =
            sk && fromName && toName && k > 0
              ? slidePlan(pitchToMidiNote(fromName), pitchToMidiNote(toName), mainMs637, midiToPitchName)
              : null
          if (plan && plan.steps.length > 0) {
            for (const p of plan.steps) pre.push({ pitchName: p, ms: plan.stepMs })
            held = plan.heldMs
          }
        }
        if (pre.length === 0) {
          pushSegEv(gStartMs, graceNoteMs637, gracePitches637[gi])
          return
        }
        let gAt = gStartMs
        for (const st of pre) {
          pushSegEv(gAt, st.ms * k, st.pitchName ?? gracePitches637[gi])
          gAt += st.ms * k
        }
        pushSegEv(gAt, held * k, gracePitches637[gi])
      }
      // ① 前倚音（从本音符拍点起奏，主音顺延）
      if (gn637 && !gn637.after && gracePitches637.length > 0) {
        let gAt = at2
        for (let gi = 0; gi < gn637.notes.length; gi++) {
          pushSegGrace(gi, gAt)
          gAt += graceNoteMs637
        }
      }
      // ② 装饰短音 / 滑音阶梯 + 按住的主音（色块挂在本音符的首个非倚音事件上）
      {
        let at = mainAt637
        for (let si = 0; si < preSeq637.length; si++) {
          const st = preSeq637[si]
          pushSegEv(at, st.ms, st.pitchName, si === 0)
          at += st.ms
        }
        // 本音事件只在**与布局算出的音高不同**时才显式给 `pitch`（临时转调）——与主旋律同一口径，
        // 也让"没有装饰的段内音"保持旧事件形状（不凭空多出 `pitch` 字段，见 smoke 的 AX7c/AX9b）
        const heldPitch637 = notePitch637 && notePitch637 !== placed.audioPitch ? notePitch637 : null
        pushSegEv(at, heldMs637, heldPitch637, preSeq637.length === 0)
      }
      // ③ 后倚音（接在主音符的时值之后）
      if (gn637 && gn637.after && gracePitches637.length > 0) {
        let gAt = mainAt637 + mainMs637
        for (let gi = 0; gi < gn637.notes.length; gi++) {
          pushSegGrace(gi, gAt)
          gAt += graceNoteMs637
        }
      }
      segEndMs = Math.max(segEndMs, at2 + dur2)
      lastSegEvIdx = events.length - 1
      lastSegTokIdx = ci
      lastEmittedDurIdx = ci
      lastSegHadGraceOrOrnament = hasGraceOrOrnament
      continue
    }
  }

  while (i < seq.length && guard++ < maxIter) {
    const item = seq[i]
    if (item.kind === 'segment') {
      // adj427：临时段（{bz}/{dsb}）——**不占主旋律时值**，此处只打标记；
      // 段内容等到**下一个音符事件**时用同一个 passMs 补发（⇒ 反复每遍都发声、与主旋律同刻）。
      // adj629：替谱段只在**它自己那一遍**发（`pass` = 所属歌词行序号 = 第几遍）；
      // 不匹配时**不动** pendingSegment（同一条线上并存 bz 段时，别把它的补发标记清掉）。
      const s = item.seg
      if (s && (s.type !== 'tp' || (s.pass ?? 2) === pass)) pendingSegment = s
      i++
      continue
    }
    if (item.kind === 'instrument') {
      // adj301/351：@乐器名 切换（覆盖该声部默认）；@@（name=null）清除该声部覆盖（回声部默认）
      overriddenByVoice.set(item.instr!.voice, item.instr!.name ?? null)
      i++
      continue
    }
    if (item.kind === 'note' && item.note) {
      const placed = item.note
      const token = placed.token
      const g = placed.id.group
      const bi = placed.barIndex
      const bp = placed.beatPos
      const clock = groupStartMs[g] + (barStartMsInGroup[g][bi] ?? 0) + bp * beatMs
      // adj361：若有待跳时刻，先把 passMs 对齐（使本事件 atMs = 待跳时刻 → 无缝衔接）
      if (pendingJumpMs >= 0) {
        passMs = pendingJumpMs - clock
        pendingJumpMs = -1
      }
      /**
       * adj629k：**补发临时段要放在"静音判定"之前**。
       *
       * 静音（`replacedByTp`）是"这一遍主旋律不发声"，与"替谱层什么时候把事件补发出去"无关；
       * 旧顺序在静音分支里 `continue`，于是**替谱段的补发被推迟到下一个没被静音的音符**——
       * 若替谱覆盖到本组末尾（后面没有未静音的音符），补发会一直拖到走查结束、用**最后一遍的
       * `passMs`** 发出（时间落错），听感就是"跳音"。现在先补发再判静音，顺序与时间都稳定。
       */
      if (pendingSegment) {
        emitSegmentEvents(pendingSegment, passMs, curKey)
        pendingSegment = null
      }
      // adj629：本遍若被替谱段替代，则**主旋律这一段不发声**（替谱层已在上面发声）
      if (replacedByTp(placed, pass)) {
        i++
        continue
      }
      const durationMs = (tokenDuration(token) * 60000) / bpm
      // adj627：音高按**当前生效调号**现算（有临时转调时 `placed.audioPitch` 只反映"第一遍"的调号，
      // 反复/跳转后同一音符可能落在不同的调上；这里用 `curKey` 与走查位置严格对应）
      const pitch = token.kind === 'note' ? pitchToName(token.pitch, token.octaveShift, token.accidental, curKey) : placed.audioPitch
      const curNoteIdx = item.noteIdx ?? -1
      // adj282：每个 event 的 atMs 由所属 group 的拍时钟决定（不受源码顺序累加），
      // 保证同组同 (barIndex, beatPos) 的各声部事件 atMs 相同 → 同步播放
      const atMs = passMs + clock
      lastEndMs = Math.max(lastEndMs, atMs + durationMs)
      // adj89：合并判定——与前一已发事件音高相同、索引相邻（中间无音符）、
      // 且**两者同属同一条连音线**（严格 slur 内连奏）：
      // (2 - | 2/) 的 2 连 2.5 拍；(2 3/ 2/ | 2) 第 3、4 个 2 连奏；
      // (2 3 | 2) 中间隔 3 不合并；**连音线外的同音符不并入**
      // （(2 - | 2) 2 → 播 3 拍再播 1 拍，不连成 4 拍）
      //
      // adj396/adj504/adj629r：倚音对这档合并的影响**分前后**看：
      //  · **前倚音**排在主音符**之前**、占本音符开头 ⇒ 并进来就没有独立起奏点、倚音会被吞 ✗ 不合并；
      //  · **后倚音**占的正是这个长音的**末尾** ✗ 旧口径也一律不合并 —— 于是
      //    `(6- | 6[h1'/])` 这种"跨小节同音连线 + 末尾后倚音"被拆成两次起奏（用户报「6 演奏了 2 次」）。
      //    现在允许合并：延长前者、把后倚音挪到**合并后的末尾**奏出（时值不增不减）。
      //
      // 注意：合并判定放在**倚音/音色算完之后**（下面 adj629r 块）——后倚音要复用 `graceWindowMs`/
      // `graceNoteMs`/`gracePitches`/`instrument`/`gain` 这些量，早于它们的旧位置做不到。
      // adj351：按声部取覆盖乐器（该声部最近一次 @ 结果；未设置/@@ 清空 → 用该声部 Y 默认乐器）
      // adj427：按**声部角色**分流——'accomp'（bz 上层）/ 'second'（dsb 下层）为伴奏/第二声部：
      //   用第 2 可用音色（色块随之换色）+ 0.75 力度；'main' / 未设置 = 主声部，音色力度都不变。
      const playRole = placed.playVoice
      const isSecondaryVoice = playRole === 'accomp' || playRole === 'second'
      const voiceInst = overriddenByVoice.get(placed.id.voice)
      // adj434：`@乐器名@` 曲内显式切换 → 标记 explicit（播放端不让「试听音色」压掉它）
      // adj455：但**选定了具体试听音色**时全篇统一，此时不再认曲内 `@` 切换（也不标 explicit，
      //   避免"标记说它有自己的音色、实际播放却是统一音色"的自相矛盾）；提示由界面负责
      //   （PlaybackDialog 用 countScoreInstrumentSwitches 告知"谱面里的 @ 已被统一覆盖"）。
      const hasExplicitInst =
        overrideRef === '' && !isSecondaryVoice && typeof voiceInst === 'string' && voiceInst.length > 0
      const instrument = instOr(
        isSecondaryVoice
          ? accompInstrument()
          : hasExplicitInst
            ? parseInstrumentRef(voiceInst!).ref
            : voiceDefaultOf(placed.id.voice),
      )
      const gain = isSecondaryVoice ? ACCOMP_GAIN : 1
      // 倚音（时值口径 adj489/505/507/624；**摆放口径 adj623：前倚音占用本音符的时值**）：
      //   ① 短倚音（带减时线）组时值 = **主音符因子 × 倚音因子**（adj507），组内**均分**这个时段；
      //      主音符因子按**本体**（不含增时线与附点，adj624）算：1 拍 → 1、< 1 拍 → 1/2；
      //      再取上限 `min(值, 本体 ÷ 2)`（adj624：本体 < 1/2 拍时倚音 = 本体的一半）；
      //      例：`3[2/]` = 1/4 拍；`3/[2/]` = 1/8 拍；`3///[2/]` = 1/16 拍；`3 -[2/]` 仍 1/4 拍；
      //   ② 长倚音（无减时线）组时值 = 主音符**本体** ×（附点 2/3、否则 1/2），组内均分
      //      例：`3[2]` = 1/2 拍、`3.[2]` = 1 拍、`3[32]` 共享 1/2 拍；
      //   ③ 前/后倚音的时值都从**本音符自己**的时值里匀（前后同一把尺子）：
      //      主音符发声时值 = 本音符总时值 − 组时值，**本音符总时值不变**
      //      ⇒ 小节总长、后续音符的起始点都不受影响（不再向前/向后一个音符借，整曲不会被挪动）；
      //   ④ 前倚音依次奏于本音符**开头**（从拍点起奏、主音符顺延到倚音之后），
      //      后倚音依次奏于主音符**末尾**（含增时线/附点）；
      //   ⑤ `3 -[h5/]`：主音符先奏满增时线/附点（到总时值末尾前），最后 1/4 拍才奏后倚音
      //      —— 倚音**时值**按本体 1 拍算（adj624），**位置**在增时线/附点之后。
      const gn = token.kind === 'note' ? token.gracenotes : undefined
      const gracePitches =
        gn && gn.notes.length > 0
          ? gn.notes.map((g) => pitchToName(g.pitch, g.octaveShift, g.accidental, curKey))
          : []
      /**
       * adj505（用户规范，力度按方案 b「只做力度区分」）：
       * **短倚音**（带减时线）不占强位、重音在主音符上 ⇒ 力度取 **90%**（稍弱起）；
       * **长倚音**在拍点上是重音 ⇒ **力度不变**。前/后倚音同一把尺子。
       * 逐事件 `gain` 会经 `playback/index.ts` 的 `0.5 × gain` 落到 `velocity = round(127 × gain)`。
       */
      const isShortGrace = (gn?.notes ?? []).reduce((m, g) => Math.max(m, g.diminishCount), 0) > 0
      const graceGain = isShortGrace ? gain * 0.9 : gain
      // 组时值（拍）+ 单个倚音时值（ms）—— adj489 均分
      const graceGroup = gn && gn.notes.length > 0 ? graceGroupBeats(token, durationMs / beatMs) : 0
      /** 本音符原本时值（拍）—— 倚音从这份里匀 */
      const principalBeats = durationMs / beatMs
      // 主音符新时值 + 倚音组的实际摆放窗口
      let principalNewMs = durationMs
      /** 倚音组实际占用的时长（ms；只在下面"装不下"的兜底分支里才会被压缩） */
      let graceWindowMs = graceGroup * beatMs
      /** 主音符起奏点相对拍点的偏移：前倚音占本音符**开头** ⇒ 主音符后移；后倚音 ⇒ 0（落拍点） */
      let mainShiftMs = 0
      if (gn && gn.notes.length > 0) {
        if (graceGroup <= principalBeats) {
          // 够装（绝大多数）：**倚音只吃本音符自己的时值**，本音符总时值不变——
          // 前倚音占本音符开头（主音符后移 `graceGroup`）、后倚音占本音符末尾（主音符照常起奏、提前收尾）。
          principalNewMs = (principalBeats - graceGroup) * beatMs
          if (!gn.after) mainShiftMs = graceGroup * beatMs
        } else if (!gn.after) {
          // adj624：按现行时值规则（短倚音 ≤ 本体的一半、长倚音 ≤ 本体）**已不可达**，此处只作兜底：
          // 仍只占本音符的时值——窗口压缩到本音符长度（倚音按比例变快）、主音符挤成 0 拍不发声；
          // **绝不向前一个音符借**（adj508 的旧口径会把上一个音符截短、整曲位移），也不撑长小节。
          graceWindowMs = principalBeats * beatMs
          principalNewMs = 0
          mainShiftMs = graceWindowMs
        } else {
          // 后倚音装不下（同样按现行时值规则不可达，兜底）：本主音符保持原时值，后倚音接在其末尾。
          principalNewMs = principalBeats * beatMs
        }
      }
      const mainMs = principalNewMs
      /** 主音符发声起点：前倚音占本音符开头 ⇒ 后移 `mainShiftMs`；无倚音/后倚音 ⇒ 落拍点（偏移 0） */
      const mainAtMs = atMs + mainShiftMs
      /** 单个倚音时值（ms）= **实际窗口**均分（组时值超过本音符时窗口已被压缩，倚音随之变快） */
      const graceNoteMs = gracePerNoteBeats(graceWindowMs / beatMs, gn?.notes.length ?? 0) * beatMs
      // 演奏型装饰（adj502 波音 / adj635 打音·叠音，用户规范）：与倚音同源——时值从主音符里匀出来、
      // 总时值守恒，但**从主音侧起奏**（波音与打音从主音开始；叠音从上方邻音起奏、主音顺延）：
      //   · 短音时长按族取：波音 = clamp(P/8, 45, 110)ms；打音/叠音 = clamp(P/16, 30, 70)ms（辅助音"极小"）；
      //   · P 取「扣掉倚音后的发声时值」mainMs ⇒ 与倚音共用同一个主音符预算，总守恒不打折；
      //   · 短音依次排在**主音起奏点** mainAtMs 之后，其后才是"按住的主音"（heldMs）；
      //   · 邻音取调内二度、不继承主音临时变音；7 上翻八度、1 下翻八度（见 ornaments.ts）。
      const ornKind = token.kind === 'note' ? ornamentOf(token.symbols) : null
      const ornPlan = ornKind ? ornamentPlan(mainMs, ornKind) : null
      /**
       * adj636：**滑音**（`&shy` 从下方滑进、`&xhy` 从上方滑进，见 `slides.ts`）——只在**没有**点状装饰
       * （波音/打音/叠音）时生效：两者同写时点状装饰优先（都要求"重新起奏"，叠在一起没有音乐含义）。
       */
      const slideKind = token.kind === 'note' && ornKind === null ? slideOf(token.symbols) : null
      /** 按住的主音时值（有装饰/滑音时 = 计划里剩下的那一段；否则就是整个发声时值） */
      let heldMs = ornPlan ? ornPlan.heldMs : mainMs
      /**
       * **本音符开头的前置短音序列**（按演奏顺序，依次从 `mainAtMs` 起排）：
       *  · 点状装饰（波音/打音/叠音）＝ 若干等长短音（`ornPlan.shortMs`），`pitchName = null` 表示"本音本体"；
       *  · 滑音 ＝ 逐半音的阶梯音（`slidePlan`，如 `6&shy` = 5 → 5#），**到本音音高的那一格就是下面的主音事件**；
       *  · 无装饰无滑音 ＝ 空（本音符直接从自己的音高起奏）。
       * 两种情形**总时值都不变**（前置占的开头 + 按住的剩余 = 本音符发声时值）。
       */
      const preSeq: { pitchName: string | null; ms: number }[] = []
      if (ornPlan && ornPlan.steps.length > 0) {
        for (const step of ornPlan.steps) {
          let pitchName: string | null = null
          if (step !== 'P' && token.kind === 'note') {
            const nb = neighborDegree(token.pitch, step === 'U')
            pitchName = pitchToName(nb.pitch, token.octaveShift + nb.octave, null, curKey)
          }
          preSeq.push({ pitchName, ms: ornPlan.shortMs })
        }
      } else if (slideKind && token.kind === 'note') {
        // 起点 = 本音在滑动方向上的调内二度（`&shy` 从下方滑进 ⇒ 取**下方**邻音；`&xhy` ⇒ 上方邻音）
        const nb = neighborDegree(token.pitch, slideKind === 'xhy')
        const fromName = pitchToName(nb.pitch, token.octaveShift + nb.octave, null, curKey)
        const toName = pitch ?? placed.audioPitch
        const plan =
          fromName && toName ? slidePlan(pitchToMidiNote(fromName), pitchToMidiNote(toName), mainMs, midiToPitchName) : null
        if (plan && plan.steps.length > 0) {
          for (const p of plan.steps) preSeq.push({ pitchName: p, ms: plan.stepMs })
          heldMs = plan.heldMs
        }
      }
      /** 按住的主音起奏点 = 主音起奏点 + 前置短音之和 */
      const heldAtMs = mainAtMs + preSeq.reduce((a, s) => a + s.ms, 0)
      /**
       * adj633/adj636（用户要求）：**倚音上的演奏型装饰与滑音**（`2[3/&sby]`、`6/[5/&die]`、`3[2/&da]`、
       * `6/[5/&shy]`）——口径「倚音的演奏参考主音符，只在时值按比率缩得更短」：
       *  · 装饰/滑音**计划本身按主音符算**：P 取 `mainMs`（与主音符上的同名记号同一个 P），同一套
       *    短音时长、预算规则与邻音规则 ⇒ 奏法形状与主音符完全一致；
       *  · 再把这个计划里的每一步时长**整体 × k**（`k = 该倚音的发声时值 / P`）——只是按比率变快；
       *    各步之和 = 该倚音的发声时值（`graceNoteMs`），总时值守恒不打折（倚音不额外占拍）；
       *  · 邻音取**该倚音**音级的调内二度（同主音符口径：不继承临时变音，`7` 上翻八度、`1` 下翻八度）；
       *  · 力度沿用该倚音的 `graceGain`（短倚音 90%），与主音符"用主音符自己的力度"同一口径。
       * 主音符发声时值为 0（极端兜底路径）时退化为普通倚音事件，不硬塞装饰。
       */
      const pushGraceNote = (gi: number, gStartMs: number): void => {
        const g = gn!.notes[gi]
        /** 发一个该倚音的事件（字段顺序与既有单音事件一致） */
        const pushOne = (atMs0: number, durMs: number, pitchName: string | null) => {
          // 注：闭包里用上面已收窄的 `placed`（`item.note` 在回调里收窄不成立）
          events.push({ placed, instrument, atMs: atMs0, durationMs: durMs, pitch: pitchName, gain: graceGain, playVoice: playRole, ...(hasExplicitInst ? { explicitInstrument: true } : {}) })
        }
        const kind = ornamentOf(g.symbols)
        const k = mainMs > 0 ? graceNoteMs / mainMs : 0
        const nbOf = (up: boolean) => {
          const nb = neighborDegree(g.pitch, up)
          return pitchToName(nb.pitch, g.octaveShift + nb.octave, null, curKey)
        }
        // 前置短音（装饰短音 / 滑音阶梯），时值随后统一 ×k（见上面的口径）
        const pre: { pitchName: string | null; ms: number }[] = []
        let planHeld = graceNoteMs
        if (kind && k > 0) {
          const plan = ornamentPlan(mainMs, kind)
          for (const step of plan.steps) pre.push({ pitchName: step === 'P' ? null : nbOf(step === 'U'), ms: plan.shortMs })
          if (plan.steps.length > 0) planHeld = plan.heldMs
        } else {
          // adj636：倚音上的滑音——起点仍是该倚音音级的调内二度（`&shy` 下方、`&xhy` 上方）
          const sk = slideOf(g.symbols)
          const toName = gracePitches[gi]
          const fromName = sk ? nbOf(sk === 'xhy') : null
          const plan = sk && fromName && toName && k > 0
            ? slidePlan(pitchToMidiNote(fromName), pitchToMidiNote(toName), mainMs, midiToPitchName)
            : null
          if (plan && plan.steps.length > 0) {
            for (const p of plan.steps) pre.push({ pitchName: p, ms: plan.stepMs })
            planHeld = plan.heldMs
          }
        }
        if (pre.length === 0) {
          pushOne(gStartMs, graceNoteMs, gracePitches[gi])
          return
        }
        let gAt = gStartMs
        for (const st of pre) {
          pushOne(gAt, st.ms * k, st.pitchName ?? gracePitches[gi])
          gAt += st.ms * k
        }
        // 收尾：装饰短音 / 滑音阶梯之后按住的那个主音（同一个倚音，时值 = 计划里的 heldMs × k）
        pushOne(gAt, planHeld * k, gracePitches[gi])
      }
      /**
       * adj629r（用户报「`(- (6[1'/]- 6.) 1'/) | … (6- | 6[h1'/])- …` 里 `(6- | 6[h1'/])` 只应是一个
       * `6` 奏 4 拍、末尾一个后倚音，实际 `6` 奏了两次」）：**同音连音合并**放在这里（倚音/音色都算完之后），
       * 并按"倚音在前还是在后"区别对待：
       *  · **前倚音**不合并——它排在主音符**之前**、占本音符开头，并进来就没有独立起奏点、倚音会被吞；
       *  · **后倚音**可以合并——它占的正是这个长音的**末尾**：延长前者，再把后倚音排在合并后的末尾奏出，
       *    总时值不增不减（长音少奏 `graceWindowMs`，这段正好留给后倚音）。
       * adj503：带**演奏型装饰**（波音/打音/叠音）的音符自己不能被并进前一个（它要重新起奏并奏出辅助音）；
       * adj596：合并只能在**同一声部内**（多声部单元按小节交替后，"上一个已发事件"可能属于另一声部）。
       */
      const sameVoiceAsPrev =
        lastMainEvIdx >= 0 && events[lastMainEvIdx]?.placed.id.voice === placed.id.voice
      {
        const prevRanges = lastEventNoteIdx >= 0 ? slurOf.get(lastEventNoteIdx) : undefined
        const curRanges = slurOf.get(curNoteIdx)
        const shareSlur =
          prevRanges !== undefined && curRanges !== undefined && [...prevRanges].some((r) => curRanges.has(r))
        const hasFrontGrace = gn !== undefined && !gn.after && gracePitches.length > 0
        const hasTailGrace = gn !== undefined && gn.after && gracePitches.length > 0
        /**
         * adj651c：**延续类连音线**——本音符是某条延续线的终点，且**上一个已发事件正好是它的起点**
         * （演奏顺序相邻，源码顺序不相邻）。这是"跨跳房子接续"的唯一可判据。
         */
        const continuesFromPrev =
          lastEventNoteIdx >= 0 && contTieStartOf.get(curNoteIdx) === lastEventNoteIdx
        if (
          lastEventNoteIdx >= 0 &&
          sameVoiceAsPrev &&
          /**
           * adj710/adj722：**`{dsb}` 两层都不合并**——合并会吞掉起奏点，让"上下两声部逐音一一对应"失效
           * （用户报「没有按双声部演奏」）。
           * adj722 起判据从"`playRole === 'second'`"改为"**`parentY` 有值**"：
           * 翻转后包络外主旋律是**主声部**（`playVoice` 未设），但它同样必须保留每个音的起奏点。
           */
          placed.parentY === undefined &&
          (continuesFromPrev || (curNoteIdx === lastEventNoteIdx + 1 && shareSlur)) &&
          !hasFrontGrace &&
          ornKind === null &&
          slideKind === null &&
          !lastEventHadTailGrace &&
          lastMainEvIdx >= 0 &&
          pitch !== null &&
          pitch === lastEventPitch
        ) {
          const prev = events[lastMainEvIdx]
          // 后倚音占这个长音的末尾 ⇒ 长音先奏到"末尾之前"，空出来的那段给后倚音
          const tailMs = hasTailGrace ? graceWindowMs : 0
          prev.durationMs += durationMs - tailMs
          lastEndMs = Math.max(lastEndMs, prev.atMs + prev.durationMs) // adj361：合并后当前播放时刻随之前移
          // adj300：连音合并——把被合并音符的拍段并入 prev 的播放拍段（色块可覆盖全时值，
          // 如 (1 - - - | 1) - 0 0 中 1 合并 6 拍，色块依次滑过 1 - - - 1 -）
          // adj502/503：色块挂在"该音符携带 playheadSegs 的那个事件"上——普通音符 = 主事件（= prev）；
          // 带波音的音符 = **首个波音短音**（见上文的发射顺序）⇒ 追加拍段要落到那一个上，
          // 否则 `prevBeat` 会从 0 起算、色块与已有段重叠。
          const blockEv = events[lastBlockEvIdx >= 0 ? lastBlockEvIdx : lastMainEvIdx]
          const prevBeat = (blockEv.playheadSegs ?? []).reduce((a, s) => a + s.beats, 0)
          // adj451：并入的拍段力度取**发声事件（prev）的 gain**——合并后是一个 noteOn，
          // 音频只可能用一个力度，色块轨道必须跟着它，二者不能各说各话。
          const prevGain = prev.gain ?? 1
          blockEv.playheadSegs = (blockEv.playheadSegs ?? []).concat(
            buildPlayheadSegs(item.note!, prevBeat, rightEdgeByNoteIdx.get(item.note!.id.index), computeColorBounds(item.note!, pageByNoteIdx.get(item.note!.id.index)!, voiceBlockByNoteIdx, noteSize)).map((s) => ({ ...s, instrument: blockEv.instrument, playVoice: item.note!.playVoice, gain: prevGain })),
          )
          if (hasTailGrace) {
            // 后倚音接在被合并长音的**末尾**（时值口径与不合并时一致：主音让出这一小段）
            // adj633：带波音的倚音在这里也照旧展开成波音短音（`pushGraceNote`）
            let gAt = prev.atMs + prev.durationMs
            for (let gi = 0; gi < gn!.notes.length; gi++) {
              pushGraceNote(gi, gAt)
              gAt += graceNoteMs
            }
          }
          // adj157：合并时值；atMs 来自拍时钟（每个 event 独立），不需全局 at 累加
          lastEventNoteIdx = curNoteIdx
          // 合并进来的那个音带后倚音 ⇒ 末尾已有倚音，再并下一个音会盖住它（同 adj396 的顾虑）
          lastEventHadTailGrace = hasTailGrace
          i++
          continue
        }
      }
      if (gn && !gn.after && gracePitches.length > 0) {
        // adj623：前倚音一律从**本音符自己的拍点**起奏（占用本音符的时值），主音符顺延到倚音之后。
        let gAt = atMs
        for (let gi = 0; gi < gn.notes.length; gi++) {
          // adj436：倚音是**独立事件**，必须**继承主音符的声部角色与音色来源**——
          // 否则「试听音色」的全局覆盖会把 `@手风琴@` 之后的倚音（如 `3/[3/5/]`）压回主音色
          // （用户报「演奏到 `3/[3/5/]` 处又切回主音色了，应该还是手风琴」）；
          // 段内（bz/dsb）音符的倚音缺 `playVoice` 还会丢掉伴奏/第二声部音色。
          // adj633：带波音的倚音由 `pushGraceNote` 展开成「波音短音 + 按住的主音」。
          pushGraceNote(gi, gAt)
          gAt += graceNoteMs
        }
      }
      // adj375：新事件开始 → 上一个事件已完成（不会再被连音合并）→ 结算它的呼吸静音
      settleBreath()
      // adj502/adj635/adj636：演奏型装饰与滑音的**前置短音**（装饰短音 / 滑音半音阶梯）
      // ——首个短音顺便携带色块（色块要与"音符起奏"对齐，否则会晚一个短音的长度才亮）
      const playheadSegs = buildPlayheadSegs(item.note!, 0, rightEdgeByNoteIdx.get(item.note!.id.index), computeColorBounds(item.note!, pageByNoteIdx.get(item.note!.id.index)!, voiceBlockByNoteIdx, noteSize)).map((s) => ({ ...s, instrument, playVoice: item.note!.playVoice, gain }))
      // adj503：色块挂在**首个前置短音**上（有装饰/滑音时）或主事件上（都没有）——记下来供连音合并追加拍段
      const blockEvIdx = preSeq.length > 0 ? events.length : -1
      {
        let at = mainAtMs
        for (let si = 0; si < preSeq.length; si++) {
          const st = preSeq[si]
          events.push({
            placed: item.note,
            instrument,
            atMs: at,
            durationMs: st.ms,
            // 装饰的 'P' 步不带 `pitch` ⇒ 沿用 placed.audioPitch（本音本体，含变音记号）
            ...(st.pitchName ? { pitch: st.pitchName } : {}),
            gain,
            playVoice: playRole,
            ...(hasExplicitInst ? { explicitInstrument: true } : {}),
            ...(si === 0 ? { playheadSegs } : {}),
          })
          at += st.ms
        }
      }
      const mainEvIdx = events.length
      events.push({
        placed: item.note,
        instrument,
        atMs: heldAtMs,
        durationMs: heldMs,
        gain,
        playVoice: playRole,
        // adj627：临时转调下"当下调号算出的音高"与布局值不同时才**显式覆盖**
        // （播放层取 `ev.pitch ?? ev.placed.audioPitch`；反复第二次经过转调线时布局值已不适用）
        ...(pitch && pitch !== placed.audioPitch ? { pitch } : {}),
        // adj434：`@乐器名@` 显式指定 → 播放端保留该音色（不被「试听音色」全局覆盖压掉）
        ...(hasExplicitInst ? { explicitInstrument: true } : {}),
        // 有色块的话，色块已挂在首个前置短音上（见上）
        ...(preSeq.length === 0 ? { playheadSegs } : {}),
      })
      // adj623：前倚音只吃**本音符自己的时值** ⇒ 无需再回改上一个主音符事件
      // （adj508 的旧口径会把上一个音符截短来给倚音腾出"拍点前"的时间，现已废弃）。
      // adj375：本音符是某 &hx 的作用对象 → 标记该事件待结算（连音合并会累加时值后再一起算）
      if (hxBreathNoteIdx.has(curNoteIdx)) breathEvIdx = mainEvIdx
      if (gn && gn.after && gracePitches.length > 0) {
        // 后倚音接在主音符（含增时线/附点）之后；
        // 若 principal_new === 0（极端短主音符），gAt 仍用 mainAtMs + mainMs（即原 atMs + 原 durationMs）。
        let gAt = mainAtMs + mainMs
        for (let gi = 0; gi < gn.notes.length; gi++) {
          // adj436：同样继承声部角色与音色来源（同前倚音）
          // adj633：带演奏型装饰的倚音由 `pushGraceNote` 展开成「装饰短音 + 按住的主音」
          pushGraceNote(gi, gAt)
          gAt += graceNoteMs
        }
      }
      lastEventNoteIdx = curNoteIdx
      lastEventPitch = pitch
      lastMainEvIdx = mainEvIdx
      lastBlockEvIdx = blockEvIdx >= 0 ? blockEvIdx : mainEvIdx
      // adj504/adj629r：只有**后倚音**会阻止下一个音符合并进来（前倚音/波音都不阻止，见上面的说明）
      lastEventHadTailGrace = gn !== undefined && gn.after && gracePitches.length > 0
      i++
      continue
    }
    const bar = item.bar!
    /**
     * adj665：**转调状态在小节线处推进**——本小节的音符已在上面按"进入本小节时的调号"发声，
     * 这里才套用本线的影响：该线自带显式 `d:<调>` ⇒ 换调；`d:` ⇒ 回描述头调号。
     * 反复/跳跃记号**不改变调号**（用户口径：转调后反复/跳跃都继续用转调后的调号）。
     */
    if (bar.keyChange) curKey = bar.keyChange.clear ? keySemitone : bar.keyChange.targetKey ?? curKey
    // adj359：跳房子——本遍不演奏该 volta 时，跳到其末尾小节线
    // （停在末尾线上而非其后一位：`:|]["2."` 共用一根线时，仍需处理该线上的 volta2 番号）
    // adj368：判断依据按标签类型——番号（`["2."`）比遍次；文字标签（`["结束句"`）比该段最终遍数
    // adj653：番号可以是**多个**（`["2.3."` = 第 2、3 遍共用）⇒ 判"本遍 ∈ nums"
    const trySkipVolta = (): boolean => {
      if (!bar.voltaStart) return false
      const label = voltaLabelOf(item)
      const skip = label.kind === 'text' ? pass < (segMaxPass[i] ?? 1) : !label.nums.includes(pass)
      if (!skip) return false
      const target = voltaAfter.get(i) ?? i + 1
      landedByVoltaSkip = target
      i = target
      pendingJumpMs = lastEndMs // adj361：被跳过的房子不占时，从当前播放时刻无缝接上
      return true
    }
    /**
     * 因跳过 volta 而落在的小节线：**不再触发该线的 `:|` 回跳**（该反复已在跳过时越过）。
     *
     * adj598（用户口径）：但该线上的**注释/修饰符跳转与曲终照常执行**——未封闭房子
     * `|["n." … |]/` 的定义就是"演奏到**下一个跳跃或结束**"，落到那根线时它自己的
     * `&ds`/`&dc`/`&fine` 必须生效（旧实现落点直接 `i++`，会把 `&fine` 当成没写过）。
     */
    const landedByVolta = i === landedByVoltaSkip
    if (landedByVolta) {
      landedByVoltaSkip = -1
      /**
       * adj653：落点线上**确实会生效的跳转记号**优先于"再判一次跳房子标签"。
       *
       * `… :|&ds]["4." …` 这种"一根线既是上一个房子的终点、又是下一个房子的起点、还挂着 `&ds`"，
       * 若先按下一个房子的番号再跳一次，就会**把 D.S. 一起跳过去**：用户谱例把 `["2.3."` 换成
       * `["2."` 时，末遍跳过房子 2 落到这根线，D.S. 丢失 ⇒ 整曲少一遍、`["4."` 一次都不响。
       */
      const jumpFires =
        (bar.marks?.includes('fine') === true && (!hasBigRepeat || bigRepeatDone)) ||
        (bar.marks?.includes('dc') === true && !bigRepeatDone) ||
        (bar.marks?.includes('ds') === true && !bigRepeatDone) ||
        (bar.marks?.includes('ty') === true && bigRepeatDone)
      if (!jumpFires && trySkipVolta()) continue
    }
    // adj359：小节线修饰符跳转（&fine 曲终 / &dc 从头反复 / &ds 跳花S / &ty 跳越）
    // 规则（用户规范）：&dc/&ds「大反复」全曲各只跳一次（之后再遇不跳，续播到 Fine/终止线，避免死循环）；
    // &ty 第一次遇到忽略，大反复之后再次遇到才跳到下一个 &ty（两 ty 之间不演奏）；
    // &fine 在有 dc/ds 时仅于大反复之后生效（第一遍穿过 Fine 走到大反复）。
    /**
     * adj653（用户口径）：同一根线上**既 `:|` 又 `&ds`/`&dc`** 时——**反复优先**。
     * 本段还有遍次没走完（`pass < count`）就先按 `:|` 回跳；等遍次走完再到这根线，才执行 `&ds`/`&dc`。
     *
     * 用户的谱例：`… 1- 0 1/ 6,/ :|&ds][…`，该段共 3 遍（段内两根 `:|`）——第 2 遍到这根线要**回 `|:`**、
     * 第 3 遍才跳 `&hs`；旧实现先判 `&ds`，于是第 2 遍就跳了花 S，`bigRepeatDone` 提前置位，
     * 第 3 遍把后面的房子全跳过 ⇒ 整曲只奏 3 遍、房子 4 一次都不响。
     */
    const repeatPending =
      (bar.type === ':|' || bar.type === ':|:') && pass < (repeatCountAt.get(i) ?? 2)
    if (bar.marks?.length && !repeatPending) {
      if (bar.marks.includes('fine') && (!hasBigRepeat || bigRepeatDone)) {
        i = seq.length // 曲终：播放到此结束
        continue
      }
      if (bar.marks.includes('dc')) {
        if (!bigRepeatDone) {
          i = 0 // 从头反复
          bigRepeatDone = true
          pass = 1
          repeatStart = 0
          pendingJumpMs = lastEndMs // adj361：从当前播放时刻无缝接上（从头反复）
          continue
        }
        i++
        continue
      }
      if (bar.marks.includes('ds')) {
        if (!bigRepeatDone) {
          i = segnoIdx >= 0 ? segnoIdx + 1 : 0 // 跳到花 S 之后（hs 通常写在 ds 之前）
          bigRepeatDone = true
          // adj362：D.S. 后进入「下一遍」（pass 递增，不重置为 1）——房子番号按遍次选择，
          // 于是跳过前面已奏过的房子、进入下一号房子；repeatStart 保持不变（仍在同一反复段内，
          // 且 pass 已超过该段遍数 → 不会再误回跳）
          pass++
          pendingJumpMs = lastEndMs // adj361：跳到花 S 后从当前播放时刻无缝接上
          continue
        }
        i++
        continue
      }
      if (bar.marks.includes('ty')) {
        if (bigRepeatDone) {
          const nextTy = seq.findIndex((it, k) => k > i && it.kind === 'bar' && it.bar?.marks?.includes('ty'))
          if (nextTy >= 0) {
            i = nextTy + 1 // 跳到下一个 &ty 之后（两 ty 之间不演奏）
            pendingJumpMs = lastEndMs // adj361：跳越段不占时，从当前播放时刻无缝接上
            continue
          }
        }
        i++
        continue
      }
    }
    // 反复结束线 :| —— 优先于 volta 跳过：`:|]["2."` 共用一根线时（volta1 结束 + volta2 开始），
    // 正常演奏到该线应先按反复回跳；只有「因跳过 volta1 而落在此线」时才越过回跳、转去判断 volta2 番号
    // adj598：`landedByVolta` 时**整块跳过**（回跳已在跳过房子时越过），但下面 switch 里的
    // 终止线 `||` / 段落起点 `|:` 仍要照常处理——落点线可能正是"结束"或"下一段起点"。
    if (!landedByVolta && (bar.type === ':|' || bar.type === ':|:')) {
      const count = repeatCountAt.get(i) ?? 2 // 本段内到该线的第几个 :|（+1 = 总遍数）
      if (pass < count) {
        i = repeatStart
        pass++
        pendingJumpMs = lastEndMs // adj361：反复回跳→从当前播放时刻无缝接上（新遍）
        continue
      }
      if (bar.type === ':|:') {
        repeatStart = i + 1 // 新段落起点
        pass = 1
      }
      i++
      continue
    }
    if (trySkipVolta()) continue
    switch (bar.type) {
      case '|:':
      case '||:':
        repeatStart = i + 1
        pass = 1 // 新段落起点 → 遍次从 1 起
        i++
        break
      case '||':
      case '||/':
        i = seq.length // 终止线：结束
        break
      default:
        i++
    }
  }

  // adj375：走查结束——最后一个事件没有"下一个事件"来触发结算，这里补一次
  settleBreath()
  // adj427：段落在行尾/后面没有音符时，用最后一遍的 passMs 补发（保证它仍然发声）
  if (pendingSegment) {
    emitSegmentEvents(pendingSegment, passMs, curKey)
    pendingSegment = null
  }

  // adj361：总时长 = 实际播放到的时刻（= 所有事件的最大结束时刻，含反复遍）
  // adj427：再与段层事件末刻取最大（段落比其后主旋律长时不被截断）
  totalMs = Math.max(lastEndMs, segEndMs)

  // adj88：从指定音符开始——丢弃起点之前的音符事件，其后 atMs 统一减去起点 atMs
  if (startIdxByPage !== null) {
    /**
     * adj629d（用户报「试听时点替谱层的音符不能跳到该处演奏」）：
     * 段层音符的 id 在**高位命名空间**（`SEG_*`/`SEG_TP_*`），与主旋律的 0 起小整数完全不同段——
     * 旧的 `e.placed.id.index >= startIdx.index` 判断会把"点段层音符"当成"从头开始"（0 >= 1e12 恒假，
     * 于是 `from` 落在第一个主旋律音符上）⇒ 播放从头开始、点哪都没用。
     * 现在：**先按 id 精确命中**（段层音符就是事件里的那一个），命中不了再退回原来的"主旋律序号 ≥"口径。
     */
    const segTarget = decodeSegmentNoteId(startIdxByPage.index) ?? decodeTpNoteId(startIdxByPage.index)
    let from = segTarget
      ? events.findIndex((e) => e.placed.id.index === startIdxByPage.index)
      : events.findIndex((e) => !e.placed.segment && e.placed.id.index >= startIdxByPage.index)
    /**
     * adj723f（用户报「点 `{dsb}` **下声部**只演奏该声部，点第一声部才是多声部演奏」）：
     *
     * **从该音符所属的"那一拍"起播，而不是从该事件本身起播。**
     *
     * 为什么：`{dsb}` 里"一个音"在事件流里其实是**一对**（段内容 = 副声部 + 包络外主旋律 = 主声部），
     * 两者 `atMs` 相同但**在事件数组里不相邻**——段内容事件集中在前面、包络外在后面
     * （实测本句：段内容 `#1e12+…` 七条在 `atMs` 0…1.71s，包络外 `#0..6` 七条同样 0…1.71s）。
     * 于是：
     *  · 点**上排段内容** ⇒ `from` 落在段内容那一条 ⇒ 后面**包含**包络外全部 ⇒ 正常多声部；
     *  · 点**下排包络外** ⇒ `from` 落在包络外那一条 ⇒ `slice(from)` 把**前面整段段内容全切掉**
     *    ⇒ 只剩主声部（用户看到的现象）。
     *
     * 修法：把 `from` 回退到"**所有与之同刻（`atMs` 相同）的事件中最小的下标**"。
     * 注意**不能**只比较相邻前一条（`events[from-1]`）——实测事件数组里
     * 上下两声部并非"两段连续排列"，而是**交错**的（`atMs` 序列形如
     * `0,214,428,…,1714` **再** `0,214,428,…,1714`，且同一拍内还可能夹着装饰/倚音短音），
     * 只用相邻比较会在"前一条恰好是另一遍/更长音"时提前停下（实测 `from` 只回退 1 步）。
     * 故用**向前扫描取最小下标**（每次起播只算一次，代价可忽略）。
     *
     * 容差用的 `0.5ms` 远小于最小拍长（120bpm 下 32 分音符也有 62.5ms），
     * 只用来吸收浮点累积误差，不会把相邻两拍并进来。
     */
    if (from > 0) {
      const t0 = events[from].atMs
      let lo = from
      for (let k = from - 1; k >= 0; k--) {
        if (Math.abs(events[k].atMs - t0) < 0.5) lo = k
      }
      from = lo
    }
    if (from > 0) {
      const base = events[from].atMs
      const sliced = events.slice(from).map((e) => ({ ...e, atMs: Math.max(0, e.atMs - base) }))
      return { events: sliced, totalMs: totalMs - base, bpm }
    }
    if (from === 0) return { events, totalMs, bpm }
    // 起点音符不在事件中（隐藏休止符等）→ 从第一个可播放事件开始
    return { events, totalMs, bpm }
  }

  return { events, totalMs, bpm }
}
