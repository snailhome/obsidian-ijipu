/**
 * engine/cursorMap.ts — 编辑器 ↔ 谱面位置双向映射（M3 核心）
 *
 * 契约：layout 为每个音符输出稳定 id（"page_voice_group_index"），
 * 并渲染为 SVG 的 data-notepos（音符）/ data-cipos（歌词）属性。
 * 本模块在编辑器端复现该编号规则，实现：
 *  - codePosToNoteId：编辑器光标位置 → 音符 id（仅 Q 行内联动）
 *  - noteIdToCodePos：音符 id → 编辑器字符位置（点击谱面跳转）
 */
import { tokenizeMusicLine, matchSegmentHead, findSegmentEnd } from './parser/tokenizer'
import { isDurational, decodeSegmentNoteId, decodeTpNoteId, segmentNoteIndexBase, tpNoteIndexBase } from './layout/segments'
import type { MusicToken, ScoreLayout } from './types'

const Q_RE = /^Q(\d*)(?:"[^"]*")?\s*:(.*)$/
const C_RE = /^C(\d*)\s*:\s*(.*)$/
const ID_RE = /^(\d+)_(\d+)_(\d+)_(\d+)$/

export interface NoteIdParts {
  page: number
  voice: number
  group: number
  index: number
}

export function parseNoteId(id: string): NoteIdParts | null {
  const m = ID_RE.exec(id)
  if (!m) return null
  return { page: +m[1], voice: +m[2], group: +m[3], index: +m[4] }
}

const isNoteToken = (t: { kind: string }) =>
  t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'

/**
 * adj445：一行内临时段（`{bz …}` / `{dsb …}`）的源码位置信息。
 *
 * 段内 token 挂在段头 token 的 `children` 上，**不在**顶层 token 流里 ⇒ 主旋律的
 * 「第 n 个音符」计数器完全跳过它们。光标联动要处理段内音符，就必须自己按
 * 「段头 token 下标 + 段内时值序号」定位——与 layout 生成 id 时用的是同一套次序。
 */
interface SegmentSpan {
  /** 段头（open）token 在 token 序列中的下标（= layout 的 `seg.openIndex`） */
  openIndex: number
  /** `{` 所在列（光标进入段的下界） */
  openPos: number
  /** `}` 所在列（未闭合段取行尾哨兵；光标在段内的上界） */
  closePos: number
  /** 段内时值 token（源码次序；序号 = 下标） */
  notes: { pos: number }[]
}

/** 枚举一行内的临时段（按源码顺序） */
function segmentSpansOf(tokens: MusicToken[]): SegmentSpan[] {
  const out: SegmentSpan[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind !== 'segment' || t.dir !== 'open') continue
    const next = tokens[i + 1]
    const paired = next && next.kind === 'segment' && next.dir === 'close' && next.type === t.type
    // 未闭合（tokenizer 兜底路径）时段内内容一直延伸到行尾 ⇒ 上界取哨兵值
    const closePos = paired ? next.pos : Number.MAX_SAFE_INTEGER
    const notes: { pos: number }[] = []
    for (const c of t.children ?? []) if (isDurational(c)) notes.push(c)
    out.push({ openIndex: i, openPos: t.pos, closePos, notes })
  }
  return out
}

/**
 * 光标列 → 所在临时段内的音符（返回段头下标 + 段内时值序号）；不在任何段内返回 null。
 *
 * 取法与主旋律一致（「光标处或紧邻左侧的音符」）：点击段内任意位置（含音符间的空隙）
 * 都对应它左边那个音；光标在段头 `{bz` 之前没有左邻音时取段内**第一个**音。
 */
function locateSegmentNote(
  tokens: MusicToken[],
  col: number,
): { openIndex: number; durSeq: number } | null {
  for (const sp of segmentSpansOf(tokens)) {
    if (col < sp.openPos || col > sp.closePos) continue
    if (sp.notes.length === 0) return null
    let last = 0
    let k = 0
    for (const n of sp.notes) {
      if (n.pos > col) break
      last = k
      k++
    }
    return { openIndex: sp.openIndex, durSeq: Math.min(last, sp.notes.length - 1) }
  }
  return null
}

