/**
 * engine/parser/parser.ts — .jps 源码行级解析器
 *
 * 将 .jps 文本解析为 ParseResult（描述头 + 行 AST + 曲词分组 + 错误列表）。
 * 语法依据手册：V/B/Z/D/P/J 描述头、Q/C 主体行（Q 后可带声部编号与名称）、
 * "[fenye]" 分页行、"#" 注释行。
 */
import type {
  Header,
  HeaderLine,
  LyricChar,
  LyricLine,
  MusicGroup,
  MusicLine,
  MusicToken,
  ParseError,
  ParseResult,
  SlurToken,
  SourceLine,
} from '../types'
import { tokenizeMusicLine } from './tokenizer'
import { tokenDuration } from '../duration'
import { errAt } from './errors'

const HEADER_KEYS = new Set(['V', 'B', 'Z', 'D', 'P', 'J', 'Y', 'S'])

/**
 * 拆解 J 描述头值（节拍）为「数字 + 文字」：
 *  - 纯数字 "80" → { num: "80" }（渲染 ♩=80）
 *  - 纯文字 "欢快地" → { text: "欢快地" }
 *  - "90 欢快地"（数字后跟空格再接文字）→ { num: "90", text: "欢快地" }
 *  - 其余（如 "120-140"、"96(稍快)" 无空格分隔）整体视为文字，保持原样
 */
export function splitTempo(value: string): { num?: string; text?: string } {
  const v = value.trim()
  if (v === '') return {}
  if (/^\d+$/.test(v)) return { num: v }
  const m = /^(\d+)\s+(.+)$/.exec(v)
  if (m) {
    const text = m[2].trim()
    return { num: m[1], text: text === '' ? undefined : text }
  }
  return { text: v }
}

/**
 * 组合 J 的「数字 + 文字」为展示标签：
 *  - 只有数字 → "♩= 96"；只有文字 → "欢快地"；两者 → "♩= 80 欢快地"；都无 → ""
 *  - = 号后带空格（adj42：与调式行 = 对齐格式一致）
 */
export function tempoLabel(num: string | undefined, text: string | undefined): string {
  const pieces: string[] = []
  if (num) pieces.push(`♩= ${num}`)
  if (text) pieces.push(text)
  return pieces.join(' ')
}

/** 解析一个 C 行（歌词）：每个汉字/音节对应一个音符；@ 占位（占一个字空间）；~ 连字；
 *  中文标点不占音符位，紧跟前面的字渲染（adj35） */
function parseLyricContent(content: string, line: number): { chars: LyricChar[]; errors: ParseError[] } {
  const chars: LyricChar[] = []
  const errors: ParseError[] = []
  let i = 0
  const n = content.length
  let pending: LyricChar | null = null // 正在累积的音节
  let punctBuf = '' // 待挂载的中文标点（adj35）
  let noteBuf: string | null = null // 待挂载的引号注释（adj58："..." 不占歌词位，挂到注释后第一个字）

  const flush = () => {
    if (pending) {
      if (pending.text.length > 0) chars.push(pending)
      pending = null
    }
  }

  /** 把累积标点挂到最后一个已提交的字后面（标点不占音符位，adj35） */
  const mountPunct = () => {
    if (punctBuf !== '') {
      const last = chars[chars.length - 1]
      if (last && !last.skip) last.trailing = (last.trailing ?? '') + punctBuf
      punctBuf = ''
    }
  }

  const isPunct = (c: string) => '，。、；：？！…—·〈〉《》“”‘’（）【】!,.?;:()[]-—~'.includes(c)
  /** 汉字：每个字独立占一个音符位（无空格歌词也对齐）；拉丁/数字连续累积为音节 */
  const isCJK = (c: string) => /\p{Script=Han}/u.test(c)

  while (i < n) {
    const c = content[i]
    if (c === ' ' || c === '\t') {
      flush()
      mountPunct()
      i++
      continue
    }
    if (c === '"') {
      // 引号注释（adj58）：双引号包围的文本为注释，不占歌词对齐位；
      // 挂到注释后面第一个歌词字上，渲染在该字前面；_ 代替空格（adj59）
      flush()
      mountPunct()
      let k = i + 1
      let note = ''
      while (k < n && content[k] !== '"') {
        note += content[k] === '_' ? ' ' : content[k]
        k++
      }
      if (k >= n) errors.push(errAt('歌词引号注释未闭合', line, i, 'warning'))
      noteBuf = note
      i = k + 1
      continue
    }
    if (c === '@') {
      flush()
      mountPunct()
      chars.push({ text: '', skip: true, punctuation: false, pos: i, raw: '@' })
      i++
      continue
    }
    if (c === '~') {
      // 连字：与下一个非空白字符合并到当前音节
      let k = i + 1
      while (k < n && (content[k] === ' ' || content[k] === '\t')) k++
      if (k < n) {
        if (pending) {
          pending.text += content[k]
          pending.raw += content[k]
        } else {
          mountPunct()
          chars.push({ text: content[k], skip: false, punctuation: false, pos: i, raw: '~' + content[k] })
        }
        i = k + 1
      } else {
        errors.push(errAt('连字符号 "~" 后缺少文字', line, i, 'warning'))
        i++
      }
      continue
    }
    if (isPunct(c)) {
      // 中文标点：结束当前音节，累积挂到前一个字后（adj35）
      flush()
      punctBuf += c
      i++
      continue
    }
    // 汉字：每字独立音节（各自占一个音符槽位，避免无空格歌词挤占错位）
    if (isCJK(c)) {
      flush()
      mountPunct()
      pending = { text: c, skip: false, punctuation: false, pos: i, raw: c }
      if (noteBuf !== null) {
        pending.note = noteBuf
        noteBuf = null
      }
      i++
      continue
    }
    // 普通字符（拉丁字母/数字等）：累积为音节
    if (!pending) {
      mountPunct() // 新音节前先挂载标点
      pending = { text: '', skip: false, punctuation: false, pos: i, raw: '' }
      if (noteBuf !== null) {
        pending.note = noteBuf
        noteBuf = null
      }
    }
    pending.text += c
    pending.raw += c
    i++
  }
  flush()
  mountPunct()
  return { chars, errors }
}

