/**
 * engine/scoreIR/fromJps.ts — `.jps` 源码 → ScoreIR
 *
 * 只做「解析结果 → 语义模型」的搬运，**不重新解析源码**（语法归 parser 管）。
 * 三条硬口径：
 *  1. 小节分组必须带 `groupIndex`（同时演奏 vs 先后演奏，写回 jps 时全靠它）；
 *  2. 连音线用 `ParseResult.slurPairs`（唯一配对口径），两端同高才置 tie；
 *  3. 任何表达不了的结构都进 `issues`，不静默丢。
 */
import { parseJps } from '../parser'
import type { MusicToken, NoteToken, ParseError, RhythmToken, RestToken } from '../types'
import type {
  IRBarline,
  IREvent,
  IRIssue,
  IRLyricLine,
  IRLyricSlot,
  IRMeasure,
  IRNote,
  IRPart,
  IRRest,
  IRRhythm,
  IRSourcePos,
  ScoreIR,
} from './types'
import { jpsPitchToMidi, keySemitoneOf } from './pitch'
import { dedupeIssues, makeIssue } from './issues'

export interface JpsToIrResult {
  ir: ScoreIR
  /** 原样带回 `parseJps` 的错误/告警（不塞进 issues：两者语义不同） */
  errors: ParseError[]
}

/** 音符/休止/节奏符才占「发声位」（连音线配对与歌词对齐都按它数） */
function isSounding(t: MusicToken): t is NoteToken | RestToken | RhythmToken {
  return t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
}

