/**
 * engine/parser/normalize.ts — 解析期「行首隐式小节线」归一化（adj1323）
 *
 * 用户口径（2026-11-23 定稿）：
 *  - 每个 `Q:` 行行首默认就是隐式隐藏小节线；行首写出来的 barline 一律并到上一行末；
 *  - 行首不需要 `|` / `|/` / `|*`；行首 `[` 直接写，不需要 `|/`；
 *  - `:|`、`|:`、`||`、`&hs` 等写到行首也会被搬到上一行末；
 *  - `| &dc |` 要理解成 `|&dc`（先挂修饰符再合并相邻 barline）；
 *  - `| |` 只留一根；
 *  - 首行普通 `|`/`|/`/`|*` 丢弃，语义线保留。
 *
 * 为什么放在解析期：排版、播放、流线谱、插件、CLI 都吃 `ParseResult` 的 token 流；
 * 在这里把边界收敛成“一根线”，下游不用各写一份合并规则。
 */
import type {
  BarlineMark,
  MusicGroup,
  MusicLine,
  MusicToken,
  ParseError,
  ParseResult,
} from '../types'
import { errAt } from './errors'
import { joinBarlineTokens } from './barlineJoin'

type BarlineTok = Extract<MusicToken, { kind: 'barline' }>

/** 小节线修饰符编码（裸写时给提示；写在 barline 后则挂上去） */
const BARLINE_MARK_CODES = new Set<BarlineMark>(['fine', 'dc', 'ds', 'ty', 'hs'])

/** `Q1"女声": ` 这类前缀的长度（token.pos 是行内容内偏移，加它才是整行列号） */
function contentPrefixLen(raw: string): number {
  const trimmed = raw.trim()
  const m = /^Q\d*(?:"[^"]*")?\s*:\s*/.exec(trimmed)
  return m ? m[0].length : 0
}

function isDurational(t: MusicToken): boolean {
  return t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
}

/** 这一行/这段 token 里有没有“内容”（音符/休止/节奏，或带 children 的段） */
function hasContent(tokens: readonly MusicToken[]): boolean {
  return tokens.some((t) => isDurational(t) || (t.kind === 'segment' && t.dir === 'open' && (t.children?.length ?? 0) > 0))
}

/** 第一根“非纯注释”的 token（跳过行首 voltaOnly） */
function firstRealToken(tokens: readonly MusicToken[]): MusicToken | undefined {
  for (const t of tokens) {
    if (t.kind === 'barline' && t.voltaOnly) continue
    return t
  }
  return undefined
}

function warningAt(music: MusicLine, pos: number, message: string, hint: string): ParseError {
  return errAt(message, music.pos.line, contentPrefixLen(music.raw) + Math.max(0, pos), 'warning', hint)
}

/**
 * 1）独立小节线修饰符归位：`| &dc |` → `|&dc` + `|`。
 *
 * 为什么放在最前：后面“行首收集 / 相邻合并”都按 barline token 走；先把 `&dc` 从
 * decoration 变成前一根 barline 的 `marks`，它才会参与合并。
 */
function foldBarlineMarkDecorations(groups: readonly MusicGroup[], errors: ParseError[]): void {
  for (const g of groups) {
    const music = g.music
    const out: MusicToken[] = []
    for (const t of music.tokens) {
      if (t.kind === 'decoration' && BARLINE_MARK_CODES.has(t.code as BarlineMark)) {
        const prev = out[out.length - 1]
        if (prev && prev.kind === 'barline' && !prev.voltaOnly) {
          const marks = prev.marks ?? []
          if (!marks.includes(t.code as BarlineMark)) prev.marks = [...marks, t.code as BarlineMark]
          continue
        }
        const atLineStart = out.length === 0
        errors.push(
          warningAt(
            music,
            t.pos,
            atLineStart
              ? `小节线修饰符 \`&${t.code}\` 不要裸放行首`
              : `小节线修饰符 \`&${t.code}\` 要写在小节线后`,
            atLineStart
              ? `请把它写在小节线后（建议上一行末，如 \`… |&${t.code}\`）；行首默认是隐式隐藏小节线，不需要 ` +
                  `\`|\` 打头。`
              : `\`&hs\`/\`&dc\`/\`&ty\`/\`&fine\`/\`&ds\` 属于小节线修饰符，如 \`… |&${t.code} 1 2\`。`,
          ),
        )
      }
      out.push(t)
    }
    music.tokens = out
  }
}

