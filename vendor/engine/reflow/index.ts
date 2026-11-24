/**
 * engine/reflow/index.ts — 乐谱重排（P2，adj1324）
 *
 * 用户 2026-11-23 定稿：只在小节线后断行；多声部按同一小节断；歌词一起拆；
 * `{bz}` / `{dsb}` / `{tp}` 段覆盖的区间不可断；`[fenye]` 保留；每行末尾缺小节线补 `|`。
 *
 * 实现策略：**先合并、再拆分**——把同一“声部集合”的连续 Q 行首尾相接成一条连续谱，
 * 按规则重新断行；不是逐条 Q 行各自重排。换声部集合、`[fenye]`、带 `{tp}` 的单元、
 * 行首裸 `[` 才断开（这些是硬边界）。
 *
 * 排版仍然**不碰 `placeVoiceBlock`**：重排把长块切成多个“一块一行”的块，
 * 现有排版已经支持多个多声部块（大括号/声部名/块间对齐都是现成的）。
 *
 * 纯函数、零 DOM；应用对话框、以后 CLI 都只调 `reflowJps()`。
 */
import type {
  BarlineToken,
  LyricChar,
  LyricLine,
  MusicGroup,
  MusicLine,
  MusicToken,
  PageConfig,
  ParseResult,
} from '../types'
import { defaultPageConfig, PAPER_SIZE } from '../types'
import { parseJps } from '../parser/parser'
import { splitBars, countMeasures } from '../parser/bars'
import { joinBarlineTokens } from '../parser/barlineJoin'
import { computeSegments } from '../layout/segments'
import { measureFixedWidth, measureSpaceWidth } from '../layout/index'
import { tokenDuration } from '../duration'
import { extractJpsConfig } from '../settings'

/** 重排参数 */
export interface ReflowOptions {
  /** 每行最多几个小节（硬上限；不给且没给其它模式时默认 4） */
  maxMeasuresPerLine?: number
  /** 固定部分宽 / 可用宽 的上限（0~1，如 0.8；硬上限） */
  fixedInkRatio?: number
  /** 目标行数；在硬上限内做 DP，尽量正好这么多行 */
  targetLineCount?: number
  /** 页面/字号；缺省读谱面 `# jps-config`，再缺省 `defaultPageConfig` */
  pageConfig?: PageConfig
}

export interface ReflowResult {
  source: string
  /** 每行起始小节号（1 起；`unit` 是排版单元序号） */
  breaks: { unit: number; measure: number }[]
  /** 重排后总行数覆盖的小节数（多声部按单元最大小节数计） */
  measures: number
  warnings: string[]
}

interface UnitInfo {
  index: number
  lines: MusicLine[]
  groups: MusicGroup[]
  /** 单元第一行在 `result.lines` 里的下标 */
  startLine: number
  /** 单元占用的 music/lyric 行下标（重排时跳过） */
  skip: Set<number>
  /** 单元内部夹着的注释/空行（重排时原样放在这一块之前，别丢） */
  preamble: string[]
  /** 本单元前面是否紧跟 `[fenye]`（分页是硬边界，重排不能跨过去合并） */
  pageBreakBefore: boolean
}

interface VoicePart {
  voice: number
  /** Q 行 token（已去掉歌词行注入的 `{tp}`） */
  tokens: MusicToken[]
  segs: ReturnType<typeof splitBars>
  lyrics: LyricLine[]
}

const EPS = 1e-6

function isDurational(t: MusicToken): t is Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }> {
  return t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
}

function isBoundary(t: MusicToken): t is BarlineToken {
  return t.kind === 'barline' && t.voltaOnly !== true
}

/**
 * Q 行里去掉**替谱段 `{tp … }`**：它们是 `injectLyricVariants()` 从歌词行注入的，
 * 源码本来写在 `C:` 行里。重排 Q 行时不能再写一遍（否则解析器会报“只能写在歌词行”）。
 * 歌词切片会保留 C 行里的 `{tp}` 原文。
 */
function qTokensOf(group: MusicGroup): MusicToken[] {
  return group.music.tokens.filter((t) => !(t.kind === 'segment' && t.type === 'tp'))
}

/** 这个单元里有没有歌词行注入的 `{tp}`（有就单独重排，保留 C 行原文） */
function hasTpUnit(unit: UnitInfo): boolean {
  return unit.groups.some((g) => g.music.tokens.some((t) => t.kind === 'segment' && t.type === 'tp'))
}

/** 行首是裸 `[` 跳房子标注 ⇒ 必须留在行首，不能和前一行合并 */
function barOf(type: BarlineToken['type'] = '|'): BarlineToken {
  return { kind: 'barline', type, pos: 0, raw: type }
}

/** 一组声部 → 重排用的 parts（Q token 去掉 tp） */
function partsOfGroups(groups: MusicGroup[]): VoicePart[] {
  return groups.map((g) => {
    const tokens = qTokensOf(g)
    return { voice: g.music.voice, tokens, segs: splitBars(tokens), lyrics: g.lyrics }
  })
}

