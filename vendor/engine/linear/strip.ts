/**
 * engine/linear/strip.ts — 多行谱 → 单行谱（方案 A：坐标重排），adj1258
 *
 * ## 做什么
 *
 * 拿**正常排版**的结果当"字形底稿"，按**演奏顺序**（`PlaySequence` 已展开反复/跳转）
 * 把每个源小节克隆出来，按时间横着排成一条线：
 *
 * ```
 * x(小节) = 累计宽度；小节内 x ∝ 时刻（每拍 W 像素）
 * ```
 *
 * ## 为什么不重排字形
 *
 * 数字、减时线、高低八度点、变音、倚音、歌词都是既有渲染画的；这里只做**仿射变换**
 * （平移 + 每小节一个横向量纲 k），字号与纵向层级一个字都不动 ——
 * 于是"A4 里什么样，条带上就什么样"，也天然满足"墨迹不重叠"那套规则。
 *
 * ## 反复/跳转怎么进来的
 *
 * 不在源码层展开（那是解析器的事），也不自己算反复——直接吃 `seq.barNos`
 * （逐遍记录、同一个源小节号会出现多次）：
 * 每出现一次就克隆一次，x 往后接。于是条带上**不存在**反复记号/跳房子/`&ds`/`&dc`/`&fine`。
 *
 * ## 行首小节线（用户 2026-11-08 点出的坑；adj1323 起已由解析期归一化）
 *
 * 解析期已把行首 barline 并到上一行末，行首默认是隐式隐藏小节线。
 * 拼接处优先用上一行的 `endType`（没有才退回本小节的 `leadType`）：
 * `||` / `||/` → `||`，反复/隐藏线 → `|`。
 *
 * ## 歌词（adj1267）
 *
 * 一个曲行下有多条 `C:` 行 = 多段词。条带**按这个源小节第几次被演奏**换行：
 * 第 1 次画第 1 行、第 2 次画第 2 行……（`StripRun.pass`）。只画这段主声部的词，
 * 第二声部的歌词行不参与换行（`C1:`/`C2:` 也占 `line` 序号，会串段）。
 */
import type {
  BarlineType,
  PageConfig,
  PlacedBarline,
  PlacedSlur,
  PlacedToken,
  ScoreLayout,
  ScorePage,
} from '../types'
import type { PlaySequence } from '../playback/sequence'
import { BAR_NUMBER_BOTTOM_GAP, barNumberBoxH } from '../layout/spacing'
import { digitSlotW } from '../layout/spaceLayout'
import { extractMeasures, type SrcMeasure } from './measures'
import type { LinearStrip, LinearStripOptions, StripNote, StripOnset, StripRun } from './types'

/** 一次演奏（一个小节的一条） */
interface Occurrence {
  no: number
  t0: number
  t1: number
  /** 这个源小节第几次被演奏（1 起）—— 多段歌词按它换行（`adj1267`） */
  pass: number
}

/**
 * 演奏顺序里的小节出现表。
 *
 * `barStartsMs` 末尾那条是**「曲末」时刻**（不是小节起点，见 `sequence.ts:3295`），
 * 且 `barNos` 只在小节起点记 ⇒ 取 `barNos.length` 为准，`t1` 用下一条起点/曲末。
 *
 * `pass` 的口径（`adj1267` 改）：**同一个小节号第几次出现**，不是"整首第几遍"。
 * 为什么不能用"整首第几遍"：反复只覆盖一小段时，后面的段落也处在第 2 遍里
 * （`… |: 5-8 :| 9-12` 里 9-12 的 pass 会是 2），那段明明只唱一次却会被换成第 2 段词。
 */
function occurrencesOf(seq: PlaySequence): Occurrence[] {
  const starts = seq.barStartsMs ?? []
  const nos = seq.barNos ?? starts.map((_, i) => i + 1)
  const out: Occurrence[] = []
  const seen = new Map<number, number>()
  for (let i = 0; i < nos.length; i++) {
    const t0 = starts[i] ?? 0
    const t1 = starts[i + 1] ?? seq.totalMs
    if (t1 - t0 < 0.5) continue
    const times = (seen.get(nos[i]) ?? 0) + 1
    seen.set(nos[i], times)
    out.push({ no: nos[i], t0, t1, pass: times })
  }
  return out
}