/** 拆出一根带 `[` 的小节线：类型/记号/`]` 归上一行末，`[` 变成行首 voltaOnly 注释 */
function splitVolta(t: BarlineTok): { typeTok: BarlineTok; anno: BarlineTok } {
  const typeTok: BarlineTok = {
    kind: 'barline',
    type: t.type,
    pos: t.pos,
    // 播放端只从 raw 里取 `[`/`]` 顺序：`[` 给注释，`]` 留给类型线
    raw: t.voltaEnd ? ']' : '',
  }
  if (t.marks) typeTok.marks = t.marks
  if (t.voltaEnd) typeTok.voltaEnd = true
  if (t.voltaEndSlash) typeTok.voltaEndSlash = true
  if (t.comment) typeTok.comment = t.comment
  if (t.keyChange) typeTok.keyChange = t.keyChange
  const anno: BarlineTok = {
    kind: 'barline',
    type: '|',
    voltaStart: t.voltaStart,
    voltaOnly: true,
    pos: t.pos,
    raw: '[',
  }
  return { typeTok, anno }
}

/** 行首连续 barline / volta 注释；返回剩下的 token 与拆出来的部分 */
function consumeLeading(tokens: MusicToken[], errors: ParseError[], music: MusicLine): {
  boundaries: BarlineTok[]
  volta: BarlineTok | null
  rest: MusicToken[]
} {
  const boundaries: BarlineTok[] = []
  let volta: BarlineTok | null = null
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.kind !== 'barline') break
    if (t.voltaOnly) {
      if (!volta) volta = t
      else errors.push(warningAt(music, t.pos, '同一行行首出现了多个跳房子起点，已保留第一个', '一个断点只需要一个 `[`。'))
      i++
      continue
    }
    if (t.voltaStart) {
      const { typeTok, anno } = splitVolta(t)
      if (!volta) volta = anno
      else errors.push(warningAt(music, t.pos, '同一行行首出现了多个跳房子起点，已保留第一个', '一个断点只需要一个 `[`。'))
      boundaries.push(typeTok)
      i++
      continue
    }
    boundaries.push(t)
    i++
  }
  return { boundaries, volta, rest: tokens.slice(i) }
}

/** 把一串 barline 合成一根（从左到右） */
function reduceBoundaries(boundaries: BarlineTok[], music: MusicLine, errors: ParseError[]): BarlineTok | null {
  if (boundaries.length === 0) return null
  let cur = boundaries[0]
  for (let i = 1; i < boundaries.length; i++) {
    const { token, warnings } = joinBarlineTokens(cur, boundaries[i])
    cur = token
    for (const w of warnings) errors.push(warningAt(music, boundaries[i].pos, w, '请合并成一条小节线，保留正确的类型。'))
  }
  return cur
}

/** 这根线是不是“普通线”（没有语义/记号/备注/转调/终点） */
function isPlainBoundary(t: BarlineTok): boolean {
  return (
    (t.type === '|' || t.type === '|/' || t.type === '|*') &&
    !t.marks?.length &&
    !t.comment &&
    !t.keyChange &&
    !t.voltaEnd &&
    !t.voltaEndSlash
  )
}

/** 首行/上一行无内容：普通线丢弃；带属性转隐藏；语义线保留 */
function firstLineBoundary(merged: BarlineTok): BarlineTok | null {
  if (isPlainBoundary(merged)) return null
  if (merged.type === '|' || merged.type === '|/' || merged.type === '|*') {
    // 普通线但带记号/备注/转调：保留记号，但不画行首竖线
    return { ...merged, type: '|/' }
  }
  return merged
}

/**
 * adj1324：这根线是否带“作用于下一小节”的拍号/转调备注。
 * 这种线不能整根并到上一行末（否则显示到上一行行尾）；只把线型并过去，
 * 备注/转调搬到当前行行首的隐藏线上（“裸起开头”）。
 */
function hasMeasureChange(t: BarlineTok): boolean {
  if (t.keyChange !== undefined) return true
  return t.comment !== undefined && /p\s*:\s*\d+\s*\/\s*\d+/i.test(t.comment)
}