/**
 * adj629d：**歌词行里的替谱段** `{tp … }`（用户报「点预览里替谱部分的音符不跳脚本、试听也点不过去」）。
 *
 * 替谱段的段头 token 是解析期**注入**到曲行 token 流里的，源码侧（本模块只重新分词 `Q:` 行）
 * 复现不出那个下标；因此替谱音符的 id 改用**源码可推导**的三元组
 * 「组号 + 歌词行号 + 该行内第几个 `{tp}` + 段内时值序号」（见 `layout/segments.ts`）。
 * 这里提供两个方向共用的"扫源码"工具。
 */
interface TpSpan {
  /** `{` 在本行内容里的列 */
  openPos: number
  /** `}` 的列（未闭合取行尾） */
  closePos: number
  /** 段内容起点列（跳过 `{tp` 后的空白） */
  contentStart: number
  /** 段内容终点列 */
  contentEnd: number
}

/** 枚举一条歌词行内容里的全部 `{tp … }`（按源码顺序） */
function tpSpansOf(body: string): TpSpan[] {
  const out: TpSpan[] = []
  let i = 0
  while (i < body.length) {
    if (body[i] === '{' && matchSegmentHead(body, i) === 'tp') {
      let k = i + 3
      while (k < body.length && (body[k] === ' ' || body[k] === '\t')) k++
      const end = findSegmentEnd(body, k)
      out.push({
        openPos: i,
        closePos: end === -1 ? body.length : end,
        contentStart: k,
        contentEnd: end === -1 ? body.length : end,
      })
      if (end === -1) break
      i = end + 1
      continue
    }
    i++
  }
  return out
}

/** 段内时值 token（源码次序；序号 = 下标） */
function durationalsOf(body: string, sp: TpSpan): { pos: number }[] {
  const { tokens } = tokenizeMusicLine(body.slice(sp.contentStart, sp.contentEnd), { line: 1, col: sp.contentStart })
  return tokens.filter(isDurational)
}

/**
 * 光标在本行内容里的列 → 命中的替谱段序号与段内音符序号（取"光标处或紧邻左侧的音"，
 * 与段层 `{bz}` 的 `locateSegmentNote` 同一口径）。
 */
function locateTpNote(body: string, col: number): { variantIdx: number; durSeq: number } | null {
  const spans = tpSpansOf(body)
  for (let vi = 0; vi < spans.length; vi++) {
    const sp = spans[vi]
    if (col < sp.openPos || col > sp.closePos) continue
    const notes = durationalsOf(body, sp)
    if (notes.length === 0) return null
    let last = 0
    let k = 0
    for (const n of notes) {
      if (n.pos > col - sp.contentStart) break
      last = k
      k++
    }
    return { variantIdx: vi, durSeq: Math.min(last, notes.length - 1) }
  }
  return null
}

/** 一条源码行的定位信息（列基准用） */
interface LineInfo {
  /** 去掉行首缩进后的内容 */
  trimmed: string
  /** 行首空白数 */
  leading: number
  /** 「字段头 + 空格」的长度（内容起点列） */
  headLen: number
  /** 字段内容（`Q: ` / `C…: ` 之后） */
  body: string
  voice: number
}

function lineInfoOf(raw: string, m: RegExpExecArray): LineInfo {
  const leading = raw.length - raw.trimStart().length
  const trimmed = raw.trim()
  const body = m[2] ?? ''
  return { trimmed, leading, headLen: trimmed.length - body.length, body, voice: m[1] === '' ? 1 : Number(m[1]) }
}

/** 编辑器光标位置（0-based）→ notepos id；非 Q 行或超出范围返回 null
 *  @param indexToPage 布局时生成的「全局音符 index → 物理页 page」（自动分页一致）；缺省回退 [fenye] 计 */