/** 源线条 → 条带上的线条（反复/跳房子一律降级；双线保留） */
export function stripBarlineTypeOf(type: BarlineType | undefined): BarlineType {
  if (type === '||' || type === '||/') return '||'
  // `|:` / `:|` / `:|:` / `|/` / `|*` / `|` 在单行谱里都只是"小节边界"
  return '|'
}

/** 主声部：一小节里最小的声部号（多声部块里 Q1 是主旋律） */
function mainVoiceOf(notes: PlacedToken[]): number {
  let v = Infinity
  for (const n of notes) v = Math.min(v, n.id.voice)
  return v === Infinity ? 1 : v
}

/** 取一小节里真正上条带的音符：只要主声部、且不是临时段层（`{bz}`/`{dsb}`/`{tp}`） */
function mainNotesOf(m: SrcMeasure): { notes: PlacedToken[]; skipped: number } {
  const v = mainVoiceOf(m.notes)
  const notes: PlacedToken[] = []
  let skipped = 0
  for (const n of m.notes) {
    if (n.segment !== undefined || n.id.voice !== v) {
      skipped += 1
      continue
    }
    notes.push(n)
  }
  return { notes, skipped }
}

/**
 * 每条曲行有几段歌词（`adj1267`）：只看**主声部**、`line > 0` 的那几行。
 *
 * 为什么按**行**统计而不是按小节：多段歌词里某一小节可能只有一个长音、第二段词在那儿没有新字，
 * 按小节算就会让那一小节退回第 1 段词（同一句歌前后两段混着出来）。
 * 为什么只认主声部：`C1:`/`C2:` 这类按声部写的歌词行也占 `line` 序号，
 * 拿它换行会把第二声部的词搬到主旋律下面（条带只画主声部）。
 */
function verseLinesOfRows(measures: SrcMeasure[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of measures) {
    const mainVoice = mainVoiceOf(m.notes)
    let max = 0
    for (const l of m.lyrics) {
      const line = l.line ?? 0
      if (line <= 0) continue
      if (l.id.voice !== mainVoice) continue
      max = Math.max(max, line)
    }
    if (max === 0) continue
    const key = rowKeyOf(m)
    out.set(key, Math.max(out.get(key) ?? 0, max))
  }
  return out
}

/** 曲行身份（页 + 行）：歌词行序号是**每个曲部**各自从 0 数的（`layout/index.ts:6377`） */
const rowKeyOf = (m: SrcMeasure): string => `${m.pageIndex}|${m.rowIndex}`

/** 一个 run（条带上的一段小节）的坐标换算：源小节坐标 → 条带坐标 */
interface RunMap {
  run: StripRun
  /** 源 x → 条带 x（每小节一个横向比例 k；反复段每遍各一套） */
  x: (v: number) => number
  /** 源 y → 条带 y（源行基线 → 条带基线） */
  y: (v: number) => number
}

function runMapOf(run: StripRun, m: SrcMeasure, baselineY: number): RunMap {
  const kx = (run.x1 - run.x0) / Math.max(0.5, m.x1 - m.x0)
  const dy = baselineY - m.baselineY
  return {
    run,
    x: (v) => Math.round((run.x0 + (v - m.x0) * kx) * 10) / 10,
    y: (v) => Math.round((v + dy) * 10) / 10,
  }
}

/** 一条连音线在**源页**上的两端（跨行的两条半线已经合成一条） */
interface SlurSpan {
  x1: number
  x2: number
  y1: number
  y2: number
  src: PlacedSlur
}

/**
 * 把一页的连音线整理成"两端对齐的整条线"。
 *
 * 为什么不直接用 `page.slurs`：跨行的线在 A4 里是**两条半条**
 * （`half:'l'` 收在行末、`half:'r'` 从行首起）。条带把各曲行拼成一条线，
 * 两条半条会首尾相接 —— 不合并就是"两个半圆接在一起、接口一个台阶"（用户 2026-11-09 点出）。
 * 配对口径：同一 group/voice、右半条在左半条的**后面一行**（`row`）。
 */