/** 把一行行首的边界归到上一行末（或首行规则） */
function applyLeading(
  music: MusicLine,
  prev: MusicLine | null,
  boundaries: BarlineTok[],
  volta: BarlineTok | null,
  errors: ParseError[],
): void {
  const prevHasContent = prev !== null && hasContent(prev.tokens)
  if (!prevHasContent) {
    const merged = reduceBoundaries(boundaries, music, errors)
    const head: MusicToken[] = []
    if (merged) {
      const kept = firstLineBoundary(merged)
      if (kept) head.push(kept)
    }
    if (volta) {
      // 首行普通 `|` + `[`：类型线丢弃，只留注释；语义线 + `[`：合并到同一根线上
      const last = head[head.length - 1]
      if (last && last.kind === 'barline') {
        last.voltaStart = volta.voltaStart
        // 只有“纯注释”（没有任何要画的记号/备注/终点）才标 voltaOnly；
        // 带 &hs / "p:2/4" 的隐藏线仍要渲染记号，不能整根 return ''
        last.voltaOnly =
          last.type === '|/' || last.type === '|*'
            ? !last.marks?.length && !last.comment && !last.keyChange && !last.voltaEnd
            : false
        last.raw = `${last.raw}[`
      } else {
        head.push(volta)
      }
    }
    music.tokens = [...head, ...music.tokens]
    return
  }

  // 非首行：有边界就并到上一行末；没有边界就什么都不加。
  // adj1324：拍号/转调（`p:` / `d:`）作用于下一小节 ⇒ 备注搬到当前行行首，不留在上一行末。
  const carries: BarlineTok[] = []
  for (const b of boundaries) {
    let carried: BarlineTok | null = null
    if (hasMeasureChange(b)) {
      carried = { kind: 'barline', type: '|/', pos: b.pos, raw: '|/', bareAnnotation: true }
      if (b.comment !== undefined) carried.comment = b.comment
      if (b.keyChange !== undefined) carried.keyChange = b.keyChange
      delete b.comment
      delete b.keyChange
    }
    const last = prev!.tokens[prev!.tokens.length - 1]
    if (last && last.kind === 'barline') {
      const { token, warnings } = joinBarlineTokens(last, b)
      prev!.tokens[prev!.tokens.length - 1] = token
      for (const w of warnings) errors.push(warningAt(music, b.pos, w, '请合并成一条小节线，保留正确的类型。'))
    } else {
      prev!.tokens.push(b)
    }
    if (carried !== null) carries.push(carried)
  }
  if (carries.length > 0) music.tokens = [...carries, ...music.tokens]
  if (volta) music.tokens.unshift(volta)
}

/** 行内/段内相邻 barline 合并（含段 children / 歌词替谱段） */
function collapseAdjacent(tokens: MusicToken[], music: MusicLine, errors: ParseError[]): MusicToken[] {
  const out: MusicToken[] = []
  for (const t of tokens) {
    if (t.kind === 'segment') {
      if (t.dir === 'open' && t.children) t.children = collapseAdjacent(t.children, music, errors)
      out.push(t)
      continue
    }
    if (t.kind === 'barline' && out.length > 0) {
      const prev = out[out.length - 1]
      if (prev.kind === 'barline') {
        const { token, warnings } = joinBarlineTokens(prev, t)
        out[out.length - 1] = token
        for (const w of warnings) errors.push(warningAt(music, t.pos, w, '请合并成一条小节线，保留正确的类型。'))
        continue
      }
    }
    out.push(t)
  }
  return out
}

/** 建排版单元，记每个 group 的单元声部数（末尾 `[` 单/多声部判断用） */
function unitVoiceCountOf(result: Pick<ParseResult, 'lines' | 'groups'>): Map<number, number> {
  const groupOf = new Map<MusicLine, number>()
  result.groups.forEach((g, i) => groupOf.set(g.music, i))
  const out = new Map<number, number>()
  let cur: number[] = []
  let voices = new Set<number>()
  const flush = (): void => {
    const n = voices.size
    for (const gi of cur) out.set(gi, n)
    cur = []
    voices = new Set()
  }
  for (const line of result.lines) {
    if (line.kind === 'pagebreak') {
      flush()
      continue
    }
    if (line.kind !== 'music') continue
    const gi = groupOf.get(line)
    if (gi === undefined) continue
    if (voices.has(line.voice)) flush()
    cur.push(gi)
    voices.add(line.voice)
  }
  flush()
  return out
}

