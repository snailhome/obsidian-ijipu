/**
 * engine/scoreIR/musicxml.ts — MusicXML ↔ ScoreIR（零第三方依赖）
 *
 * 为什么要自己写一个极简 XML 解析器：MusicXML 的可见结构很规整（元素 + 属性 +
 * 文本），而引一个通用 XML 库会把"实体、命名空间、DTD"整套带进来；引擎要保持
 * 零依赖、能直接在 Node/WebView/QuickJS 里跑。这里只实现 ScoreIR 用得到的子集：
 * 元素、属性、文本、自闭合标签、实体转义；遇到不认识的元素**忽略但不报错**
 * （由上层按 issues 提示"未写入/未读取"）。
 *
 * 时值口径（关键）：`.jps` 的「1 拍」= 一个四分音符 = 480 tick。
 * 这与 MIDI 导出（`eventsToMidi` 的 DIV=480）完全同口径；`P: 6/8` 的 6 个单位
 * 导出后也是 6 个四分音符，五线谱软件可能提示小节时值不符——这是**已知口径差异**，
 * 会在 issues 里给一条 review（不阻断导出）。
 */
import { tokenDuration } from '../duration'
import type { BarlineMark, BarlineType } from '../types'
import type {
  IRBarline,
  IREvent,
  IRIssue,
  IRLyricLine,
  IRLyricSlot,
  IRMeasure,
  IRMeta,
  IRNote,
  IRPart,
  IRRest,
  IRRhythm,
  ScoreIR,
} from './types'
import {
  DEGREE_SEMITONES,
  keyFifthsOf,
  keySemitoneOf,
  keySemitoneOfFifths,
  midiToJpsPitch,
  parseMeter,
  spellMidiForStaff,
  staffPitchToMidi,
  BASE_MIDI,
} from './pitch'
import { dedupeIssues, makeIssue } from './issues'

/** 每四分音符的 tick 数（与 MIDI 导出同口径） */
const DIV = 480

// ============================================================
// 极简 XML
// ============================================================

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: (XmlNode | string)[]
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
}

function attrOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '')
  }
  return out
}

/** 解析 MusicXML 文本；失败返回 null（调用方给中文错误） */
function parseXml(text: string): XmlNode | null {
  const src = text
    .replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
  const root: XmlNode = { name: '#root', attrs: {}, children: [] }
  const stack: XmlNode[] = [root]
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (chunk: string): void => {
    const t = decodeEntities(chunk)
    if (t.trim() !== '') stack[stack.length - 1].children.push(t)
  }
  while ((m = re.exec(src)) !== null) {
    pushText(src.slice(last, m.index))
    last = m.index + m[0].length
    const closing = m[1] === '/'
    const name = m[2]
    const selfClosing = m[4] === '/'
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i
          break
        }
      }
      continue
    }
    const node: XmlNode = { name, attrs: attrOf(m[3] ?? ''), children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  pushText(src.slice(last))
  return root.children.find((c): c is XmlNode => typeof c !== 'string') ?? null
}

function kids(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c): c is XmlNode => typeof c === 'object' && c.name === name)
}

function kid(node: XmlNode, name: string): XmlNode | null {
  const list = kids(node, name)
  return list.length > 0 ? list[0] : null
}

function textOf(node: XmlNode | null): string {
  if (node === null) return ''
  return node.children
    .filter((c): c is string => typeof c === 'string')
    .join('')
    .trim()
}