/** 页面内容宽（多声部扣一点块首大括号/声部名留白，保守一点） */
function availWidthOf(cfg: PageConfig, voices: number): number {
  const page = PAPER_SIZE[cfg.page]?.width ?? 595.28
  const pad = voices > 1 ? cfg.note_size * 2.2 : 0
  // 与 breakRows/breakRowsSpace 一样扣掉左右 BAR_PAD（各 6px）
  return Math.max(80, page - cfg.margin_left - cfg.margin_right - pad - 12)
}

/** 建排版单元（与 layout / sequence 同一规则：声部号在本单元内重复即断；[fenye] 断） */
function buildUnits(result: ParseResult): UnitInfo[] {
  const groupOfMusic = new Map<MusicLine, MusicGroup>()
  const lineIndexOf = new Map<object, number>()
  result.groups.forEach((g) => groupOfMusic.set(g.music, g))
  result.lines.forEach((line, i) => lineIndexOf.set(line, i))

  const units: UnitInfo[] = []
  let cur: MusicLine[] = []
  let voices = new Set<number>()
  /** 上一个单元后面是否紧跟 `[fenye]`（分页硬边界） */
  let pageBreakPending = false
  const flush = (): void => {
    if (cur.length === 0) return
    const groups = cur.map((m) => groupOfMusic.get(m)).filter((g): g is MusicGroup => g !== undefined)
    const skip = new Set<number>()
    for (const g of groups) {
      const mi = lineIndexOf.get(g.music)
      if (mi !== undefined) skip.add(mi)
      for (const ly of g.lyrics) {
        const li = lineIndexOf.get(ly)
        if (li !== undefined) skip.add(li)
      }
    }
    const startLine = lineIndexOf.get(cur[0]) ?? 0
    const endLine = skip.size > 0 ? Math.max(...skip) : startLine
    const preamble: string[] = []
    // 单元内部夹着的注释/空行：先收起来，重排后放到这一块之前（不丢、不乱序到块尾）
    for (let i = startLine + 1; i < endLine; i++) {
      const line = result.lines[i]
      if (!skip.has(i) && (line.kind === 'comment' || line.kind === 'empty' || line.kind === 'unknown')) {
        preamble.push(line.raw)
        skip.add(i)
      }
    }
    units.push({
      index: units.length,
      lines: cur,
      groups,
      startLine,
      skip,
      preamble,
      pageBreakBefore: pageBreakPending,
    })
    pageBreakPending = false
    cur = []
    voices = new Set()
  }
  for (const line of result.lines) {
    if (line.kind === 'pagebreak') {
      flush()
      pageBreakPending = true
      continue
    }
    if (line.kind !== 'music') continue
    if (cur.length > 0 && voices.has(line.voice)) flush()
    cur.push(line)
    voices.add(line.voice)
  }
  flush()
  return units
}

/** 每个小节的固定部分宽（多声部取各声部最大） */
function fixedWidthsOf(parts: VoicePart[], noteSize: number, spaceLayout: boolean): number[] {
  const maxBars = Math.max(0, ...parts.map((p) => p.segs.length))
  const out = new Array<number>(maxBars).fill(0)
  for (const p of parts) {
    for (let b = 0; b < p.segs.length; b++) {
      const w = spaceLayout
        ? measureSpaceWidth(p.segs[b], noteSize)
        : measureFixedWidth(p.segs[b], noteSize)
      out[b] = Math.max(out[b], w)
    }
  }
  return out
}

/** 一行里主旋律的小节线拍位（用来把段起点/终点换算成小节断点） */
function boundaryBeatsOf(tokens: readonly MusicToken[]): number[] {
  const out: number[] = []
  let beat = 0
  for (const t of tokens) {
    if (isBoundary(t)) out.push(beat)
    else if (isDurational(t)) beat += tokenDuration(t)
  }
  return out
}

/**
 * 小节边界对应的歌词槽位号：`slotAt[m]` = 第 m 小节开始前已有几个音符槽位。
 * 行首空 seg 不算小节（与 `countMeasures` 同口径）。
 */
function boundarySlotsOf(tokens: readonly MusicToken[], measureCount: number): number[] {
  const out: number[] = [0]
  let slot = 0
  let measure = 0
  let sawNote = false
  for (const t of tokens) {
    if (isBoundary(t)) {
      if (!(measure === 0 && !sawNote)) {
        measure += 1
        out[measure] = slot
      }
    } else if (isDurational(t)) {
      slot += 1
      sawNote = true
    }
  }
  while (out.length < measureCount + 1) out.push(slot)
  return out
}

/** 从 start 之后最近的强制断点（当前不启用结构强制断点，保留给以后规则用） */
function nextForcedAfter(forced: Set<number>, start: number, measureCount: number): number {
  let best = measureCount
  for (const f of forced) {
    if (f > start && f < best) best = f
  }
  return best
}

/**
 * 用户 2026-11-24：`|]/` 是**不封闭房子的视觉终点**，位置可以在本房子范围内移动；
 * 重排先按小节排完，再把 `]/` 放到“本行最后一个仍在本房子范围内的小节线”上。
 * 如果这个位置正好是房子的真实末尾（后面的 `:|`/跳跃线或它自己），改成闭口 `]`；
 * 否则保留 `]/`（不封闭）。
 *
 * 真实末尾按 SYNTAX §2.8c：`]/` 之后最近的 `:|`/`:|:` 或带 `&ds`/`&dc`/`&fine` 的线；
 * 找不到就退回 `]/` 自己。
 */
