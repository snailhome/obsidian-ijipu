/**
 * engine/reflow/index.ts — 乐谱重排（P2，adj1324）
 *
 * 用户 2026-11-23 定稿：只在小节线后断行；多声部按同一小节断；歌词一起拆；
 * `{bz}` / `{dsb}` / `{tp}` 段覆盖的区间不可断；`[fenye]` 保留；每行末尾缺小节线补 `|`。
 *
 * 实现策略：**不碰 `placeVoiceBlock`**。重排把长多声部块切成多个“一块一行”的块，
 * 现有排版已经支持多个多声部块（大括号/声部名/块间对齐都是现成的）。
 *
 * 纯函数、零 DOM；应用对话框、以后 CLI 都只调 `reflowJps()`。
 */
import type {
  BarlineToken,
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
import { computeSegments } from '../layout/segments'
import { measureFixedWidth } from '../layout/index'
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
}

interface VoicePart {
  group: MusicGroup
  segs: ReturnType<typeof splitBars>
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

/** 页面内容宽（多声部扣一点块首大括号/声部名留白，保守一点） */
function availWidthOf(cfg: PageConfig, voices: number): number {
  const page = PAPER_SIZE[cfg.page]?.width ?? 595.28
  const pad = voices > 1 ? cfg.note_size * 2.2 : 0
  return Math.max(80, page - cfg.margin_left - cfg.margin_right - pad)
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
    })
    cur = []
    voices = new Set()
  }
  for (const line of result.lines) {
    if (line.kind === 'pagebreak') {
      flush()
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
function fixedWidthsOf(parts: VoicePart[], noteSize: number): number[] {
  const maxBars = Math.max(0, ...parts.map((p) => p.segs.length))
  const out = new Array<number>(maxBars).fill(0)
  for (const p of parts) {
    for (let b = 0; b < p.segs.length; b++) out[b] = Math.max(out[b], measureFixedWidth(p.segs[b], noteSize))
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

/**
 * 不可断的小节断点：段（`{bz}`/`{dsb}`/`{tp}`）跨越的小节边界、
 * 以及歌词 `{tp … }` 跨越的边界都不能断。
 */
function forbiddenBreaksOf(parts: VoicePart[], measureCount: number): Set<number> {
  const out = new Set<number>()
  for (const p of parts) {
    const tokens = qTokensOf(p.group)
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
    for (const ly of p.group.lyrics) {
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
): Plan {
  const starts: number[] = [0]
  const warnings: string[] = []
  let start = 0
  const allowed = (b: number): boolean => b > 0 && b < measureCount && !forbidden.has(b)
  const canBreak = (b: number): boolean => b === measureCount || allowed(b)
  let guard = 0
  while (start < measureCount && guard++ < measureCount + 2) {
    let end = start
    let sum = 0
    while (end < measureCount) {
      const count = end - start + 1
      if (count > maxMeasures) break
      const next = sum + fixed[end]
      if (next / avail > ratio && end > start) break
      sum = next
      end += 1
      if (end < measureCount && !canBreak(end)) continue // 段内不能断，继续往后吃
    }
    if (end <= start) end = start + 1
    let cut = end
    // 先向后找最近的合法断点；若超过 maxMeasures，回退到上限内最后一个合法断点
    if (cut < measureCount && !canBreak(cut)) {
      while (cut < measureCount && !canBreak(cut)) cut += 1
    }
    if (cut > measureCount) cut = measureCount
    if (cut - start > maxMeasures) {
      let best = -1
      for (let c = start + 1; c <= Math.min(measureCount, start + maxMeasures); c++) {
        if (canBreak(c)) best = c
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
  target: number,
): Plan {
  const warnings: string[] = []
  const allowedEnd = (b: number): boolean => b === measureCount || (b > 0 && b < measureCount && !forbidden.has(b))
  const maxK = Math.min(Math.max(1, target), measureCount)
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
  // 目标行数不可行时，找最近可行行数
  let chosen = -1
  for (let k = maxK; k >= 1; k--) {
    if (dp[k][measureCount] !== INF) {
      chosen = k
      break
    }
  }
  if (chosen < 0) {
    return greedyPlan(fixed, avail, measureCount, maxMeasures, ratio, forbidden)
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

function planStarts(
  unit: UnitInfo,
  opts: ReflowOptions,
  cfg: PageConfig,
): { starts: number[]; measureCount: number; warnings: string[] } {
  const parts: VoicePart[] = unit.groups.map((group) => ({ group, segs: splitBars(qTokensOf(group)) }))
  const measureCount = Math.max(1, ...parts.map((p) => countMeasures(qTokensOf(p.group))))
  const fixed = fixedWidthsOf(parts, cfg.note_size)
  const avail = availWidthOf(cfg, unit.groups.length)
  const forbidden = forbiddenBreaksOf(parts, measureCount)

  const hasTarget = Number.isFinite(opts.targetLineCount) && (opts.targetLineCount ?? 0) > 0
  const maxMeasures = Number.isFinite(opts.maxMeasuresPerLine) && (opts.maxMeasuresPerLine ?? 0) > 0
    ? Math.max(1, Math.floor(opts.maxMeasuresPerLine as number))
    : hasTarget || opts.fixedInkRatio !== undefined
      ? Number.POSITIVE_INFINITY
      : 4
  const ratioRaw = opts.fixedInkRatio
  const ratio = ratioRaw === undefined ? 1 : Math.min(1, Math.max(0.05, ratioRaw))
  const plan = hasTarget
    ? targetPlan(fixed, avail, measureCount, maxMeasures, ratio, forbidden, Math.floor(opts.targetLineCount as number))
    : greedyPlan(fixed, avail, measureCount, maxMeasures, ratio, forbidden)
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

/** 重排一个排版单元（一块一行或多声部块） */
function reflowUnit(unit: UnitInfo, opts: ReflowOptions, cfg: PageConfig): UnitReflow {
  const { starts, measureCount, warnings } = planStarts(unit, opts, cfg)
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
        // 只有一段词时，空段不写；多段词必须保留条数/顺序（否则“第几遍”会串）
        if (text === '' && group.lyrics.length === 1) continue
        out.push(`${lyricPrefixOf(ly)}${text === '' ? '' : ` ${text}`}`)
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

/** 从源码建页面配置（缺省读 `# jps-config`） */
function configOf(source: string, opts: ReflowOptions): PageConfig {
  if (opts.pageConfig) return opts.pageConfig
  const embedded = extractJpsConfig(source)
  return { ...defaultPageConfig, ...(embedded ?? {}) }
}

/**
 * 重排 `source`：只在小节线后断行，多声部按同一小节切块。
 *
 * 纯函数：不读写全局、不碰 DOM；调用方负责把 `source` 写回文档（一步撤销）。
 */
export function reflowJps(source: string, opts: ReflowOptions = {}): ReflowResult {
  const result = parseJps(source)
  const cfg = configOf(source, opts)
  const units = buildUnits(result)
  const unitByStart = new Map<number, UnitInfo>()
  for (const u of units) unitByStart.set(u.startLine, u)
  const skip = new Set<number>()
  for (const u of units) for (const i of u.skip) skip.add(i)

  const out: string[] = []
  const breaks: { unit: number; measure: number }[] = []
  const warnings: string[] = []
  let measures = 0
  for (let i = 0; i < result.lines.length; i++) {
    const unit = unitByStart.get(i)
    if (unit) {
      out.push(...unit.preamble)
      const r = reflowUnit(unit, opts, cfg)
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