/**
 * 解析期归一化入口。
 *
 * 调用点：`parseJps()` 建完 `groups/lines` 之后、`injectLyricVariants()` 之前。
 * 只搬 barline token，不合并 Q 行本身（C 行、多声部、分页结构都不动）。
 */
export function normalizeLineBoundaries(result: Pick<ParseResult, 'lines' | 'groups'>): ParseError[] {
  const errors: ParseError[] = []
  if (result.groups.length === 0) return errors

  // 1) `| &dc |` → `|&dc |`
  foldBarlineMarkDecorations(result.groups, errors)

  // 2) 逐行：行首边界归到上一行末（或首行规则）
  const lastByVoice = new Map<number, MusicLine>()
  for (const g of result.groups) {
    const music = g.music
    const { boundaries, volta, rest } = consumeLeading(music.tokens, errors, music)
    music.tokens = rest
    applyLeading(music, lastByVoice.get(music.voice) ?? null, boundaries, volta, errors)
    // 3) 行内相邻 barline 合并（含段内）
    music.tokens = collapseAdjacent(music.tokens, music, errors)
    for (const ly of g.lyrics) {
      for (const v of ly.variants ?? []) v.tokens = collapseAdjacent(v.tokens, music, errors)
    }
    lastByVoice.set(music.voice, music)
  }

  // 4) 末尾 `[`：单声部自动搬到下一行行首；多声部只提示
  const unitVoices = unitVoiceCountOf(result)
  const groupIndexOf = new Map<MusicLine, number>()
  result.groups.forEach((g, gi) => groupIndexOf.set(g.music, gi))
  const nextByVoice = new Map<number, MusicLine>()
  for (let i = result.groups.length - 1; i >= 0; i--) {
    const music = result.groups[i].music
    const next = nextByVoice.get(music.voice)
    if (next) {
      const last = music.tokens[music.tokens.length - 1]
      if (last && last.kind === 'barline' && last.voltaStart && !last.voltaOnly) {
        const gi = i
        const nextGi = groupIndexOf.get(next) ?? -1
        const single = (unitVoices.get(gi) ?? 1) <= 1 && (unitVoices.get(nextGi) ?? 1) <= 1
        if (single) {
          const first = next.tokens[0]
          if (first && first.kind === 'barline' && first.voltaOnly) {
            // 下一行已经有 `[`，不重复搬；上一行末的 `[` 保持原样（宁可重复也不丢）
          } else {
            const vs = last.voltaStart
            delete last.voltaStart
            if (last.voltaEnd) last.raw = ']'
            else last.raw = ''
            next.tokens.unshift({ kind: 'barline', type: '|', voltaStart: vs, voltaOnly: true, pos: last.pos, raw: '[' })
          }
        } else {
          errors.push(
            warningAt(
              music,
              last.pos,
              '多声部行的末尾写了跳房子起点 `[`，本轮不自动搬到下一行',
              '请把 `[` 写到下一行行首（行首不需要 `|/`）：如 `Q2: ["1." …`。',
            ),
          )
        }
      }
    }
    nextByVoice.set(music.voice, music)
  }

  // 5) 断在小节中间：上一行末不是 barline、当前行首也不是 barline
  const prevByVoice = new Map<number, MusicLine>()
  for (const g of result.groups) {
    const music = g.music
    const prev = prevByVoice.get(music.voice)
    if (prev) {
      const prevLast = [...prev.tokens].reverse().find((t) => !(t.kind === 'barline' && t.voltaOnly))
      const curFirst = firstRealToken(music.tokens)
      if (
        prevLast &&
        curFirst &&
        prevLast.kind !== 'barline' &&
        curFirst.kind !== 'barline' &&
        hasContent(prev.tokens) &&
        hasContent(music.tokens)
      ) {
        errors.push(
          warningAt(
            music,
            curFirst.pos,
            '这一行从上一行的小节中间接下去：两边都没有小节线',
            '断行只能在小节线后。把 `|` 写上一行末（如 `… 1 2 |`），或把换行挪到小节线后。',
          ),
        )
      }
    }
    prevByVoice.set(music.voice, music)
  }

  return errors
}