/** 主入口：源码 → IR */
export function parseJpsToIR(code: string): JpsToIrResult {
  const parsed = parseJps(code)
  const key = keySemitoneOf(parsed.header.key)
  const pairs = parsed.slurPairs ?? []

  // 第一遍：给每个「发声位」算 MIDI（连音线两端是否同高要靠它）
  const soundingMidi: (number | null)[] = []
  for (const g of parsed.groups) {
    for (const t of g.music.tokens) {
      if (t.kind === 'note') {
        soundingMidi.push(jpsPitchToMidi(t.pitch, t.octaveShift, t.accidental, key))
      } else if (t.kind === 'rest' || t.kind === 'rhythm') {
        soundingMidi.push(null)
      }
    }
  }

  const slurStarts = new Set<number>()
  const slurEnds = new Set<number>()
  const tieStarts = new Set<number>()
  const tieEnds = new Set<number>()
  for (const p of pairs) {
    slurStarts.add(p.start)
    slurEnds.add(p.end)
    const a = soundingMidi[p.start]
    const b = soundingMidi[p.end]
    if (a != null && a === b) {
      tieStarts.add(p.start)
      tieEnds.add(p.end)
    }
  }

  const parts = new Map<number, IRPart>()
  const lyrics: IRLyricLine[] = []
  const issues: IRIssue[] = []
  const partSounding = new Map<number, number>()
  let globalSounding = 0

  /**
   * 「同时演奏」的块号：连续 Q 行里声部号不重复 ⇒ 同一块（AGENTS/SYNTAX 2.11 的
   * adj595 口径）；一旦出现重复声部号就另起一块、接在后面演奏。
   * 写回 `.jps` 时必须靠它决定哪几行写在一起。
   */
  const blockOf = new Map<number, number>()
  {
    let block = -1
    const used = new Set<number>()
    for (const [gi, g] of parsed.groups.entries()) {
      const v = g.music.voice === 0 ? 1 : g.music.voice
      if (used.has(v)) {
        block += 1
        used.clear()
      }
      if (block < 0) block = 0
      used.add(v)
      blockOf.set(gi, block)
    }
  }

  const getPart = (voice: number, name?: string): IRPart => {
    let p = parts.get(voice)
    if (p === undefined) {
      p = { id: `P${voice}`, voice, measures: [] }
      if (name !== undefined && name !== '') p.name = name
      const inst = parsed.header.instruments[voice - 1]
      if (inst !== undefined) p.instrument = inst
      parts.set(voice, p)
    } else if (name !== undefined && name !== '' && p.name === undefined) {
      p.name = name
    }
    return p
  }

  for (const [groupIndex, group] of parsed.groups.entries()) {
    const voice = group.music.voice === 0 ? 1 : group.music.voice
    const blockIndex = blockOf.get(groupIndex) ?? groupIndex
    const part = getPart(voice, group.music.voiceName)
    const partStart = partSounding.get(voice) ?? 0
    let partCount = partStart
    const lineNo = group.music.pos.line

    let measure: IRMeasure = { index: part.measures.length, groupIndex: blockIndex, events: [], barline: null }
    let pendingStart: IRBarline | null = null

    const close = (bar: IRBarline | null): void => {
      if (measure.events.length === 0 && bar === null) return
      measure.barline = bar
      part.measures.push(measure)
      measure = { index: part.measures.length, groupIndex: blockIndex, events: [], barline: null }
    }

    for (const t of group.music.tokens) {
      if (isSounding(t)) {
        const pos = t.pos
        const src: IRSourcePos = { line: lineNo, col: pos, raw: t.raw }
        if (t.kind === 'note') {
          const note: IRNote = {
            kind: 'note',
            degree: t.pitch,
            octaveShift: t.octaveShift,
            accidental: t.accidental,
            midi: jpsPitchToMidi(t.pitch, t.octaveShift, t.accidental, key),
            augmentCount: t.augmentCount,
            diminishCount: t.diminishCount,
            dots: t.dots,
            source: src,
          }
          if (t.tupletDur !== undefined) note.tupletDur = t.tupletDur
          if (t.symbols.length > 0) note.symbols = [...t.symbols]
          if (t.comment !== undefined) note.comment = t.comment
          if (t.gracenotes !== undefined) {
            note.gracenotes = {
              after: t.gracenotes.after,
              notes: t.gracenotes.notes.map((g) => ({
                degree: g.pitch,
                octaveShift: g.octaveShift,
                accidental: g.accidental,
                midi: jpsPitchToMidi(g.pitch, g.octaveShift, g.accidental, key),
                diminishCount: g.diminishCount,
              })),
            }
          }
          if (slurStarts.has(globalSounding)) note.slurStart = true
          if (slurEnds.has(globalSounding)) note.slurEnd = true
          if (tieStarts.has(globalSounding)) note.tieStart = true
          if (tieEnds.has(globalSounding)) note.tieEnd = true
          measure.events.push(note)
        } else if (t.kind === 'rest') {
          const rest: IRRest = {
            kind: 'rest',
            hidden: t.hidden,
            augmentCount: t.augmentCount,
            diminishCount: t.diminishCount,
            dots: t.dots,
            source: src,
          }
          if (t.tupletDur !== undefined) rest.tupletDur = t.tupletDur
          if (t.interludeBeats !== undefined) rest.interludeBeats = t.interludeBeats
          if (t.comment !== undefined) rest.comment = t.comment
          measure.events.push(rest)
        } else {
          const rhythm: IRRhythm = {
            kind: 'rhythm',
            augmentCount: t.augmentCount,
            diminishCount: t.diminishCount,
            dots: t.dots,
            source: src,
          }
          if (t.tupletDur !== undefined) rhythm.tupletDur = t.tupletDur
          if (t.symbols.length > 0) rhythm.symbols = [...t.symbols]
          if (t.comment !== undefined) rhythm.comment = t.comment
          measure.events.push(rhythm)
        }
        if (t.tupletDur !== undefined) {
          issues.push(
            makeIssue(
              'unsupported',
              'review',
              '平均连音组（(y … )）暂未写入 MusicXML，已按覆盖时值导出',
              src,
            ),
          )
        }
        globalSounding += 1
        partCount += 1
        continue
      }

      if (t.kind === 'barline') {
        const bar = barlineToIR(t)
        // 隐藏小节线 1（`|/`）：不占排版也不该切小节；纯跳房子起点也不切
        if (t.type === '|/' && t.voltaStart === undefined && t.voltaEnd !== true) continue
        if (measure.events.length === 0) {
          if (t.voltaStart !== undefined || t.voltaEnd === true) pendingStart = bar
          continue
        }
        close(bar)
        continue
      }

      if (t.kind === 'instrument') {
        if (t.name !== null && part.instrument === undefined) part.instrument = t.name
        continue
      }

      if (t.kind === 'segment') {
        issues.push(
          makeIssue('unsupported', 'must', '临时段（{bz}/{dsb}/{tp}）暂未支持互转，这一段已跳过', {
            line: lineNo,
            col: t.pos,
            raw: t.raw,
          }),
        )
        continue
      }

      if (t.kind === 'decoration' || t.kind === 'bracket') {
        issues.push(
          makeIssue('unsupported', 'review', `记号「${t.raw}」暂未写入 MusicXML`, {
            line: lineNo,
            col: t.pos,
            raw: t.raw,
          }),
        )
      }
    }

    if (measure.events.length > 0) close(null)
    if (pendingStart !== null && part.measures.length > 0) {
      const last = part.measures[part.measures.length - 1]
      if (last.startBarline === undefined) last.startBarline = pendingStart
    }

    // 歌词：`C1:`/`C2:` 是**这一组的第几段词**（同组内的顺序 = 段号），
    // 不是「第几个声部」——送别那种单声部两段词就是 C1/C2 都挂在同一个 Q 组上。
    for (const [verse, lyricLine] of group.lyrics.entries()) {
      const lv = voice
      let target = lyrics.find((l) => l.voice === lv && l.verse === verse)
      if (target === undefined) {
        target = { voice: lv, verse, slots: [] }
        lyrics.push(target)
      }
      for (let k = 0; k < lyricLine.chars.length; k += 1) {
        const c = lyricLine.chars[k]
        const slotIndex = partStart + k
        const slot: IRLyricSlot = {
          text: c.text,
          skip: c.skip,
          punctuation: c.punctuation,
        }
        if (c.trailing !== undefined) slot.trailing = c.trailing
        if (c.note !== undefined) slot.note = c.note
        target.slots[slotIndex] = slot
        const ev = eventAt(part, slotIndex)
        if (ev !== null && ev.kind !== 'note') {
          issues.push(
            makeIssue('lyricOnRest', 'review', `歌词「${c.text}」落在休止/节奏符上，五线谱里会挂到下一个音`, {
              line: lyricLine.pos.line,
              col: c.pos,
              raw: c.raw,
            }),
          )
        }
      }
    }
    partSounding.set(voice, partCount)
  }

  // 歌词槽补齐到本声部的发声位总数（缺失为 null）
  for (const line of lyrics) {
    const part = parts.get(line.voice)
    const total = part === undefined ? 0 : countEvents(part)
    while (line.slots.length < total) line.slots.push(null)
  }

  const meta: ScoreIR['meta'] = {
    subtitles: parsed.header.titles.slice(1),
    authors: [...parsed.header.authors],
    key: parsed.header.key ?? 'C',
    meter: parsed.header.meter ?? '4/4',
    instruments: [...parsed.header.instruments],
  }
  const title = parsed.header.titles[0]
  if (title !== undefined) meta.title = title
  if (parsed.header.tempoNum !== undefined && parsed.header.tempoNum !== '') {
    const bpm = Number(parsed.header.tempoNum)
    if (Number.isFinite(bpm) && bpm > 0) meta.tempo = bpm
  }
  if (parsed.header.tempoText !== undefined && parsed.header.tempoText !== '') {
    meta.tempoText = parsed.header.tempoText
  }

  return {
    ir: {
      meta,
      parts: [...parts.values()].sort((a, b) => a.voice - b.voice),
      lyrics,
      issues: dedupeIssues(issues),
    },
    errors: parsed.errors,
  }
}