function numOf(node: XmlNode | null, fallback = 0): number {
  const n = Number(textOf(node))
  return Number.isFinite(n) ? n : fallback
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ============================================================
// 时值换算
// ============================================================

/** 一个 IR 事件占多少 tick（480 = 四分音符） */
export function eventTicks(ev: IREvent): number {
  return Math.max(1, Math.round(tokenDuration(ev) * DIV))
}

/** tick → 五线谱的 type/dot（对不上就返回 null，调用方会省略 <type>） */
function xmlTypeOf(ticks: number): { type: string; dots: number } | null {
  const bases: { ticks: number; type: string }[] = [
    { ticks: 1920, type: 'whole' },
    { ticks: 960, type: 'half' },
    { ticks: 480, type: 'quarter' },
    { ticks: 240, type: 'eighth' },
    { ticks: 120, type: '16th' },
    { ticks: 60, type: '32nd' },
    { ticks: 30, type: '64th' },
  ]
  for (const b of bases) {
    for (let dots = 0; dots <= 2; dots += 1) {
      let want = b.ticks
      let extra = b.ticks
      for (let i = 0; i < dots; i += 1) {
        extra /= 2
        want += extra
      }
      if (Math.abs(want - ticks) < 0.5) return { type: b.type, dots }
    }
  }
  return null
}

/** tick → jps 的增时/减时/附点（找不到精确表示时返回近似值 + exact=false） */
export function ticksToJpsDuration(ticks: number): {
  augmentCount: number
  diminishCount: number
  dots: number
  exact: boolean
} {
  let best = { augmentCount: 0, diminishCount: 0, dots: 1, exact: false, diff: Infinity }
  for (let dim = 0; dim <= 8; dim += 1) {
    for (let aug = 0; aug <= 16; aug += 1) {
      for (let dots = 0; dots <= 2; dots += 1) {
        const parts = { augmentCount: aug, diminishCount: dim, dots }
        const diff = Math.abs(tokenDuration(parts) * DIV - ticks)
        if (diff < best.diff) {
          best = { ...parts, exact: diff < 0.5, diff }
        }
        if (diff < 0.5) return { augmentCount: aug, diminishCount: dim, dots, exact: true }
      }
    }
  }
  return { augmentCount: best.augmentCount, diminishCount: best.diminishCount, dots: best.dots, exact: false }
}

// ============================================================
// IR → MusicXML
// ============================================================

/** 主入口：IR → `.musicxml` 文本（MusicXML 4.0 partwise） */
export function irToMusicXml(ir: ScoreIR): { xml: string; issues: IRIssue[] } {
  const key = keySemitoneOf(ir.meta.key)
  const fifths = keyFifthsOf(key)
  const meter = parseMeter(ir.meta.meter)
  const issues: IRIssue[] = [...ir.issues]
  if (meter.beatType !== 4) {
    issues.push(
      makeIssue(
        'meterDenominator',
        'review',
        `${ir.meta.meter} 在 .jps 里按「1 个数字 = 1 拍（四分音符）」计；导出的 MusicXML 也按四分音符写，五线谱软件可能提示小节时值不符`,
      ),
    )
  }

  const parts = ir.parts.length > 0 ? ir.parts : [emptyPart()]
  const maxMeasures = Math.max(1, ...parts.map((p) => p.measures.length))
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">')
  lines.push('<score-partwise version="4.0">')

  if (ir.meta.title !== undefined || ir.meta.subtitles.length > 0) {
    lines.push('  <work>')
    if (ir.meta.title !== undefined) lines.push(`    <work-title>${esc(ir.meta.title)}</work-title>`)
    lines.push('  </work>')
  }
  if (ir.meta.authors.length > 0) {
    lines.push('  <identification>')
    for (const a of ir.meta.authors) lines.push(`    <creator type="composer">${esc(a)}</creator>`)
    lines.push('  </identification>')
  }

  lines.push('  <part-list>')
  for (const p of parts) {
    const name = p.name ?? p.instrument ?? p.id
    lines.push(`    <score-part id="${esc(p.id)}"><part-name>${esc(name)}</part-name></score-part>`)
  }
  lines.push('  </part-list>')

  for (const part of parts) {
    lines.push(`  <part id="${esc(part.id)}">`)
    const avgMidi = averageMidi(part)
    const clef = avgMidi > 0 && avgMidi < 57 ? 'F' : 'G'
    const lyricLines = ir.lyrics.filter((l) => l.voice === part.voice).sort((a, b) => a.verse - b.verse)
    let evIndex = 0
    let lastEnding = '1'
    for (let mi = 0; mi < maxMeasures; mi += 1) {
      const m = part.measures[mi]
      lines.push(`    <measure number="${mi + 1}">`)
      if (mi === 0) {
        lines.push('      <attributes>')
        lines.push(`        <divisions>${DIV}</divisions>`)
        lines.push(`        <key><fifths>${fifths}</fifths></key>`)
        lines.push(`        <time><beats>${meter.beats}</beats><beat-type>${meter.beatType}</beat-type></time>`)
        lines.push(`        <clef><sign>${clef}</sign><line>${clef === 'F' ? 4 : 2}</line></clef>`)
        lines.push('      </attributes>')
        if (part === parts[0] && ir.meta.tempo !== undefined) {
          lines.push('      <direction placement="above">')
          lines.push('        <direction-type><metronome><beat-unit>quarter</beat-unit>' +
            `<per-minute>${Math.round(ir.meta.tempo)}</per-minute></metronome></direction-type>` +
            `<sound tempo="${Math.round(ir.meta.tempo)}"/>`)
          if (ir.meta.tempoText !== undefined) {
            lines.push(`        <direction-type><words>${esc(ir.meta.tempoText)}</words></direction-type>`)
          }
          lines.push('      </direction>')
        }
      }

      if (m === undefined) {
        // 声部小节数不齐：补整小节休止（MusicXML 要求各 part 小节数一致）
        lines.push('      <note><rest measure="yes"/>' + `<duration>${meter.beats * DIV}</duration>` +
          '<type>whole</type></note>')
        lines.push('    </measure>')
        continue
      }

      if (m.startBarline !== undefined) {
        lines.push(...barlineXml(m.startBarline, 'left', mi + 1, lastEnding))
        lastEnding = endingAfter(m.startBarline, lastEnding)
      }

      for (const ev of m.events) {
        const lyrics = lyricTextOf(lyricLines, evIndex)
        lines.push(...eventXml(ev, key, lyrics))
        evIndex += 1
      }

      if (m.barline !== null) {
        lines.push(...barlineXml(m.barline, 'right', mi + 1, lastEnding))
        lastEnding = endingAfter(m.barline, lastEnding)
        if (m.barline.keyChange !== undefined) {
          const newKey = m.barline.keyChange.clear === true
            ? key
            : (m.barline.keyChange.targetKey ?? key)
          lines.push(`      <attributes><key><fifths>${keyFifthsOf(newKey)}</fifths></key></attributes>`)
        }
      }
      lines.push('    </measure>')
    }
    lines.push('  </part>')
  }

  lines.push('</score-partwise>')
  return { xml: lines.join('\n') + '\n', issues: dedupeIssues(issues) }
}

function emptyPart(): IRPart {
  return {
    id: 'P1',
    voice: 1,
    measures: [
      {
        index: 0,
        groupIndex: 0,
        events: [{ kind: 'rest', hidden: false, augmentCount: 3, diminishCount: 0, dots: 0 }],
        barline: null,
      },
    ],
  }
}

function averageMidi(part: IRPart): number {
  let sum = 0
  let n = 0
  for (const m of part.measures) {
    for (const ev of m.events) {
      if (ev.kind === 'note') {
        sum += ev.midi
        n += 1
      }
    }
  }
  return n === 0 ? 0 : sum / n
}

/** 某个事件对应的歌词（多段词 → 多个 `<lyric number>`） */
function lyricTextOf(lines: IRLyricLine[], index: number): { verse: number; slot: IRLyricSlot }[] {
  const out: { verse: number; slot: IRLyricSlot }[] = []
  for (const line of lines) {
    const slot = line.slots[index]
    if (slot !== null && slot !== undefined && !slot.skip && slot.text !== '') {
      out.push({ verse: line.verse, slot })
    }
  }
  return out
}

function eventXml(
  ev: IREvent,
  key: number,
  lyrics: { verse: number; slot: IRLyricSlot }[],
): string[] {
  const out: string[] = []
  const ticks = eventTicks(ev)
  const type = xmlTypeOf(ticks)
  const head: string[] = []

  if (ev.kind === 'note') {
    // 倚音先写（五线谱里它们不占主音时值）
    if (ev.gracenotes !== undefined) {
      for (const g of ev.gracenotes.notes) {
        out.push(...graceXml(g, key))
      }
    }
    const sp = spellMidiForStaff(ev.midi, key)
    head.push('      <note>')
    head.push(`        <pitch><step>${sp.step}</step>${sp.alter !== 0 ? `<alter>${sp.alter}</alter>` : ''}` +
      `<octave>${sp.octave}</octave></pitch>`)
    head.push(`        <duration>${ticks}</duration>`)
    if (type !== null) {
      head.push(`        <type>${type.type}</type>`)
      for (let i = 0; i < type.dots; i += 1) head.push('        <dot/>')
    }
  } else if (ev.kind === 'rest') {
    head.push('      <note>')
    if (ev.hidden) head.push('        <rest/>')
    else head.push('        <rest/>')
    head.push(`        <duration>${ticks}</duration>`)
    if (type !== null) {
      head.push(`        <type>${type.type}</type>`)
      for (let i = 0; i < type.dots; i += 1) head.push('        <dot/>')
    }
    if (ev.hidden) head.push('        <print-object>no</print-object>')
    if (ev.comment !== undefined) {
      head.push(`        <notations><footnote>${esc(ev.comment)}</footnote></notations>`)
    }
  } else {
    head.push('      <note>')
    head.push('        <unpitched><display-step>B</display-step><display-octave>4</display-octave></unpitched>')
    head.push(`        <duration>${ticks}</duration>`)
    if (type !== null) {
      head.push(`        <type>${type.type}</type>`)
      for (let i = 0; i < type.dots; i += 1) head.push('        <dot/>')
    }
    head.push('        <notehead>x</notehead>')
  }

  // 连音线/延音线（MusicXML 要同时写 <tie> 与 <notations><tied>）
  if (ev.kind === 'note') {
    if (ev.tieStart === true) head.push('        <tie type="start"/>')
    if (ev.tieEnd === true) head.push('        <tie type="stop"/>')
  }
  const notations: string[] = []
  if (ev.kind === 'note') {
    if (ev.tieStart === true) notations.push('<tied type="start"/>')
    if (ev.tieEnd === true) notations.push('<tied type="stop"/>')
    if (ev.slurStart === true) notations.push('<slur type="start" number="1"/>')
    if (ev.slurEnd === true) notations.push('<slur type="stop" number="1"/>')
  }
  const lyricXml: string[] = []
  for (const l of lyrics) {
    lyricXml.push(`        <lyric number="${l.verse + 1}"><text>${esc(l.slot.text)}</text></lyric>`)
  }

  // 隐藏休止用 <print-object> 放在 <note> 内、音符内容之后
  if (notations.length > 0) head.push(`        <notations>${notations.join('')}</notations>`)
  for (const s of lyricXml) head.push(s)
  head.push('      </note>')
  out.push(...head)
  return out
}

/** 单条倚音（`<grace>` + 音高/类型；不写 duration） */
function graceXml(g: { midi: number; diminishCount: number }, key: number): string[] {
  const sp = spellMidiForStaff(g.midi, key)
  const type = xmlTypeOf(480 / Math.pow(2, Math.max(0, g.diminishCount)))
  const out: string[] = ['      <note>', '        <grace/>']
  out.push(`        <pitch><step>${sp.step}</step>${sp.alter !== 0 ? `<alter>${sp.alter}</alter>` : ''}` +
    `<octave>${sp.octave}</octave></pitch>`)
  if (type !== null) out.push(`        <type>${type.type}</type>`)
  out.push('      </note>')
  return out
}

/** 小节线 → MusicXML（left = 行首/块首；right = 小节末） */
function barlineXml(
  bar: IRBarline,
  location: 'left' | 'right',
  measureNumber: number,
  lastEnding: string,
): string[] {
  const out: string[] = []
  const isRepeatForward = bar.type === '|:' || bar.type === '||:'
  const isRepeatBackward = bar.type === ':|' || bar.type === ':|:'
  const style = barStyleOf(bar.type)
  const endingStart = bar.voltaStart !== undefined
  const endingStop = bar.voltaEnd === true
  if (
    style === null &&
    !isRepeatForward &&
    !isRepeatBackward &&
    !endingStart &&
    !endingStop &&
    (bar.marks === undefined || bar.marks.length === 0) &&
    bar.keyChange === undefined
  ) {
    return out
  }
  out.push(`      <barline location="${location}">`)
  if (style !== null) out.push(`        <bar-style>${style}</bar-style>`)
  if (isRepeatForward) out.push('        <repeat direction="forward"/>')
  if (isRepeatBackward) out.push('        <repeat direction="backward"/>')
  if (endingStart && bar.voltaStart !== undefined) {
    const number = endingNumber(bar.voltaStart.comment) ?? String(measureNumber)
    out.push(`        <ending number="${esc(number)}" type="start">${esc(bar.voltaStart.comment ?? number)}</ending>`)
  }
  if (endingStop) {
    out.push(`        <ending number="${esc(lastEnding)}" type="stop"/>`)
  }
  if (bar.marks !== undefined) {
    for (const mark of bar.marks) {
      out.push(`        <sound ${markSound(mark)}/>`)
    }
  }
  out.push('      </barline>')
  return out
}

/** 跳房子注释里的编号（`"2.3."` → `2,3`；没有数字返回 null） */
function endingNumber(comment: string | undefined): string | null {
  if (comment === undefined) return null
  const nums = comment.match(/\d+/g)
  if (nums === null || nums.length === 0) return null
  return nums.join(',')
}

function endingAfter(bar: IRBarline, last: string): string {
  if (bar.voltaStart !== undefined) return endingNumber(bar.voltaStart.comment) ?? last
  return last
}

function barStyleOf(type: BarlineType): string | null {
  if (type === '||' || type === ':|' || type === ':|:') return 'light-heavy'
  if (type === '||/') return 'light-light'
  if (type === '|' || type === '|:' || type === '||:') return null
  return null
}

function markSound(mark: BarlineMark): string {
  if (mark === 'fine') return 'fine="yes"'
  if (mark === 'dc') return 'dacapo="yes"'
  if (mark === 'ds') return 'dalsegno="1"'
  if (mark === 'hs') return 'segno="1"'
  return 'tocoda="1"'
}

// ============================================================
// MusicXML → IR
// ============================================================

export interface MusicXmlToIrResult {
  ir: ScoreIR
  issues: IRIssue[]
}

/** 主入口：MusicXML 文本 → IR */
export function parseMusicXmlToIR(xml: string): MusicXmlToIrResult {
  const issues: IRIssue[] = []
  const root = parseXml(xml)
  if (root === null || root.name !== 'score-partwise') {
    issues.push(makeIssue('parse', 'must', '不是 MusicXML（score-partwise）或文件无法解析'))
    return { ir: emptyIR(), issues }
  }

  // 标题/作者
  const meta: IRMeta = { subtitles: [], authors: [], key: 'C', meter: '4/4', instruments: [] }
  const workTitle = textOf(kid(kid(root, 'work') ?? root, 'work-title'))
  if (workTitle !== '') meta.title = workTitle
  const ident = kid(root, 'identification')
  if (ident !== null) {
    for (const c of kids(ident, 'creator')) {
      const t = textOf(c)
      if (t !== '') meta.authors.push(t)
    }
  }

  const partList = kid(root, 'part-list')
  const names = new Map<string, string>()
  if (partList !== null) {
    for (const sp of kids(partList, 'score-part')) {
      const id = sp.attrs.id ?? ''
      names.set(id, textOf(kid(sp, 'part-name')))
    }
  }

  const parts: IRPart[] = []
  const lyrics: IRLyricLine[] = []
  for (const [pi, pn] of kids(root, 'part').entries()) {
    const voice = pi + 1
    const part: IRPart = { id: pn.attrs.id ?? `P${voice}`, voice, measures: [] }
    const name = names.get(part.id)
    // 我们自己写的 part-name 是 `P1`/`声部 1` 这类占位；不要把它变成声部名写回 .jps
    if (name !== undefined && name !== '' && !/^(P\d+|声部\s*\d+)$/.test(name)) part.name = name
    parts.push(part)

    let divisions = 1
    let key = 0
    let beats = 4
    let beatType = 4
    let groupIndex = 0
    let evIndex = 0
    let pendingGrace: IRNote['gracenotes'] = undefined
    let lastBar: IRBarline | null = null

    for (const [mi, mx] of kids(pn, 'measure').entries()) {
      const measure: IRMeasure = { index: mi, groupIndex: groupIndex++, events: [], barline: null }
      let startBar: IRBarline | null = null

      for (const node of mx.children) {
        if (typeof node === 'string') continue
        if (node.name === 'attributes') {
          const d = numOf(kid(node, 'divisions'), divisions)
          if (d > 0) divisions = d
          const keyNode = kid(node, 'key')
          if (keyNode !== null) {
            const fifths = numOf(kid(keyNode, 'fifths'), 0)
            key = keySemitoneOfFifths(fifths)
          }
          const timeNode = kid(node, 'time')
          if (timeNode !== null) {
            beats = Math.max(1, numOf(kid(timeNode, 'beats'), beats))
            beatType = Math.max(1, numOf(kid(timeNode, 'beat-type'), beatType))
          }
          continue
        }
        if (node.name === 'direction') {
          const sound = kid(node, 'sound')
          if (sound !== null && sound.attrs.tempo !== undefined) {
            const bpm = Number(sound.attrs.tempo)
            if (Number.isFinite(bpm) && bpm > 0 && meta.tempo === undefined) meta.tempo = bpm
          }
          continue
        }
        if (node.name === 'barline') {
          const bar = barlineFromXml(node)
          if (bar !== null) {
            if (node.attrs.location === 'left') startBar = bar
            else measure.barline = bar
          }
          continue
        }
        if (node.name !== 'note') continue

        const parsed = noteFromXml(node, { divisions, key, beats, beatType, evIndex })
        if (parsed === null) continue
        if (parsed.grace !== undefined) {
          pendingGrace = parsed.grace
          continue
        }
        if (parsed.event === undefined) continue
        const ev = parsed.event
        if (parsed.chord) {
          // 简谱单声部没有柱式和弦：默认取最高音，其余标待确认（用户已拍板）
          const prev = measure.events[measure.events.length - 1]
          if (prev !== undefined && prev.kind === 'note' && ev.kind === 'note' && ev.midi > prev.midi) {
            measure.events[measure.events.length - 1] = ev
          }
          issues.push(makeIssue('chord', 'review', '五线谱和弦已按「最高音为主旋律」处理，其余音未写入简谱'))
          continue
        }
        if (pendingGrace !== undefined && ev.kind === 'note') {
          ev.gracenotes = pendingGrace
          pendingGrace = undefined
        }
        measure.events.push(ev)
        // 歌词
        for (const ly of parsed.lyrics) {
          let line = lyrics.find((l) => l.voice === voice && l.verse === ly.verse)
          if (line === undefined) {
            line = { voice, verse: ly.verse, slots: [] }
            lyrics.push(line)
          }
          line.slots[evIndex] = ly.slot
        }
        evIndex += 1
      }

      if (startBar !== null) measure.startBarline = startBar
      // MusicXML 的「小节边界」本身就是小节线：普通线在我们的写出里被省略了，
      // 读回时必须补一根 `|`，否则写回 .jps 会出现"行从上一小节中间接下去"的告警。
      if (measure.barline === null) measure.barline = { type: '|' }
      lastBar = measure.barline
      part.measures.push(measure)
    }

    // 只有 barline 的空小节也保留（反复/跳房子要挂在线上）
    if (part.measures.length === 0 && lastBar !== null) {
      part.measures.push({ index: 0, groupIndex: 0, events: [], barline: lastBar })
    }

    // 歌词补齐
    for (const line of lyrics.filter((l) => l.voice === voice)) {
      while (line.slots.length < evIndex) line.slots.push(null)
    }

    if (pi === 0) {
      const keyName = keyNameFromSemitone(key)
      meta.key = keyName
      meta.meter = `${beats}/${beatType}`
    }
  }

  if (parts.length === 0) {
    issues.push(makeIssue('parse', 'must', 'MusicXML 里没有 <part>，没有可转换的音符'))
  }

  return {
    ir: { meta, parts, lyrics, issues: dedupeIssues(issues) },
    issues: dedupeIssues(issues),
  }
}

/** jps 调号写法（用 `$` 表示降号，与引擎习惯一致） */
function keyNameFromSemitone(semitone: number): string {
  const pc = ((Math.round(semitone) % 12) + 12) % 12
  const names = ['C', '#C', 'D', '$E', 'E', 'F', '#F', 'G', '#G', 'A', '$B', 'B']
  return names[pc]
}

function emptyIR(): ScoreIR {
  return {
    meta: { subtitles: [], authors: [], key: 'C', meter: '4/4', instruments: [] },
    parts: [],
    lyrics: [],
    issues: [],
  }
}

interface NoteCtx {
  divisions: number
  key: number
  beats: number
  beatType: number
  evIndex: number
}

interface ParsedNote {
  event?: IREvent
  grace?: IRNote['gracenotes']
  chord?: boolean
  lyrics: { verse: number; slot: IRLyricSlot }[]
}

/** 一个 `<note>` → IR 事件（或倚音/和弦标记） */
function noteFromXml(node: XmlNode, ctx: NoteCtx): ParsedNote | null {
  const grace = kid(node, 'grace') !== null
  const chord = kid(node, 'chord') !== null
  const rest = kid(node, 'rest')
  const unpitched = kid(node, 'unpitched')
  const isHidden = node.attrs['print-object'] === 'no'

  // 音高
  let midi: number | null = null
  if (unpitched !== null) midi = null
  else if (rest === null) {
    const pitch = kid(node, 'pitch')
    if (pitch !== null) {
      const step = textOf(kid(pitch, 'step'))
      const alter = numOf(kid(pitch, 'alter'), 0)
      const octave = numOf(kid(pitch, 'octave'), 4)
      midi = staffPitchToMidi(step, alter, octave)
    }
  }

  // 时值（tick 以四分音符=480 为准）
  const rawDur = numOf(kid(node, 'duration'), 0)
  const ticks = rawDur > 0 && ctx.divisions > 0 ? (rawDur / ctx.divisions) * DIV : 0
  const jd = ticksToJpsDuration(Math.max(1, Math.round(ticks)))

  const lyrics = lyricsFromXml(node)
  const typeName = textOf(kid(node, 'type'))

  if (grace) {
    if (midi === null) return null
    const dim = diminishOfType(typeName)
    return {
      grace: {
        after: false,
        notes: [{ degree: 1, octaveShift: 0, accidental: null, midi, diminishCount: dim }],
      },
      lyrics,
    }
  }

  let event: IREvent
  if (unpitched !== null) {
    const r: IRRhythm = {
      kind: 'rhythm',
      augmentCount: jd.augmentCount,
      diminishCount: jd.diminishCount,
      dots: jd.dots,
    }
    event = r
  } else if (rest !== null || midi === null) {
    const r: IRRest = {
      kind: 'rest',
      hidden: isHidden,
      augmentCount: jd.augmentCount,
      diminishCount: jd.diminishCount,
      dots: jd.dots,
    }
    event = r
  } else {
    const jp = midiToJpsPitch(midi, ctx.key)
    const n: IRNote = {
      kind: 'note',
      degree: jp.degree,
      octaveShift: jp.octaveShift,
      accidental: jp.accidental,
      midi,
      augmentCount: jd.augmentCount,
      diminishCount: jd.diminishCount,
      dots: jd.dots,
    }
    const tieStart = kids(node, 'tie').some((t) => t.attrs.type === 'start')
    const tieEnd = kids(node, 'tie').some((t) => t.attrs.type === 'stop')
    if (tieStart) n.tieStart = true
    if (tieEnd) n.tieEnd = true
    const notations = kid(node, 'notations')
    if (notations !== null) {
      const slurs = kids(notations, 'slur')
      if (slurs.some((s) => s.attrs.type === 'start')) n.slurStart = true
      if (slurs.some((s) => s.attrs.type === 'stop')) n.slurEnd = true
    }
    event = n
  }
  return { event, chord, lyrics }
}

/** `<lyric number="1"><text>长</text></lyric>` → 歌词槽 */
function lyricsFromXml(node: XmlNode): { verse: number; slot: IRLyricSlot }[] {
  const out: { verse: number; slot: IRLyricSlot }[] = []
  for (const ly of kids(node, 'lyric')) {
    const textNode = kid(ly, 'text')
    const text = textOf(textNode)
    if (text === '') continue
    const number = Number(ly.attrs.number ?? '1')
    const verse = Math.max(0, (Number.isFinite(number) && number > 0 ? number : 1) - 1)
    out.push({
      verse,
      slot: { text, skip: false, punctuation: isPunctuation(text) },
    })
  }
  return out
}

function isPunctuation(text: string): boolean {
  return /^[，。、；：？！…—·（）《》〈〉“”‘’；：,.!?;:'"()[\]{}<>-]+$/.test(text)
}

/** `<type>` → 减时线数量（eighth=1、16th=2…；quarter=0） */
function diminishOfType(typeName: string): number {
  const map: Record<string, number> = {
    whole: -2,
    half: -1,
    quarter: 0,
    eighth: 1,
    '16th': 2,
    '32nd': 3,
    '64th': 4,
    '128th': 5,
  }
  return Math.max(0, map[typeName] ?? 1)
}

/** `<barline>` → IR 小节线（反复/跳房子/终止） */
function barlineFromXml(node: XmlNode): IRBarline | null {
  const style = textOf(kid(node, 'bar-style'))
  const repeats = kids(node, 'repeat')
  const direction = repeats[0]?.attrs.direction
  const endingStart = kids(node, 'ending').find((e) => e.attrs.type === 'start')
  const endingStop = kids(node, 'ending').find((e) => e.attrs.type === 'stop')
  let type: BarlineType = '|'
  if (direction === 'forward') type = style === 'light-heavy' ? '||:' : '|:'
  else if (direction === 'backward') type = endingStop !== undefined ? ':|' : ':|'
  else if (style === 'light-heavy') type = '||'
  else if (style === 'light-light') type = '||/'
  else if (endingStart !== undefined) type = '|'
  else return null

  const bar: IRBarline = { type }
  if (endingStart !== undefined) {
    const num = endingStart.attrs.number ?? '1'
    bar.voltaStart = {
      open: true,
      comment: `${num}.`,
    }
  }
  if (endingStop !== undefined) bar.voltaEnd = true
  const sounds = kids(node, 'sound')
  const marks: BarlineMark[] = []
  for (const s of sounds) {
    if (s.attrs.fine === 'yes') marks.push('fine')
    if (s.attrs.dacapo === 'yes') marks.push('dc')
    if (s.attrs.dalsegno !== undefined) marks.push('ds')
    if (s.attrs.segno !== undefined) marks.push('hs')
  }
  if (marks.length > 0) bar.marks = marks
  return bar
}

/** 给外部调用的常量（便于 smoke 断言与文档） */
export const SCORE_IR_TICKS_PER_QUARTER = DIV
export const SCORE_IR_BASE_MIDI = BASE_MIDI
export const SCORE_IR_DEGREE_SEMITONES = DEGREE_SEMITONES