export function codePosToNoteId(code: string, pos: number, indexToPage?: Map<number, number>): string | null {
  const lines = code.replace(/\r\n/g, '\n').split('\n')

  // 定位光标所在行
  let lineIdx = -1
  let lineStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (pos <= lineStart + lines[i].length) {
      lineIdx = i
      break
    }
    lineStart += lines[i].length + 1
  }
  if (lineIdx === -1) return null

  let page = 0
  let group = -1
  let noteCounter = 0
  let target: string | null = null
  /** adj629d：每个曲行（组）已依附的歌词行（行号 + 内容），供"光标落在 `C` 行的 `{tp}` 里"定位 */
  const groupLyrics: { line: number; info: LineInfo }[][] = []
  const groupVoices: number[] = []

  for (let i = 0; i <= lineIdx; i++) {
    const raw = lines[i]
    const leading = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed === '[fenye]') {
      page++
      continue
    }
    // adj629d：`C…:` 行——先按 parser 的依附规则（最近一个同声部曲行）登记，再看光标是否落在替谱段里
    const cm = C_RE.exec(trimmed)
    if (cm) {
      const li = lineInfoOf(raw, cm)
      let gi = -1
      for (let k = groupVoices.length - 1; k >= 0; k--) {
        if (groupVoices[k] === li.voice) {
          gi = k
          break
        }
      }
      if (gi < 0) gi = groupVoices.length - 1
      if (gi >= 0) {
        groupLyrics[gi] = groupLyrics[gi] ?? []
        const lineIdxInGroup = groupLyrics[gi].length
        groupLyrics[gi].push({ line: i, info: li })
        if (i === lineIdx) {
          const hit = locateTpNote(li.body, pos - lineStart - li.leading - li.headLen)
          if (!hit) return null
          const gIdx = tpNoteIndexBase(gi, lineIdxInGroup, hit.variantIdx) + hit.durSeq
          const pg = indexToPage?.get(gIdx) ?? page
          // 声部号取**所属曲行**的声部（`C2:` 的 2 是"第 2 条歌词行"的写法，不是声部号——
          // 与 parser 的依附规则一致：找不到同声部曲行时依附到最近的那个曲行）
          return `${pg}_${groupVoices[gi] ?? li.voice}_${gi}_${gIdx}`
        }
      }
      // 注意：**不能**在这里累加 `lineStart`——它是第一个循环算出的"光标所在行的起点"，
      // 第二个循环只在**光标行之前的行**上做登记（列基准必须保持为光标行起点）。
      continue
    }
    const m = Q_RE.exec(trimmed)
    if (!m) continue
    const qi = lineInfoOf(raw, m)
    group++
    groupVoices[group] = qi.voice
    groupLyrics[group] = groupLyrics[group] ?? []
    const content = qi.body
    const { tokens } = tokenizeMusicLine(content, { line: i + 1, col: 0 })
    const noteTokens = tokens.filter(isNoteToken)

    if (i === lineIdx) {
      // 光标所在 Q 行：定位「光标处/光标前最近音符」（块级，adj230）
      // 原逻辑用 >= break → 光标落在音符块末尾空隙时取到右侧下一个音符
      // （「点第一个高亮第二个」的 ±1 错位）；改为取光标处或紧邻左侧的音符，
      // 点击块内任意位置（含块末空隙/行尾）都对应本块
      const col = pos - lineStart - leading // 相对 trimmed 行的列
      const headLen = trimmed.length - content.length
      const voice = qi.voice
      // adj445：光标落在临时段 `{bz …}` / `{dsb …}` 内 → **段内音符**（用户报「点 {bz} 里的音符不联动」）。
      // 段内音符不在主旋律音符流里，必须单独定位；id 用 layout 同一套「组号 + 段头下标 + 段内时值序号」编码。
      // 注：token 的 `pos` 相对**曲行内容**（`Q:` 之后那段），故减掉 `headLen` 再比较。
      const hit = locateSegmentNote(tokens, col - headLen)
      if (hit) {
        const gIdx = segmentNoteIndexBase(group, hit.openIndex) + hit.durSeq
        const pg = indexToPage?.get(gIdx) ?? page
        target = `${pg}_${voice}_${group}_${gIdx}`
        break
      }
      let local = 0
      let last = 0
      for (const t of tokens) {
        if (t.pos + headLen > col) break
        if (isNoteToken(t)) {
          last = local
          local++
        }
      }
      if (noteTokens.length === 0) return null
      const idx = Math.min(last, noteTokens.length - 1)
      const gIdx = noteCounter + idx
      // adj291：page 用实际布局的物理页（自动分页也一致），与音符 id 的 page 对齐；无映射回退 [fenye] 计
      const pg = indexToPage?.get(gIdx) ?? page
      target = `${pg}_${voice}_${group}_${gIdx}`
      break
    }
    noteCounter += noteTokens.length
  }
  return target
}