function repositionSlashEnds(parts: VoicePart[], starts: number[]): void {
  for (const p of parts) {
    const events: { token: BarlineToken; measure: number }[] = []
    const markerStart = new Map<BarlineToken, number>()
    let measure = 0
    let sawNote = false
    let openStart: number | null = null
    for (const t of p.tokens) {
      if (t.kind !== 'barline') {
        if (isDurational(t)) sawNote = true
        continue
      }
      if (t.voltaOnly) {
        if (t.voltaStart && !t.voltaEnd) openStart = measure
        continue
      }
      const lead = measure === 0 && !sawNote
      if (!lead) measure += 1
      const endMeasure = measure - 1
      events.push({ token: t, measure: endMeasure })
      if (t.voltaEndSlash && !t.voltaStart && openStart !== null) markerStart.set(t, openStart)
      if (t.voltaEnd && !t.voltaEndSlash) openStart = null
      if (t.voltaStart) openStart = measure
    }
    if (events.length === 0) continue
    const measureCount = Math.max(...events.map((e) => e.measure)) + 1
    const endOfRow = (row: number): number => {
      if (row + 1 < starts.length) return starts[row + 1] - 1
      return measureCount - 1
    }
    for (let i = 0; i < events.length; i++) {
      const token = events[i].token
      if (!token.voltaEndSlash || token.voltaStart) continue // 连续房子共用线不搬
      const markerMeasure = events[i].measure
      // 真实末尾：自身是反复线就取自己；否则往后找反复/跳跃线
      let actualMeasure = isRepeatEndOf(token) ? markerMeasure : -1
      if (actualMeasure < 0) {
        for (let j = i + 1; j < events.length; j++) {
          const b = events[j].token
          if (b.voltaEnd || isRepeatEndOf(b) || b.marks?.some((m) => m === 'ds' || m === 'dc' || m === 'fine')) {
            actualMeasure = events[j].measure
            break
          }
        }
      }
      if (actualMeasure < 0) actualMeasure = markerMeasure
      if (actualMeasure < markerMeasure) actualMeasure = markerMeasure
      /**
       * 用户 2026-11-24：`]/` 的位置看**跳房子的起点行**，不看 `]/` 原来在哪一行。
       * 房子从某行最后一小节开始、真实末尾在后面行 ⇒ 只画这一小节，`]/` 放这行行末；
       * 房子范围在本行内结束 ⇒ 到真实末尾改闭口 `]`。
       */
      const startMeasure = markerStart.get(token) ?? markerMeasure
      const startRow = rowOfMeasure(starts, startMeasure)
      const startRowEnd = endOfRow(startRow)
      const targetMeasure = actualMeasure <= startRowEnd ? actualMeasure : startRowEnd
      if (targetMeasure === markerMeasure && actualMeasure === markerMeasure) {
        // 就在真实末尾 ⇒ 闭口
        token.voltaEnd = true
        token.voltaEndSlash = false
        continue
      }
      if (targetMeasure === markerMeasure) continue // 已在本行末尾，保留 `]/`
      const target = [...events].reverse().find((e) => e.measure === targetMeasure)?.token
      if (!target) continue
      token.voltaEnd = false
      token.voltaEndSlash = undefined
      target.voltaEnd = true
      target.voltaEndSlash = targetMeasure < actualMeasure
    }
  }
}
/** 小节 m 属于哪一行（starts 为每行起始小节，末项 = measureCount） */
function rowOfMeasure(starts: number[], m: number): number {
  for (let r = 0; r < starts.length - 1; r++) {
    if (m >= starts[r] && m < starts[r + 1]) return r
  }
  return Math.max(0, starts.length - 2)
}

/** 这个断点是不是“这一遍的结束” */
function isRepeatEndOf(t: BarlineToken): boolean {
  return t.type === ':|' || t.type === ':|:' || t.type === '||'
}

/**
 * 用户 2026-11-23 口径：**跳房子范围重排后落在同一行内，就改成闭口**。
 *
 * 开放 `[` 的范围按“下一个 `]` / 下一遍的 `:|` / 下一个 `[`”确定；
 * 起止在同一行 ⇒ 给终点小节线补 `voltaEnd`（`|`→`|]`、`:|`→`:|]`）。
 * 跨行则保持开放（原来跨行渲染靠起止两端画左右半）。
 */
function closeVoltasInRow(parts: VoicePart[], starts: number[]): void {
  for (const p of parts) {
    let measure = 0
    let sawNote = false
    let openStart: number | null = null
    let lastBar: BarlineToken | null = null
    let lastEndMeasure = -1
    for (const t of p.tokens) {
      if (t.kind !== 'barline') {
        if (isDurational(t)) sawNote = true
        continue
      }
      if (t.voltaOnly) {
        if (t.voltaStart && !t.voltaEnd) openStart = measure
        continue
      }
      const lead = measure === 0 && !sawNote
      if (!lead) measure += 1
      const endMeasure = measure - 1
      if (endMeasure >= 0) {
        lastBar = t
        lastEndMeasure = endMeasure
      }
      // 只有“这一遍结束”的线（`]` / `:|` / 下一段 `[`）才收口；普通 `|` 继续开放
      if (openStart !== null && (t.voltaEnd || isRepeatEndOf(t) || t.voltaStart)) {
        if (endMeasure >= 0 && rowOfMeasure(starts, openStart) === rowOfMeasure(starts, endMeasure)) {
          t.voltaEnd = true
        }
        openStart = null
      }
      if (t.voltaStart) openStart = measure
      else if (t.voltaEnd) openStart = null
    }
    if (openStart !== null && lastBar && lastEndMeasure >= 0) {
      if (rowOfMeasure(starts, openStart) === rowOfMeasure(starts, lastEndMeasure)) {
        lastBar.voltaEnd = true
      }
    }
  }
}
/**
 * 不可断的小节断点：段（`{bz}`/`{dsb}`/`{tp}`）跨越的小节边界、
 * 以及歌词 `{tp … }` 跨越的边界都不能断。
 */
