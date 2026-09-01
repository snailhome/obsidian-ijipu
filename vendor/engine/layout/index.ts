/**
 * engine/layout/index.ts — 排版引擎
 *
 * 排版原则（细节调整批次 adj1）：
 *  - 时值等宽：音符水平宽度与其拍数成正比（1// 与 1/ 与 1 宽 = 拍数 × 每拍宽）
 *  - 小节均分：一行内所有小节水平等宽（行宽 / 小节数）
 *  - 两端对齐：非最后一行铺满整行；整份谱的最后一行按自然宽左对齐
 *  - 小节内音符按时值（拍数）排布，perBeat = (小节宽 - 边距) / 小节拍数
 *
 * M7a：多声部块（Q1/Q2 纵向堆叠、块内小节等宽、声部括弧信息）。
 */
import { PAPER_SIZE } from '../types'
import { tokenDuration } from '../duration'
import type {
  BarlineType,
  LayoutId,
  LyricChar,
  LyricLine,
  MusicGroup,
  MusicToken,
  NoteToken,
  PageConfig,
  ParseResult,
  PlacedLyric,
  PlacedToken,
  ScoreLayout,
  ScorePage,
  ScorePageMeta,
  VoiceBlock,
} from '../types'
import { DIGIT_HEIGHT_RATIO, LAYER_GAP, SLUR_W, octaveTopY, BRACKET_PAD, H_GAP, noteScaleOf, GRACE_SIZE_RATIO, GRACE_SLOT_RATIO, GRACE_SLOT_RATIO_MULTI, VOLTA_BAR_GAP, VOLTA_RAISE, DYN_HALF_H, barlinePad, DOT_AFTER_DIGIT_GAP, DOT_R } from './spacing'
// adj284：空间优先布局的度量（本体宽 / 时值拆分 / 非时值元素间距）
import { splitNoteDur, noteBodyW, augBodyW, dotBodyW, accidentalBodyW, bracketBodyW, digitSlotW, hxBodyW } from './spaceLayout'
// adj303：乐器名标注需要用 resolveInstrument / 库名（@乐器名 / @@ 后下一个音符）
import { resolveInstrument, INSTRUMENT_LIB_NAMES } from '../playback/instruments'

// ============================================================
// 音高映射：简谱音级 → 音名（如 C4 / F#5）
// ============================================================

const KEY_SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
}
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** 解析调式字符串（如 "C"、"#F"、"F#"、"$B"、"B$"、"bE"、"Eb"；adj174/175 升降号
 *  可在字母前或后，降号支持 $ 与 b 两种写法）→ 根音半音偏移（C=0） */