function slurSpansOfPage(p: ScorePage): SlurSpan[] {
  const usedL = new Set<number>()
  const usedR = new Set<number>()
  const out: SlurSpan[] = []
  for (let i = 0; i < p.slurs.length; i++) {
    const s = p.slurs[i]
    if (s.half !== 'l' || usedL.has(i)) continue
    for (let j = i + 1; j < p.slurs.length; j++) {
      const r = p.slurs[j]
      if (r.half !== 'r' || usedR.has(j)) continue
      if ((r.group ?? -1) !== (s.group ?? -1) || (r.voice ?? -1) !== (s.voice ?? -1)) continue
      if ((r.row ?? -1) <= (s.row ?? -1)) continue
      usedL.add(i)
      usedR.add(j)
      out.push({ x1: s.x1, y1: s.y, x2: r.x2, y2: r.y, src: s })
      break
    }
  }
  // 没配上的（本来就不跨行、或找不到另一半）：按自己的两端整条画
  for (let i = 0; i < p.slurs.length; i++) {
    if (usedL.has(i) || usedR.has(i)) continue
    const s = p.slurs[i]
    out.push({ x1: s.x1, y1: s.y, x2: s.x2, y2: s.y, src: s })
  }
  return out
}

/**
 * 克隆一个音符：x/占宽/拍段按 k 缩放、y 平移到条带基线。
 *
 * ⚠ `barIndex` **必须重编**（adj1263，看真图才发现的坑）：
 * 渲染端的 `computeBeams()` 按 `y|barIndex` 分组算减时线；条带把所有行压到**同一条基线**
 * （y 全一样）又原样继承了源小节的 `barIndex` ⇒ 一整行的小节被并成一组，
 * 减时线会从第 1 小节一路连到第 4 小节（实测出现过 1469px / 2912px 的横线）。
 * 条带上"一小节 = 一段 run"，所以每个 run 给一个唯一序号，减时线就只在本小节内连。
 */
function cloneNote(
  n: PlacedToken,
  x0: number,
  m: SrcMeasure,
  k: number,
  yShift: number,
  index: number,
  barIndex: number,
): PlacedToken {
  const mapX = (x: number): number => Math.round((x0 + (x - m.x0) * k) * 10) / 10
  const out: PlacedToken = {
    ...n,
    id: { ...n.id, index },
    x: mapX(n.x),
    y: Math.round((n.y + yShift) * 10) / 10,
    width: Math.round(n.width * k * 10) / 10,
    barIndex,
  }
  if (n.rightX !== undefined) out.rightX = mapX(n.rightX)
  if (n.inkLeftX !== undefined) out.inkLeftX = mapX(n.inkLeftX)
  if (n.inkRightX !== undefined) out.inkRightX = mapX(n.inkRightX)
  if (n.segments !== undefined) {
    out.segments = n.segments.map((s) => ({
      ...s,
      x: mapX(s.x),
      perBeat: Math.round(s.perBeat * k * 10) / 10,
    }))
  }
  return out
}

/**
 * adj1324：`barlineAnchor:'gap'`——把小节线放到「前一音最右墨迹」与「后一音最左墨迹」的中点。
 *
 * 用户口径：**倚音、滑音等修饰符的墨迹算在该音符里**。所以这里必须用
 * `inkRightX` / `inkLeftX`，不能用数字左缘/槽宽；否则小节线会从后倚音或 `&hx` 中间切过去。
 * 小节序号跟着最近的那根旧线走，保持挂在线正下方。
 */
function anchorBarlinesInGaps(page: ScorePage, noteSize: number): void {
  type InkItem = { x: number; left: number; right: number }
  const noteItems: InkItem[] = page.notes
    .filter((n) => n.token.kind !== 'rest')
    .map((n) => {
      const left = n.inkLeftX ?? n.x
      const hasTail = n.token.dots > 0 || n.token.augmentCount > 0
      const right = n.inkRightX ?? (hasTail ? n.x + n.width : n.x + Math.min(n.width, digitSlotW(noteSize)))
      return { x: n.x, left, right }
    })
  /**
   * 独立的 `&hx`（滑音）、`&zkh`/`&ykh` 括号也是“音符附近的墨迹”。
   * 不并进前后音的话，小节线仍可能落在滑音箭头上。
   */
  const bracketItems: InkItem[] = page.brackets.map((b) => ({
    x: b.x,
    left: b.x - b.width / 2,
    right: b.x + b.width / 2,
  }))
  const items = [...noteItems, ...bracketItems].sort((a, b) => a.x - b.x)

  const barPositions = page.barlines.map((line) => ({ line, oldX: line.x }))
  for (const line of page.barlines) {
    let prev: InkItem | null = null
    let next: InkItem | null = null
    for (const n of items) {
      if (n.x < line.x - 0.5) prev = n
      else {
        next = n
        break
      }
    }
    if (prev !== null && next !== null && next.left > prev.right) {
      line.x = Math.round(((prev.right + next.left) / 2) * 10) / 10
    }
  }
  for (const bn of page.barNumbers) {
    let best: { line: number; oldX: number; distance: number } | null = null
    for (const p of barPositions) {
      const distance = Math.abs(p.oldX - bn.x)
      if (best === null || distance < best.distance) best = { line: p.line.x, oldX: p.oldX, distance }
    }
    if (best !== null) bn.x = best.line
  }
}