/** notepos id → 编辑器字符位置；找不到返回 null */
export function noteIdToCodePos(code: string, id: string): number | null {
  const parts = parseNoteId(id)
  if (!parts) return null

  const lines = code.replace(/\r\n/g, '\n').split('\n')
  const lineStartOf = (n: number): number => {
    let acc = 0
    for (let i = 0; i < n && i < lines.length; i++) acc += lines[i].length + 1
    return acc
  }
  let page = 0
  let noteCounter = 0
  let lineStart = 0
  let group = -1
  // adj445：段内音符 id（高位命名空间）→ 用「组号（= 第几个 Q 行）+ 段头下标 + 段内时值序号」定位
  const seg = decodeSegmentNoteId(parts.index)
  /**
   * adj629d：**替谱段音符**（写歌词行里的 `{tp … }`）——`openIndex` 是注入后的下标、源码侧没有，
   * 改用 id 里的「歌词行号 + 行内第几个 `{tp}` + 段内时值序号」：先按 parser 的依附规则
   * （`C…:` 依附最近一个同声部曲行）把歌词行归到各组，再在该行的第 n 个 `{tp}` 里取第 m 个音。
   */
  const tp = decodeTpNoteId(parts.index)
  if (tp) {
    const groupLyrics: { line: number; info: LineInfo }[][] = []
    const groupVoices: number[] = []
    let g = -1
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const trimmed = raw.trim()
      if (trimmed === '[fenye]') continue
      const cm = C_RE.exec(trimmed)
      if (cm) {
        const li = lineInfoOf(raw, cm)
        let gi = -1
        for (let k = groupVoices.length - 1; k >= 0; k--) {
          if (groupVoices[k] === li.voice) {
            gi = k
            break
          }
        }
        if (gi < 0) gi = groupVoices.length - 1
        if (gi >= 0) {
          groupLyrics[gi] = groupLyrics[gi] ?? []
          groupLyrics[gi].push({ line: i, info: li })
        }
        continue
      }
      const qm = Q_RE.exec(trimmed)
      if (!qm) continue
      g++
      groupVoices[g] = lineInfoOf(raw, qm).voice
      groupLyrics[g] = groupLyrics[g] ?? []
    }
    const ly = groupLyrics[tp.group]?.[tp.lineIdx]
    if (!ly) return null
    const spans = tpSpansOf(ly.info.body)
    const sp = spans[tp.variantIdx]
    if (!sp) return null
    const t = durationalsOf(ly.info.body, sp)[tp.durSeq]
    if (!t) return null
    return lineStartOf(ly.line) + ly.info.leading + ly.info.headLen + sp.contentStart + t.pos
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const leading = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed === '[fenye]') {
      page++
      lineStart += raw.length + 1
      continue
    }
    const m = Q_RE.exec(trimmed)
    if (!m) {
      lineStart += raw.length + 1
      continue
    }
    group++ // Q 行序号（与 layout 的组号 gi 同源）
    const content = m[2] ?? ''
    const { tokens } = tokenizeMusicLine(content, { line: i + 1, col: 0 })
    const headLen = trimmed.length - content.length

    // 段内音符：只在本组（本 Q 行）里找段头 token，再取段内第 durSeq 个时值 token
    if (seg) {
      if (group === seg.group) {
        const open = tokens[seg.openIndex]
        if (open && open.kind === 'segment' && open.dir === 'open') {
          const t = (open.children ?? []).filter(isDurational)[seg.durSeq]
          if (t) return lineStart + leading + headLen + t.pos
        }
        return null
      }
      lineStart += raw.length + 1
      continue
    }

    const noteTokens = tokens.filter(isNoteToken)

    if (noteCounter <= parts.index && parts.index < noteCounter + noteTokens.length) {
      // 目标音符在本行
      const local = parts.index - noteCounter
      const t = noteTokens[local]
      return lineStart + leading + headLen + t.pos
    }
    noteCounter += noteTokens.length
    lineStart += raw.length + 1
  }
  return null
}

/** 布局后的「全局音符 index → 物理页 page」映射（自动分页也一致）——供光标联动对齐音符 id 的 page */
export function buildIndexToPage(layout: ScoreLayout): Map<number, number> {
  const m = new Map<number, number>()
  for (const pg of layout.pages) for (const n of pg.notes) m.set(n.id.index, pg.index)
  return m
}