/** 解析整份 .jps 源码 */
export function parseJps(source: string): ParseResult {
  const lines: SourceLine[] = []
  const errors: ParseError[] = []
  const groups: MusicGroup[] = []

  const header: Header = { titles: [], authors: [], instruments: [], notes: [] }
  let lastMusicIndex = -1 // 最近一个 Q 行在 lines 中的索引

  const srcLines = source.replace(/\r\n/g, '\n').split('\n')

  for (let idx = 0; idx < srcLines.length; idx++) {
    const raw = srcLines[idx]
    const lineNo = idx + 1
    const pos = { line: lineNo, col: 0 }
    const trimmed = raw.trim()

    // 空行
    if (trimmed === '') {
      lines.push({ kind: 'empty', pos, raw })
      continue
    }

    // 分页行
    if (trimmed === '[fenye]') {
      lines.push({ kind: 'pagebreak', pos, raw })
      continue
    }

    // 注释行（# 在行首）
    if (trimmed.startsWith('#')) {
      lines.push({ kind: 'comment', pos, raw })
      continue
    }

    // 描述头行：V/B/Z/D/P/J
    const headerMatch = /^([A-Z])\s*:\s*(.*)$/.exec(trimmed)
    if (headerMatch && HEADER_KEYS.has(headerMatch[1])) {
      const key = headerMatch[1]
      const value = headerMatch[2]
      const hl: HeaderLine = { kind: 'header', key, value, pos, raw }
      lines.push(hl)
      switch (key) {
        case 'V':
          header.version = value
          break
        case 'B':
          header.titles.push(value)
          break
        case 'Z':
          header.authors.push(value)
          break
        case 'D':
          header.key = value
          break
        case 'P':
          header.meter = value
          break
        case 'J': {
          header.tempo = value // 原始值（最后一条，兼容旧消费方）
          const t = splitTempo(value)
          if (t.num !== undefined) header.tempoNum = t.num // 多条数字取最后一条
          if (t.text !== undefined) {
            header.tempoText = header.tempoText ? `${header.tempoText} ${t.text}` : t.text
          }
          break
        }
        case 'Y':
          // adj302：一个 Y 行只保留一种乐器（取第一个词；多乐器写多行，每行一种）
          header.instruments.push(value.trim().split(/\s+/)[0] ?? '')
          break
        case 'S':
          // adj154：支持字面 \n 换行——拆成多行说明（每行一个 text，渲染时纵向堆叠）
          header.notes.push(...value.split('\\n'))
          break
      }
      continue
    }

    // 曲行：Q[声部号]["声部名"]:
    const musicMatch = /^Q(\d*)(?:"([^"]*)")?\s*:\s*(.*)$/.exec(trimmed)
    if (musicMatch) {
      const voice = musicMatch[1] === '' ? 1 : Number(musicMatch[1])
      const voiceName = musicMatch[2] || undefined
      const { tokens, errors: tokErrors } = tokenizeMusicLine(musicMatch[3] ?? '', pos)
      errors.push(...tokErrors)
      // adj338：旧写法单 @乐器名（legacy）→ 告警提示改用 @...@（带行+列定位）
      // 注意：列 = 行前缀（`Q1: ` 等）+ token 在曲行内容内的偏移，使跳转定位到 @ 所在完整列
      const prefixLen = trimmed.length - (musicMatch[3] ?? '').length
      for (const t of tokens) {
        if (t.kind === 'instrument' && t.legacy && t.name) {
          errors.push(errAt(`旧乐器写法 @${t.name}，建议改用 @${t.name}@`, pos.line, prefixLen + t.pos, 'warning'))
        }
      }
      const ml: MusicLine = {
        kind: 'music',
        voice,
        voiceName,
        tokens,
        pos,
        raw,
      }
      lines.push(ml)
      groups.push({ music: ml, lyrics: [], startIndex: lines.length - 1 })
      lastMusicIndex = lines.length - 1
      continue
    }

    // 词行：C[声部号]:
    const lyricMatch = /^C(\d*)\s*:\s*(.*)$/.exec(trimmed)
    if (lyricMatch) {
      const voice = lyricMatch[1] === '' ? 1 : Number(lyricMatch[1])
      const { chars, errors: lyrErrors } = parseLyricContent(lyricMatch[2] ?? '', lineNo)
      errors.push(...lyrErrors)
      const ll: LyricLine = { kind: 'lyric', voice, chars, pos, raw }
      lines.push(ll)
      // 依附于最近一个同声部 Q 行
      if (lastMusicIndex >= 0) {
        const target = [...groups].reverse().find((g) => g.music.voice === voice)
        if (target) target.lyrics.push(ll)
        else {
          const g = groups[groups.length - 1]
          if (g) g.lyrics.push(ll)
        }
      } else {
        errors.push(errAt('歌词行缺少对应的曲行（C 行必须跟在 Q 行之后）', lineNo, 0))
      }
      continue
    }

    // 其他：未识别行
    lines.push({ kind: 'unknown', pos, raw })
    errors.push(errAt(`无法识别的行 "${trimmed.slice(0, 20)}${trimmed.length > 20 ? '…' : ''}"`, lineNo, 0, 'warning'))
  }

  // ---- 平均连音组 (y...) 时值均分（多连音线）：组内音符时值 = 组总时值 / 组内音符数 ----
  applyTupletDurations(groups, parseMeterBeats(header.meter))

  return { header, lines, groups, errors }
}