/** 一条小节线（条带坐标） */
function barlineAt(x: number, yTop: number, yBottom: number, type: BarlineType): PlacedBarline {
  return {
    id: { page: 0, voice: 1, group: 1, index: 0 },
    type,
    x: Math.round(x * 10) / 10,
    yTop: Math.round(yTop * 10) / 10,
    yBottom: Math.round(yBottom * 10) / 10,
  } as PlacedBarline
}

/**
 * 建一条单行谱。
 *
 * @param layout 用**条带字号**排出来的版面（`note_size` 就是要显示的字号）
 * @param seq    整曲的播放序列（已展开反复/跳转）
 * @param cfg    与 layout 同一份页面配置
 */
export function buildLinearStrip(
  layout: ScoreLayout,
  seq: PlaySequence,
  cfg: PageConfig,
  opts: LinearStripOptions = {},
): LinearStrip {
  const noteSize = cfg.note_size
  /**
   * adj1268 → adj1274（用户 2026-11-09 改口）：小节号**与应用一样画在小节线下方**。
   * 所以这里不再需要"整条带往下让几像素"的顶部留白（那是为了画在上方才有的）。
   */
  const withBarNumbers = opts.barNumbers === true
  const barBoxH = barNumberBoxH(noteSize)
  const baselineY = opts.baselineY ?? Math.round(noteSize * 2.2)
  /** adj1274：曲/词行间距的额外量（用户拖虚线调；正 = 词往下） */
  const lyricGap = Number.isFinite(opts.lyricGap) ? Math.round(opts.lyricGap as number) : 0
  const withLyrics = opts.lyrics !== false
  const beatMs = seq.bpm > 0 ? 60000 / seq.bpm : 500
  const pxPerBeat = opts.pxPerBeat ?? Math.round(noteSize * 1.6)

  const measures = extractMeasures(layout, cfg)
  /**
   * `adj1285`（用户 2026-11-10「整道曲子只显示了 10 个小节，实际 62 小节」）：
   * **演奏序列的小节号 ≠ 排版里小节的序号**，不能再按"号相等"来配。
   *
   * 为什么：多声部谱（`Q1:`/`Q2:`/`Q3:`）里，引擎的小节号是**按各声部各自数**的
   * （实测 `scores-library/score-x57z`：序列号是 `1-8, 25-33, 52-60, 79-87`），
   * 而 `extractMeasures` 给的是阅读顺序 `1..35`。按号配 ⇒ 只有碰巧相等的几段配上，
   * 后半首**静默丢掉**（实测条带只覆盖全曲的 48.6%，用户看到的就是"只显示了几小节"）。
   *
   * 现在按**首次出现顺序**配：演奏顺序里第 k 个不同的源小节号 → 排版里第 k 个小节。
   *  · 反复：不同号只在第一次出现时入表 ⇒ 顺序仍是阅读顺序 ✓；
   *  · 空小节（没有音符、序列里也没有条目的）两边会**同时缺席** ⇒ 顺序仍然对齐 ✓；
   *  · `&ds` 跳回前面（号已出现过）不改变顺序 ✓。
   * 配不上的（排版里确实缺）计入 `dropped.missingBar`，由台面显示，不再静默。
   */
  const barOrder: number[] = []
  {
    const seenBar = new Set<number>()
    for (const no of seq.barNos ?? []) {
      if (seenBar.has(no)) continue
      seenBar.add(no)
      barOrder.push(no)
    }
  }
  const byNo = new Map<number, SrcMeasure>()
  for (let i = 0; i < barOrder.length; i++) {
    const m = measures[i]
    if (m !== undefined) byNo.set(barOrder[i], m)
  }
  /** 每条曲行有几段歌词（`adj1267`；没有多段就是 0） */
  const verseLines = verseLinesOfRows(measures)

  const occ = occurrencesOf(seq)
  const notes: StripNote[] = []
  const runs: StripRun[] = []
  const page: ScorePage = {
    index: 0,
    width: 1,
    height: 1,
    notes: [],
    lyrics: [],
    barlines: [],
    voiceBlocks: [],
    slurs: [],
    dynamics: [],
    brackets: [],
    barNumbers: [],
    meta: {
      titles: [],
      authors: [],
      key: null,
      meter: null,
      tempo: null,
      tempoNum: null,
      tempoText: null,
      instruments: [],
      notes: [],
    },
  }
  let cursor = 0
  let noteIdx = 0
  let droppedVoice = 0
  let droppedCross = 0
  /** adj1285：演奏序列里有、但排版里配不上的源小节（不再静默丢，见 `dropped.missingBar`） */
  let droppedMissing = 0
  /** 歌词最下沿（按"要不要画"都算一份，见循环里的说明） */
  let lyricBottom = 0

  for (let i = 0; i < occ.length; i++) {
    const o = occ[i]
    const m = byNo.get(o.no)
    if (m === undefined) {
      droppedMissing += 1
      continue
    }
    const { notes: src, skipped } = mainNotesOf(m)
    droppedVoice += skipped
    if (src.length === 0) continue

    const srcW = Math.max(0.5, m.x1 - m.x0)
    /**
     * adj1276（用户 2026-11-09）：**默认不再按时间拉伸小节**（`k = 1`）。
     *
     * 用户口径："音符的排列…直接参考应用的预览…不用再重新算各音符间距"。
     * 原来的 `k = max(1, 每拍像素 × 拍数 / 小节自然宽)` 会把音符间距按时间重算一遍：
     * 短小节被拉宽、密集小节保持原样 —— 看起来和预览不是同一张谱。
     * 现在条带 = 预览里那一行按演奏顺序接起来，x 只做平移。
     * （`timedStretch: true` 保留旧行为，供对照/以后需要"按拍等宽"时用。）
     */
    const k =
      opts.timedStretch === true ? Math.max(1, (((o.t1 - o.t0) / beatMs) * pxPerBeat) / srcW) : 1
    const yShift = baselineY - m.baselineY
    const x0 = cursor
    const x1 = x0 + srcW * k

    for (const n of src) {
      const c = cloneNote(n, x0, m, k, yShift, noteIdx, runs.length)
      noteIdx += 1
      page.notes.push(c)
      /**
       * 音符时刻：**用小节内拍位算**（`adj1283`，用户 2026-11-09「谱带移动比合成音慢」）。
       *
       * 原来按"音符在小节里的 x 比例 × 小节时长"折算 —— 可空间优先排版里 x 不跟时值成比例
       * （音符常常挤在小节左侧、右边留白），折出来的时刻整体偏小 ⇒ 谱带走得比声音慢。
       * `beatPos` 是"小节内第几拍"（从 0 起），乘一拍毫秒就是**真正的发声时刻**，
       * 与合成音（按播放序列的拍点渲染）同源。
       */
      const t0 = o.t0 + n.beatPos * beatMs
      /**
       * adj1284（用户 2026-11-09「从第一音就慢」的**真因之一**）：
       * 这里原来写的是 `Math.max(1, duration)` —— 把**不足一拍**的时值钳成 1 拍。
       * 八分音符（0.5 拍）的结束时刻因此被推后一倍、十六分音符（0.25 拍）推后四倍，
       * 而滚动位置的插值跨度正是拿 `t1 - t0` 算的 ⇒ 谱带比声音慢 2 倍 / 4 倍
       * （实测 `春庭雪` 的 `2//`：真时值 200ms，`t1 - t0` 却是 800ms）。
       * 现在只保留"不许为 0 或负"的极小值兜底，时值是多少就是多少。
       */
      const t1 = Math.min(o.t1, t0 + Math.max(0.001, n.duration) * beatMs)
      notes.push({
        t0: Math.round(t0 * 10) / 10,
        t1: Math.round(t1 * 10) / 10,
        x: c.x,
        w: c.width,
        sourceBar: m.no,
      })
    }

    /**
     * `adj1267`（用户 P2 的后续）：多段歌词**按这个源小节第几次演奏**换行。
     * `o.pass` = 1 用第 1 条 `C:` 行、= 2 用第 2 条……；超过段数就停在最后一段。
     * 这一小节在这一遍里没有那一段的字（长音跨过了）⇒ 就不画（不退回上一段，免得"串词"）。
     *
     * ⚠ 这段**不受 `withLyrics` 短路**：关掉歌词时还要靠它算"要不要预留歌词那一行的高度"
     * （`adj1267` 的口径：开关只少画字，不缩谱带）。
     */
    const wantLine = Math.min(Math.max(0, o.pass - 1), verseLines.get(rowKeyOf(m)) ?? 0)
    /**
     * adj1273：第 N 段词**画在第 1 段词的位置上**（往上挪 `N × 行距`）。
     * 不挪的话，第 2 段词永远在下面一行 ⇒ 条带得为"最低那一行"留高度，切换遍次时字会跳。
     */
    const verseStep = cfg.geci_size + 4 + cfg.height_cici
    for (const l of m.lyrics) {
      if ((l.line ?? 0) !== wantLine) continue
      // 第 1 个字的字左缘本来会比内容左缘再往左 1px 左右（字居中放在数字下），夹到 0 免得被裁掉
      const ly = Math.round((l.y + yShift - wantLine * verseStep + lyricGap) * 10) / 10
      /**
       * 高度按内容算（`adj1273`）；但**歌词关掉时也照样预留这一行的高度**（`adj1267` 的口径：
       * 开关只少画字、不缩谱带，否则一按开关字号跟着跳）。
       */
      lyricBottom = Math.max(lyricBottom, ly + cfg.geci_size * 0.35)
      if (!withLyrics) continue
      page.lyrics.push({
        ...l,
        id: { ...l.id, index: noteIdx++ },
        x: Math.max(0, Math.round((x0 + (l.x - m.x0) * k) * 10) / 10),
        y: ly,
      })
    }

    // 小节线：第一小节不画（条带从内容开始）；其余在小节起点补一根
    if (i > 0) {
      const prev = byNo.get(occ[i - 1].no)
      /**
       * adj1323：行首 barline 现在都归到上一行末，所以优先用 `prev.endType`；
       * 没有才退回本小节的 `m.leadType`。`||`/`||/` 保留双线，反复/隐藏线降级为 `|`。
       */
      const type = stripBarlineTypeOf(prev?.endType ?? m.leadType)
      page.barlines.push(barlineAt(x0, baselineY + m.staffTop, baselineY + m.staffBottom, type))
    }

    runs.push({
      sourceBar: m.no,
      pass: o.pass,
      t0: Math.round(o.t0 * 10) / 10,
      t1: Math.round(o.t1 * 10) / 10,
      x0: Math.round(x0 * 10) / 10,
      x1: Math.round(x1 * 10) / 10,
      pageIndex: m.pageIndex,
      rowIndex: m.rowIndex,
    })
    cursor = x1
  }

  /**
   * adj1268：小节号画在**小节线正上方**（框底贴小节线顶端）。
   * 第 1 段 run 没有小节线（条带从内容开始），所以从第 2 段起画；反复段每出现一次都画。
   */
  if (withBarNumbers) {
    // adj1274：与应用一致——序号挂在小节线**下方**（框顶 = 小节线底缘 + 固定间隙）
    for (let i = 1; i < runs.length; i++) {
      const m = byNo.get(runs[i].sourceBar)
      const bottom = baselineY + (m?.staffBottom ?? noteSize * 0.6)
      page.barNumbers.push({
        n: runs[i].sourceBar,
        x: runs[i].x0,
        yBarBottom: Math.round(bottom * 10) / 10,
        voice: 1,
        group: 1,
      })
    }
  }

  // 曲末的终止线（`||`）
  const lastOcc = occ[occ.length - 1]
  const lastMeasure = lastOcc ? byNo.get(lastOcc.no) : undefined
  if (lastMeasure?.endType === '||' || lastMeasure?.endType === '||/') {
    page.barlines.push(
      barlineAt(cursor, baselineY + lastMeasure.staffTop, baselineY + lastMeasure.staffBottom, '||'),
    )
  }

  /**
   * adj1269（用户 2026-11-09）：**跨小节、跨行的连音线/渐强渐弱要画出来**。
   *
   * 为什么必须重画：A4 版里跨行的连音线被拆成两条"半条"（`half:'l'` 收在行末、`half:'r'` 从行首起）；
   * 条带把各曲行拼成了一条线 ⇒ 那两条半条现在**首尾相接**，必须合成一条完整的弧线，
   * 否则接口处会出现一个台阶/两个半圆。同一小节内的线也照样按 k 缩放搬过来。
   *
   * 坐标怎么搬：x 走**各自所在小节**的 `run` 变换（每小节一个 k，反复段每遍各一套）；
   * y 加上"源行基线 → 条带基线"的位移。跨行的线两端 y 位移可能不同（源行基线不同），
   * 取**较高**的那个当统一 y（`renderSlur` 只吃一个 y；取低的会压到下面那行的数字上）。
   */
  const runsByBar = new Map<number, { run: StripRun; map: RunMap }[]>()
  for (const run of runs) {
    const m = byNo.get(run.sourceBar)
    if (m === undefined) continue
    const list = runsByBar.get(run.sourceBar) ?? []
    list.push({ run, map: runMapOf(run, m, baselineY) })
    runsByBar.set(run.sourceBar, list)
  }
  /**
   * 一条连音线在条带上的落点：两端各自找"所在小节的第 k 遍"。
   *
   * 第 k 遍配对（而不是只画第 1 遍）：反复段里的线每遍都要有；两端的遍数取 `min`，
   * 一端在反复段外时只画能配对上的那几遍（宁少不串）。
   */
  const mapMarks = (
    pageIndex: number,
    x1: number,
    x2: number,
    onPair: (a: RunMap, b: RunMap) => void,
    row?: number,
    nearY?: number,
  ): boolean => {
    const barA = measureOfX(measures, pageIndex, x1, row, nearY)
    const barB = measureOfX(measures, pageIndex, x2, row, nearY)
    if (barA < 0 || barB < 0) return false
    const listA = runsByBar.get(barA) ?? []
    const listB = runsByBar.get(barB) ?? []
    const pairs = Math.min(listA.length, listB.length)
    if (pairs === 0) return false
    for (let k = 0; k < pairs; k++) onPair(listA[k].map, listB[k].map)
    return true
  }
  for (const p of layout.pages) {
    for (const span of slurSpansOfPage(p)) {
      const ok = mapMarks(p.index, span.x1, span.x2, (a, b) => {
        const x1 = a.x(span.x1)
        const x2 = b.x(span.x2)
        if (!(x2 > x1)) return
        page.slurs.push({
          ...span.src,
          x1: Math.max(0, x1),
          x2,
          y: Math.min(a.y(span.y1), b.y(span.y2)),
          half: undefined,
        })
      }, span.src.row, span.src.rowTop ?? span.src.y)
      if (!ok) droppedCross += 1
    }
    for (const d of p.dynamics) {
      const ok = mapMarks(p.index, d.x1, d.x2, (a, b) => {
        const x1 = a.x(d.x1)
        const x2 = b.x(d.x2)
        if (!(x2 > x1)) return
        page.dynamics.push({ ...d, x1: Math.max(0, x1), x2, y: Math.min(a.y(d.y), b.y(d.y)) })
      }, undefined, d.y)
      if (!ok) droppedCross += 1
    }
  }

  /**
   * adj1273：高度按内容算（谱表下沿 / 歌词下沿取大的），不再用"字号 × 1.9 + 歌词 × 1.4"估算——
   * 估算值在"间距按比例放大"之后会把最后一行歌词裁掉几像素。
   *
   * 2026-11-14 用户改口：不显示歌词时，谱带高度要相应减小，不再为了"缩放不跳"保留歌词行高度。
   */
  let contentBottom = baselineY + noteSize * 0.7
  let staffBottomY = contentBottom
  for (const m of measures) {
    contentBottom = Math.max(contentBottom, baselineY + m.staffBottom)
    staffBottomY = Math.max(staffBottomY, baselineY + m.staffBottom)
  }
  /**
   * 高度按内容算；**不显示歌词时不再给歌词行留高度**（用户 2026-11-14：
   * 「当不显示歌词时，谱带高度要相应减小」）。歌词行本身仍参与 `lyricBottom` 计算，
   * 只是不并进最终高度。
   */
  contentBottom = withLyrics ? Math.max(contentBottom, lyricBottom) : contentBottom
  // adj1274：小节号现在画在**线下方**，条带底部要给它留出位置
  if (withBarNumbers) contentBottom = Math.max(contentBottom, staffBottomY + BAR_NUMBER_BOTTOM_GAP + barBoxH + 2)
  const height = Math.ceil(contentBottom + 4)
  /**
   * adj1281（用户 2026-11-09「词行的位置调整虚线放在词行中间」）：
   * 那条虚线画在**词行字的垂直中间**（不是曲/词之间的空白里），一眼能对上"我要挪的是这一行词"。
   */
  const lyricTopY =
    page.lyrics.length > 0 ? Math.min(...page.lyrics.map((l) => l.y)) - cfg.geci_size * 0.72 : Number.NaN
  const guideQuciY = Math.round(
    (Number.isFinite(lyricTopY) ? lyricTopY + cfg.geci_size * 0.36 : staffBottomY + noteSize * 0.35) * 10,
  ) / 10
  let lyricLines = 1
  for (const v of verseLines.values()) lyricLines = Math.max(lyricLines, v + 1)

  const onsets = onsetsOf(notes)
  const outPage: ScorePage = { ...page, width: Math.max(1, cursor), height }
  if (opts.barlineAnchor === 'gap') anchorBarlinesInGaps(outPage, noteSize)

  return {
    page: outPage,
    width: Math.max(1, cursor),
    height,
    baselineY,
    lyricLines,
    guideQuciY,
    runs,
    notes,
    onsets,
    noteSize,
    pxPerBeat,
    beatMs,
    dropped: { crossMeasure: droppedCross, fragment: 0, extraVoice: droppedVoice, missingBar: droppedMissing },
  }
}