/** 小节线 token → IR小节线（字段一一搬，不在这里做语义判断） */
function barlineToIR(t: Extract<MusicToken, { kind: 'barline' }>): IRBarline {
  const bar: IRBarline = { type: t.type }
  if (t.marks !== undefined && t.marks.length > 0) bar.marks = [...t.marks]
  if (t.voltaStart !== undefined) {
    const v = t.voltaStart
    bar.voltaStart = { open: v.open }
    if (v.slash !== undefined) bar.voltaStart.slash = v.slash
    if (v.plus !== undefined) bar.voltaStart.plus = v.plus
    if (v.minus !== undefined) bar.voltaStart.minus = v.minus
    if (v.comment !== undefined) bar.voltaStart.comment = v.comment
  }
  if (t.voltaEnd === true) bar.voltaEnd = true
  if (t.voltaEndSlash === true) bar.voltaEndSlash = true
  if (t.voltaOnly === true) bar.voltaOnly = true
  if (t.bareAnnotation === true) bar.bareAnnotation = true
  if (t.keyChange !== undefined) bar.keyChange = { ...t.keyChange }
  if (t.comment !== undefined) bar.comment = t.comment
  return bar
}

/** 取 part 里第 n 个发声位（歌词落在什么上要判断） */
function eventAt(part: IRPart, index: number): IREvent | null {
  let n = 0
  for (const m of part.measures) {
    for (const ev of m.events) {
      if (n === index) return ev
      n += 1
    }
  }
  return null
}

/** 一个 part 的发声位总数（音符/休止/节奏符） */
export function countEvents(part: IRPart): number {
  let n = 0
  for (const m of part.measures) n += m.events.length
  return n
}