/** 解析拍号名义拍数（"4/4" → 4；"6/8 (2/4)" → 6；无法解析返回 null） */
function parseMeterBeats(meter: string | undefined): number | null {
  if (!meter) return null
  const m = /^(\d+)\s*\//.exec(meter.trim())
  return m ? Number(m[1]) : null
}

/**
 * 平均连音组 "(y ... )"：组内音符时值均分「组总时值」。
 * 组总时值 = 小节名义拍数 - 组外音符实际时值（不足时回退组内原始时值和）；
 * 组内音符按均分时值（tupletDur 覆盖，布局与播放共用）。
 */
function applyTupletDurations(groups: MusicGroup[], meterBeats: number | null): void {
  type NoteLike = Extract<MusicToken, { kind: 'note' } | { kind: 'rest' } | { kind: 'rhythm' }>
  const isNoteLike = (t: MusicToken): t is NoteLike =>
    t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
  for (const g of groups) {
    const tokens = g.music.tokens
    // 按小节切分（| 等小节线分隔；行尾未闭合的收尾小节）
    let start = 0
    for (let i = 0; i <= tokens.length; i++) {
      const atBar = i === tokens.length || tokens[i].kind === 'barline'
      if (!atBar) continue
      const measure = tokens.slice(start, i)
      // FIFO 配对（与布局一致），收集每组音符
      const open: { slur: SlurToken; members: NoteLike[] }[] = []
      for (const t of measure) {
        if (isNoteLike(t)) {
          for (const o of open) o.members.push(t)
        } else if (t.kind === 'slur' && t.dir === 'open') {
          open.push({ slur: t, members: [] })
        } else if (t.kind === 'slur' && t.dir === 'close') {
          const o = open.shift()
          if (o && o.slur.tuplet && o.members.length >= 2) {
            const n = o.members.length
            const rawSum = o.members.reduce((a, m) => a + tokenDuration(m), 0)
            const outer = measure.reduce(
              (a, m) => a + (isNoteLike(m) && !o.members.includes(m) ? tokenDuration(m) : 0),
              0,
            )
            const groupTotal =
              meterBeats !== null && meterBeats > 0 && meterBeats - outer > 0
                ? meterBeats - outer
                : rawSum
            const per = groupTotal / n
            // adj217：末音符 tupletDur 用剩余值（groupTotal - per×(n-1)），消除浮点累加误差
            // ——1/3×3 累加得 0.9999…，布局按拍切分时误落到下一拍（minDur≈8.88e-16）
            for (let mi = 0; mi < n; mi++) {
              const m = o.members[mi]
              m.tupletDur = mi === n - 1 ? groupTotal - per * (n - 1) : per
            }
          }
        }
      }
      start = i + 1
    }
  }
}
