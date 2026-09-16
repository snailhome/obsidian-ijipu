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
import type { BarlineMark, BarlineType, MusicToken, ParseResult, PlacedBarline, PlacedToken, ScoreLayout, ScorePage, VoiceBlock } from '../types'
import { tokenDuration } from '../duration'
import { parseKey, pitchToName } from '../layout/index'
import { graceNoteBeats } from '../layout/spaceLayout'
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

/** 从描述头 J 推断拍速（30~240），无效或缺失默认 90；数字部分优先（多条 J 时） */
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
   */
  seg?: { voice: number; children: MusicToken[] }
  bar?: {
    type: BarlineType
    marks?: BarlineMark[]
    voltaStart?: PlacedBarline['voltaStart']
    voltaEnd?: boolean
    /** adj360：|]/ 房子右侧未封闭——该房子延续到其后第一个跳跃小节线(:|)或结束小节线(||) */
    voltaEndSlash?: boolean
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
  const isDsbLower = !plc.segment && plc.playVoice === 'second'

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
    // dsb upper：对侧 = 下层 baseline（row.y + dy/2）
    const lowerY = pageVoiceBaselineForSegmentLower(page, plc.id.group, plc.id.voice, noteSize)
    if (lowerY === null) return null
    // adj429：上下色块**严格等高**——把"对称中线" midEqual 从 row.y 上移 `0.25×ns`，
    // 让 upper 用 TOP_EXT(1.1ns)、lower 用 BOT_EXT(0.6ns) 各自延伸后，两块高度相等。
    // 视觉上"上盖减时线、下不压歌词"的设计意图保留（TOP_EXT > BOT_EXT 是覆盖减时线的代价），
    // 但通过中线偏移把不对称性消化在**位置**而不是**高度**里 → 上下看起来完全等高。
    // 整组随之轻微上移 0.25×ns；上一行曲部底 − quci=15 远大于此偏移，无侵入风险。
    const offset = (TOP_EXT - BOT_EXT) / 2 // 0.25 × ns
    const midEqual = (y + lowerY) / 2 - offset
    const yTopMin = y - TOP_EXT
    const yBottomMax = midEqual
    const h = yBottomMax - yTopMin
    if (h < MIN_H) return null
    return { yTopMin, yBottomMax }
  }
  if (isDsbLower) {
    // dsb 包络内的主旋律音（下层 = 第二声部）：对侧 = 上层 baseline
    // adj429：与 upper 共享 midEqual（中线不在 row.y，往上偏 0.25×ns），保证上下严格等高。
    const upperY = pageVoiceBaselineForSegmentUpper(page, plc.id.group, plc.id.voice)
    if (upperY === null) return null
    const offset = (TOP_EXT - BOT_EXT) / 2
    const midEqual = (y + upperY) / 2 - offset
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
 * adj429：取该页该 group 的 dsb 段**下层基线 y**（= row.y + dy/2）。
 *
 * 通过 `segmentBrackets` 间接得到：`PlacedSegmentBracket.yBottomLower` = 下层基线 + 0.3×字号，
 * 故反推下层基线 = `yBottomLower − noteSize × 0.3`。
 */
function pageVoiceBaselineForSegmentLower(
  page: ScorePage,
  group: number,
  voice: number,
  noteSize: number,
): number | null {
  const sb = page.segmentBrackets?.find((s: { group: number; voice: number; type: string }) => s.group === group && s.voice === voice && s.type === 'dsb')
  if (!sb || sb.yBottomLower === undefined) return null
  return sb.yBottomLower - noteSize * 0.3 // 把 "+0.3×字号" 减回去，得到下层基线
}

/**
 * adj429：取该页该 group 的 dsb 段**上层基线 y**（= row.y − dy/2）。
 *
 * 段层音符（layer='upper'）的 y 本身就是上层基线。直接取第一个 dsb upper 音符的 y 即可。
 */
function pageVoiceBaselineForSegmentUpper(
  page: ScorePage,
  group: number,
  voice: number,
): number | null {
  for (const n of page.notes) {
    if (n.id.group === group && n.id.voice === voice && n.segment?.type === 'dsb' && n.segment.layer === 'upper') {
      return n.y
    }
  }
  return null
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

export function buildPlaySequence(
  result: ParseResult,
  layout: ScoreLayout,
  bpm: number,
  startNoteId?: string | null,
  defaultInstrumentRef?: string,
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
    for (const [group, notes] of byGroupNotes) {
      const sorted = [...notes].sort((a, b) => a.x - b.x)
      const bars = (byGroupBars.get(group) ?? []).slice().sort((a, b) => a.x - b.x)
      sorted.forEach((n, i) => {
        const nextNote = i < sorted.length - 1 && sorted[i + 1].x > n.x + 1e-3 ? sorted[i + 1].x : Infinity
        const nextBar = bars.find((b) => b.x > n.x + 1e-3)?.x ?? Infinity
        const edge = Math.min(nextNote, nextBar)
        // adj374：本音符「时值元素实际右缘」——增时线每条各占一个时值元素槽，
        // 而音符声明的 rightX = x + width 是按更窄的槽宽累加的，**末条增时线可能越过 rightX**；
        // 末元素（后面既无音符也无小节线）时若直接用 rightX，末段色块宽度会被算成 0/极小
        // → 观感"增时线没有色块"。故色块右边界取 max(下一时值元素/小节线左缘, 本音符实际右缘)，
        // 保证「一个时值元素一块」且块至少盖住它自己画出来的笔画。
        const segs = n.segments ?? []
        const lastSeg = segs[segs.length - 1]
        const inkRight = lastSeg ? lastSeg.x + lastSeg.perBeat * lastSeg.beats : (n.rightX ?? n.x + n.width)
        const own = Math.max(n.rightX ?? inkRight, inkRight)
        const base = edge === Infinity ? own : Math.max(edge, own)
        /**
         * adj439：**重叠区的色块以段层右界（大括号 `}`）为界限**（用户要求）。
         *
         * dsb 下层（包络内的主旋律）若不钳制，右边界会取"**包络外**那个主旋律音的 x"
         * ⇒ 色块越过 `}` 一直盖到下一小节（用户截图：下层绿块从 `5` 跨过 `}` 到最后的 `5` 前）。
         * 上层的段层音符在 `emitSegmentEvents` 里已收在段内容区内（`xContent1` ≤ 大括号槽），
         * 故这里只对**下层**（`playVoice === 'second'`）钳制到段层右界 `segmentBrackets.x2`。
         */
        const segRight = n.playVoice === 'second' ? segRightByGroupVoice.get(`${n.id.page}|${n.id.group}|${n.id.voice}`) : undefined
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
        seq.push({
          kind: 'bar',
          bar: {
            type: token.type,
            marks: token.marks,
            voltaStart: token.voltaStart,
            voltaEnd: token.voltaEnd,
            voltaEndSlash: token.voltaEndSlash,
          },
        })
      } else if (token.kind === 'instrument') {
        // adj301/351：乐器切换指令纳入播放序列（不产生音符事件）——按所属声部（voice）记录，
        // 多声部各声部独立切换乐器（下一组同声部延续）
        seq.push({ kind: 'instrument', instr: { name: token.name, voice: group.music.voice } })
      } else if (token.kind === 'segment') {
        // adj427：临时段（{bz … } / {dsb … }）——**不占主旋律时值**，只推进段内的音符序号吗？
        // 不：段内音符是**独立**的（children 各自成事件），主旋律的 noteIdx 完全不受影响。
        // 这里只登记一个"待补发"标记项，实际事件在走查时补发。
        if (token.dir === 'open' && token.children && token.children.length > 0) {
          seq.push({ kind: 'segment', seg: { voice: group.music.voice, children: token.children } })
        }
      } else if (token.kind === 'note' || token.kind === 'rest' || token.kind === 'rhythm') {
        const placed = byIndex.get(noteIdx)
        if (placed) seq.push({ kind: 'note', note: placed, noteIdx })
        noteIdx++
      }
    }
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

  // 3. 跳房子配对：voltaStart 的 seq 索引 → 对应 voltaEnd 的 seq 索引
  // adj359：指向 voltaEnd「本小节线」而非其后一位——使 `:|]["2."`（共用一根线：volta1 结束 + volta2 开始）
  // 在跳过 volta1 后仍能处理该线上的 volta2 番号
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
      if (item.bar.voltaEndSlash) {
        const ext = seq.findIndex(
          (it, k) =>
            k > si &&
            it.kind === 'bar' &&
            (it.bar?.type === ':|' || it.bar?.type === ':|:' || it.bar?.type === '||' || it.bar?.type === '||/'),
        )
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
   */
  const voltaLabelOf = (it: SeqItem): { kind: 'num' | 'text' | 'none'; num: number } => {
    const c = it.kind === 'bar' ? it.bar?.voltaStart?.comment : undefined
    if (!c || c.trim() === '') return { kind: 'none', num: 1 }
    const m = /(\d+)/.exec(c)
    return m ? { kind: 'num', num: Number(m[1]) } : { kind: 'text', num: 1 }
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
    // 每个 voice 在 result.groups 中按顺序的下一个待处理 group 索引（多组多声部各自独立 ms）
    const voiceNextGroupIdx = new Map<number, number>()
    // 已纳入 voiceBlock 的 groupIndex
    const covered = new Set<number>()
    // 块拍数（块内 max groupBeats）
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
    // 1. 多声部块（voiceBlock）— 每个 voice 在该 vb 取下一个未处理的 group（adj307）
    for (const page of layout.pages) {
      for (const vb of page.voiceBlocks) {
        const gis: number[] = []
        for (const v of vb.voices) {
          // 找该 voice 下一个属于本 vb 的 group（按 result.groups 顺序遍历，跳过已覆盖）
          let cur = voiceNextGroupIdx.get(v.voice) ?? 0
          while (
            cur < result.groups.length &&
            (covered.has(cur) || result.groups[cur].music.voice !== v.voice)
          ) {
            cur++
          }
          if (cur < result.groups.length && result.groups[cur].music.voice === v.voice) {
            gis.push(cur)
            voiceNextGroupIdx.set(v.voice, cur + 1)
          }
        }
        if (gis.length === 0) continue
        gis.sort((a, b) => a - b)
        const bb = blockBeatsOf(gis)
        for (const gi of gis) {
          groupStartMs[gi] = ms
          barStartMsInGroup[gi] = bsMsOf(gi)
          covered.add(gi)
        }
        ms += bb * beatMs
      }
    }
    // 2. 单声部 group（不在任何 voiceBlock 内）按 groups 顺序自成块累加
    for (let gi = 0; gi < result.groups.length; gi++) {
      if (covered.has(gi)) continue
      groupStartMs[gi] = ms
      barStartMsInGroup[gi] = bsMsOf(gi)
      let bb = 0
      for (const tk of result.groups[gi].music.tokens) {
        if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') bb += tokenDuration(tk)
      }
      ms += bb * beatMs
    }
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
  // adj88：连音线内相同音高连续音符连奏合并——上一个已发事件的音符索引与音高；
  // 当前音符若与上一个音高相同、同属某连音线且中间无音符（索引相邻），则时值并入前一事件
  let lastEventNoteIdx = -1
  let lastEventPitch: string | null | undefined = undefined
  // adj396：上一个音符的**主音符事件**下标（连音合并要并到主音符上，而非其后追加的倚音事件）
  let lastMainEvIdx = -1
  /** adj396：上一个音符是否带倚音（带倚音的音符不参与连音合并） */
  let lastEventHadGrace = false
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
  let pendingSegment: { voice: number; children: MusicToken[] } | null = null
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
  const emitSegmentEvents = (seg: { voice: number; children: MusicToken[] }, passMsNow: number): void => {
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
     * adj440：段层**右界**（大括号槽 `/` 内容区右缘，来自 `segmentBrackets.x2`）。
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
    for (const t of seg.children) {
      if (t.kind !== 'note' && t.kind !== 'rest' && t.kind !== 'rhythm') continue
      const placed = segPlacedByToken.get(t)
      if (!placed) continue
      const g2 = placed.id.group
      const at2 = passMsNow + groupStartMs[g2] + (barStartMsInGroup[g2][placed.barIndex] ?? 0) + placed.beatPos * beatMs
      const dur2 = (tokenDuration(t) * 60000) / bpm
      const isSec = placed.playVoice === 'accomp' || placed.playVoice === 'second'
      const ov = overriddenByVoice.get(placed.id.voice)
      const inst2 = isSec
        ? accompInstrument()
        : typeof ov === 'string' && ov.length > 0
          ? parseInstrumentRef(ov).ref
          : voiceDefaultOf(placed.id.voice)
      const gain2 = isSec ? ACCOMP_GAIN : 1
      events.push({
        placed,
        instrument: inst2,
        atMs: at2,
        durationMs: dur2,
        gain: gain2,
        playVoice: placed.playVoice,
        // adj429：色块按曲行几何动态定界（多声部/临时叠加段不再互相覆盖、也不压歌词）
        playheadSegs: buildPlayheadSegs(placed, 0, edgeOf(placed), {
          ...computeColorBounds(placed, pageByNoteIdx.get(placed.id.index)!, voiceBlockByNoteIdx, noteSize),
          // adj442：**左端不外扩**——色块从起始音符开始（见 buildPlayheadSegs 注释）。
          // 原先这里给段内首个音传 `left`，会把色块拉到 `{` / 左括号之前（用户指出观感不对）。
        }).map((s) => ({ ...s, instrument: inst2, playVoice: placed.playVoice })),
      })
      segEndMs = Math.max(segEndMs, at2 + dur2)
    }
  }

  while (i < seq.length && guard++ < maxIter) {
    const item = seq[i]
    if (item.kind === 'segment') {
      // adj427：临时段（{bz}/{dsb}）——**不占主旋律时值**，此处只打标记；
      // 段内容等到**下一个音符事件**时用同一个 passMs 补发（⇒ 反复每遍都发声、与主旋律同刻）。
      pendingSegment = item.seg ?? null
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
      const durationMs = (tokenDuration(token) * 60000) / bpm
      const pitch = placed.audioPitch
      const curNoteIdx = item.noteIdx ?? -1
      // adj282：每个 event 的 atMs 由所属 group 的拍时钟决定（不受源码顺序累加），
      // 保证同组同 (barIndex, beatPos) 的各声部事件 atMs 相同 → 同步播放
      const g = placed.id.group
      const bi = placed.barIndex
      const bp = placed.beatPos
      const clock = groupStartMs[g] + (barStartMsInGroup[g][bi] ?? 0) + bp * beatMs
      // adj361：若有待跳时刻，先把 passMs 对齐（使本事件 atMs = 待跳时刻 → 无缝衔接）
      if (pendingJumpMs >= 0) {
        passMs = pendingJumpMs - clock
        pendingJumpMs = -1
      }
      const atMs = passMs + clock
      // adj427：若有待补发的临时段，就在这里用**同一个 passMs** 补发——它与本音符同刻开始
      if (pendingSegment) {
        emitSegmentEvents(pendingSegment, passMs)
        pendingSegment = null
      }
      lastEndMs = Math.max(lastEndMs, atMs + durationMs)
      // adj89：合并判定——与前一已发事件音高相同、索引相邻（中间无音符）、
      // 且**两者同属同一条连音线**（严格 slur 内连奏）：
      // (2 - | 2/) 的 2 连 2.5 拍；(2 3/ 2/ | 2) 第 3、4 个 2 连奏；
      // (2 3 | 2) 中间隔 3 不合并；**连音线外的同音符不并入**
      // （(2 - | 2) 2 → 播 3 拍再播 1 拍，不连成 4 拍）
      // adj396：带倚音的音符不参与连音合并——倚音本身是要发声的独立事件，
      // 合并会把倚音时值吞进长音（且合并目标必须落在**主音符事件**上，
      // 后倚音事件排在主音符之后，旧代码用 events 末元素会并到倚音上）。
      const prevRanges = lastEventNoteIdx >= 0 ? slurOf.get(lastEventNoteIdx) : undefined
      const curRanges = slurOf.get(curNoteIdx)
      const shareSlur =
        prevRanges !== undefined &&
        curRanges !== undefined &&
        [...prevRanges].some((r) => curRanges.has(r))
      const curHasGrace = token.kind === 'note' && (token.gracenotes?.notes.length ?? 0) > 0
      if (
        lastEventNoteIdx >= 0 &&
        curNoteIdx === lastEventNoteIdx + 1 &&
        shareSlur &&
        !curHasGrace &&
        !lastEventHadGrace &&
        lastMainEvIdx >= 0 &&
        pitch !== null &&
        pitch === lastEventPitch
      ) {
        const prev = events[lastMainEvIdx]
        prev.durationMs += durationMs
        lastEndMs = Math.max(lastEndMs, prev.atMs + prev.durationMs) // adj361：合并后当前播放时刻随之前移
        // adj300：连音合并——把被合并音符的拍段并入 prev 的播放拍段（色块可覆盖全时值，
        // 如 (1 - - - | 1) - 0 0 中 1 合并 6 拍，色块依次滑过 1 - - - 1 -）
        const prevBeat = (prev.playheadSegs ?? []).reduce((a, s) => a + s.beats, 0)
        prev.playheadSegs = (prev.playheadSegs ?? []).concat(
          buildPlayheadSegs(item.note!, prevBeat, rightEdgeByNoteIdx.get(item.note!.id.index), computeColorBounds(item.note!, pageByNoteIdx.get(item.note!.id.index)!, voiceBlockByNoteIdx, noteSize)).map((s) => ({ ...s, instrument: prev.instrument, playVoice: item.note!.playVoice })),
        )
        // adj157：合并时值；atMs 来自拍时钟（每个 event 独立），不需全局 at 累加
        lastEventNoteIdx = curNoteIdx
        lastEventHadGrace = false
        i++
        continue
      }
      // adj351：按声部取覆盖乐器（该声部最近一次 @ 结果；未设置/@@ 清空 → 用该声部 Y 默认乐器）
      // adj427：按**声部角色**分流——'accomp'（bz 上层）/ 'second'（dsb 下层）为伴奏/第二声部：
      //   用第 2 可用音色（色块随之换色）+ 0.75 力度；'main' / 未设置 = 主声部，音色力度都不变。
      const playRole = placed.playVoice
      const isSecondaryVoice = playRole === 'accomp' || playRole === 'second'
      const voiceInst = overriddenByVoice.get(placed.id.voice)
      // adj434：`@乐器名@` 曲内显式切换 → 标记 explicit（播放端不让「试听音色」压掉它）
      const hasExplicitInst = !isSecondaryVoice && typeof voiceInst === 'string' && voiceInst.length > 0
      const instrument = isSecondaryVoice
        ? accompInstrument()
        : hasExplicitInst
          ? parseInstrumentRef(voiceInst!).ref
          : voiceDefaultOf(placed.id.voice)
      const gain = isSecondaryVoice ? ACCOMP_GAIN : 1
      // 倚音（adj23 / adj396 时值规范）：倚音**占用主音符的时值**——
      //   ① 单个倚音实际时值 = 1/2^(括号内减时线条数 + 1) 拍（写 `2/` 即实音符的 `2//` = 1/4 拍）；
      //   ② 前倚音依次演奏于主音符**开头**（`3[2/]`：先 1/4 拍倚音 2，再 3/4 拍主音符 3）；
      //      后倚音依次演奏于主音符**末尾**（`3[h2/]`：先 3/4 拍主音符 3，最后 1/4 拍倚音 2）；
      //   ③ 多倚音各占各自时值、依次排列（`3[3/2/]` = 1/4 + 1/4 倚音，主音符余 1/2 拍）；
      //   ④ 主音符发声时值 = 总时值 − Σ倚音时值（**总时值不变**，不再向相邻音符借时间，
      //      故布局时钟 / totalMs / 反复跳转都用同一套拍位，无需额外补偿）；
      //   ⑤ `3 -[h5/]`：主音符先奏满增时线/附点（到总时值末尾前），最后 1/4 拍才奏后倚音。
      const gn = token.kind === 'note' ? token.gracenotes : undefined
      const gracePitches =
        gn && gn.notes.length > 0
          ? gn.notes.map((g) => pitchToName(g.pitch, g.octaveShift, g.accidental, keySemitone))
          : []
      const graceBeats = gn ? gn.notes.map((g) => graceNoteBeats(g.diminishCount)) : []
      const graceTotalMs = (graceBeats.reduce((a, b) => a + b, 0) * 60000) / bpm
      const graceMsAt = (gi: number) => (graceBeats[gi] * 60000) / bpm
      /** 主音符发声起点（前倚音之后）；无前倚音即 atMs */
      const mainAtMs = gn && !gn.after ? atMs + graceTotalMs : atMs
      /** 主音符发声时值 = 总时值 − Σ倚音时值（不足时钳制为 0） */
      const mainMs = Math.max(0, durationMs - graceTotalMs)
      if (gn && !gn.after && gracePitches.length > 0) {
        let gAt = atMs
        for (let gi = 0; gi < gn.notes.length; gi++) {
          // adj436：倚音是**独立事件**，必须**继承主音符的声部角色与音色来源**——
          // 否则「试听音色」的全局覆盖会把 `@手风琴@` 之后的倚音（如 `3/[3/5/]`）压回主音色
          // （用户报「演奏到 `3/[3/5/]` 处又切回主音色了，应该还是手风琴」）；
          // 段内（bz/dsb）音符的倚音缺 `playVoice` 还会丢掉伴奏/第二声部音色。
          events.push({ placed: item.note, instrument, atMs: gAt, durationMs: graceMsAt(gi), pitch: gracePitches[gi], gain, playVoice: playRole, ...(hasExplicitInst ? { explicitInstrument: true } : {}) })
          gAt += graceMsAt(gi)
        }
      }
      // adj375：新事件开始 → 上一个事件已完成（不会再被连音合并）→ 结算它的呼吸静音
      settleBreath()
      const mainEvIdx = events.length
      events.push({
        placed: item.note,
        instrument,
        atMs: mainAtMs,
        durationMs: mainMs,
        gain,
        playVoice: playRole,
        // adj434：`@乐器名@` 显式指定 → 播放端保留该音色（不被「试听音色」全局覆盖压掉）
        ...(hasExplicitInst ? { explicitInstrument: true } : {}),
        playheadSegs: buildPlayheadSegs(item.note!, 0, rightEdgeByNoteIdx.get(item.note!.id.index), computeColorBounds(item.note!, pageByNoteIdx.get(item.note!.id.index)!, voiceBlockByNoteIdx, noteSize)).map((s) => ({ ...s, instrument, playVoice: item.note!.playVoice })),
      })
      // adj375：本音符是某 &hx 的作用对象 → 标记该事件待结算（连音合并会累加时值后再一起算）
      if (hxBreathNoteIdx.has(curNoteIdx)) breathEvIdx = mainEvIdx
      if (gn && gn.after && gracePitches.length > 0) {
        // 后倚音接在主音符（含增时线/附点）之后，填满本音符时值的最后一段
        // adj436：同样继承声部角色与音色来源（同前倚音）
        let gAt = mainAtMs + mainMs
        for (let gi = 0; gi < gn.notes.length; gi++) {
          events.push({ placed: item.note, instrument, atMs: gAt, durationMs: graceMsAt(gi), pitch: gracePitches[gi], gain, playVoice: playRole, ...(hasExplicitInst ? { explicitInstrument: true } : {}) })
          gAt += graceMsAt(gi)
        }
      }
      lastEventNoteIdx = curNoteIdx
      lastEventPitch = pitch
      lastMainEvIdx = mainEvIdx
      lastEventHadGrace = curHasGrace
      i++
      continue
    }
    const bar = item.bar!
    // adj359：跳房子——本遍不演奏该 volta 时，跳到其末尾小节线
    // （停在末尾线上而非其后一位：`:|]["2."` 共用一根线时，仍需处理该线上的 volta2 番号）
    // adj368：判断依据按标签类型——番号（`["2."`）比遍次；文字标签（`["结束句"`）比该段最终遍数
    const trySkipVolta = (): boolean => {
      if (!bar.voltaStart) return false
      const label = voltaLabelOf(item)
      const skip = label.kind === 'text' ? pass < (segMaxPass[i] ?? 1) : label.num !== pass
      if (!skip) return false
      const target = voltaAfter.get(i) ?? i + 1
      landedByVoltaSkip = target
      i = target
      pendingJumpMs = lastEndMs // adj361：被跳过的房子不占时，从当前播放时刻无缝接上
      return true
    }
    // 因跳过 volta 而落在的小节线：不再触发该线的 :| 回跳（该反复已在跳过时越过），只处理其 volta 番号后前进
    if (i === landedByVoltaSkip) {
      landedByVoltaSkip = -1
      if (trySkipVolta()) continue
      i++
      continue
    }
    // adj359：小节线修饰符跳转（&fine 曲终 / &dc 从头反复 / &ds 跳花S / &ty 跳越）
    // 规则（用户规范）：&dc/&ds「大反复」全曲各只跳一次（之后再遇不跳，续播到 Fine/终止线，避免死循环）；
    // &ty 第一次遇到忽略，大反复之后再次遇到才跳到下一个 &ty（两 ty 之间不演奏）；
    // &fine 在有 dc/ds 时仅于大反复之后生效（第一遍穿过 Fine 走到大反复）。
    if (bar.marks?.length) {
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
    if (bar.type === ':|' || bar.type === ':|:') {
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
    emitSegmentEvents(pendingSegment, passMs)
    pendingSegment = null
  }

  // adj361：总时长 = 实际播放到的时刻（= 所有事件的最大结束时刻，含反复遍）
  // adj427：再与段层事件末刻取最大（段落比其后主旋律长时不被截断）
  totalMs = Math.max(lastEndMs, segEndMs)

  // adj88：从指定音符开始——丢弃起点之前的音符事件，其后 atMs 统一减去起点 atMs
  if (startIdxByPage !== null) {
    // adj427：段层事件 id 在高位段（900000+），不能参与"起点音符"的定位——按主旋律音符判断
    const from = events.findIndex((e) => !e.placed.segment && e.placed.id.index >= startIdxByPage.index)
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