function forbiddenBreaksOf(parts: VoicePart[], measureCount: number): Set<number> {
  const out = new Set<number>()
  for (const p of parts) {
    const tokens = p.tokens
    const bounds = boundaryBeatsOf(tokens)
    for (const seg of computeSegments(tokens)) {
      const start = seg.startBeat
      const end = start + seg.beats
      for (let k = 0; k < bounds.length; k++) {
        const b = bounds[k]
        if (b > start + EPS && b < end - EPS) out.add(k + 1)
      }
    }
    const slotAt = boundarySlotsOf(tokens, measureCount)
    for (const ly of p.lyrics) {
      for (const v of ly.variants ?? []) {
        const n = v.tokens.filter(isDurational).length
        if (n <= 0) continue
        const from = v.slot
        const to = v.slot + n
        for (let m = 1; m < measureCount; m++) {
          const s = slotAt[m] ?? Number.POSITIVE_INFINITY
          if (s > from + EPS && s < to - EPS) out.add(m)
        }
      }
    }
  }
  return out
}

interface Plan {
  /** 每行起始小节（0 起；第一项恒为 0，最后一项之后到 measureCount） */
  starts: number[]
  warnings: string[]
}

/** 贪心：最多 N 小节 / 固定占宽比例；遇不可断区向后让 */
function greedyPlan(
  fixed: number[],
  avail: number,
  measureCount: number,
  maxMeasures: number,
  ratio: number,
  forbidden: Set<number>,
  forced: Set<number>,
): Plan {
  const starts: number[] = [0]
  const warnings: string[] = []
  let start = 0
  const allowed = (b: number): boolean => b > 0 && b < measureCount && !forbidden.has(b)
  const canBreak = (b: number): boolean => b === measureCount || allowed(b)
  let guard = 0
  while (start < measureCount && guard++ < measureCount + 2) {
    // 闭合跳房子 `]` 之后是结构边界，不能把这一行排到它后面
    const limit = nextForcedAfter(forced, start, measureCount)
    let end = start
    let sum = 0
    while (end < measureCount) {
      if (end >= limit) break // 到强制断点就收
      const count = end - start + 1
      if (count > maxMeasures) break
      const next = sum + fixed[end]
      if (next / avail > ratio && end > start) break
      sum = next
      end += 1
      if (end < measureCount && !canBreak(end)) continue // 段内不能断，继续往后吃
    }
    if (end <= start) end = start + 1
    let cut = Math.min(end, limit)
    // 先向后找最近的合法断点；若超过 maxMeasures，回退到上限内最后一个合法断点
    if (cut < measureCount && !canBreak(cut) && !forced.has(cut)) {
      while (cut < measureCount && !canBreak(cut) && !forced.has(cut)) cut += 1
    }
    if (cut > measureCount) cut = measureCount
    if (cut - start > maxMeasures) {
      let best = -1
      for (let c = start + 1; c <= Math.min(measureCount, start + maxMeasures); c++) {
        if (canBreak(c) || forced.has(c)) best = c
      }
      if (best > start) cut = best
      else warnings.push(`第 ${start + 1} 小节起有一段跨小节结构，本行超过最多 ${maxMeasures} 小节`)
    }
    if (cut <= start) cut = Math.min(measureCount, start + 1)
    starts.push(cut)
    start = cut
  }
  if (starts[starts.length - 1] !== measureCount) starts.push(measureCount)
  return { starts, warnings }
}