export function parseKey(key: string | undefined): number {
  if (!key) return 0
  const m = /^([#$b]?)([A-G])([#$b]?)$/.exec(key.trim())
  if (!m) return 0
  const semis = KEY_SEMITONE[m[2]]
  const acc = m[1] || m[3]
  return semis + (acc === '#' ? 1 : acc === '$' || acc === 'b' ? -1 : 0)
}

/** 中音 1 的 MIDI 编号（简谱中音 1 = C4 = MIDI 60） */
const BASE_MIDI = 60

/** 大调音阶级数 → 半音偏移（1→根音, 2→大二度, ... 7→大七度） */
const DEGREE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]

/** 音级 + 八度 + 变音 → MIDI → 音名（null = 无音高） */
export function pitchToName(
  pitch: NoteToken['pitch'],
  octaveShift: number,
  accidental: NoteToken['accidental'],
  keySemitone: number,
): string | null {
  const accSemis = accidental === '#' ? 1 : accidental === '$' ? -1 : 0
  const degree = DEGREE_SEMITONES[pitch - 1]
  const midi = BASE_MIDI + keySemitone + degree + octaveShift * 12 + accSemis
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

// ============================================================
// 拍号 / 时值等宽参数
// ============================================================

/** 每拍自然宽（px，最后一行/断行预估用） */
const BPW_NATURAL = 14
/** 音符最小占宽（随字号缩放）：数字槽宽 0.62×noteSize + 水平元素最小间距 H_GAP（adj64/66：1 → 0.5 → -2） */
const minNoteW = (noteSize: number, extra = 0) => noteSize * 0.62 + H_GAP + extra
/** 数字槽半宽（0.31×noteSize，歌词/高低音点对齐基准） */
const halfDigitW = (noteSize: number) => noteSize * 0.31
/**
 * 倚音占位额外宽（adj98：倚音计入音符占位宽度——前倚音向左、后倚音向右扩展）。
 * 倚音字号 = 主音符 × 0.4（adj101 由 0.3 调大），每音占宽 0.62×0.4×noteSize；
 * 多音符（≥2）数字间距缩小为 0.5×0.4×noteSize（adj103，与渲染一致）；
 * 组内 n 个倚音线性叠加 + 左侧 2px 间距。
 */
function graceExtraW(t: Extract<MusicToken, { kind: 'note' }> | undefined, noteSize: number): number {
  if (!t || t.kind !== 'note' || !t.gracenotes || t.gracenotes.notes.length === 0) return 0
  const n = t.gracenotes.notes.length
  const gW = noteSize * GRACE_SIZE_RATIO * GRACE_SLOT_RATIO // 单音槽宽
  const gapW = n >= 2 ? noteSize * GRACE_SIZE_RATIO * GRACE_SLOT_RATIO_MULTI : gW // 多音符间距缩小
  return (n - 1) * gapW + gW + 4 // 组总宽 + 4px 间距（左右各 2px）
}
/**
 * 音符最小额外占宽（adj287：时值优先也计入，防变音角标/前倚音与相邻元素重叠）
 * = 倚音组宽 graceExtraW（前倚音向左、后倚音向右）+ 变音角标左扩展 accidentalBodyW。
 * 空间优先路径已分别用 grW/accW 单独处理，不引用本函数。
 */
function noteExtraW(t: Extract<MusicToken, { kind: 'note' }> | undefined, noteSize: number): number {
  return (t ? graceExtraW(t, noteSize) : 0) + (t && t.accidental ? accidentalBodyW(noteSize) : 0)
}
/** 小节内左右留白（px） */
const BAR_PAD = 6
/** 拍与拍之间间距（px，adj41：原 8 调为 4） */
const NOTE_GAP = 4
/**
 * 小节线最小占位空间（px，adj50）：单线宽 1.1 + 两侧与音符各 4px = 9.1。
 * 小节线空间 = max(bar_gap, 线组总宽 + 8)，保证线与两侧音符至少 4px 间距；
 * 各类型线组宽度不同（粗线 1.8、细线 1.1、点 r=1.8），占位随类型变化。
 * |/ 隐藏小节线1：不显示也不占位（空间 0）。
 * adj86：临时节拍（|"P:2/4" / |"p:2/4"）在小节线右侧画分数 → 占位含
 * 分数半宽 + 2px 间距，保证分数不压到下一小节音符。
 */
const MIN_BARLINE_SPACE = 9.1
/** 小节线类型 → 线组总宽（px；细线 1.1、粗线 1.8、点 r=1.5；adj55 间距：线与线 1、线与点 1.5；adj58 点径 3.0） */
function barlineTotalW(type: BarlineType): number {
  switch (type) {
    case '|':
      return 1.1
    case '||':
      return 3.9 // 细 1.1 + 1 + 粗 1.8
    case '||/':
      return 3.2 // 1.1 + 1 + 1.1
    case '|:':
    case ':|':
      return 8.4 // 粗 1.8 + 1 + 细 1.1 + 1.5 + 点 3.0
    case ':|:':
      return 15.0 // 点 3.0 + 1.5 + 细 1.1 + 1 + 粗 1.8 + 1 + 细 1.1 + 1.5 + 点 3.0
    case '||:':
      return 7.7 // 双细线 + 右点（1.1 + 1 + 1.1 + 1.5 + 点 3.0）
    case '|*':
      return 1.1 // 隐藏但占位（同单线）
    default:
      return 0 // |/ 不占位
  }
}
/** 临时节拍分数半宽（与 render 中一致：字号 10×s，数字 0.32em/位 + 1.5×s 留空） */
function meterCommentHalfW(comment: string, noteSize: number): number | null {
  const pm = /^p:\s*(\d+)\s*\/\s*(\d+)$/i.exec(comment)
  if (!pm) return null
  const s = noteScaleOf(noteSize)
  const size = Math.round(10 * s)
  return Math.max(pm[1].length, pm[2].length) * size * 0.32 + 1.5 * s
}
const barlineSpace = (gap: number, type: BarlineType = '|', comment?: string, noteSize = 18) => {
  if (type === '|/') return 0
  const base = Math.max(gap, MIN_BARLINE_SPACE, barlineTotalW(type) + 8)
  // adj86：临时节拍占位 = 分数半宽 + 2px 间距（分数从线右缘起画，再留 2px 与下一音符隔开）
  if (comment) {
    const halfW = meterCommentHalfW(comment, noteSize)
    if (halfW !== null) return Math.max(base, barlineTotalW(type) / 2 + halfW + 2)
  }
  return base
}

/** 小节内每拍信息（adj106：倚音占位按拍记录，不再整小节最大 extra 应用到所有拍——会高估行宽导致早断行） */
function segBeatMap(seg: BarSeg, noteSize = 18): Map<number, { minDur: number; extra: number }> {
  const byBeat = new Map<number, { minDur: number; extra: number }>()
  let beat = 0
  for (const t of seg.notes) {
    if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
      const dur = tokenDuration(t)
      // adj217/218：近整数归整（浮点累加 4.9999… 归并拍边界）
      const nearInt = Math.abs(beat - Math.round(beat)) < 1e-3
      const b = nearInt ? Math.round(beat) : Math.floor(beat + 1e-9)
      const e = byBeat.get(b) ?? { minDur: Infinity, extra: 0 }
      e.minDur = Math.min(e.minDur, dur)
      if (t.kind === 'note') e.extra = Math.max(e.extra, noteExtraW(t, noteSize))
      byBeat.set(b, e)
      beat += dur
    }
  }
  return byBeat
}

/** 小节自然宽（adj35）：逐拍累加每拍 need（密集拍多占、正常拍 14），断行与拍级挤占一致；adj106 拍级倚音占位 */
function segNeedW(seg: BarSeg, noteSize = 18): number {
  const byBeat = segBeatMap(seg, noteSize)
  let w = 0
  for (const e of byBeat.values()) {
    w += e.minDur > 0 ? Math.max(BPW_NATURAL, minNoteW(noteSize, e.extra) / e.minDur) : BPW_NATURAL
  }
  return w
}

/**
 * 拍级每拍宽分配（adj35 音符间距原则）：
 *  ① 平均分布：正常拍 perBeat = 剩余宽 / 正常拍总时值；
 *  ② 最小间距 1px：每拍 need = max(自然宽 14, 12.16 / 拍内最小时值)；
 *  ③ 超拍挤占：拍宽不足以按最小间距容纳时，该拍固定为 need（宽 = 拍时值 × need），
 *     其余正常拍平均分享剩余宽度（迭代收敛）。
 * 返回每拍 perBeat；stretch=true 时总宽 ≈ avail（两端对齐撑满，极端兜底等比压缩不溢出）；
 * stretch=false 时按自然宽排布（行尾留白，adj198：≤3 小节的行不分散对齐）。
 */
function allocatePerBeats(
  beats: { dur: number; minDur: number; extra?: number }[],
  avail: number,
  noteSize = 18,
  stretch = true,
): number[] {
  const n = beats.length
  if (n === 0) return []
  const need = beats.map((b) =>
    b.minDur > 0 ? Math.max(BPW_NATURAL, minNoteW(noteSize, b.extra ?? 0) / b.minDur) : BPW_NATURAL,
  )
  const fixed = new Array<boolean>(n).fill(false)
  let pb = avail / Math.max(1e-6, beats.reduce((a, b) => a + b.dur, 0))
  for (let iter = 0; iter <= n; iter++) {
    let fixedW = 0
    let normalDur = 0
    for (let p = 0; p < n; p++) {
      if (fixed[p]) fixedW += beats[p].dur * need[p]
      else normalDur += beats[p].dur
    }
    const pbNew = (avail - fixedW) / Math.max(1e-6, normalDur)
    let changed = false
    for (let p = 0; p < n; p++) {
      if (!fixed[p] && need[p] > pbNew) {
        fixed[p] = true
        changed = true
      }
    }
    pb = pbNew
    if (!changed) break
  }
  const total = beats.reduce((a, bb, p) => a + bb.dur * (fixed[p] ? need[p] : pb), 0)
  if (total > avail && total > 0) {
    const scale = avail / total
    return beats.map((_bb, p) => (fixed[p] ? need[p] * scale : pb * scale))
  }
  // adj198：不撑满模式——按自然宽排布（每拍 = need，行尾留白）
  if (!stretch) {
    return beats.map((_bb, p) => need[p])
  }
  // adj85：总宽不足 avail（密集拍 need 大、正常拍均分后仍有富余）时等比放大，
  // 保证行内容撑满整行（两端对齐），避免行尾留白
  if (total < avail && total > 0) {
    const scale = avail / total
    return beats.map((_bb, p) => (fixed[p] ? need[p] * scale : pb * scale))
  }
  return beats.map((_bb, p) => (fixed[p] ? need[p] : pb))
}

/**
 * adj253：单声部每拍宽规则（用户法则）：
 *   ① 每拍最小宽 baseW[i] = max(BPW_NATURAL, minNoteW/minDur)（该拍最小时值单元决定）；
 *   ② 撑满（stretch）：Σ baseW < avail → 多出部分给各拍均摊；≥ avail → 等比压缩到 avail；
 *   ③ 自然对齐（≤3 小节、stretch=false）：avgW = max(baseW)/2，小于 avgW 的拍以 avgW 显示。
 *   （各拍在自己宽度内按拍内浮点位置平均分布各音符，见 placeMusicRow 段定位。）
 */
function singleRulePerBeats(
  beats: { dur: number; minDur: number; extra?: number }[],
  avail: number,
  noteSize = 18,
  stretch = true,
): number[] {
  const n = beats.length
  if (n === 0) return []
  const baseW = beats.map((b) =>
    b.minDur > 0 ? Math.max(BPW_NATURAL, minNoteW(noteSize, b.extra ?? 0) / b.minDur) : BPW_NATURAL,
  )
  const sum = baseW.reduce((a, b) => a + b, 0)
  if (stretch) {
    if (sum < avail) {
      const extra = (avail - sum) / n
      return baseW.map((bw) => bw + extra)
    }
    // Σ≥avail：复用 allocatePerBeats（固定高 need 拍、压缩其余）——
    // 避免所有拍等比压缩使密集拍（如 16 分音符）被压薄而重叠
    return allocatePerBeats(beats, avail, noteSize, true)
  }
  // 自然对齐：avgW = max/2；小于 avgW 的拍以 avgW 显示
  const avgW = Math.max(...baseW) / 2
  return baseW.map((bw) => (bw < avgW ? avgW : bw))
}

// ============================================================
// 布局参数（由页面配置派生）
// ============================================================

interface LayoutMetrics {
  noteSize: number
  noteGap: number
  barlineWidth: number
  /** 第 1 页正文起始 y（描述头区域 descAreaH + 正文上间距） */
  titleAreaH: number
  /** 后续页正文起始 y（不占描述头区域，descAreaH 释放给曲部词部） */
  bodyTopH: number
}

function metrics(config: PageConfig): LayoutMetrics {
  const noteSize = config.note_size
  return {
    noteSize,
    noteGap: noteSize * 0.22,
    barlineWidth: noteSize * 0.32,
    titleAreaH: config.margin_top + config.descAreaH + config.body_margin_top,
    bodyTopH: config.margin_top + config.body_margin_top,
  }
}

/** 行距配置（支持按页覆盖：config.heights['a'+page] = [quci, cici, ciqu, shengbu, ciquLyric?]） */
interface Spacing {
  quci: number // 曲下间距（曲部与词部）
  cici: number // 词下间距（词与词）
  ciqu: number // 曲上间距：曲部与曲部（本行无歌词时的行尾间距，adj79 拆分）
  ciquLyric: number // 曲部与上一行词部间距（本行有歌词时的行尾间距，adj79）
  shengbu: number // 声部行间距（adj72）
}

function spacingFor(config: PageConfig, page: number): Spacing {
  const h = config.heights?.['a' + page]
  return {
    quci: h?.[0] ?? config.height_quci,
    cici: h?.[1] ?? config.height_cici,
    ciqu: h?.[2] ?? config.height_ciqu,
    shengbu: h?.[3] ?? config.height_shengbu,
    ciquLyric: h?.[4] ?? config.height_ciqu_lyric,
  }
}

/** 计算一行曲（含歌词行数）占用的总高度；
 *  无歌词时歌词部空间（曲下间距 quci + 歌词行高）为 0（adj33），减少两曲部间空白；
 *  行尾间距（adj79）：本行有歌词 → 曲部与上一行词部间距 ciquLyric；无歌词 → 曲部与曲部间距 ciqu */
function lineHeightOf(config: PageConfig, m: LayoutMetrics, sp: Spacing, lyricRows: number): number {
  return (
    m.noteSize * 1.7 +
    (lyricRows > 0 ? sp.ciquLyric : sp.ciqu) +
    (lyricRows > 0 ? sp.quci + lyricRows * (config.geci_size + 4 + sp.cici) : 0)
  )
}

/** 判断 token 是否产生可播放音符（注：隐藏休止符 8 不可发声） */
function toPlayable(t: MusicToken): t is NoteToken {
  return t.kind === 'note'
}

/** 四舍五入到 0.1（消除浮点噪声） */
const r1 = (v: number) => Math.round(v * 10) / 10

/** 按小节切分（每小节音符 + 小节后的 barline；行首 barline 在 segs[0].bar） */
interface BarSeg {
  notes: MusicToken[]
  bar: (Extract<MusicToken, { kind: 'barline' }>) | null
}

function splitBars(tokens: MusicToken[]): BarSeg[] {
  const segs: BarSeg[] = []
  let cur: MusicToken[] = []
  for (const t of tokens) {
    if (t.kind === 'barline') {
      segs.push({ notes: cur, bar: t })
      cur = []
    } else {
      cur.push(t)
    }
  }
  if (cur.length > 0) segs.push({ notes: cur, bar: null })
  return segs
}

/** 小节实际拍数（音符时值总和） */
function segBeats(seg: BarSeg): number {
  return seg.notes.reduce(
    (a, t) => a + (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm' ? tokenDuration(t) : 0),
    0,
  )
}

/** 音符间总间距：n 个拍 (n-1) 个 NOTE_GAP 间隙（adj38/63：拍间距） */
function noteGapOf(n: number): number {
  return Math.max(0, n - 1) * NOTE_GAP
}

/** 排版行：完整小节行（均分撑满）或小节碎片行（超长小节按拍数拆分） */
type LayoutRow =
  | { kind: 'bars'; start: number; end: number }
  | { kind: 'frag'; segIdx: number; noteStart: number; noteEnd: number }

/** 断行：正常小节按逐拍 need 自然宽断行（adj35：密集拍多占、正常拍 14，与拍级挤占一致）；
 *  超长小节（拍数超行上限）拆为碎片行。 */
function breakRows(segs: BarSeg[], availW: number, noteSize = 18): LayoutRow[] {
  const rows: LayoutRow[] = []
  let start = 0
  let w = 0 // 当前行逐拍 need 宽累积
  for (let i = 0; i < segs.length; i++) {
    const sb = segBeats(segs[i])
    // adj106：小节整体超宽判定改用「拍级 need 总和」（原来按最密拍 need 高估，拆得过碎）
    const segW = segNeedW(segs[i], noteSize) + noteGapOf(Math.ceil(sb))
    if (segW > availW - BAR_PAD * 2) {
      // 超长小节：flush 当前行，再按音符拍数拆碎片行（按拍级 need 累计，adj106）
      if (i > start) rows.push({ kind: 'bars', start, end: i })
      const byBeat = segBeatMap(segs[i], noteSize)
      const needOf = new Map<number, number>()
      for (const [p, e] of byBeat) needOf.set(p, Math.max(BPW_NATURAL, minNoteW(noteSize, e.extra) / e.minDur))
      let accNeed = 0
      let accBeats = 0
      let noteStart = 0
      let lastP = -1
      const notes = segs[i].notes
      for (let j = 0; j < notes.length; j++) {
        const t = notes[j]
        const dur =
          t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm' ? tokenDuration(t) : 0
        const p = Math.floor(accBeats)
        if (p !== lastP) {
          // 进入新拍：计入该拍 need + 与前拍的间隙（行首拍无间隙）
          const add = (needOf.get(p) ?? BPW_NATURAL) + (lastP >= 0 ? NOTE_GAP : 0)
          if (accNeed + add > availW - BAR_PAD * 2 && j > noteStart) {
            rows.push({ kind: 'frag', segIdx: i, noteStart, noteEnd: j })
            noteStart = j
            accNeed = 0
          }
          accNeed += add
          lastP = p
        }
        accBeats += dur
      }
      rows.push({ kind: 'frag', segIdx: i, noteStart, noteEnd: notes.length })
      start = i + 1
      w = 0
    } else {
      // adj38/63：小节宽含拍间距（每拍 NOTE_GAP，n 拍 n-1 个间隙）；
      // 此前误按音符数算间隙（16 分音符小节被高估 48px）→ 断行过保守、单小节行被铺满间距虚大
      // adj64：另含非时值元素（&zkh/&ykh 括号）占位宽，先扣除再分摊；adj294：括号为独立 token 计数
      let bp = 0
      for (const t of segs[i].notes) {
        if (t.kind === 'bracket') bp += BRACKET_PAD
      }
      const nw = segW + bp
      if (i > start && w + nw > availW) {
        rows.push({ kind: 'bars', start, end: i })
        start = i
        w = nw
      } else {
        w += nw
      }
    }
  }
  if (start < segs.length) rows.push({ kind: 'bars', start, end: segs.length })
  return rows
}

/**
 * adj288：空间优先模式的断行——按「带时值元素本体宽 + 非时值元素占位」的最小需求宽
 * 累计，超过页面有效宽则断行（对应「可分配宽 < 0 一定换行」）。
 * 不再用时值优先的拍级 need（会高估小节宽，导致过早断行）。超长小节首版不拆 frag。
 */
function breakRowsSpace(segs: BarSeg[], availW: number, noteSize: number): LayoutRow[] {
  const segNeed = segs.map((seg) => {
    let durSum = 0
    for (const t of seg.notes) {
      if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
        const s = splitNoteDur(t)
        const accW = t.kind === 'note' && t.accidental ? accidentalBodyW(noteSize) : 0
        const grW = t.kind === 'note' ? graceExtraW(t, noteSize) : 0
        durSum +=
          noteBodyW(noteSize, grW) + accW + (t.dots > 0 ? dotBodyW(noteSize) : 0) + s.augCount * augBodyW(noteSize)
      }
      // adj294：&zkh/&ykh 为独立 bracket token——按 token 计数占位宽，不再依附音符 symbols
      for (const t of seg.notes) {
        if (t.kind === 'bracket') durSum += bracketBodyW()
      }
    }
    // 小节线占位（本体宽 + 双侧间距上限 0.5×音符宽）
    if (seg.bar) durSum += barlineSpace(0, seg.bar.type, seg.bar.comment, noteSize) + 2 * 0.5 * digitSlotW(noteSize)
    return durSum
  })
  const rows: LayoutRow[] = []
  let start = 0
  let acc = 0
  for (let i = 0; i < segs.length; i++) {
    const nw = segNeed[i]
    if (i > start && acc + nw > availW - BAR_PAD * 2) {
      rows.push({ kind: 'bars', start, end: i })
      start = i
      acc = nw
    } else {
      acc += nw
    }
  }
  if (start < segs.length) rows.push({ kind: 'bars', start, end: segs.length })
  return rows
}

// ============================================================
// 排版单元：单声部组 / 多声部块
// ============================================================

interface UnitGroup {
  groupIndex: number
  group: MusicGroup
}

interface Unit {
  groups: UnitGroup[]
  multi: boolean
}

// ============================================================
// 主排版函数
// ============================================================

export function layoutScore(result: ParseResult, config: PageConfig): ScoreLayout {
  const paper = PAPER_SIZE[config.page]
  const m = metrics(config)
  const keySemitone = parseKey(result.header.key)
  const availW = paper.width - config.margin_left - config.margin_right
  const bottomLimit = paper.height - config.margin_bottom

  const meta: ScorePageMeta = {
    titles: result.header.titles,
    authors: result.header.authors,
    key: result.header.key ?? null,
    meter: result.header.meter ?? null,
    tempo: result.header.tempo ?? null,
    tempoNum: result.header.tempoNum ?? null,
    tempoText: result.header.tempoText ?? null,
    instruments: result.header.instruments,
    notes: result.header.notes,
  }

  const pages: ScorePage[] = []
  let noteCounter = 0
  let barCounter = 0

  const startPage = () => {
    const page: ScorePage = {
      index: pages.length,
      width: paper.width,
      height: paper.height,
      notes: [],
      lyrics: [],
      barlines: [],
      voiceBlocks: [],
      slurs: [],
      dynamics: [],
      brackets: [],
      meta,
    }
    pages.push(page)
    return page
  }
  startPage()

  let pageIndex = 0
  let y = m.titleAreaH // 当前行顶 y

  /** 歌词 → 槽位映射（每行词独立）：标点不占槽位；@ 消耗槽位 */
  const buildLyricMaps = (lyrics: LyricLine[]): Map<number, LyricChar>[] =>
    lyrics.map((line) => {
      const map = new Map<number, LyricChar>()
      let slot = 0
      let lastSlot = -1 // 最近放置的字（标点挂其后，adj40）
      for (const ch of line.chars) {
        if (ch.punctuation) {
          // 标点不占音符位，紧跟前面的字（跨 @ 占位也跟前面的字）
          if (lastSlot >= 0) {
            const cur = map.get(lastSlot)
            map.set(lastSlot, cur ? { ...cur, trailing: (cur.trailing ?? '') + ch.text } : { ...ch, skip: false, trailing: ch.text })
          }
          continue
        }
        if (ch.skip) {
          slot++
          continue
        }
        map.set(slot, { ...ch }) // 保留解析期挂载的 trailing（adj35：标点紧跟本字渲染）
        lastSlot = slot
        slot++
      }
      return map
    })

  /**
   * 放置一个音符并处理歌词对齐。
   * segStartX = 该音符时值段起点；数字居中于第 1 拍段（增时线占后续每拍）。
   * 返回推进后的拍数。
   */
  const placeNoteAt = (
    t: Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>,
    segments: { x: number; perBeat: number; beats: number; el?: 'note' | 'aug' | 'dot' }[],
    yTop: number,
    pageIdx: number,
    groupIndex: number,
    voice: number,
    slotIndex: number,
    lyricMaps: Map<number, LyricChar>[],
    geciSize: number,
    sp: Spacing,
    beatPos: number,
    barIndex: number,
    // adj314：多声部空间优先用「音符块本体在时值段内水平居中」（参考单声部 placeNoteSpace）——
    // 提供 space 时按本体居中定位 note.x/width；时值优先路径不传，行为不变。
    // adj319：augW/hxW 含增时线/hx 显示占宽，noteRightX 累加避免色块按段宽算时漏掉
    space?: { noteBodyW: number; dotBodyW: number; accW: number; leftExt: number; hasDot: boolean; augW: number; hxW: number },
  ) => {
    const dur = tokenDuration(t)
    const first = segments[0] ?? { x: 0, perBeat: BPW_NATURAL, beats: dur }
    const w = Math.max(4, segments.reduce((a, s) => a + s.beats * s.perBeat, 0))
    // 数字中心（adj44）：
    //  增时线/附点音符锚定第 1 拍段中点（"-" 各占一拍、附点在其后）；
    //  其余音符（跨拍纯音符/连音组音符）居中于整个时值段（避免跨拍段偏移）
    const centerOnFirst = t.augmentCount > 0 || t.dots > 0
    // adj314：多声部空间优先——数字锚定**段起点**（严格同拍对齐），不做本体居中。
    //  诊断：段起点(segStart)在各声部同一拍已对齐；若按本体居中在各自时值段内偏移，
    //  则各声部同拍时值段长短不同 → 数字视觉错位。故多声部统一数字=段起点，保证纵向对齐。
    let nx: number
    let noteW: number
    let noteRightX: number
    if (space) {
      nx = first.x
      // ★ adj319：noteRightX 累加附点+增时线+hx 显示占宽（照搬单声部 actualW/rightX 计算，
      // 此前多声部 rightX 只含本体宽 → 色块按段滑动时末段 width 用本体宽，且 dot段 x1
      // 小于 dot.x 时附点色块消失）。附点右缘 = 附点圆心 + 圆半径（确保 endX ≥ 附点圆右缘）。
      let displayW = space.noteBodyW
      if (space.hasDot) {
        const dotGapE = DOT_AFTER_DIGIT_GAP(m.noteSize)
        // 附点右缘 = 数字右 + 间隙 + 第一个附点圆心 + 半径；双附点第 i 个圆心在 dotX0 + (i)·2·rDot，
        // 需覆盖最后一个附点圆右 → 加 (t.dots − 1)·2·DOT_R（adj320：双附点作为一个时值元素）
        displayW = Math.max(displayW, space.noteBodyW + dotGapE + space.dotBodyW / 2 + DOT_R + (t.dots - 1) * 2 * DOT_R)
      }
      if (space.augW) displayW += space.augW
      if (space.hxW) displayW += space.hxW
      noteW = displayW
      noteRightX = first.x + displayW
      // adj317：多声部 space 显式附点段位置（圆心 = 数字右缘 + 间隙 + 半附点宽），
      // 避免渲染回退公式 seg0.x + mainDur*perBeat 在 perBeat<本体宽时落在数字内
      if (space.hasDot) {
        const dotGap = DOT_AFTER_DIGIT_GAP(m.noteSize)
        segments.push({
          x: r1(first.x + space.noteBodyW + dotGap + space.dotBodyW / 2),
          perBeat: r1(space.dotBodyW / 0.5),
          beats: 0.5,
          el: 'dot',
        })
      }
    } else {
      nx = (centerOnFirst ? first.x + first.beats * (first.perBeat / 2) : first.x + w / 2) - 6
      noteW = w
      noteRightX = nx + w
    }
    const id: LayoutId = { page: pageIdx, voice, group: groupIndex, index: noteCounter }
    pages[pageIdx].notes.push({
      id,
      token: t,
      x: r1(nx),
      y: r1(yTop + m.noteSize * 1.1),
      width: r1(noteW),
      rightX: r1(noteRightX),
      duration: dur,
      beatPos,
      barIndex,
      segments,
      audioPitch: toPlayable(t)
        ? pitchToName(t.pitch, t.octaveShift, t.accidental, keySemitone)
        : null,
      playable: toPlayable(t),
    })
    lyricMaps.forEach((map, row) => {
      const ch = map.get(slotIndex)
      if (!ch) return
      // 歌词中心对齐音符数字（数字槽宽中心 = nx + NOTE_DIGIT_W/2，adj24）；
      // adj71：附带音符占位宽（歌词字宽 < 槽宽时横向放大自适应）
      pages[pageIdx].lyrics.push({
        id,
        char: ch,
        x: r1(nx + halfDigitW(m.noteSize) - geciSize / 2),
        y: r1(yTop + m.noteSize * 1.7 + sp.quci + row * (geciSize + 4 + sp.cici)),
        slotW: r1(w),
      })
    })
    noteCounter++
    return dur
  }

  /** 排布一个曲行（bars：每拍宽按行总拍数平均、小节宽=拍数×每拍宽；frag：超长小节按拍数铺满）
   *  refPerBeat：前面曲部行的平均每拍宽（adj199：未撑满行前面有曲部时按小节线对齐，
   *  每小节宽与前面行一致，而非自然宽）；返回该行平均每拍宽（供后续行对齐）。 */
  const placeMusicRow = (
    segs: BarSeg[],
    row: LayoutRow,
    groupIndex: number,
    voice: number,
    yTop: number,
    lyricMaps: Map<number, LyricChar>[],
    geciSize: number,
    sp: Spacing,
    slotStart: number,
    refPerBeat?: number,
  ): number | undefined => {
    const page = pages[pageIndex]
    // 小节线高度（adj50/69）：与音符数字等高（墨迹高 ≈0.8em，上沿基线-0.8×字号、下沿基线+0.5×s）
    // 再向上延伸 4px×s、向下延伸 4px×s → 基线-18.4×s .. 基线+4.5×s（随曲部字号缩放）
    const barNoteY = yTop + m.noteSize * 1.1
    const bs = noteScaleOf(m.noteSize)
    const yTopBar = r1(barNoteY - 18.4 * bs)
    const yBottomBar = r1(barNoteY + 4.5 * bs)
    let x = config.margin_left
    let slotIndex = slotStart
    let openDyn: { type: 'crescendo' | 'decrescendo'; x: number; plus: number } | null = null
    const finishDyn = (endX: number) => {
      if (openDyn) {
        page.dynamics.push({
          x1: r1(openDyn.x),
          x2: r1(endX),
          // adj：渐强渐弱 hairpin 中心 y 贴近行音符数字顶（间距对齐连音线，不再固定 -26）
          // 数字顶 = yTop + noteSize×0.3（音符基线 yTop+1.1×noteSize - 0.8×noteSize）
          y: r1(yTop + m.noteSize * 0.3 - (LAYER_GAP + DYN_HALF_H + SLUR_W / 2) * bs),
          type: openDyn.type,
          // adj：渐强渐弱 "+" 提升级数（>+ / <++）；无则 0 缺省
          plus: openDyn.plus > 0 ? openDyn.plus : undefined,
        })
        openDyn = null
      }
    }

    if (row.kind === 'frag') {
      // 超长小节碎片行：拍级每拍宽（adj35）
      const seg = segs[row.segIdx]
      const slice = { notes: seg.notes.slice(row.noteStart, row.noteEnd), bar: null }
      const beatsInfo: { dur: number; minDur: number; extra: number }[] = []
      let fgBeat = 0
      for (const t of slice.notes) {
        if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
          const dur = tokenDuration(t)
          let pos = fgBeat
          let rem = dur
          while (rem > 1e-9) {
            const nearInt = Math.abs(pos - Math.round(pos)) < 1e-3
            const p = nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)
            while (beatsInfo.length <= p) beatsInfo.push({ dur: 0, minDur: Infinity, extra: 0 })
            const piece = Math.min(rem, (nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)) + 1 - pos)
            beatsInfo[p].dur += piece
            beatsInfo[p].minDur = Math.min(beatsInfo[p].minDur, piece)
            pos += piece
            rem -= piece
          }
          // adj106：倚音占位记到音符起始拍（该拍分配更宽，避免倚音与相邻音符重叠）
          if (t.kind === 'note') {
            const p0 = Math.floor(fgBeat + 1e-9)
            if (beatsInfo[p0]) beatsInfo[p0].extra = Math.max(beatsInfo[p0].extra, noteExtraW(t, m.noteSize))
          }
          fgBeat += dur
        }
      }
      // adj64：非时值元素（括号）占位先扣除再分摊（超长小节碎片行同规则）；adj294：括号为独立 token
      let fragBracket = 0
      for (const t of slice.notes) {
        if (t.kind === 'bracket') fragBracket += BRACKET_PAD
      }
      const perBeats = allocatePerBeats(beatsInfo, availW - BAR_PAD * 2 - noteGapOf(beatsInfo.length) - fragBracket, m.noteSize)
      // 段列表（adj36：附点段用基础拍每拍宽）
      const fragSegs: { p: number; piece: number; perBeat: number; note: Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>; notePos: number }[] = []
      let fgB = 0
      for (const t of slice.notes) {
        if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
          const dur = tokenDuration(t)
          const notePos = fgB
          let pos = fgB
          let rem = dur
          while (rem > 1e-9) {
            const nearInt = Math.abs(pos - Math.round(pos)) < 1e-3
            const p = nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)
            const piece = Math.min(rem, (nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)) + 1 - pos)
            fragSegs.push({
              p,
              piece,
              // adj85：附点段用所在拍 perBeat（原用音符起始拍，段宽与拍宽不一致 → 行尾留白）
              perBeat: perBeats[p],
              note: t,
              notePos,
            })
            pos += piece
            rem -= piece
          }
          fgB += dur
        }
      }
      const beatW: number[] = new Array(beatsInfo.length).fill(0)
      for (const fs of fragSegs) beatW[fs.p] += fs.piece * fs.perBeat
      const beatStart: number[] = []
      let fAcc = 0
      for (let p = 0; p < beatsInfo.length; p++) {
        beatStart.push(fAcc)
        fAcc += beatW[p]
      }
      // 渲染（逐音符聚合段，段起点逐段累计拍内偏移；拍与拍 8px，adj38）
      let curP = -1
      let offInBeat = 0
      let fIdx = 0
      // adj294：&zkh/&ykh 为独立 bracket token——碎片行同规则：源码顺序推进、占位让位
      const fragNotes = slice.notes
      let fragTokIdx = 0
      let fragLastRight = 0
      let fragBracketAcc = 0
      while (fIdx < fragSegs.length) {
        const rs = fragSegs[fIdx]
        // 推进源码游标到本音符：途中 bracket 收集待渲染（占位让位计入 xOff）
        const pendFrag: Extract<MusicToken, { kind: 'bracket' }>[] = []
        while (fragTokIdx < fragNotes.length && fragNotes[fragTokIdx] !== rs.note) {
          const tk = fragNotes[fragTokIdx]
          if (tk.kind === 'bracket') {
            pendFrag.push(tk)
            fragBracketAcc += BRACKET_PAD
          }
          fragTokIdx++
        }
        const xOff = fragBracketAcc
        const segments: { x: number; perBeat: number; beats: number }[] = []
        while (fIdx < fragSegs.length && fragSegs[fIdx].notePos === rs.notePos) {
          const s = fragSegs[fIdx]
          if (s.p !== curP) {
            curP = s.p
            offInBeat = 0
          }
          // adj75：跨拍段逐段累计拍间距（单音符 6--- 内部也有拍间距，与多音符行一致）
          segments.push({ x: x + BAR_PAD + beatStart[s.p] + offInBeat + s.p * NOTE_GAP + xOff, perBeat: s.perBeat, beats: s.piece })
          offInBeat += s.piece * s.perBeat
          fIdx++
        }
        placeNoteAt(rs.note, segments, yTop, pageIndex, groupIndex, voice, slotIndex, lyricMaps, geciSize, sp, rs.notePos, 0)
        const fragPlacedX = pages[pageIndex].notes[pages[pageIndex].notes.length - 1].x
        fragLastRight = pages[pageIndex].notes[pages[pageIndex].notes.length - 1].rightX ?? 0
        // adj294：渲染本音符源码之前的 bracket（紧贴本音符左缘，从远到近排列）
        for (let pi = 0; pi < pendFrag.length; pi++) {
          const bk = pendFrag[pi]
          const bw = bracketBodyW()
          page.brackets.push({
            dir: bk.dir,
            x: r1(fragPlacedX + bw / 2 - (pendFrag.length - pi) * bw),
            yTop: r1(yTop + m.noteSize * 0.7),
            width: r1(bw),
            voice,
            group: groupIndex,
          })
        }
        slotIndex++
      }
      // adj294：碎片行末残留 bracket——紧贴上一元素右端放置
      while (fragTokIdx < fragNotes.length) {
        const tk = fragNotes[fragTokIdx]
        if (tk.kind === 'bracket') {
          const bw = bracketBodyW()
          page.brackets.push({
            dir: tk.dir,
            x: r1(fragLastRight + bw / 2),
            yTop: r1(yTop + m.noteSize * 0.7),
            width: r1(bw),
            voice,
            group: groupIndex,
          })
          fragBracketAcc += bw
        }
        fragTokIdx++
      }
      finishDyn(x + BAR_PAD + (beatStart[beatsInfo.length - 1] ?? 0) + (beatW[beatsInfo.length - 1] ?? 0))
      return undefined // frag 行不参与小节线对齐参考
    }

    // bars 行（adj35 拍级每拍宽）：
    //  ① 正常拍平均分布（剩余宽 / 正常拍总时值）
    //  ② 拍内音符最小间距 1px（need = max(14, 12.16/拍内最小时值)）
    //  ③ 超拍挤占其它正常拍空间，正常拍再平均调整
    const leadingEmpty = row.start < row.end && segs[row.start].notes.length === 0 ? 1 : 0
    // adj47：跨行跳房子起点——上一行末的 voltaStart 小节线改画在本行行首
    // （断行发生在 [ 起点小节线后时，线若留在行尾会溢出右边界且跳房子跨行反向）
    const leadVoltaBar =
      row.start > 0 && !leadingEmpty && segs[row.start - 1].bar?.voltaStart
        ? segs[row.start - 1].bar
        : null
    // 行首小节线占位：非普通 |、非 |/ 的行首线（|: || :|: |* 等）预留 线宽 + 右侧 4px 间距
    const leadBar = leadingEmpty === 1 ? segs[row.start].bar : leadVoltaBar
    const leadPad =
      leadBar && leadBar.type !== '|' && leadBar.type !== '|/' ? barlineTotalW(leadBar.type) + 4 : 0
    // 行预算：每对相邻内容小节之间按该小节线上类型占位（|/ 不占位）
    let barGaps = 0
    {
      let prevBar = -1
      for (let b = row.start; b < row.end; b++) {
        if (leadingEmpty === 1 && b === row.start) continue
        if (prevBar >= 0) {
          const pbar = segs[prevBar].bar
          barGaps += barlineSpace(config.bar_gap, pbar?.type, pbar?.comment, m.noteSize)
        }
        prevBar = b
      }
    }
    const pads = BAR_PAD * 2 + barGaps + leadPad

    // 行内拍序列（跨小节连续拍；行首空 seg 不占拍）
    const beatsInfo: { dur: number; minDur: number; extra: number }[] = []
    let gBeat = 0
    for (let b = row.start; b < row.end; b++) {
      const seg = segs[b]
      const isEmptyLead = leadingEmpty === 1 && b === row.start
      if (isEmptyLead) continue
      for (const t of seg.notes) {
        if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
          const dur = tokenDuration(t)
          let pos = gBeat
          let rem = dur
          while (rem > 1e-9) {
            // adj217/218：近整数归整——tupletDur 浮点累加（4.9999…）误判拍边界时归并
            const nearInt = Math.abs(pos - Math.round(pos)) < 1e-3
            const p = nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)
            while (beatsInfo.length <= p) beatsInfo.push({ dur: 0, minDur: Infinity, extra: 0 })
            const piece = Math.min(rem, (nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)) + 1 - pos)
            beatsInfo[p].dur += piece
            beatsInfo[p].minDur = Math.min(beatsInfo[p].minDur, piece)
            pos += piece
            rem -= piece
          }
          // adj106：倚音占位记到音符起始拍（该拍分配更宽，避免倚音与相邻音符重叠）
          if (t.kind === 'note') {
            const p0 = Math.floor(gBeat + 1e-9)
            if (beatsInfo[p0]) beatsInfo[p0].extra = Math.max(beatsInfo[p0].extra, noteExtraW(t, m.noteSize))
          }
          gBeat += dur
        }
      }
    }
    // 拍间距预算（adj38：拍与拍 8px）
    const noteGap = noteGapOf(beatsInfo.length)
    // adj64：非时值元素（&zkh/&ykh 括号）占位宽先扣除，剩余宽才按比例分摊给带时值元素
    // adj294：括号为独立 token，按 token 计数（不再依附音符 symbols）
    let bracketPadTotal = 0
    for (let b = row.start; b < row.end; b++) {
      const seg = segs[b]
      if (leadingEmpty === 1 && b === row.start) continue
      for (const t of seg.notes) {
        if (t.kind === 'bracket') bracketPadTotal += BRACKET_PAD
      }
    }
    // adj198：≤3 小节的行不分散对齐（自然宽、行尾留白）；
    // adj205：>3 小节一律撑满两端对齐（**含最后一行**——此前最后一行即使
    // 5 小节也不撑满，违反「≤3 才自然宽」规则）
    // adj297：阈值可配置——行小节数 < align_min_bars（默认 4）自然对齐，≥ 则撑满
    // adj199：未撑满行前面有曲部（refPerBeat 提供）时，按小节线对齐——
    // 每拍宽直接取参考行平均每拍宽（不加 BPW_NATURAL 下限：撑满行每拍宽可小于自然宽，
    // 抬升会破坏小节线对齐），使各小节宽与前面行一致（纵向小节线对齐）
    const barCount = row.end - row.start - leadingEmpty
    const stretch = barCount >= config.align_min_bars
    // adj211：行末以 ||（终止线）结束且 ≤3 小节时，不参与前面行的小节线对齐
    // （refPerBeat）——终止线行音乐已结束，无需与其他行纵向对齐小节线，按自然宽排布
    const endsByTerminal = segs[row.end - 1]?.bar?.type === '||'
    const perBeats =
      !stretch && refPerBeat !== undefined && !endsByTerminal
        ? beatsInfo.map(() => refPerBeat)
        : singleRulePerBeats(beatsInfo, availW - pads - noteGap - bracketPadTotal, m.noteSize, stretch)

    // 段列表（adj36）：附点段（dots 部分）每拍宽 = 音符基础时值拍的 perBeat，
    // 不被所在拍（超拍）放大 —— 附点只占前音符时值的 0.5
    interface RowSegInfo {
      p: number
      piece: number
      perBeat: number
      note: Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>
      notePos: number
      barIdx: number
      /** 拍间距基准拍（adj44：平均连音组内统一用组起始拍，保证均分） */
      gapOf: number
    }
    const rowSegs: RowSegInfo[] = []
    let gB = 0
    // 平均连音组 (y... 起始拍栈（组内拍间距基准 = 组首拍，adj44）
    const tupletStartStack: number[] = []
    for (let b = row.start; b < row.end; b++) {
      const seg = segs[b]
      if (leadingEmpty === 1 && b === row.start) continue
      for (const t of seg.notes) {
        if (t.kind === 'slur') {
          if (t.dir === 'open' && t.tuplet) tupletStartStack.push(Math.floor(gB))
          else if (t.dir === 'close' && tupletStartStack.length > 0) tupletStartStack.pop()
          continue
        }
        if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
          const dur = tokenDuration(t)
          const notePos = gB
          let pos = gB
          let rem = dur
          while (rem > 1e-9) {
            // adj217/218：近整数归整——tupletDur 浮点累加（4.9999…）误判拍边界时归并；
            // 距整数 <1e-3 视为整数拍边界
            const nearInt = Math.abs(pos - Math.round(pos)) < 1e-3
            const p = nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)
            const piece = Math.min(rem, (nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)) + 1 - pos)
            rowSegs.push({
              p,
              piece,
              // adj85：附点段用所在拍 perBeat（原用音符起始拍，附点跨到密集拍时
              // 段宽与拍宽不一致 → 行尾留白；改所在拍后拍宽 = perBeats[p]×dur 自洽）
              perBeat: perBeats[p],
              note: t,
              notePos,
              barIdx: b,
              // 拍间距基准（adj75）：普通音符按段所在拍 p（跨拍段逐段累计 NOTE_GAP，
              // 单音符 6--- 内部也有拍间距，末尾增时线不再被小节线甩开）；
              // 平均连音组内统一用组首拍（组内无拍间距 → 均分）
              gapOf: tupletStartStack.length > 0 ? tupletStartStack[tupletStartStack.length - 1] : p,
            })
            pos += piece
            rem -= piece
          }
          gB += dur
        }
      }
    }

    // 每拍宽 = Σ 段宽（附点段用基础拍每拍宽）；拍起点
    const beatW: number[] = new Array(beatsInfo.length).fill(0)
    for (const rs of rowSegs) beatW[rs.p] += rs.piece * rs.perBeat
    const beatStart: number[] = []
    let bAcc = 0
    for (let p = 0; p < beatsInfo.length; p++) {
      beatStart.push(bAcc)
      bAcc += beatW[p]
    }

    x = config.margin_left
    let segBeat = 0 // 小节起点拍（行内，跳过行首空 seg）
    let segIdx = 0
    // adj47：跨行跳房子起点——上一行末的 voltaStart 小节线画在本行行首（贴左边距）
    if (leadVoltaBar) {
      const halfW = barlineTotalW(leadVoltaBar.type) / 2
      const lineX = Math.min(
        Math.max(x + halfW, config.margin_left + halfW),
        page.width - config.margin_right - halfW,
      )
      const bid: LayoutId = { page: pageIndex, voice, group: groupIndex, index: barCounter }
      page.barlines.push({
        id: bid,
        type: leadVoltaBar.type,
        marks: leadVoltaBar.marks, // adj206
        voltaStart: leadVoltaBar.voltaStart,
        voltaEnd: leadVoltaBar.voltaEnd,
        voltaEndSlash: leadVoltaBar.voltaEndSlash,
        voltaOnly: leadVoltaBar.voltaOnly,
        comment: leadVoltaBar.comment,
        x: r1(lineX),
        yTop: yTopBar,
        yBottom: yBottomBar,
        width: m.barlineWidth,
      })
      barCounter++
    }
    for (let b = row.start; b < row.end; b++) {
      const seg = segs[b]
      const isEmptyLead = leadingEmpty === 1 && b === row.start
      // 小节宽 = Σ 拍宽；非整拍小节（如 4.5 拍）按实际重叠拍数比例（避免尾拍整宽虚高）
      let segBarW = 0
      if (!isEmptyLead) {
        const sb = segBeats(seg)
        const p0 = Math.max(0, Math.floor(segBeat + 1e-9))
        const p1 = Math.min(beatsInfo.length - 1, Math.floor(segBeat + sb - 1e-9))
        for (let p = p0; p <= p1; p++) {
          const overlap = Math.min(p + 1, segBeat + sb) - Math.max(p, segBeat)
          if (overlap <= 0) continue
          const pb = beatsInfo[p]?.dur > 0 ? beatW[p] / beatsInfo[p].dur : 0
          segBarW += overlap * pb
        }
      }
      // 小节起点对应的行内相对 x（segBeat 可能非整数：尾拍小节）
      const segBeatFloor = Math.max(0, Math.floor(segBeat + 1e-9))
      const pbFloor = beatsInfo[segBeatFloor]?.dur > 0 ? beatW[segBeatFloor] / beatsInfo[segBeatFloor].dur : 0
      const barStartX = beatStart[segBeatFloor] + (segBeat - segBeatFloor) * pbFloor

      let slotIdx = 0 // 小节内音符数
      // adj：渐强渐弱定位用——按小节音符顺序记录每个音符的数字槽中心 x
      // （渐强渐弱 < > 起点 / ! 终点取「其所跟音符」的槽中心，而非小节末音符）
      const noteCenters: number[] = []
      // 渲染该小节音符（按音符聚合段，段起点逐段累计拍内偏移；音符间 8px，adj38）
      let curP = -1
      let offInBeat = 0
      // adj294：&zkh/&ykh 为独立 bracket token——按源码顺序推进游标，占位让位（不等音符符号）
      const segNotes = seg.notes
      let tokIdx = 0
      let lastRightAbs = 0 // 本小节上一个已放置元素占位右端（行末 bracket 用）
      let bracketAcc = 0 // 行内已让位 bracket 总宽（后续音符右移）
      while (segIdx < rowSegs.length && rowSegs[segIdx].barIdx === b) {
        const rs = rowSegs[segIdx]
        // 推进源码游标到本音符：途中遇到 bracket 收集为待渲染（占位让位宽度计入 xOff）
        const pendingBrackets: Extract<MusicToken, { kind: 'bracket' }>[] = []
        while (tokIdx < segNotes.length && segNotes[tokIdx] !== rs.note) {
          const tk = segNotes[tokIdx]
          if (tk.kind === 'bracket') {
            pendingBrackets.push(tk)
            bracketAcc += BRACKET_PAD
          }
          tokIdx++
        }
        // 本音符 x 偏移：之前所有 bracket 占位让位宽度
        const xOff = bracketAcc
        const segments: { x: number; perBeat: number; beats: number }[] = []
        let first = true
        while (segIdx < rowSegs.length && rowSegs[segIdx].barIdx === b && rowSegs[segIdx].notePos === rs.notePos) {
          const s = rowSegs[segIdx]
          if (s.p !== curP) {
            curP = s.p
            // 音符从拍中间开始（notePos 非整）时，首段补拍内偏移；后续段（跨拍）从拍首开始
            // adj218：notePos 浮点尾（tupletDur 累加 4.9999…）→ 拍内偏移近整数归 0
            if (first) {
              const frac = rs.notePos - Math.floor(rs.notePos)
              offInBeat = frac < 1e-3 || 1 - frac < 1e-3 ? 0 : frac * s.perBeat
            } else {
              offInBeat = 0
            }
          }
          segments.push({
            // adj38：拍与拍之间 8px（按行内拍序；平均连音组内统一组首拍，adj44）；adj64：+括号占位
            // adj75：用当前段 s.gapOf（按段所在拍递增，单音符 6--- 内部也有拍间距）
            x: x + BAR_PAD + (beatStart[s.p] - barStartX) + offInBeat + s.gapOf * NOTE_GAP + xOff,
            perBeat: s.perBeat,
            beats: s.piece,
          })
          offInBeat += s.piece * s.perBeat
          if (first) {
            first = false
          }
          segIdx++
        }
        // adj219：beatPos 近整数归整（浮点尾 0.9999… → 1），供减时线按拍分组正确
        const bpRaw = rs.notePos - segBeat
        const bp = Math.abs(bpRaw - Math.round(bpRaw)) < 1e-3 ? Math.round(bpRaw) : bpRaw
        placeNoteAt(rs.note, segments, yTop, pageIndex, groupIndex, voice, slotIndex, lyricMaps, geciSize, sp, bp, b)
        // 记录该音符数字槽中心（渐强渐弱 < > 起点 / ! 终点定位用）
        const placedX = pages[pageIndex].notes[pages[pageIndex].notes.length - 1].x
        noteCenters.push(placedX + halfDigitW(m.noteSize))
        lastRightAbs = pages[pageIndex].notes[pages[pageIndex].notes.length - 1].rightX ?? 0
        // adj294：渲染本音符源码之前的 bracket（紧贴本音符左缘，从远到近排列）
        for (let pi = 0; pi < pendingBrackets.length; pi++) {
          const bk = pendingBrackets[pi]
          const bw = bracketBodyW()
          page.brackets.push({
            dir: bk.dir,
            x: r1(placedX + bw / 2 - (pendingBrackets.length - pi) * bw),
            yTop: r1(yTop + m.noteSize * 0.7),
            width: r1(bw),
            voice,
            group: groupIndex,
          })
        }
        slotIndex++
        slotIdx++
      }
      // adj294：小节末尾残留的 bracket（其后无音符）——紧贴上一元素右端放置
      while (tokIdx < segNotes.length) {
        const tk = segNotes[tokIdx]
        if (tk.kind === 'bracket') {
          const bw = bracketBodyW()
          page.brackets.push({
            dir: tk.dir,
            x: r1(lastRightAbs + bw / 2),
            yTop: r1(yTop + m.noteSize * 0.7),
            width: r1(bw),
            voice,
            group: groupIndex,
          })
          bracketAcc += bw
        }
        tokIdx++
      }
      // 渐强/渐弱（adj：起点 / 终点取 < > ! 所跟音符的「数字槽中心」；
      // 用 noteCenters 顺序游标 nk 对齐所跟音符，避免此前误取小节末音符位置）
      let nk = 0
      for (const t of seg.notes) {
        if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
          nk++
          continue
        }
        if (t.kind !== 'decoration') continue
        // "+" 数量 = 抬升级数（<+ / >++，每级抬升，类似跳房子）
        let plus = 0
        for (const ch of t.code) if (ch === '+') plus++
        if (t.dynamics === 'crescendo' || t.dynamics === 'decrescendo') {
          const startX = noteCenters[nk - 1] ?? x + BAR_PAD
          openDyn = { type: t.dynamics, x: startX, plus }
        } else if (t.dynamics === 'end') {
          const endX = noteCenters[nk - 1] ?? x + BAR_PAD
          finishDyn(endX)
        }
      }
      // 小节线：画在小节内容右端（+BAR_PAD 不重叠音符，adj36），并在小节间距内居中（adj25）；
      // 占位空间随线组类型变化（|/ 隐藏线不占位）
      const bar = seg.bar
      if (bar) {
        const isRowStartEmpty = isEmptyLead
        // adj47：断行发生在 [ 起点小节线后时，该线移到下一行行首渲染（leadVoltaBar），
        // 行尾不再画（避免番号溢出右边界、跳房子跨行反向）
        const movesToNextRow =
          bar.voltaStart && b === row.end - 1 && row.end < segs.length
        // adj137：行首空 seg 的普通单线 | 跳过（行从边距开始）；
        // 带跳房子（voltaStart/voltaEnd）或小节线修饰符的行首线**不跳过**——否则起点/标记丢失
        const skipRowStart =
          isRowStartEmpty && bar.type === '|' && !bar.voltaStart && !bar.voltaEnd && !bar.marks?.length
        if (!movesToNextRow && !skipRowStart) {
          // 小节线整体不超出页面内容区（左/右边距内，adj）
          const lineX0 =
            isEmptyLead
              ? x
              : x + BAR_PAD + segBarW + barlineSpace(config.bar_gap, bar.type, bar.comment, m.noteSize) / 2 + Math.floor(segBeat + segBeats(seg)) * NOTE_GAP
          const halfW = barlineTotalW(bar.type) / 2
          const lineX = Math.min(
            Math.max(lineX0, config.margin_left + halfW),
            page.width - config.margin_right - halfW,
          )
          const bid: LayoutId = { page: pageIndex, voice, group: groupIndex, index: barCounter }
          page.barlines.push({
            id: bid,
            type: bar.type,
            marks: bar.marks, // adj206：小节线修饰符透传
            voltaStart: bar.voltaStart,
            voltaEnd: bar.voltaEnd,
            voltaEndSlash: bar.voltaEndSlash,
            voltaOnly: bar.voltaOnly,
            comment: bar.comment,
            x: r1(lineX),
            yTop: yTopBar,
            yBottom: yBottomBar,
            width: m.barlineWidth,
          })
        }
        barCounter++
      }
      // 行首空 seg：若带需占位的小节线（|: || :|: |* 等），预留 线宽 + 右侧 4px
      x += isEmptyLead
        ? leadPad
        : segBarW + (b < row.end - 1 ? barlineSpace(config.bar_gap, seg.bar?.type, seg.bar?.comment, m.noteSize) : 0)
      segBeat += isEmptyLead ? 0 : segBeats(seg)
    }
    finishDyn(x) // 行尾关闭未闭合渐强
    // adj199：返回该行平均每拍宽（撑满行 → 实际均分宽；未撑满行 → 参考宽/自然宽），
    // 供后续行按小节线对齐
    const totalBeats = beatsInfo.reduce((a, b) => a + b.dur, 0)
    return totalBeats > 0 ? beatsInfo.reduce((a, b, p) => a + b.dur * perBeats[p], 0) / totalBeats : undefined
  }

  /**
   * adj284：空间优先放置一行（无括号的 bars 行）。
   * 带时值元素（音符块 / 每条增时线）按「本体宽 + (时值/总时值)×可分配宽 W」分配；
   * 附点依附音符块，与音符块在 1.5 倍时值段内三段留空分散对齐（模型 V2）；
   * 小节线为非时值元素，占 barlineSpace + 非时值间距。音符块/增时线/附点各自
   * 以独立段（el 标记）写入 segments，供渲染端绘制。
   */
  const placeMusicRowSpace = (
    segs: BarSeg[],
    row: LayoutRow,
    groupIndex: number,
    voice: number,
    yTop: number,
    lyricMaps: Map<number, LyricChar>[],
    geciSize: number,
    sp: Spacing,
    slotStart: number,
  ) => {
    if (row.kind !== 'bars') return
    const page = pages[pageIndex]
    const leadingEmpty = row.start < row.end && segs[row.start].notes.length === 0 ? 1 : 0

    // ---- 提取带时值元素（音符块 / 增时线 / 附点）+ 小节线 ----
    interface NEl {
      t: Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>
      slotPos: number
      barIdx: number
      beatPos: number
      noteDur: number
      augCount: number
      augDur: number
      dotDur: number
      hasDot: boolean
      noteBodyW: number
      dotBodyW: number
      /** 变音角标左扩展宽（#/$/=/♯/♭/♮），无变音为 0 */
      accW: number
      /** 前倚音左扩展宽（[ 组），仅前倚音非 0 */
      leftExt: number
      /** 是否带 &hx（滑音箭头，右侧，无时值元素，依附音符/增时线之后） */
      hasHx: boolean
      /** 该音符的每拍时值宽（分配宽/时值），供小节线间距自适应收紧；预计算后填充 */
      perBeatW?: number
    }
    const noteList: NEl[] = []
    const barList: { bar: Extract<MusicToken, { kind: 'barline' }>; atEnd: boolean }[] = []
    let slotPos = slotStart
    for (let b = row.start; b < row.end; b++) {
      const seg = segs[b]
      const isEmptyLead = leadingEmpty === 1 && b === row.start
      if (!isEmptyLead) {
        let cumBeat = 0
        for (const t of seg.notes) {
          if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
            const s = splitNoteDur(t)
            const accW = t.kind === 'note' && t.accidental ? accidentalBodyW(m.noteSize) : 0
            const grW = t.kind === 'note' ? graceExtraW(t, m.noteSize) : 0
            const gn = t.kind === 'note' ? t.gracenotes : undefined
            // 前倚音向左扩展、后倚音向右扩展；只有前倚音影响「数字左缘」
            const leftExt = gn && !gn.after ? grW : 0
            noteList.push({
              t,
              slotPos,
              barIdx: b,
              beatPos: cumBeat,
              noteDur: s.noteDur,
              augCount: s.augCount,
              augDur: s.augDur,
              dotDur: s.dotDur,
              hasDot: t.dots > 0,
              noteBodyW: noteBodyW(m.noteSize, grW) + accW,
              dotBodyW: t.dots > 0 ? dotBodyW(m.noteSize) : 0,
              accW,
              leftExt,
              hasHx: t.symbols.includes('hx'),
            })
            slotPos++
            cumBeat += s.noteDur * (1 + s.augCount) + s.dotDur
          }
        }
      }
      if (seg.bar) barList.push({ bar: seg.bar, atEnd: b === row.end - 1 })
    }

    // ---- 总时值 / 带时值本体宽和 / 可分配宽 W ----
    let totalDur = 0
    let durBodySum = 0
    for (const n of noteList) {
      const noteElDur = n.noteDur + (n.hasDot ? n.dotDur : 0)
      totalDur += noteElDur + n.augCount * n.augDur
      durBodySum += n.noteBodyW + (n.hasDot ? n.dotBodyW : 0) + n.augCount * augBodyW(m.noteSize)
    }
    let nonDurPad = 0
    const bp = barlinePad(m.noteSize)
    for (const bk of barList) {
      // adj314：预算与放置一致——小节线占位 = 线自身宽 + 两侧净间距 barlinePad(noteSize)。
      // 之前用 barlineSpace(含固定 +8 空隙) / 0.5×音符宽 做预算，高估占位→ W 被挤小→ 拍内音符过密。
      const lineW = barlineTotalW(bk.bar.type)
      nonDurPad += lineW + bp * 2
    }
    // adj294：&zkh/&ykh 为独立括号标记（无时值元素）——占位从行宽扣（A 方案）
    let bracketCount = 0
    for (let bi = row.start; bi < row.end; bi++) {
      for (const tk of segs[bi].notes) if (tk.kind === 'bracket') bracketCount++
    }
    if (bracketCount > 0) nonDurPad += bracketBodyW() * bracketCount
    // adj293：&hx（滑音箭头，右侧）为无时值元素——依附其前的带时值元素之后，本体宽占位
    for (const n of noteList) {
      if (n.hasHx) nonDurPad += hxBodyW(m.noteSize)
    }
    const W = Math.max(0, availW - durBodySum - nonDurPad)

    // adj288：每音符每拍时值宽 + 每小节首/末音符每拍宽（供小节线间距自适应收紧）
    const segFirstPb: (number | undefined)[] = new Array(segs.length).fill(undefined)
    const segLastPb: (number | undefined)[] = new Array(segs.length).fill(undefined)
    for (const n of noteList) {
      const noteElDur = n.noteDur + (n.hasDot ? n.dotDur : 0)
      const noteElW =
        n.noteBodyW + (n.hasDot ? n.dotBodyW : 0) + (totalDur > 0 ? (noteElDur / totalDur) * W : 0)
      n.perBeatW = noteElDur > 0 ? noteElW / noteElDur : 0
      if (segFirstPb[n.barIdx] === undefined) segFirstPb[n.barIdx] = n.perBeatW
      segLastPb[n.barIdx] = n.perBeatW
    }
    // adj314：小节线一侧间距 = 1/2 音符字体宽度 barlinePad(noteSize)（用户规则 A）——
    // 不随音符占宽(W)放大，宽松时避免"空上加空"、压缩时仍能区分小节；
    // 间距随字号比例缩放，要调整只改 spacing.ts 的 barlinePad。
    const barGapSide = () => barlinePad(m.noteSize)

    // ---- 小节线几何（与既有 matchMusicRow 一致） ----
    const barNoteY = yTop + m.noteSize * 1.1
    const bs = noteScaleOf(m.noteSize)
    const yTopBar = r1(barNoteY - 18.4 * bs)
    const yBottomBar = r1(barNoteY + 4.5 * bs)

    // adj285：空间优先直接把 note.x 设为「音符块段左缘」（数字左对齐于此，数字中心=段中心），
    // 不复用 placeNoteAt 的「中心-6」偏移——否则数字在段内不居中，音符块左右三段留空不均。
    const placeNoteSpace = (
      t: Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>,
      segList: { x: number; perBeat: number; beats: number; el?: 'note' | 'aug' | 'dot' }[],
      noteX: number,
      noteW: number,
      rightX: number,
      slotIndex: number,
      beatPos: number,
      barIndex: number,
    ) => {
      const dur = tokenDuration(t)
      const id: LayoutId = { page: pageIndex, voice, group: groupIndex, index: noteCounter }
      pages[pageIndex].notes.push({
        id,
        token: t,
        x: r1(noteX),
        y: r1(yTop + m.noteSize * 1.1),
        width: r1(noteW),
        rightX: r1(rightX),
        duration: dur,
        beatPos,
        barIndex,
        segments: segList,
        audioPitch: toPlayable(t) ? pitchToName(t.pitch, t.octaveShift, t.accidental, keySemitone) : null,
        playable: toPlayable(t),
      })
      lyricMaps.forEach((map, row) => {
        const ch = map.get(slotIndex)
        if (!ch) return
        pages[pageIndex].lyrics.push({
          id,
          char: ch,
          x: r1(noteX + halfDigitW(m.noteSize) - geciSize / 2),
          y: r1(yTop + m.noteSize * 1.7 + sp.quci + row * (geciSize + 4 + sp.cici)),
          slotW: r1(noteW),
        })
      })
      noteCounter++
      return dur
    }

    // ---- 放置 ----
    let curX = config.margin_left
    let barCursor = 0
    let noteCursor = 0
    for (let b = row.start; b < row.end; b++) {
      const seg = segs[b]
      const isEmptyLead = leadingEmpty === 1 && b === row.start
      if (!isEmptyLead) {
        for (const tok of seg.notes) {
          if (tok.kind === 'note' || tok.kind === 'rest' || tok.kind === 'rhythm') {
            const n = noteList[noteCursor++]
            const noteElDur = n.noteDur + (n.hasDot ? n.dotDur : 0)
            const noteElW =
              n.noteBodyW + (n.hasDot ? n.dotBodyW : 0) + (totalDur > 0 ? (noteElDur / totalDur) * W : 0)
            // 音符块段左缘：带附点时与附点三段留空分散（音符块靠左）；
            // 无附点时音符块内容在时值宽度 noteElW 内居中（左右等留空）
            let blockX = curX
            let dotCX = 0
            if (n.hasDot) {
              const g = Math.max(0, (noteElW - n.noteBodyW - n.dotBodyW) / 3)
              blockX = curX + g
              dotCX = curX + g + n.noteBodyW + g + n.dotBodyW / 2
            } else {
              blockX = curX + Math.max(0, (noteElW - n.noteBodyW) / 2)
            }
            const segments: { x: number; perBeat: number; beats: number; el?: 'note' | 'aug' | 'dot' }[] = []
            segments.push({ x: r1(blockX), perBeat: r1(n.noteBodyW / n.noteDur), beats: n.noteDur, el: 'note' })
            if (n.hasDot) segments.push({ x: r1(dotCX), perBeat: r1(n.dotBodyW / n.dotDur), beats: n.dotDur, el: 'dot' })
            let xCursor = curX + noteElW
            for (let a = 0; a < n.augCount; a++) {
              const augElW = augBodyW(m.noteSize) + (totalDur > 0 ? (n.augDur / totalDur) * W : 0)
              // perBeat = 实际每拍宽（段宽 = augElW），使增时线字符在自身时值宽度内居中
              segments.push({ x: r1(xCursor), perBeat: r1(augElW / n.augDur), beats: n.augDur, el: 'aug' })
              xCursor += augElW
            }
            // 音符实际占位宽（不含括号）：音符块段（含附点三段留空）+ 增时线
            const actualW = xCursor - curX
            const rightX = xCursor // 音符实际占位右端
            // &hx（滑音箭头）无时值元素：依附其前的带时值元素之后，本体宽占位
            if (n.hasHx) xCursor += hxBodyW(m.noteSize)
            // 段左缘 blockX；数字左缘右移 变音角标(accW)+前倚音(leftExt)，给角标/倚音腾位
            placeNoteSpace(n.t, segments, blockX + n.accW + n.leftExt, actualW, rightX, n.slotPos, n.beatPos, b)
            curX = xCursor
          } else if (tok.kind === 'bracket') {
            // adj294：&zkh/&ykh 独立括号标记——占宽、按源码序列序插位、不影响音符
            const bw = bracketBodyW()
            page.brackets.push({
              dir: tok.dir,
              x: r1(curX + bw / 2),
              yTop: r1(yTop + m.noteSize * 0.7),
              width: r1(bw),
              voice,
              group: groupIndex,
            })
            curX += bw
          }
        }
      }
      // 该 seg 末尾小节线（非时值元素）
      if (seg.bar && barList[barCursor] && barList[barCursor].bar === seg.bar) {
        const bk = barList[barCursor]
        // adj315：间距只朝向有音符的一侧——行首/行末背对音符那侧不设间距（贴边）。
        // 中间小节线左侧/右侧各 barlinePad；行首（左侧无音符）gapL=0；行末（atEnd）gapR=0。
        const gapL = segLastPb[b] === undefined ? 0 : barGapSide()
        const gapR = bk.atEnd ? 0 : barGapSide()
        // adj314：小节线占位用「线自身宽 + 两侧动态间距」，不再叠加 barlineSpace 固定 +8 空隙——
        // 否则一侧间距被撑到 ~8.5px，超过半个音符宽（4.03px）导致小节线间距过大。
        // 行首小节线（该侧无音符）：线左缘贴边（用线自身半宽）。
        const barHalf = segLastPb[b] === undefined ? barlineTotalW(bk.bar.type) / 2 : barlineTotalW(bk.bar.type) / 2
        // 行末小节线（atEnd）：右缘贴右边距，右侧不设间距；否则按左间距 + 中心推算
        let lineX = curX + gapL + barHalf
        if (bk.atEnd) lineX = page.width - config.margin_right - barlineTotalW(bk.bar.type) / 2
        const bid: LayoutId = { page: pageIndex, voice, group: groupIndex, index: barCounter }
        page.barlines.push({
          id: bid,
          type: bk.bar.type,
          marks: bk.bar.marks,
          voltaStart: bk.bar.voltaStart,
          voltaEnd: bk.bar.voltaEnd,
          voltaEndSlash: bk.bar.voltaEndSlash,
          voltaOnly: bk.bar.voltaOnly,
          comment: bk.bar.comment,
          x: r1(lineX),
          yTop: yTopBar,
          yBottom: yBottomBar,
          width: r1(m.barlineWidth),
        })
        barCounter++
        curX += gapL + barlineTotalW(bk.bar.type) + gapR
        barCursor++
      }
    }
  }

  /** 处理一个单声部组 */
  const placeGroup = (groupIndex: number, voice: number, tokens: MusicToken[], lyrics: LyricLine[]) => {
    const segs = splitBars(tokens)
    // adj288：空间优先用「本体宽」判据断行，避免时长优先拍级 need 高估导致过早换行
    const rows = config.noteSpaceLayout === 'space' ? breakRowsSpace(segs, availW, m.noteSize) : breakRows(segs, availW, m.noteSize)
    const geciSize = config.geci_size
    const lyricMaps = buildLyricMaps(lyrics)

    // 预计算每行起始槽位
    const rowSlots: number[] = []
    let acc = 0
    const isNoteLike = (t: MusicToken) => t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
    for (const row of rows) {
      rowSlots.push(acc)
      if (row.kind === 'bars') {
        for (let b = row.start; b < row.end; b++) {
          acc += segs[b].notes.filter(isNoteLike).length
        }
      } else {
        acc += segs[row.segIdx].notes.slice(row.noteStart, row.noteEnd).filter(isNoteLike).length
      }
    }

    // adj199：参考每拍宽（前面曲部行的平均每拍宽，供未撑满行按小节线对齐）
    let refPerBeat: number | undefined
    rows.forEach((row, ri) => {
      const sp = spacingFor(config, pageIndex)
      const rowH = lineHeightOf(config, m, sp, lyrics.length)
      // adj73：分页判定改为「放置前」且用完整行高——行不越界；
      // 首页/换页后首行 y 必小于 limit 不会误换；放不下时换页到新页放置（不再产生空页）
      if (y + rowH > bottomLimit) {
        pageIndex = pages.length
        startPage()
        y = m.bodyTopH // 后续页不占描述头区域
      }
      // adj284：空间优先（无括号 bars 行）走 placeMusicRowSpace；否则走时值优先。
      // 含 &zkh/&ykh 括号的行先行版回退时值优先（括号的空间优先占位后续再补）
      // adj286：空间优先已支持 &zkh/&ykh 括号占位，不再因括号回退时值优先
      const isSpace = config.noteSpaceLayout === 'space' && row.kind === 'bars'
      const pb = isSpace
        ? placeMusicRowSpace(segs, row, groupIndex, voice, y, lyricMaps, geciSize, sp, rowSlots[ri])
        : placeMusicRow(segs, row, groupIndex, voice, y, lyricMaps, geciSize, sp, rowSlots[ri], refPerBeat)
      if (!isSpace && row.kind === 'bars' && pb !== undefined) refPerBeat = pb
      y += rowH
    })
  }

  /** 多声部块：各声部按小节对齐纵向堆叠（块内小节等宽 + 时值等宽） */
  const placeVoiceBlock = (unit: Unit) => {
    const geciSize = config.geci_size
    const sp = spacingFor(config, pageIndex)
    // adj275：多声部括号占位（括号/注释在页面有效范围、音符内容区右移）；每组占位在 parts 后按注释长度独立计算
    const parts = unit.groups.map(({ groupIndex, group }) => ({
      groupIndex,
      voice: group.music.voice,
      name: group.music.voiceName,
      segs: splitBars(group.music.tokens),
      lyricMaps: buildLyricMaps(group.lyrics),
      lyricRows: group.lyrics.length,
    }))
    // adj276：每组占位独立计算（按本组最长注释宽；无注释小、有注释大），括号与其曲/词部紧凑、不与上一组对齐
    const maxNameLen = parts.reduce((mx, p) => Math.max(mx, p.name ? p.name.length : 0), 0)
    const labelPad = maxNameLen * m.noteSize * 0.72
    const blockPad = labelPad + 14
    const blockStartX = config.margin_left + blockPad
    const blockAvailW = availW - blockPad
    const numBars = Math.max(...parts.map((p) => p.segs.length))
    // 块内每拍宽 = 块可用宽 / 块总拍数（每小节取各声部最大拍数，adj15）
    let blockBeats = 0
    const barBeats: number[] = []
    for (let b = 0; b < numBars; b++) {
      let m = 0
      for (const p of parts) {
        const s = p.segs[b]
        if (s) m = Math.max(m, segBeats(s))
      }
      // adj250：块内每小节取整数拍（向上取整）——保证块内拍索引整数、各声部小节对齐
      const mb = Math.ceil(m)
      barBeats.push(mb)
      blockBeats += mb
    }
    // 块级每小节间隔空间：统一所有声部（取该小节线上类型；|/ 不占位），保证纵向对齐
    const gapSpaces: number[] = []
    for (let b = 0; b < numBars - 1; b++) {
      gapSpaces.push(barlinePad(m.noteSize))
    }
    const pads = BAR_PAD * 2 + gapSpaces.reduce((a, s) => a + s, 0)
    // adj250：多声部块改用拍级每拍宽（allocatePerBeats，与单声部 bars 行一致）——
    // 小节线按切分后的拍子位置排列（不是对行宽平均分割）；>3 小节两端分散对齐（撑满）
    // 各小节块内起始拍（整数，barBeats 已向上取整）
    const barStartBeat: number[] = []
    {
      let acc = 0
      for (let b = 0; b < numBars; b++) {
        barStartBeat.push(acc)
        acc += barBeats[b]
      }
    }
    // 块内总拍 = Σ 每小节整数拍（barBeats 已向上取整）
    const totalBeats = blockBeats
    // adj314：多声部块支持空间优先布局（与单声部 placeMusicRowSpace 同款模型，
    // 但以「小节」为对齐单元——小节线严格对齐 + 小节内各拍对齐）：
    // 每声部每小节本体宽 → 小节基准本体宽 = max(各声部) → 按基准本体宽占比分摊空白。
    // 此时值优先路径仍保留（noteSpaceLayout !== 'space' 时走原切分法则）。
    const useSpace = config.noteSpaceLayout === 'space'
    // adj316：多声部空间优先——拉伸空白 s_b 均分到「小节头 + 各拍后」，使上/下音符与小节线
    // 间距相对平均（用户要求，替代把 W 摊进每拍段宽导致小节线侧右）。仅 space 路径填充。
    const mspS: number[] = []
    const mspBarRelW: number[] = []
    const mspSegX: number[] = new Array(totalBeats).fill(0)
    const perBeats: number[] = useSpace ? (() => {
      // ---- ① 每声部每小节带时值元素本体宽之和 ----
      const bodyW: number[][] = parts.map((p) => {
        const arr: number[] = []
        for (let b = 0; b < numBars; b++) {
          const seg = p.segs[b] ?? { notes: [], bar: null }
          let sum = 0
          for (const t of seg.notes) {
            if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
              const s = splitNoteDur(t)
              const accW = t.kind === 'note' && t.accidental ? accidentalBodyW(m.noteSize) : 0
              const grW = t.kind === 'note' ? graceExtraW(t, m.noteSize) : 0
              const bodyW0 = noteBodyW(m.noteSize, grW) + accW
              sum += bodyW0 + (t.dots > 0 ? dotBodyW(m.noteSize) : 0) + s.augCount * augBodyW(m.noteSize)
            }
            // 独立括号标记 / &hx 滑音箭头为非时值元素——不计入本体宽，由 nonDurPad 占位
          }
          arr.push(sum)
        }
        return arr
      })
      // ---- ② 小节基准本体宽 = max(各声部该小节本体宽) ----
      const baseW: number[] = new Array(numBars).fill(0)
      for (let b = 0; b < numBars; b++) {
        for (const a of bodyW) baseW[b] = Math.max(baseW[b], a[b] ?? 0)
      }
      // const durBodySum = baseW.reduce((a, b) => a + b, 0) // adj317b 改用 baseBarSum（拍级 ΣbeatBodyW），不再需要此基线口径
      // ---- ③ 非时值元素占位：pads（内容边界 + 块级共享小节间距）+ 括号 + &hx 滑音箭头 ----
      let nonDurPad = pads
      for (let b = 0; b < numBars; b++) {
        for (const p of parts) {
          const seg = p.segs[b] ?? { notes: [], bar: null }
          for (const t of seg.notes) {
            if (t.kind === 'bracket') nonDurPad += bracketBodyW()
            if (t.kind === 'note' && t.symbols.includes('hx')) nonDurPad += hxBodyW(m.noteSize)
          }
        }
      }
      // ---- ③b 每小节每拍最大本体占宽（含非时值占位），跨声部取最大——供小节内拍级不等宽分配 ----
      const beatBodyW: number[][] = []
      for (let b = 0; b < numBars; b++) {
        const bb = barBeats[b]
        const perBeatMax: number[] = new Array(bb).fill(0)
        for (const p of parts) {
          const seg = p.segs[b] ?? { notes: [], bar: null }
          const voiceBeats: number[] = new Array(bb).fill(0)
          let beatAcc = 0
          for (const t of seg.notes) {
            if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
              const s = splitNoteDur(t)
              const accW = t.kind === 'note' && t.accidental ? accidentalBodyW(m.noteSize) : 0
              const grW = t.kind === 'note' ? graceExtraW(t, m.noteSize) : 0
              const bodyW0 = noteBodyW(m.noteSize, grW) + accW + (t.dots > 0 ? dotBodyW(m.noteSize) : 0) + s.augCount * augBodyW(m.noteSize)
              const dur = tokenDuration(t)
              // 音符本体宽均分到它覆盖的拍（跨拍增时线/附点按拍均分）
              const startBeat = Math.floor(beatAcc + 1e-9)
              // adj316：拍区间半开 [startBeat, endBeat)，endBeat 用 ceil（跨拍/半拍正确），
              // 原 `k <= endBeat`（floor）对整拍音符双计宽（本体宽 2 倍 → 段宽远超本体 → 小节线侧右）。
              const endBeat = Math.min(bb, Math.ceil(beatAcc + dur - 1e-9))
              const nSpan = Math.max(1, endBeat - startBeat)
              const perPiece = bodyW0 / nSpan
              for (let k = startBeat; k < endBeat && k < bb; k++) voiceBeats[k] += perPiece
              beatAcc += dur
            } else {
              // 非时值元素（&zkh/&ykh 括号）计入当前拍
              const bIdx = Math.min(bb - 1, Math.floor(beatAcc + 1e-9))
              if (t.kind === 'bracket') voiceBeats[bIdx] += bracketBodyW()
            }
          }
          // 跨声部取最大：同一拍纵向堆叠、同一 x，取最宽声部
          for (let k = 0; k < bb; k++) perBeatMax[k] = Math.max(perBeatMax[k], voiceBeats[k])
        }
        beatBodyW.push(perBeatMax)
      }
      // ---- ⑥ adj317：拍宽 = 该拍最大本体占宽；拉伸空白 s 均分到「(总拍数+numBars-1) 个槽位」——
      // 每小节 (拍数+1) 个槽位中：首小节「节头」= 0（行首贴左）；其余 (tb+numBars-1) 个
      // 槽位均分 s。末小节末拍后填 s → 末音符右缘对齐内容右界（行尾对齐）；中间小节节头 +
      // 各拍后 = s（小节线两侧间距对称）。
      const outPerBeat: number[] = []
      let baseBarSum = 0
      for (let b = 0; b < numBars; b++) {
        baseBarSum += (beatBodyW[b] ?? []).reduce((a, s) => a + s, 0) + (barBeats[b] > 0 ? (barBeats[b] - 1) * NOTE_GAP : 0)
      }
      const totalSlots = totalBeats + numBars - 1
      // adj317c：末节线钳制到 rightLimit - halfW（与单声部 atEnd 行末线一致），avStretch 反推 ΣbarBar
      // lineX0末 = blockStartX + ΣbarBar + ΣgapSpaces(前) + BAR（末小节后无 gapSpaces，不加 gap/2），
      // 令 lineX0末 = pageW - margin_right - halfW → ΣbarBar = (pageW - margin_right - halfW) - blockStartX - ΣgapSpaces - BAR
      // adj318：行小节数 < align_min_bars（与单声部 stretch 同步）→ 自然宽，不撑满、不钳制末线
      // （s=0，avStretch=0，ΣbarBar=baseBarSum，lineX末 自然值 ≤ 钳制上界）
      const stretchBars = numBars >= config.align_min_bars
      const sumGapSpaces = gapSpaces.reduce((a, s) => a + s, 0)
      const halfBarW = barlineTotalW('|') / 2
      const targetEndBarX = pages[pageIndex].width - config.margin_right - halfBarW
      const targetBarSum = stretchBars ? Math.max(0, targetEndBarX - blockStartX - sumGapSpaces - BAR_PAD) : 0
      const avStretch = stretchBars ? Math.max(0, targetBarSum - baseBarSum) : 0
      const s = totalSlots > 0 ? avStretch / totalSlots : 0
      for (let b = 0; b < numBars; b++) {
        const bb = barBeats[b]
        const start = barStartBeat[b]
        mspS[b] = s
        // 首小节节头 = 0（行首贴左）；中间小节节头 = s（小节线对称）
        let rel = b === 0 ? 0 : s
        for (let k = 0; k < bb; k++) {
          const idx = start + k
          const wb = beatBodyW[b][k] > 0 ? beatBodyW[b][k] : BPW_NATURAL
          outPerBeat[idx] = wb
          mspSegX[idx] = rel
          rel += wb + NOTE_GAP + s
        }
        // 末拍后净间隙 = s（去 NOTE_GAP）—— 末小节末拍后 s 撑到内容右界
        rel -= NOTE_GAP
        mspBarRelW[b] = rel
      }
      while (outPerBeat.length < totalBeats) outPerBeat.push(BPW_NATURAL)
      return outPerBeat
    })() : (() => {
      // —— 时值优先（原切分法则）—— adj251：每拍最小宽 + 纵向取最大 + 剩余均分
      const availBeats = blockAvailW - pads - noteGapOf(totalBeats)
      const beatBaseW: number[] = []
      for (let b = 0; b < numBars; b++) {
        for (const p of parts) {
          const seg = p.segs[b] ?? { notes: [], bar: null }
          let barBeatAcc = 0
          for (const t of seg.notes) {
            if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
              const dur = tokenDuration(t)
              let pos = barBeatAcc
              let rem = dur
              const extra = t.kind === 'note' ? noteExtraW(t, m.noteSize) : 0
              while (rem > 1e-9) {
                const nearInt = Math.abs(pos - Math.round(pos)) < 1e-3
                const pp = nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)
                const piece = Math.min(rem, (nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)) + 1 - pos)
                const bb = barStartBeat[b] + pp
                const need = Math.max(BPW_NATURAL, minNoteW(m.noteSize, extra) / piece)
                beatBaseW[bb] = Math.max(beatBaseW[bb] ?? 0, need)
                pos += piece
                rem -= piece
              }
              barBeatAcc += dur
            }
          }
        }
      }
      while (beatBaseW.length < totalBeats) beatBaseW.push(BPW_NATURAL)
      const sumBase = beatBaseW.reduce((a, b) => a + b, 0)
      return beatBaseW.map((bw) => (sumBase < availBeats ? bw + (availBeats - sumBase) / totalBeats : bw))
    })()
    // 块内每拍段起点（相对内容左端 margin_left + BAR_PAD；每拍宽 + 拍间距累计）。
    // 循环到 totalBeats（含）——beatStartX[totalBeats] 为末小节右端，供小节线取整
    const beatStartX: number[] = []
    {
      let acc = 0
      for (let bi = 0; bi <= totalBeats; bi++) {
        beatStartX[bi] = acc
        acc += (perBeats[bi] ?? 0) + NOTE_GAP
      }
    }

    const voiceHeights = parts.map((p) => lineHeightOf(config, m, sp, p.lyricRows))
    // adj72：多声部块内声部行之间额外间距 height_shengbu（独立于行距 ciqu，可单独调整）
    const blockH = voiceHeights.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * sp.shengbu

    if (y + blockH > bottomLimit) {
      pageIndex = pages.length
      startPage()
      y = m.bodyTopH // 后续页不占描述头区域
    }

    const blockY = y
    let voiceY = blockY
    const blockVoices: VoiceBlock['voices'] = []
    const voiceYTop: number[] = []

    for (let vi = 0; vi < parts.length; vi++) {
      const p = parts[vi]
      blockVoices.push({ voice: p.voice, name: p.name })
      voiceYTop.push(voiceY)
      let x = blockStartX
      let slotIndex = 0
      for (let b = 0; b < numBars; b++) {
        // adj248：beatAcc 必须是**小节内**拍位置（0 起），每小节重置——
        // 此前跨小节累计使 segments.x 漂移、音符 x 逐小节超出页面（多声部音符未全显示）
        let beatAcc = 0
        const seg = p.segs[b] ?? { notes: [], bar: null }
        const barStartB = barStartBeat[b]
        for (const t of seg.notes) {
          if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
            // adj320：段循环拆「主时值」段（去附点）——附点由 placeNoteAt 生成 dot 段。
            // 此前用 tokenDuration(t)（含附点）拆段 + placeNoteAt 又 push dot 段 → 附点双重计入
            // （segments.beats 总和 > 实际时值，色块跨拍时多出/乱序）。
            const sd = splitNoteDur(t)
            const dur = sd.noteDur * (1 + sd.augCount)
            // adj250：段 x 用拍级每拍宽累计（块内拍位），小节内拍位置从 0 起
            const segments: { x: number; perBeat: number; beats: number }[] = []
            {
              let pos = beatAcc
              let rem = dur
              while (rem > 1e-9) {
                const nearInt = Math.abs(pos - Math.round(pos)) < 1e-3
                const pp = nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)
                const blockBeat = barStartB + pp
                const perBeat = perBeats[blockBeat] ?? perBeats[totalBeats - 1]
                const piece = Math.min(rem, (nearInt ? Math.round(pos) : Math.floor(pos + 1e-9)) + 1 - pos)
                segments.push({
                  // 段 x = 拍起点累计 + 拍内浮点偏移（(pos-pp)*perBeat）——
                  // 否则同拍内的减时线音符（2/ 3/ 等）都被映射到拍起点、重叠
                  x: x + BAR_PAD + (useSpace ? (mspSegX[blockBeat] ?? 0) : ((beatStartX[blockBeat] ?? 0) - (beatStartX[barStartB] ?? 0))) + (pos - pp) * perBeat,
                  perBeat,
                  beats: piece,
                })
                pos += piece
                rem -= piece
              }
            }
            // adj226：id.group 用真实组索引（此前误传块内声部序号 vi——
            // 前面还有单声部行时组序号错位，预览↔编辑器光标联动全偏）
            // adj314：多声部空间优先——音符块本体在时值段内水平居中（参考单声部）
            let space: { noteBodyW: number; dotBodyW: number; accW: number; leftExt: number; hasDot: boolean; augW: number; hxW: number } | undefined
            if (useSpace) {
              const accW = t.kind === 'note' && t.accidental ? accidentalBodyW(m.noteSize) : 0
              const grW = t.kind === 'note' ? graceExtraW(t, m.noteSize) : 0
              const gn = t.kind === 'note' ? t.gracenotes : undefined
              const leftExt = gn && !gn.after ? grW : 0
              space = {
                noteBodyW: noteBodyW(m.noteSize, grW) + accW,
                dotBodyW: t.dots > 0 ? dotBodyW(m.noteSize) : 0,
                accW,
                leftExt,
                hasDot: t.dots > 0,
                // ★ adj319：增时线/hx 占宽累加进 noteRightX（与单声部 actualW 对齐）
                augW: t.kind === 'note' ? splitNoteDur(t).augCount * augBodyW(m.noteSize) : 0,
                hxW: t.kind === 'note' && t.symbols.includes('hx') ? hxBodyW(m.noteSize) : 0,
              }
            }
            const dur2 = placeNoteAt(t, segments, voiceY, pageIndex, p.groupIndex, p.voice, slotIndex, p.lyricMaps, geciSize, sp, beatAcc, b, space)
            beatAcc += dur2
            slotIndex++
          }
        }
        // 小节右端（下一小节起点）：本小节拍宽累计（去尾拍间距）+ 小节间距
        x += (useSpace ? (mspBarRelW[b] ?? 0) : ((beatStartX[barStartB + barBeats[b]] ?? 0) - (beatStartX[barStartB] ?? 0))) + (b < numBars - 1 ? gapSpaces[b] : 0)
      }
      voiceY += voiceHeights[vi] + (vi < parts.length - 1 ? sp.shengbu : 0)
    }

    // adj249：小节线改为**每个声部单独绘制**（参考单声部：高度 = 该声部音符行高），
    // 不再上下贯穿整个多声部块与词部；且只在该声部实际有小节线的位置画线（不多出）。
    // 各声部 x 统一（块级小节对齐），y 取该声部行高（复用单声部小节线高度公式）。
    const bs = noteScaleOf(m.noteSize)
    const barX: number[] = []
    let xBar = blockStartX
    for (let b = 0; b < numBars; b++) {
      let bt: Extract<MusicToken, { kind: 'barline' }> | null = null
      for (const p of parts) {
        const s = p.segs[b]
        if (s?.bar) {
          bt = s.bar
          break
        }
      }
      const halfW = barlineTotalW(bt?.type ?? '|') / 2
      // 小节线按拍子累计位置：小节内容右端 = 小节起点 + BAR_PAD + 小节拍宽累计（去尾拍间距）
      // + 前面拍间距累计 + 空间/2（与单声部 bars 行一致）
      // 小节宽度 = 拍宽累计（含拍间距）；小节线在小节内容右端 + 空间/2（与音符段 x 一致）
      const barWb = useSpace ? (mspBarRelW[b] ?? 0) : ((beatStartX[barStartBeat[b] + barBeats[b]] ?? 0) - (beatStartX[barStartBeat[b]] ?? 0))
      // adj315：与 xBar 推进用同一 gapSpaces（barlinePad），小节线 = 小节内容右端 + 半间距
      const barToNextGap = b < numBars - 1 ? gapSpaces[b] : 0
      const lineX0 = xBar + BAR_PAD + barWb + barToNextGap / 2
      barX[b] = r1(
        Math.min(
          Math.max(lineX0, config.margin_left + halfW),
          pages[pageIndex].width - config.margin_right - halfW,
        ),
      )
      xBar += barWb + (b < numBars - 1 ? (b < gapSpaces.length ? gapSpaces[b] : 0) : 0)
    }
    for (let vi = 0; vi < parts.length; vi++) {
      const p = parts[vi]
      const vTop = voiceYTop[vi]
      const barNoteY = vTop + m.noteSize * 1.1
      const yTopBar = r1(barNoteY - 18.4 * bs)
      const yBottomBar = r1(barNoteY + 4.5 * bs)
      for (let b = 0; b < numBars; b++) {
        const seg = p.segs[b]
        if (!seg?.bar) continue
        if (b === 0 && seg.notes.length === 0 && seg.bar.type === '|') continue
        const bid: LayoutId = { page: pageIndex, voice: p.voice, group: p.groupIndex, index: barCounter }
        pages[pageIndex].barlines.push({
          id: bid,
          type: seg.bar.type,
          marks: seg.bar.marks, // adj206
          voltaStart: seg.bar.voltaStart,
          voltaEnd: seg.bar.voltaEnd,
          voltaEndSlash: seg.bar.voltaEndSlash,
          voltaOnly: seg.bar.voltaOnly,
          comment: seg.bar.comment,
          x: barX[b],
          yTop: yTopBar,
          yBottom: yBottomBar,
          width: m.barlineWidth,
        })
        barCounter++
      }
    }

    pages[pageIndex].voiceBlocks.push({
      // adj275：括号在有效范围（margin_left 右侧）、顺延内推；adj276：按本组注释宽（labelPad）独立计算
      x: r1(config.margin_left + labelPad + 2),
      yTop: blockY,
      // adj271：yBottom = 最后声部曲部底。声部循环用 voiceHeights（含词行高）推进，
      // 第 2+ 声部位于词部下方；用纯曲 pureH 会偏上、括号没延伸到最后一曲部，
      // 故用 voiceYTop[last]（含词推进到的最后声部曲顶）+ 曲部高 noteSize*1.7
      yBottom: voiceYTop[parts.length - 1] + m.noteSize * 1.7,
      voices: blockVoices,
      // adj280：每声部曲部中心（音符数字垂直中心 = 曲顶 + 0.85×noteSize），注释与曲部垂直居中
      voiceCenters: voiceYTop.map((yt) => r1(yt + m.noteSize * 0.85)),
    })

    y = blockY + blockH
  }

  // ---- 构建排版单元序列（含分页标记） ----
  const events: ({ kind: 'unit'; unit: Unit } | { kind: 'pagebreak' })[] = []
  let cur: UnitGroup[] = []
  let curVoices = new Set<number>()
  const flush = () => {
    if (cur.length > 0) {
      events.push({ kind: 'unit', unit: { groups: cur, multi: curVoices.size > 1 } })
      cur = []
      curVoices = new Set()
    }
  }
  for (const line of result.lines) {
    if (line.kind === 'pagebreak') {
      flush()
      events.push({ kind: 'pagebreak' })
      continue
    }
    if (line.kind !== 'music') continue
    const groupIndex = result.groups.findIndex((g) => g.music === line)
    if (groupIndex === -1) continue
    const group = result.groups[groupIndex]
    const v = group.music.voice
    if (cur.length > 0 && curVoices.has(v)) flush()
    cur.push({ groupIndex, group })
    curVoices.add(v)
  }
  flush()

  // ---- 按事件序列排版 ----
  for (const ev of events) {
    if (ev.kind === 'pagebreak') {
      pageIndex = pages.length
      startPage()
      y = m.bodyTopH // 后续页不占描述头区域
      continue
    }
    const { unit } = ev
    if (unit.multi) {
      placeVoiceBlock(unit)
    } else {
      for (const { groupIndex, group } of unit.groups) {
        placeGroup(groupIndex, group.music.voice, group.music.tokens, group.lyrics)
      }
    }
  }

  // ---- 连音线后处理（M7c）----
  const notesByIndex = new Map<number, PlacedToken>()
  for (const p of pages) for (const n of p.notes) notesByIndex.set(n.id.index, n)

  const slurPairs: { start: number; end: number; depth: number; tuplet: boolean; plus: number; minus: number }[] = []
  // 配对规则：先进后出（LIFO 栈式，adj55）—— 最近打开的先闭合，标准括号嵌套；
  // 栈跨行保留：上一行未闭合的括号延续到下一行配对（跨行两半）
  const sQueue: { start: number; depth: number; tuplet: boolean; plus: number; minus: number }[] = []
  let gNote = 0
  let lastNote = -1
  // adj54：每个音符索引对应的「音符单位数」——基础 1，增时线每根折算 +1、
  // 附点按 (1+0.5×附点数) 乘算（如 1- =2、1. =1.5、1-. =3），供自动样式判断连音线长度
  const noteUnits: number[] = []
  for (const line of result.lines) {
    if (line.kind !== 'music') continue
    const group = result.groups.find((g) => g.music === line)
    if (!group) continue
    for (const t of group.music.tokens) {
      if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
        // 音符锚定栈中所有尚未设置起点的开括号（adj56：同起点嵌套 ——
        // 如 ((3 2/) 4)：内层与外层连音线都从 3 开始，不能只锚定队尾，
        // 否则外层括号 start 保持 -1 被丢弃）
        for (const s of sQueue) {
          if (s.start === -1) s.start = gNote
        }
        lastNote = gNote
        // adj54：记录单位数（休止符/节奏符同样按增时线/附点折算）
        noteUnits.push((1 + t.augmentCount) * (1 + 0.5 * t.dots))
        gNote++
      } else if (t.kind === 'slur') {
        if (t.dir === 'open') {
          sQueue.push({ start: -1, depth: sQueue.length, tuplet: t.tuplet === true, plus: t.plus ?? 0, minus: t.minus ?? 0 })
        } else {
          // adj55：先进后出 —— pop 最近打开的开括号；栈跨行保留（未闭合延续到后续行）
          const s = sQueue.pop()
          // 退化对（起点=终点，如 "(2)"）也记录（adj137：供外层连音线分割），但不渲染自身；
          // adj91：连音线嵌套最多两层（depth 0/1），第三层（如 (1 (2 (3 5))) 的 (3 5)）不渲染
          if (s && s.start !== -1 && lastNote >= s.start && s.depth < 2) {
            slurPairs.push({ start: s.start, end: lastNote, depth: s.depth, tuplet: s.tuplet, plus: s.plus, minus: s.minus })
          }
        }
      }
    }
  }

  /** 连音线样式：0 自动（2-4 音符单位弧线、>4 平顶，adj54 增时线/附点折算）| 1 圆弧 | 2 平顶 */
  const slurStyleOf = (unitCount: number): 'arc' | 'flat' => {
    if (config.lianyinxian_type === 1) return 'arc'
    if (config.lianyinxian_type === 2) return 'flat'
    return unitCount <= 4 ? 'arc' : 'flat'
  }

  // 可视行分组（页内 y 相同 → 同一行；跨页按放置顺序编号），供跨行连音符判定
  const rows: { page: number; y: number; notes: PlacedToken[] }[] = []
  const rowOfNote = new Map<number, number>()
  for (const p of pages) {
    const byY = new Map<number, PlacedToken[]>()
    for (const n of p.notes) {
      const arr = byY.get(n.y)
      if (arr) arr.push(n)
      else byY.set(n.y, [n])
    }
    const ys = [...byY.keys()].sort((p1, p2) => p1 - p2)
    for (const y of ys) {
      const notes = byY.get(y)!.slice().sort((m, n) => m.x - n.x)
      const rowIdx = rows.length
      rows.push({ page: p.index, y, notes })
      for (const n of notes) rowOfNote.set(n.id.index, rowIdx)
    }
  }

  // 有效对（含跨行对）；同时统计每行最大嵌套深度 → 外层在上、内层向下错开
  interface SlurInfo {
    sp: (typeof slurPairs)[number]
    a: PlacedToken
    b: PlacedToken
    rowA: number
    rowB: number
    /** 渲染段（adj137：外层连音线被内层括号对分割，如 (1 (2) 3) → [1,2] 与 [2,3]） */
    segs: [number, number][]
  }
  /** 计算连音线渲染段：被范围内退化内层对（单音符，如 (1 (2) 3) 的 (2)）分割 */
  const segsOf = (sp: (typeof slurPairs)[number]): [number, number][] => {
    if (sp.start === sp.end) return [] // 退化对自身不渲染
    // adj137：仅退化内层对（p.start === p.end，范围在外部内部）打断外层；
    // 普通嵌套（内层多音符）保持整条（既有行为）
    const inner = slurPairs
      .filter((p) => p.depth > sp.depth && p.start === p.end && p.start > sp.start && p.end < sp.end)
      .sort((a, b) => a.start - b.start)
    if (inner.length === 0) return [[sp.start, sp.end]]
    const segs: [number, number][] = []
    let cur = sp.start
    for (const p of inner) {
      if (p.start < cur) continue
      if (p.start > cur) segs.push([cur, p.start])
      cur = Math.max(cur, p.end)
      if (cur >= sp.end) break
    }
    if (cur < sp.end) segs.push([cur, sp.end])
    return segs.length > 0 ? segs : [[sp.start, sp.end]]
  }
  const slurInfos: SlurInfo[] = []
  for (const sp of slurPairs) {
    // adj137：同行外层才被退化内层打断；跨行外层保持整段（LIFO 跨行两半行为不变）
    const aAll = notesByIndex.get(sp.start)
    const bAll = notesByIndex.get(sp.end)
    const rowAllA = aAll ? rowOfNote.get(sp.start) : undefined
    const rowAllB = bAll ? rowOfNote.get(sp.end) : undefined
    const segs =
      rowAllA !== undefined && rowAllA === rowAllB && sp.start !== sp.end ? segsOf(sp) : sp.start === sp.end ? [] : [[sp.start, sp.end]]
    if (segs.length === 0) continue // 退化对不渲染
    for (const [s0, s1] of segs) {
      const a = notesByIndex.get(s0)
      const b = notesByIndex.get(s1)
      const rowA = a ? rowOfNote.get(s0) : undefined
      const rowB = b ? rowOfNote.get(s1) : undefined
      if (!a || !b || rowA === undefined || rowB === undefined) continue
      slurInfos.push({ sp, a, b, rowA, rowB, segs: [[s0, s1]] })
    }
  }
  // adj44：每对连音符的嵌套抬升 = 与其音符范围重叠的所有连音符的最大深度差 ×2
  // （多层嵌套每层抬 2px（adj95，原 7px 过疏）；独立连音符（无更深的连音符与之重叠）抬升 0，
  //  避免同排其他嵌套把它抬高——间距保持紧凑不虚大）
  // adj137：重叠判定用严格包含（相邻段如 [1,2] 与 [2,3] 端点相接不算重叠，保持等高）
  const nestedRaise: number[] = slurInfos.map((info) => {
    let maxOverlap = info.sp.depth
    for (const other of slurInfos) {
      if (other === info) continue
      const o = other.sp
      // 音符范围重叠（含跨行对）且深度更深 → 视为嵌套/包含关系
      if (o.depth > info.sp.depth && o.start < info.sp.end && info.sp.start < o.end) {
        maxOverlap = Math.max(maxOverlap, o.depth)
      }
    }
    return (maxOverlap - info.sp.depth) * 2
  })

  const highOf = (n: PlacedToken) =>
    n.token.kind === 'note' && n.token.octaveShift > 0 ? n.token.octaveShift : 0
  /**
   * 连音符覆盖范围内所有音符的最大高音点数（adj44：线需避开其下全部音符的
   * 高八度点，而不只端点；否则中间音符的高音点会与线交叉）。
   */
  const maxHiInRange = (fromIdx: number, toIdx: number): number => {
    let m = 0
    for (let i = fromIdx; i <= toIdx; i++) {
      const n = notesByIndex.get(i)
      if (n) m = Math.max(m, highOf(n))
    }
    return m
  }
  /**
   * 连音符覆盖范围内所有音符的最大上方修饰符层数（adj132：波音/颤音/顿音等
   * & 修饰符画在数字上方，连音线需在其上；括号 zkh/ykh 与右侧的 hx 不占上方层）。
   */
  const maxSymInRange = (fromIdx: number, toIdx: number): number => {
    let m = 0
    for (let i = fromIdx; i <= toIdx; i++) {
      const n = notesByIndex.get(i)
      if (n && n.token.kind === 'note') {
        // adj294：括号 zkh/ykh 已独立为 bracket token（不入修饰符层），hx 在右侧不占上方层
        const cnt = n.token.symbols.filter((s) => s !== 'hx').length
        m = Math.max(m, cnt)
      }
    }
    return m
  }
  /**
   * 该行连音线基准 y（adj60 层级化）：线底距「数字顶（无高八度）或最高高八度点顶（有）」LAYER_GAP=2；
   * 线为 stroke（中心 y，宽 SLUR_W）→ 中心 = 元素顶 - LAYER_GAP - SLUR_W/2。
   * 高八度点层顶 = 基线 - 0.8×noteSize - LAYER_GAP - 2r - (hi-1)×INNER_GAP（octaveTopY）。
   * adj132：再上移 修饰符层数 ×（符号高 + 层距）；adj135：取消倚音自动避让
   * （影响所有连音线），改用 (+ 手动抬升。
   * 嵌套错开：外层线上移 raise（仅当确实包含内层线时，adj44）。
   */
  const slurYFor = (note: PlacedToken, hi: number, symCount: number, raise: number) => {
    const s = noteScaleOf(m.noteSize)
    const topY = hi > 0 ? octaveTopY(note.y, hi, m.noteSize) : note.y - m.noteSize * DIGIT_HEIGHT_RATIO
    let base = topY - LAYER_GAP * s - (SLUR_W * s) / 2
    // 每层修饰符：符号字号 10×s + 层距 LAYER_GAP×s（与 render 上方符号堆叠一致）
    base -= symCount * (10 * s + LAYER_GAP * s)
    return base - raise
  }
  /** 行内跳房子线最低 y + 2s（adj134：连音线不得高于跳房子线，避免与其重叠） */
  const voltaFloorY = (rowIdx: number): number | null => {
    const r = rows[rowIdx]
    const barY = r.y - 18.4 // 小节线上端 = 音符基线 - 18.4（adj50）
    let floor: number | null = null
    for (const b of pages[r.page].barlines) {
      if (Math.abs(b.yTop - barY) < 1 && b.voltaStart) {
        const vy = b.yTop - VOLTA_BAR_GAP - (b.voltaStart.plus ?? 0) * VOLTA_RAISE
        if (floor === null || vy < floor) floor = vy
      }
    }
    return floor === null ? null : floor + 2 * noteScaleOf(m.noteSize)
  }

  /** 行首小节线中心 x（跨行连音符右半部从行首小节线处开始，adj106）；
   *  仅取「位于行首音符左侧」的小节线（行首真有节线才从其开始），否则 null 用边距 */
  const rowStartBarX = (rowIdx: number): number | null => {
    const r = rows[rowIdx]
    // adj216：小节线上端偏移 18.4×s（随音符字号）——固定 18.4 在 note_size≠18 时失配
    const barY = r.y - 18.4 * noteScaleOf(m.noteSize)
    const firstNoteX = r.notes[0]?.x ?? Infinity
    let minX: number | null = null
    for (const b of pages[r.page].barlines) {
      if (Math.abs(b.yTop - barY) < 1 && b.x < firstNoteX && (minX === null || b.x < minX)) minX = b.x
    }
    return minX
  }

  /** 行末小节线 x（该行 x 最大的小节线；无则 null；adj199 自然宽行连音线左半终点） */
  const rowEndBarX = (rowIdx: number): number | null => {
    const r = rows[rowIdx]
    // adj216：同 rowStartBarX，随音符字号缩放
    const barY = r.y - 18.4 * noteScaleOf(m.noteSize)
    let maxX: number | null = null
    for (const b of pages[r.page].barlines) {
      if (Math.abs(b.yTop - barY) < 1 && (maxX === null || b.x > maxX)) maxX = b.x
    }
    return maxX
  }

  for (let si = 0; si < slurInfos.length; si++) {
    const { sp, a, b, rowA, rowB } = slurInfos[si]
    const noteCount = sp.end - sp.start + 1 // 覆盖的 token 数（tupletCount 标签用，adj43）
    // adj54：自动样式按「音符单位数」判断（增时线/附点折算进长度），>4 单位用平顶
    let unitCount = 0
    for (let i = sp.start; i <= sp.end; i++) unitCount += noteUnits[i] ?? 1
    const baseStyle = slurStyleOf(unitCount)
    // adj106：嵌套时外层连音线一律平顶（nestedRaise>0 = 被更深线包含/包裹），
    // 平顶线层次清晰不与内层圆弧交叉，保证美观
    const style = nestedRaise[si] > 0 ? 'flat' : baseStyle
    // adj140：跨行连音线统一平顶（用户要求跨行显示平顶线，非弧线——
    // 弧线跨行两端行高差大、且不易延伸到行末小节线；嵌套外层同平顶）
    const crossRowStyle: 'arc' | 'flat' = 'flat'
    // adj108：连音线端点 = 数字槽中心 ± 1px×s（原固定 6.58/4.58，字号变化时端点错位）
    const sSlur = noteScaleOf(m.noteSize)
    const halfDig = halfDigitW(m.noteSize)
    // adj44 嵌套抬升 + adj135：(+ 抬升 / adj136：(- 下降（每级 2px，与跳房子类似）
    const raise = nestedRaise[si] + (sp.plus ?? 0) * VOLTA_RAISE - (sp.minus ?? 0) * VOLTA_RAISE
    if (rowA === rowB) {
      pages[a.id.page].slurs.push({
        // 起点=开始音符数字槽中心右 1px×s、终点=结束音符数字槽中心左 1px×s
        x1: r1(a.x + halfDig + sSlur),
        x2: r1(b.x + halfDig - sSlur),
        y: r1(
          Math.max(
            slurYFor(a, maxHiInRange(sp.start, sp.end), maxSymInRange(sp.start, sp.end), raise),
            voltaFloorY(rowA) ?? -Infinity,
          ),
        ),
        depth: sp.depth,
        style,
        // 仅平均连音组 (y...) 标数字（普通连音线 (…) 不加，adj43）
        tupletCount: sp.tuplet ? noteCount : undefined,
      })
    } else if (rowB === rowA + 1) {
      // 相邻行：上一行左半部（开始 → 行末小节线）、下一行右半部（边距 → 结束）；
      // 行首/行末均为连音符最高点；相隔多行视为误输入，不渲染
      const rA = rows[rowA]
      const lastA = rA.notes[rA.notes.length - 1]
      // adj143：撑满行左半横线延伸到**页面右边距**（原连到行末小节线，效果不理想）；
      // adj199：自然宽行（未撑满，≤3 小节/最后一行）左半到行末小节线即可，不延伸到右边距
      const rowAEndBar = rowEndBarX(rowA)
      const xEndA =
        rowAEndBar !== null && rowAEndBar < pages[rA.page].width - config.margin_right - 10
          ? rowAEndBar
          : pages[rA.page].width - config.margin_right
      // adj106：下一行始端 = 行首小节线（有则从其开始）否则从左边距开始
      const xStartB = rowStartBarX(rowB) ?? config.margin_left
      pages[rA.page].slurs.push({
        x1: r1(a.x + halfDig + sSlur),
        x2: r1(xEndA),
        y: r1(
          Math.max(
            slurYFor(a, maxHiInRange(sp.start, lastA.id.index), maxSymInRange(sp.start, lastA.id.index), raise),
            voltaFloorY(rowA) ?? -Infinity,
          ),
        ),
        depth: sp.depth,
        style: crossRowStyle,
        tupletCount: sp.tuplet ? noteCount : undefined,
        half: 'l', // 左半部：从最低处到行末最高点，右侧开口
      })
      const firstB = rows[rowB].notes[0]
      pages[rows[rowB].page].slurs.push({
        x1: r1(xStartB),
        x2: r1(b.x + halfDig - sSlur),
        y: r1(
          Math.max(
            slurYFor(b, maxHiInRange(firstB.id.index, sp.end), maxSymInRange(firstB.id.index, sp.end), raise),
            voltaFloorY(rowB) ?? -Infinity,
          ),
        ),
        depth: sp.depth,
        style: crossRowStyle,
        tupletCount: sp.tuplet ? noteCount : undefined,
        half: 'r', // 右半部：从行首最高点到最低处，左侧开口
      })
    }
  }

  // adj71：每行歌词按 x 排序后计算相邻最小间距（gapL），供渲染判断两侧是否密集会重叠
  for (const p of pages) {
    const byY = new Map<number, PlacedLyric[]>()
    for (const l of p.lyrics) {
      const arr = byY.get(l.y) ?? []
      arr.push(l)
      byY.set(l.y, arr)
    }
    for (const list of byY.values()) {
      list.sort((a, b) => a.x - b.x)
      list.forEach((l, i) => {
        const dPrev = i > 0 ? l.x - list[i - 1].x : Infinity
        const dNext = i < list.length - 1 ? list[i + 1].x - l.x : Infinity
        l.gapL = Math.min(dPrev, dNext)
      })
    }
  }

  // adj303：显示乐器名——@乐器名 / @@（切回默认）后第一个音符上方标注乐器名（仅在 showInstrument 开启时）
  if (config.showInstrument === true) {
    const defaultId = resolveInstrument(result.header.instruments?.[0])
    for (const group of result.groups) {
      // 该声部默认乐器（按 Y 顺序，无对应 Y 用全局默认）——@@ 恢复名用
      const gY = result.header.instruments?.[group.music.voice - 1]
      const voiceDefaultId = gY !== undefined ? resolveInstrument(gY) : defaultId
      let pending: string | null = null
      for (const tk of group.music.tokens) {
        if (tk.kind === 'instrument') {
          pending = tk.name != null ? tk.name : INSTRUMENT_LIB_NAMES[voiceDefaultId] ?? ''
        } else if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') {
          if (pending !== null) {
            for (const page of pages) {
              const placed = page.notes.find((n) => n.token === tk)
              if (placed) {
                placed.instrumentLabel = pending
                break
              }
            }
            pending = null
          }
        }
      }
    }
  }

  const configKey = JSON.stringify(config)
  return { pages, config, configKey }
}