/** 同一批起点的容差（ms）：和弦音算一个"落点" */
const SAME_ONSET_MS = 0.5

/**
 * `adj1285`（用户 2026-11-09 晚复核后的口径）：**每个发声起点**的谱面位置。
 *
 * 用户原话：「合成音演奏到哪个音符，谱子应相应的音符移到定位色块处，这个音形要对齐」。
 * 于是滚动按**音**落位（`adj1284` 曾按拍建表，拍里的第二/三个十六分音符会被"滑过去"）：
 *  · 同一时刻的和弦算一个起点，取整组中心（否则色块会在和弦音之间来回跳）；
 *  · 起点顺序 = 演奏顺序（`notes` 本来就是按 run / 小节 / 音的顺序排的）。
 */
function onsetsOf(notes: StripNote[]): StripOnset[] {
  const out: StripOnset[] = []
  for (let i = 0; i < notes.length; i++) {
    const t0 = notes[i].t0
    if (i > 0 && Math.abs(t0 - notes[i - 1].t0) <= SAME_ONSET_MS) continue // 和弦里的后几个
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (let j = i; j < notes.length && Math.abs(notes[j].t0 - t0) <= SAME_ONSET_MS; j++) {
      const c = notes[j].x + notes[j].w / 2
      lo = Math.min(lo, c)
      hi = Math.max(hi, c)
    }
    out.push({ t: t0, x: Math.round(((lo + hi) / 2) * 10) / 10 })
  }
  return out
}