/** 目标行数：在硬上限内做 DP，行数越接近目标越好 */
function targetPlan(
  fixed: number[],
  avail: number,
  measureCount: number,
  maxMeasures: number,
  ratio: number,
  forbidden: Set<number>,
  forced: Set<number>,
  target: number,
): Plan {
  const warnings: string[] = []
  const allowedEnd = (b: number): boolean =>
    b === measureCount || forced.has(b) || (b > 0 && b < measureCount && !forbidden.has(b))
  // 闭合跳房子会额外增加断点；DP 行数上限要留出这些结构性断点
  const maxK = Math.min(measureCount, Math.max(1, target) + forced.size + 1)
  const INF = Number.POSITIVE_INFINITY
  // dp[k][i] = 前 i 小节分成 k 行的最小代价
  const dp: number[][] = Array.from({ length: maxK + 1 }, () => new Array<number>(measureCount + 1).fill(INF))
  const prev: number[][] = Array.from({ length: maxK + 1 }, () => new Array<number>(measureCount + 1).fill(-1))
  dp[0][0] = 0
  for (let k = 1; k <= maxK; k++) {
    for (let i = 1; i <= measureCount; i++) {
      if (!allowedEnd(i)) continue
      for (let j = k - 1; j < i; j++) {
        if (dp[k - 1][j] === INF) continue
        // 行不能跨过闭合跳房子的结构断点
        if (i > nextForcedAfter(forced, j, measureCount)) continue
        const count = i - j
        if (count > maxMeasures) continue
        let sum = 0
        for (let b = j; b < i; b++) sum += fixed[b] ?? 0
        const fill = sum / avail
        if (fill > ratio && count > 1) continue
        const overflow = fill > 1 ? 100 : 0
        const cost = dp[k - 1][j] + (1 - fill) ** 2 + overflow + count * 0.0001
        if (cost < dp[k][i]) {
          dp[k][i] = cost
          prev[k][i] = j
        }
      }
    }
  }
  // 目标行数不可行时，找**最接近**的可行行数（先看正好 target，再左右扩）
  let chosen = -1
  if (target <= maxK && dp[target][measureCount] !== INF) {
    chosen = target
  } else {
    for (let d = 1; d <= maxK && chosen < 0; d++) {
      for (const k of [target - d, target + d]) {
        if (k >= 1 && k <= maxK && dp[k][measureCount] !== INF) {
          chosen = k
          break
        }
      }
    }
  }
  if (chosen < 0) {
    return greedyPlan(fixed, avail, measureCount, maxMeasures, ratio, forbidden, forced)
  }
  if (chosen !== target) warnings.push(`目标 ${target} 行做不到，按 ${chosen} 行重排`)
  const cuts: number[] = []
  let i = measureCount
  let k = chosen
  while (k > 0 && i > 0) {
    const j = prev[k][i]
    if (j < 0) break
    cuts.push(i)
    i = j
    k -= 1
  }
  cuts.reverse()
  const starts = [0, ...cuts.filter((c) => c > 0 && c < measureCount)]
  if (starts[starts.length - 1] !== measureCount) starts.push(measureCount)
  return { starts, warnings }
}

function planStartsForParts(
  parts: VoicePart[],
  opts: ReflowOptions,
  cfg: PageConfig,
): { starts: number[]; measureCount: number; warnings: string[] } {
  const measureCount = Math.max(1, ...parts.map((p) => countMeasures(p.tokens)))
  const fixed = fixedWidthsOf(parts, cfg.note_size, cfg.noteSpaceLayout === 'space')
  const avail = availWidthOf(cfg, parts.length)
  const forbidden = forbiddenBreaksOf(parts, measureCount)
  // 用户 2026-11-24 拍板：`|]/` 随实际行宽调整，**不强制换行**；
  // 跳房子端点只作为普通小节线参与填充，闭口由 closeVoltasInRow 处理。
  const forced = new Set<number>()

  const hasTarget = Number.isFinite(opts.targetLineCount) && (opts.targetLineCount ?? 0) > 0
  const maxMeasures = Number.isFinite(opts.maxMeasuresPerLine) && (opts.maxMeasuresPerLine ?? 0) > 0
    ? Math.max(1, Math.floor(opts.maxMeasuresPerLine as number))
    : hasTarget || opts.fixedInkRatio !== undefined
      ? Number.POSITIVE_INFINITY
      : 4
  const ratioRaw = opts.fixedInkRatio
  const ratio = ratioRaw === undefined ? 1 : Math.min(1, Math.max(0.05, ratioRaw))
  const plan = hasTarget
    ? targetPlan(fixed, avail, measureCount, maxMeasures, ratio, forbidden, forced, Math.floor(opts.targetLineCount as number))
    : greedyPlan(fixed, avail, measureCount, maxMeasures, ratio, forbidden, forced)
  return { starts: plan.starts, measureCount, warnings: plan.warnings }
}

/** 按起始小节切 Q 行 token；行首空 seg（语义线）不算小节 */
function splitVoiceTokens(tokens: MusicToken[], starts: number[], measureCount: number): MusicToken[][] {
  const pieces: MusicToken[][] = []
  let cur: MusicToken[] = []
  let measure = 0
  let sawNote = false
  let next = 1
  for (const t of tokens) {
    cur.push(t)
    if (isBoundary(t)) {
      if (!(measure === 0 && !sawNote)) {
        measure += 1
        if (next < starts.length && starts[next] === measure && measure < measureCount) {
          pieces.push(cur)
          cur = []
          next += 1
        }
      }
    } else if (isDurational(t)) {
      sawNote = true
    }
  }
  if (cur.length > 0) pieces.push(cur)
  while (pieces.length < starts.length) pieces.push([])
  return pieces.slice(0, starts.length)
}

function hasNoteLike(tokens: readonly MusicToken[]): boolean {
  return tokens.some(isDurational)
}

/** 每行末尾必须有 barline；没有就补 `|`（空行不补） */
function ensureEndBarline(tokens: MusicToken[]): MusicToken[] {
  if (tokens.length === 0 || !hasNoteLike(tokens)) return tokens
  const last = tokens[tokens.length - 1]
  if (last.kind === 'barline' && !last.voltaOnly) return tokens
  return [...tokens, { kind: 'barline', type: '|', pos: 0, raw: '|' } as BarlineToken]
}

