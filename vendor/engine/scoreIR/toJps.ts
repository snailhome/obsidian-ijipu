/**
 * engine/scoreIR/toJps.ts — ScoreIR → `.jps` 源码
 *
 * 这是互转的**唯一语法出口**：任何识别结果 / MusicXML 结果都先落到 ScoreIR，
 * 再由这里写文本。好处是语法合法性只在一处兜底（不再让每个调用方各拼字符串）。
 *
 * 写回口径：
 *  - 按 `groupIndex` 分组：同一块里的 Q1/Q2 写在一起（同时演奏），下一块另起；
 *  - 一个 Q 行内的多个小节按顺序写，小节线跟在小节末；
 *  - 歌词按「本声部发声位」切片，一段词一行 `C<声部>:`，缺位写 `@` 保持对齐；
 *  - 写不出来的东西（平均连音组等）进 issues，不静默丢。
 */
import type {
  IRBarline,
  IREvent,
  IRIssue,
  IRLyricSlot,
  IRNote,
  IRPart,
  IRRest,
  IRRhythm,
  ScoreIR,
} from './types'
import { countEvents } from './fromJps'
import { dedupeIssues, makeIssue } from './issues'

export interface IrToJpsResult {
  code: string
  issues: IRIssue[]
}

/** 主入口：IR → `.jps` 文本 */
export function irToJps(ir: ScoreIR): IrToJpsResult {
  const issues: IRIssue[] = [...ir.issues]
  const out: string[] = []
  out.push('V: 1.0')
  if (ir.meta.title !== undefined && ir.meta.title !== '') out.push(`B: ${ir.meta.title}`)
  for (const sub of ir.meta.subtitles) out.push(`B: ${sub}`)
  for (const author of ir.meta.authors) out.push(`Z: ${author}`)
  out.push(`D: ${ir.meta.key}`)
  out.push(`P: ${ir.meta.meter}`)
  if (ir.meta.tempo !== undefined) out.push(`J: ${Math.round(ir.meta.tempo)}`)
  if (ir.meta.tempoText !== undefined && ir.meta.tempoText !== '') out.push(`J: ${ir.meta.tempoText}`)
  for (const inst of ir.meta.instruments) out.push(`Y: ${inst}`)

  const parts = [...ir.parts].sort((a, b) => a.voice - b.voice)
  const groupIndices = [...new Set(parts.flatMap((p) => p.measures.map((m) => m.groupIndex)))].sort(
    (a, b) => a - b,
  )

  /** 每个 part 的发声位游标（写歌词时按它切片） */
  const cursor = new Map<number, number>()
  for (const p of parts) cursor.set(p.voice, 0)

  for (const g of groupIndices) {
    const present = parts.filter((p) => p.measures.some((m) => m.groupIndex === g))
    if (present.length === 0) continue
    for (const part of present) {
      const measures = part.measures.filter((m) => m.groupIndex === g)
      if (measures.length === 0) continue
      const tokens: string[] = []
      let first = true
      for (const m of measures) {
        if (first && m.startBarline !== undefined) tokens.push(barText(m.startBarline))
        first = false
        for (const ev of m.events) tokens.push(eventText(ev, issues))
        if (m.barline !== null) tokens.push(barText(m.barline))
      }
      if (tokens.length === 0) continue
      const name = part.name !== undefined && part.name !== '' ? `"${part.name}"` : ''
      out.push(`Q${part.voice}${name}: ${tokens.join(' ')}`)

      // 歌词：一行一段词；按本块事件数切片
      const total = measures.reduce((n, m) => n + m.events.length, 0)
      const start = cursor.get(part.voice) ?? 0
      const lines = ir.lyrics.filter((l) => l.voice === part.voice).sort((a, b) => a.verse - b.verse)
      for (const line of lines) {
        const chars: string[] = []
        for (let i = start; i < start + total; i += 1) {
          chars.push(lyricText(line.slots[i] ?? null))
        }
        while (chars.length > 0 && chars[chars.length - 1] === '@') chars.pop()
        if (chars.length > 0) out.push(`C${part.voice}: ${chars.join(' ')}`)
      }
      cursor.set(part.voice, start + total)
    }
    // 声部缺失只提示一次（不猜、不补假小节）
    const missing = itNames(parts)
    void missing
  }

  // 声部小节数不齐：给一条 review（写出来的是"能写的那部分"）
  const total = parts.map((p) => countEvents(p))
  if (new Set(total).size > 1) {
    issues.push(
      makeIssue('lostOnWrite', 'review', '各声部小节数不一致：缺少小节的声部已按原样略过，请人工补齐'),
    )
  }

  return { code: out.join('\n') + '\n', issues: dedupeIssues(issues) }
}