/**
 * 某个页面坐标 x 落在第几号源小节（找不到 -1）。
 *
 * ⚠ `adj1280`（用户截图实报「曲部没有连音线，反倒下面行里多了不少连音线」）：
 * **行与行的 x 范围是重叠的**（每一行都从页边距开始），只按 x 找会命中**别的行**的小节，
 * 于是连音线的 y 用了别行的基线 —— 结果是"谱带上方没有线、下面飘着一排弧"。
 * 现在优先按**行号**匹配（`PlacedSlur.row`），没有行号时按"离哪个基线近"。
 */
function measureOfX(
  measures: SrcMeasure[],
  pageIndex: number,
  x: number,
  row?: number,
  nearY?: number,
): number {
  let fallback = -1
  let best: { no: number; d: number } | null = null
  for (const m of measures) {
    if (m.pageIndex !== pageIndex) continue
    if (!(x >= m.x0 - 0.5 && x < m.x1 + 0.5)) continue
    if (row !== undefined && m.rowIndex === row) return m.no
    if (fallback < 0) fallback = m.no
    if (nearY !== undefined) {
      const d = Math.abs(m.baselineY - nearY)
      if (best === null || d < best.d) best = { no: m.no, d }
    }
  }
  if (row !== undefined && fallback >= 0) return best?.no ?? fallback
  return best?.no ?? fallback
}