/** 小节线源码（类型 + 修饰 + 跳房子 + 备注/转调；不直接用 raw，避免 P1 拆分后的半截 raw） */
function barlineSourceOf(t: BarlineToken): string {
  const voltaStart = t.voltaStart
  const voltaSrc = (): string => {
    if (!voltaStart) return ''
    let s = '['
    s += '+'.repeat(voltaStart.plus ?? 0)
    s += '-'.repeat(voltaStart.minus ?? 0)
    if (voltaStart.slash) s += '/'
    if (voltaStart.comment) s += `"${voltaStart.comment}"`
    return s
  }
  if (t.voltaOnly) return voltaSrc()
  let s = t.type
  for (const m of t.marks ?? []) s += `&${m}`
  if (t.voltaEnd) s += ']'
  if (t.voltaEndSlash) s += '/'
  s += voltaSrc()
  const kc = t.keyChange
  if (kc || t.comment) {
    let q = ''
    if (kc) {
      if (kc.clear) q += 'd:'
      else if (kc.keyText) q += `d:1=${kc.keyText}`
      else if (kc.targetKey !== undefined) q += `d:1=${KEY_NAMES[((Math.round(kc.targetKey) % 12) + 12) % 12]}`
      else q += 'd:'
    }
    q += t.comment ?? ''
    s += `"${q}"`
  }
  return s
}

const KEY_NAMES = ['C', '#C', 'D', '$E', 'E', 'F', '#F', 'G', '#G', 'A', '$B', 'B']

/** 一个 token 块 → 源码（段内递归；块间单空格） */
function serializeTokens(tokens: readonly MusicToken[]): string {
  const parts: string[] = []
  for (const t of tokens) {
    if (t.kind === 'segment') {
      if (t.dir === 'open') {
        parts.push(t.raw)
        if (t.children && t.children.length > 0) parts.push(serializeTokens(t.children))
      } else {
        parts.push(t.raw)
      }
      continue
    }
    if (t.kind === 'barline') {
      parts.push(barlineSourceOf(t))
      continue
    }
    parts.push(t.raw)
  }
  return parts.filter((s) => s !== '').join(' ')
}

/** 歌词槽位 → 源码字符偏移（含 `{tp}` 起点；用于按断点切片） */
function offsetAtSlot(ly: LyricLine, content: string, slot: number): number {
  let best = content.length
  if (slot < ly.chars.length) best = Math.min(best, ly.chars[slot].pos)
  for (const v of ly.variants ?? []) {
    if (v.slot === slot) best = Math.min(best, v.pos)
  }
  return best
}

function trimTrailingAt(s: string): string {
  let out = s.trim()
  out = out.replace(/(?:\s*@)+\s*$/, '').trim()
  return out
}

function lyricPrefixOf(ly: LyricLine): string {
  return `C${ly.voice === 1 ? '' : ly.voice}:`
}

/** 一行 C 源码按槽位 [from,to) 切一段；等价于“补 @ 到满 → 切 → 删行末 @” */
function lyricPieceOf(ly: LyricLine, content: string, from: number, to: number): string {
  const a = Math.max(0, Math.min(content.length, offsetAtSlot(ly, content, from)))
  const b = Math.max(a, Math.min(content.length, offsetAtSlot(ly, content, to)))
  return trimTrailingAt(content.slice(a, b))
}

interface UnitReflow {
  lines: string[]
  breaks: { unit: number; measure: number }[]
  measureCount: number
  warnings: string[]
}