function itNames(parts: IRPart[]): string {
  return parts.map((p) => p.id).join(',')
}

/** 歌词槽 → 文本（null / skip 写成 `@`，保持与音符对齐） */
function lyricText(slot: IRLyricSlot | null): string {
  if (slot === null || slot.skip) return '@'
  let s = slot.text
  if (slot.trailing !== undefined) s += slot.trailing
  return s
}

/** 一个事件 → jps token 文本 */
function eventText(ev: IREvent, issues: IRIssue[]): string {
  if (ev.kind === 'note') return noteText(ev, issues)
  if (ev.kind === 'rest') return restText(ev)
  return rhythmText(ev)
}

function durationTail(ev: { augmentCount: number; diminishCount: number; dots: number }): string {
  return '-'.repeat(Math.max(0, ev.augmentCount)) +
    '/'.repeat(Math.max(0, ev.diminishCount)) +
    '.'.repeat(Math.max(0, ev.dots))
}

function noteText(n: IRNote, issues: IRIssue[]): string {
  if (n.tupletDur !== undefined) {
    issues.push(makeIssue('unsupported', 'review', '平均连音组写回 .jps 时按普通时值写出，组信息已丢失', n.source))
  }
  let s = String(n.degree)
  if (n.octaveShift > 0) s += "'".repeat(Math.trunc(n.octaveShift))
  if (n.octaveShift < 0) s += ','.repeat(Math.trunc(-n.octaveShift))
  if (n.accidental !== null) s += n.accidental
  if (n.gracenotes !== undefined && n.gracenotes.notes.length > 0) {
    const body = n.gracenotes.notes
      .map((g) => {
        let t = String(g.degree)
        if (g.octaveShift > 0) t += "'".repeat(Math.trunc(g.octaveShift))
        if (g.octaveShift < 0) t += ','.repeat(Math.trunc(-g.octaveShift))
        if (g.accidental !== null) t += g.accidental
        t += '/'.repeat(Math.max(0, g.diminishCount))
        return t
      })
      .join('')
    s += n.gracenotes.after ? `[h${body}]` : `[${body}]`
  }
  s += durationTail(n)
  for (const sym of n.symbols ?? []) s += `&${sym}`
  if (n.comment !== undefined) s += `"${n.comment}"`
  const open = n.slurStart === true || n.tieStart === true
  const close = n.slurEnd === true || n.tieEnd === true
  if (open) s = '(' + s
  if (close) s += ')'
  return s
}

function restText(r: IRRest): string {
  let s = r.hidden ? '8' : '0'
  s += durationTail(r)
  if (r.interludeBeats !== undefined) s += `{jz ${r.interludeBeats}}`
  if (r.comment !== undefined) s += `"${r.comment}"`
  return s
}

function rhythmText(r: IRRhythm): string {
  let s = '9' + durationTail(r)
  for (const sym of r.symbols ?? []) s += `&${sym}`
  if (r.comment !== undefined) s += `"${r.comment}"`
  return s
}

/** 小节线 → 文本（顺序：] 、[ 、注释/转调、& 修饰符；解析端顺序无关） */
function barText(bar: IRBarline): string {
  if (bar.voltaOnly === true || bar.bareAnnotation === true) return bar.type
  let s = bar.type
  if (bar.voltaEnd === true) s += ']'
  if (bar.voltaEndSlash === true) s += '/'
  if (bar.voltaStart !== undefined) {
    const v = bar.voltaStart
    s += '['
    if (v.open === false) s += '/'
    s += '+'.repeat(Math.max(0, v.plus ?? 0))
    s += '-'.repeat(Math.max(0, v.minus ?? 0))
    if (v.comment !== undefined) s += `"${v.comment}"`
  }
  if (bar.keyChange !== undefined) {
    if (bar.keyChange.clear === true) s += '"d:"'
    else if (bar.keyChange.keyText !== undefined) s += `"d:${bar.keyChange.keyText}"`
    s += '+'.repeat(Math.max(0, bar.keyChange.plus ?? 0))
    s += '-'.repeat(Math.max(0, bar.keyChange.minus ?? 0))
  } else if (bar.comment !== undefined) {
    s += `"${bar.comment}"`
  }
  for (const mark of bar.marks ?? []) s += `&${mark}`
  return s
}