/** 重排一个排版单元（含 `{tp}` 的单元单独走这里，歌词按源码切片保 `{tp}` 原文） */
function reflowUnit(unit: UnitInfo, opts: ReflowOptions, cfg: PageConfig): UnitReflow {
  const parts = partsOfGroups(unit.groups)
  const { starts, measureCount, warnings } = planStartsForParts(parts, opts, cfg)
  closeVoltasInRow(parts, starts)
  repositionSlashEnds(parts, starts)
  const piecesByGroup = new Map<MusicGroup, MusicToken[][]>()
  const slotAtByGroup = new Map<MusicGroup, number[]>()
  for (const group of unit.groups) {
    const tokens = qTokensOf(group)
    piecesByGroup.set(group, splitVoiceTokens(tokens, starts, measureCount))
    slotAtByGroup.set(group, boundarySlotsOf(tokens, measureCount))
  }

  const out: string[] = []
  for (let row = 0; row < starts.length - 1; row++) {
    for (const group of unit.groups) {
      const music = group.music
      const prefix = `Q${music.voice === 1 ? '' : music.voice}${music.voiceName ? `"${music.voiceName}"` : ''}:`
      const piece = ensureEndBarline(piecesByGroup.get(group)?.[row] ?? [])
      out.push(piece.length === 0 ? prefix : `${prefix} ${serializeTokens(piece)}`)

      const from = starts[row]
      const to = starts[row + 1]
      const slots = slotAtByGroup.get(group) ?? []
      const fromSlot = slots[from] ?? 0
      const toSlot = slots[to] ?? fromSlot
      const content = (ly: LyricLine): string => {
        // 原始 C 行内容：从 raw 里剥掉 `C...:` 前缀
        const m = /^\s*C\d*\s*:\s*(.*)$/.exec(ly.raw.trim())
        return m ? m[1] : ly.chars.map((c) => c.raw).join(' ')
      }
      for (const ly of group.lyrics) {
        const text = lyricPieceOf(ly, content(ly), fromSlot, toSlot)
        // 用户 2026-11-24：空 C 行（没有歌词）直接删除，不写空 `C:`
        if (text === '') continue
        out.push(`${lyricPrefixOf(ly)} ${text}`)
      }
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()

  return {
    lines: out,
    breaks: starts.slice(0, -1).map((m) => ({ unit: unit.index, measure: m + 1 })),
    measureCount,
    warnings,
  }
}

/** 歌词槽位文本（含引号注释/后缀标点；`@` 仍写 `@`） */
function lyricSlotTextOf(ch: LyricChar | undefined): string {
  if (!ch || ch.skip) return '@'
  let s = ch.raw || ch.text || ''
  if (ch.note) s = `"${ch.note}" ${s}`
  if (ch.trailing) s += ch.trailing
  return s.trim() === '' ? '@' : s
}

/** 一条 C 行 → 按音符槽位补齐的字符串数组（缺的补 `@`） */
function slotsOfLyricLine(ly: LyricLine | undefined, slotCount: number): string[] {
  const out: string[] = []
  const chars = ly?.chars ?? []
  for (let i = 0; i < slotCount; i++) out.push(lyricSlotTextOf(chars[i]))
  // 歌词比音符多（少见）：多出来的字并到最后一个槽，别静默丢
  if (chars.length > slotCount && out.length > 0) {
    const extra = chars.slice(slotCount).map((c) => lyricSlotTextOf(c)).join(' ')
    out[out.length - 1] = `${out[out.length - 1]} ${extra}`.trim()
  }
  return out
}

/** 槽位数组 → 一段 C 行文本；行末 `@` 删除 */
function joinLyricSlots(slots: string[]): string {
  const arr = [...slots]
  while (arr.length > 0) {
    const last = arr[arr.length - 1]
    if (last === '@' || last.trim() === '') arr.pop()
    else break
  }
  return arr.join(' ').trim()
}

/**
 * 把一个 run 里同一声部的多个 Q 行**首尾相接**成一条连续 token 流。
 * 单元边界补 `|`；两边都是小节线时按合并表并成一根（`|`+`|:` → `|:`、`:|`+`|:` → `:|:`），
 * 不制造空小节。
 */
function mergedTokensOf(units: UnitInfo[], voice: number): MusicToken[] {
  const merged: MusicToken[] = []
  for (let ui = 0; ui < units.length; ui++) {
    const group = units[ui].groups.find((g) => g.music.voice === voice)
    if (!group) continue
    const toks = qTokensOf(group)
    if (toks.length === 0) continue
    if (merged.length > 0 && !isBoundary(merged[merged.length - 1]) && hasNoteLike(toks)) {
      merged.push(barOf('|'))
    }
    let start = 0
    if (toks[0].kind === 'barline' && merged.length > 0) {
      const last = merged[merged.length - 1]
      if (last.kind === 'barline' && !last.voltaOnly) {
        merged[merged.length - 1] = joinBarlineTokens(last, toks[0]).token
        start = 1
      }
    }
    merged.push(...toks.slice(start))
    if (ui < units.length - 1 && hasNoteLike(toks) && merged.length > 0 && !isBoundary(merged[merged.length - 1])) {
      merged.push(barOf('|'))
    }
  }
  return merged
}

/**
 * 重排一个“同声部集合”的连续段：**先把段内所有 Q 行合并成一条连续谱**，
 * 再按规则重新断行。这是用户 2026-11-23 明确要求的“整体合并再拆分”，
 * 不是逐条 Q 行各自重排。
 */
function reflowRun(units: UnitInfo[], opts: ReflowOptions, cfg: PageConfig): UnitReflow {
  const first = units[0]
  const voices = first.groups.map((g) => g.music.voice)
  const parts: VoicePart[] = []
  const verseSlots = new Map<number, string[][]>()
  const voiceNames = new Map<number, string | undefined>()

  for (const voice of voices) {
    const merged = mergedTokensOf(units, voice)
    const groups = units
      .map((u) => u.groups.find((g) => g.music.voice === voice))
      .filter((g): g is MusicGroup => g !== undefined)
    // 一曲行一词行：按“词行序号”合并；缺这一词行的曲行补 `@`
    const maxVerses = Math.max(0, ...groups.map((g) => g.lyrics.length))
    const streams: string[][] = Array.from({ length: maxVerses }, () => [])
    for (const group of groups) {
      const slotCount = qTokensOf(group).filter(isDurational).length
      for (let k = 0; k < maxVerses; k++) {
        streams[k].push(...slotsOfLyricLine(group.lyrics[k], slotCount))
      }
    }
    parts.push({ voice, tokens: merged, segs: splitBars(merged), lyrics: [] })
    verseSlots.set(voice, streams)
    voiceNames.set(voice, groups.find((g) => g.music.voiceName)?.music.voiceName)
  }

  const { starts, measureCount, warnings } = planStartsForParts(parts, opts, cfg)
  closeVoltasInRow(parts, starts)
  repositionSlashEnds(parts, starts)
  const piecesByVoice = new Map<number, MusicToken[][]>()
  const slotAtByVoice = new Map<number, number[]>()
  for (const p of parts) {
    piecesByVoice.set(p.voice, splitVoiceTokens(p.tokens, starts, measureCount))
    slotAtByVoice.set(p.voice, boundarySlotsOf(p.tokens, measureCount))
  }

  const out: string[] = []
  for (let row = 0; row < starts.length - 1; row++) {
    for (const p of parts) {
      const voice = p.voice
      const piece = ensureEndBarline(piecesByVoice.get(voice)?.[row] ?? [])
      const from = starts[row]
      const to = starts[row + 1]
      const slots = slotAtByVoice.get(voice) ?? []
      const fromSlot = slots[from] ?? 0
      const toSlot = slots[to] ?? fromSlot
      const streams = verseSlots.get(voice) ?? []
      const texts = streams.map((stream) => joinLyricSlots(stream.slice(fromSlot, toSlot)))
      // 声部在这一行已经结束（缩声部之后没有音、也没有词）⇒ 不输出空 Q/C 行
      if (piece.length === 0 && texts.every((t) => t === '')) continue
      const name = voiceNames.get(voice)
      const prefix = `Q${voice === 1 ? '' : voice}${name ? `"${name}"` : ''}:`
      out.push(piece.length === 0 ? prefix : `${prefix} ${serializeTokens(piece)}`)
      for (let k = 0; k < texts.length; k++) {
        const text = texts[k]
        // 用户 2026-11-24：空 C 行（没有歌词）直接删除，不写空 `C:`
        if (text === '') continue
        out.push(`C${voice === 1 ? '' : voice}: ${text}`)
      }
    }
  }

  return {
    lines: out,
    breaks: starts.slice(0, -1).map((m) => ({ unit: first.index, measure: m + 1 })),
    measureCount,
    warnings,
  }
}

/**
 * 把单元切成“同声部集合”的连续 run。
 * 换声部集合、`[fenye]`、带 `{tp}` 的单元、行首裸 `[` 都必须断开；
 * 其余连续 Q 行合并成一条连续谱再重排。
 */
function buildRuns(units: UnitInfo[]): UnitInfo[][] {
  const runs: UnitInfo[][] = []
  let cur: UnitInfo[] = []
  /** 上一个单元的声部集合（只允许“缩声部”，不允许中途加声部；加了就另起一段） */
  let prevVoices = ''
  let curTp = false
  const setOf = (s: string): Set<number> =>
    new Set(s === '' ? [] : s.split(',').map((v) => Number(v)))
  const flush = (): void => {
    if (cur.length === 0) return
    runs.push(cur)
    cur = []
    prevVoices = ''
    curTp = false
  }
  for (const u of units) {
    const voices = u.groups.map((g) => g.music.voice).sort((a, b) => a - b).join(',')
    const tp = hasTpUnit(u)
    const prevSet = setOf(prevVoices)
    const nextSet = setOf(voices)
    const subset = cur.length > 0 && [...nextSet].every((v) => prevSet.has(v))
    if (
      cur.length > 0 &&
      (u.pageBreakBefore || tp || curTp || !subset)
    ) {
      flush()
    }
    cur.push(u)
    prevVoices = voices
    curTp = tp
    if (tp) flush()
  }
  flush()
  return runs
}


/** 从源码建页面配置（缺省读 `# jps-config`） */
function configOf(source: string, opts: ReflowOptions): PageConfig {
  if (opts.pageConfig) return opts.pageConfig
  const embedded = extractJpsConfig(source)
  return { ...defaultPageConfig, ...(embedded ?? {}) }
}

/**
 * 重排 `source`：先把同一“声部集合”的连续 Q 行整体合并成一条连续谱，
 * 再按“最多 N 小节 / 固定占宽 / 目标行数”重新断行；多声部共用同一组小节断点。
 *
 * 纯函数：不读写全局、不碰 DOM；调用方负责把 `source` 写回文档（一步撤销）。
 */
export function reflowJps(source: string, opts: ReflowOptions = {}): ReflowResult {
  const result = parseJps(source)
  const cfg = configOf(source, opts)
  const units = buildUnits(result)
  const runs = buildRuns(units)
  const runByStart = new Map<number, UnitInfo[]>()
  for (const run of runs) runByStart.set(run[0].startLine, run)
  const skip = new Set<number>()
  for (const u of units) for (const i of u.skip) skip.add(i)

  const out: string[] = []
  const breaks: { unit: number; measure: number }[] = []
  const warnings: string[] = []
  let measures = 0
  for (let i = 0; i < result.lines.length; i++) {
    const run = runByStart.get(i)
    if (run) {
      for (const u of run) out.push(...u.preamble)
      // 带 {tp} 的单元单独走源码切片；其余先合并整个 run 再拆分
      const r = run.length === 1 && hasTpUnit(run[0]) ? reflowUnit(run[0], opts, cfg) : reflowRun(run, opts, cfg)
      out.push(...r.lines)
      breaks.push(...r.breaks)
      warnings.push(...r.warnings)
      measures += r.measureCount
      continue
    }
    if (skip.has(i)) continue
    out.push(result.lines[i].raw)
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return { source: `${out.join('\n')}\n`, breaks, measures, warnings }
}
