/**
 * engine/playback/sequence.ts — 播放序列构建（纯函数，可单测）
 *
 * 输入：解析结果 + 排版结果 + 拍速（BPM）
 * 输出：按实际播放顺序展开的事件序列（含反复记号展开）：
 *  - `|:` / `:|`：段内反复（两遍）
 *  - `:|:`：包围式反复（段起点/终点）
 *  - `[ ]` 跳房子：第一遍经过 [ 段，第二遍跳过
 *  - `||` / `||/`：终止线，播放到此结束
 */
import type { BarlineMark, BarlineType, ParseResult, PlacedBarline, PlacedToken, ScoreLayout } from '../types'
import { tokenDuration } from '../duration'
import { parseKey, pitchToName } from '../layout/index'
import { resolveInstrument } from './instruments'
import type { InstrumentId } from './instruments'

/**
 * 解析音符 id（"page_voice_group_index"）为全局音符序号定位起点。
 * 返回 { index }（全局音符索引，按 byIndex 映射）；无法解析返回 null。
 */
function parseStartNoteIdx(id: string): { index: number } | null {
  const parts = id.split('_')
  const index = Number(parts[parts.length - 1])
  return Number.isFinite(index) ? { index } : null
}

/** adj300：播放拍段（每段 ≤1 拍）——色块按拍段滑动；连音合并时后续音符拍段并入事件 */
export interface PlayheadSeg {
  /** 段起点拍偏移（相对事件起点） */
  beat: number
  /** 段拍数（≤1） */
  beats: number
  pageIndex: number
  x: number
  y: number
  width: number
  voice: number
  group: number
}

export interface PlayEvent {
  placed: PlacedToken
  /** 距开始的延迟（ms） */
  atMs: number
  /** 时值（ms） */
  durationMs: number
  /** 音高覆盖（倚音等装饰音，MIDI 音名；缺省用 placed.audioPitch，adj23） */
  pitch?: string | null
  /** adj257：乐器名（多声部按各自乐器同时演奏；缺省 = 通用音色） */
  instrument?: string
  /** adj300：播放拍段轨道（连音合并时含被合并音符的拍段，覆盖完整时值；普通事件 = 音符拍段） */
  playheadSegs?: PlayheadSeg[]
}

export interface PlaySequence {
  events: PlayEvent[]
  totalMs: number
  bpm: number
}

/** 从描述头 J 推断拍速（30~240），无效或缺失默认 90；数字部分优先（多条 J 时） */
export function inferBpm(result: ParseResult): number {
  const t = result.header.tempoNum ?? result.header.tempo
  if (t) {
    const n = Number(t)
    if (Number.isFinite(n) && n > 0) {
      return Math.min(240, Math.max(30, Math.round(n)))
    }
  }
  // adj308：默认试听速度 60 拍/分（描述头无 J 时）
  return 60
}

interface SeqItem {
  kind: 'note' | 'bar' | 'instrument'
  note?: PlacedToken
  /** 音符全局索引（slur 区间用；bar 项无） */
  noteIdx?: number
  /** adj301：乐器切换指令（@乐器名 / @@） */
  instr?: { name: string | null }
  bar?: { type: BarlineType; marks?: BarlineMark[]; voltaStart?: PlacedBarline['voltaStart']; voltaEnd?: boolean }
}

/** adj320：构建一个音符的播放拍段——按「时值元素」分块：
 *  · 附图段（el='dot'）与其前一个主音符段**合并为一个色块**（附点不单独分块）；
 *  · 增时线段（el='aug'）**独立一个色块**；纯音符跨拍段（多声部 5--- 无 aug el）各拍一块。
 *  x = 块左缘，width = 至「下一块左缘」（连续）；最后块宽 = to「endX」（下一时值元素左缘或小节线左缘）。
 *  endX 由 buildPlaySequence 传入（同 group 内下一时值元素.x 或小节线.x）。 */
function buildPlayheadSegs(plc: PlacedToken, startBeat: number, endX?: number): PlayheadSeg[] {
  const base = {
    pageIndex: plc.id.page,
    y: plc.y,
    voice: plc.id.voice,
    group: plc.id.group,
  }
  const segs = plc.segments ?? []
  const right = endX ?? (plc.rightX ?? (plc.x + plc.width))
  if (segs.length === 0) {
    return [{ beat: startBeat, beats: plc.duration, x: plc.x, width: Math.max(0, right - plc.x), ...base }]
  }
  // 先分块（dot 并入前一个主音符块；aug/纯 note 各自成块）
  const blocks: { x: number; beats: number; dot: boolean }[] = []
  for (const s of segs) {
    if (s.el === 'dot' && blocks.length > 0) {
      blocks[blocks.length - 1].beats += s.beats
    } else {
      blocks.push({ x: s.x, beats: s.beats, dot: s.el === 'dot' })
    }
  }
  // 算宽度：每块右 = 下一块左（连续）；最后块右 = right
  const out: PlayheadSeg[] = []
  let acc = startBeat
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i]
    const x1 = i < blocks.length - 1 ? blocks[i + 1].x : right
    out.push({ beat: acc, beats: blk.beats, x: blk.x, width: Math.max(0, x1 - blk.x), ...base })
    acc += blk.beats
  }
  return out
}

export function buildPlaySequence(
  result: ParseResult,
  layout: ScoreLayout,
  bpm: number,
  startNoteId?: string | null,
): PlaySequence {
  // 0. adj88：起始音符定位——双击谱面音符试听时，从该音符（含之后）开始播放；
  //    事件延迟统一减去起点音符的 atMs，使起点音符立即播放
  const startIdxByPage = startNoteId ? parseStartNoteIdx(startNoteId) : null
  // 1. 按全局音符序号索引 PlacedToken
  const byIndex = new Map<number, PlacedToken>()
  for (const page of layout.pages) {
    for (const n of page.notes) byIndex.set(n.id.index, n)
  }
  // ★ adj320：每个音符的色块右边界 = 同 group 内下一个时值元素左缘，或该小节线左缘（取先到者）。
  //   使色块「当前时值元素 → 下一时值元素/小节线前」连续覆盖，不依赖显示占宽右缘。
  const rightEdgeByNoteIdx = new Map<number, number>()
  {
    const byGroupNotes = new Map<number, PlacedToken[]>()
    const byGroupBars = new Map<number, PlacedBarline[]>()
    for (const page of layout.pages) {
      for (const n of page.notes) (byGroupNotes.get(n.id.group) ?? byGroupNotes.set(n.id.group, []).get(n.id.group)!).push(n)
      for (const b of page.barlines) (byGroupBars.get(b.id.group) ?? byGroupBars.set(b.id.group, []).get(b.id.group)!).push(b)
    }
    for (const [group, notes] of byGroupNotes) {
      const sorted = [...notes].sort((a, b) => a.x - b.x)
      const bars = (byGroupBars.get(group) ?? []).slice().sort((a, b) => a.x - b.x)
      sorted.forEach((n, i) => {
        const nextNote = i < sorted.length - 1 && sorted[i + 1].x > n.x + 1e-3 ? sorted[i + 1].x : Infinity
        const nextBar = bars.find((b) => b.x > n.x + 1e-3)?.x ?? Infinity
        const edge = Math.min(nextNote, nextBar)
        rightEdgeByNoteIdx.set(n.id.index, edge === Infinity ? (n.rightX ?? n.x + n.width) : edge)
      })
    }
  }
  // adj301/302：全局默认乐器 = 描述头第一个 Y 乐器（name 与试听音色库一致，无则音色库第一个钢琴）。
  // 多声部按声部序号对应 Y 行顺序（Q1→Y[0]、Q2→Y[1]…）；声部比 Y 行多时用全局默认。
  // @乐器名 覆盖声部默认（全局持续直到 @@），@@ 清除覆盖（回声部默认）
  const yInstruments = result.header.instruments
  const defaultInstrument = resolveInstrument(yInstruments?.[0])
  const voiceDefaultOf = (voice: number): InstrumentId => {
    const y = yInstruments?.[voice - 1]
    return y !== undefined ? resolveInstrument(y) : defaultInstrument
  }

  // 2. 重建交错序列（音符 + 小节线），保持源码顺序
  //    adj88：同时记录连音线 (…) 覆盖的音符区间（open slur → 当前音符起点，close → 终点），
  //    供「相同音高连奏合并时值」使用（如 (2 - | 2/) 的 2 连奏 2.5 拍）
  const seq: SeqItem[] = []
  let noteIdx = 0
  const slurStarts: number[] = []
  const slurRanges: [number, number][] = []
  for (const line of result.lines) {
    if (line.kind !== 'music') continue
    const group = result.groups.find((g) => g.music === line)
    if (!group) continue
    for (const token of group.music.tokens) {
      if (token.kind === 'slur') {
        if (token.dir === 'open') slurStarts.push(noteIdx)
        else {
          const s = slurStarts.pop()
          if (s !== undefined && noteIdx - 1 > s) slurRanges.push([s, noteIdx - 1])
        }
        continue
      }
      if (token.kind === 'barline') {
        seq.push({
          kind: 'bar',
          bar: { type: token.type, marks: token.marks, voltaStart: token.voltaStart, voltaEnd: token.voltaEnd },
        })
      } else if (token.kind === 'instrument') {
        // adj301：乐器切换指令纳入播放序列（不产生音符事件，仅切换当前乐器）
        seq.push({ kind: 'instrument', instr: { name: token.name } })
      } else if (token.kind === 'note' || token.kind === 'rest' || token.kind === 'rhythm') {
        const placed = byIndex.get(noteIdx)
        if (placed) seq.push({ kind: 'note', note: placed, noteIdx })
        noteIdx++
      }
    }
  }
  // 音符 → 所在 slur 区间（一个音符可属多层；用于判断相邻音符是否在同一连音线内）
  const slurOf = new Map<number, Set<number>>()
  slurRanges.forEach(([s, e], ri) => {
    for (let k = s; k <= e; k++) {
      const set = slurOf.get(k)
      if (set) set.add(ri)
      else slurOf.set(k, new Set([ri]))
    }
  })

  // 3. 跳房子配对：voltaStart 的 seq 索引 → 对应 voltaEnd 之后的位置
  const voltaAfter = new Map<number, number>()
  const pendingStarts: number[] = []
  seq.forEach((item, si) => {
    if (item.kind !== 'bar') return
    if (item.bar?.voltaStart) pendingStarts.push(si)
    if (item.bar?.voltaEnd && pendingStarts.length > 0) {
      const start = pendingStarts.pop()!
      voltaAfter.set(start, si + 1)
    }
  })

  // 4. 展开反复（支持两层：反复内嵌跳房子）
  // adj258：按 voiceBlocks 分块——多声部块内 group 共享 blockStartMs（同一组 Q1/Q2 同时播放），
  // 跨块顺序累加。单声部 group 不在任何 voiceBlock 内，自成块（blockStartMs = 累加）。
  // adj307：多组多声部（同一 voice 在不同 voiceBlock 多次出现）— 不再用全局 voice→首 group
  // 索引共享（会导致第二组覆盖第一组 ms）；改为按 voiceBlocks 顺序，每个 voice
  // 在该 vb 内取"下一个未处理"的 group 索引，使每组 ms 独立累加、同步正确。
  const beatMs = 60000 / bpm
  const groupStartMs: number[] = new Array(result.groups.length).fill(0)
  const barStartMsInGroup: number[][] = result.groups.map(() => [])
  // adj282：group → 所在块时长 ms（同块各声部共享；反复回跳推进遍时钟用）
  const blockDurOfGroup: number[] = new Array(result.groups.length).fill(0)
  let totalMs = 0
  {
    let ms = 0
    // 每个 voice 在 result.groups 中按顺序的下一个待处理 group 索引（多组多声部各自独立 ms）
    const voiceNextGroupIdx = new Map<number, number>()
    // 已纳入 voiceBlock 的 groupIndex
    const covered = new Set<number>()
    // 块拍数（块内 max groupBeats）
    const blockBeatsOf = (gis: number[]) => {
      let bb = 0
      for (const gi of gis) {
        let b = 0
        for (const tk of result.groups[gi].music.tokens) {
          if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') b += tokenDuration(tk)
        }
        if (b > bb) bb = b
      }
      return bb
    }
    // 该 group 的 bsMs（按 token 拍累计；同块各 group 小节对齐 → bsMs 一致）
    const bsMsOf = (gi: number) => {
      const bsMs: number[] = []
      let beats = 0
      bsMs.push(0)
      for (const tk of result.groups[gi].music.tokens) {
        if (tk.kind === 'barline') bsMs.push(beats * beatMs)
        else if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') beats += tokenDuration(tk)
      }
      bsMs.push(beats * beatMs)
      return bsMs
    }
    // 1. 多声部块（voiceBlock）— 每个 voice 在该 vb 取下一个未处理的 group（adj307）
    for (const page of layout.pages) {
      for (const vb of page.voiceBlocks) {
        const gis: number[] = []
        for (const v of vb.voices) {
          // 找该 voice 下一个属于本 vb 的 group（按 result.groups 顺序遍历，跳过已覆盖）
          let cur = voiceNextGroupIdx.get(v.voice) ?? 0
          while (
            cur < result.groups.length &&
            (covered.has(cur) || result.groups[cur].music.voice !== v.voice)
          ) {
            cur++
          }
          if (cur < result.groups.length && result.groups[cur].music.voice === v.voice) {
            gis.push(cur)
            voiceNextGroupIdx.set(v.voice, cur + 1)
          }
        }
        if (gis.length === 0) continue
        gis.sort((a, b) => a - b)
        const bb = blockBeatsOf(gis)
        for (const gi of gis) {
          groupStartMs[gi] = ms
          barStartMsInGroup[gi] = bsMsOf(gi)
          blockDurOfGroup[gi] = bb * beatMs
          covered.add(gi)
        }
        ms += bb * beatMs
      }
    }
    // 2. 单声部 group（不在任何 voiceBlock 内）按 groups 顺序自成块累加
    for (let gi = 0; gi < result.groups.length; gi++) {
      if (covered.has(gi)) continue
      groupStartMs[gi] = ms
      barStartMsInGroup[gi] = bsMsOf(gi)
      let bb = 0
      for (const tk of result.groups[gi].music.tokens) {
        if (tk.kind === 'note' || tk.kind === 'rest' || tk.kind === 'rhythm') bb += tokenDuration(tk)
      }
      blockDurOfGroup[gi] = bb * beatMs
      ms += bb * beatMs
    }
    totalMs = ms
  }

  const events: PlayEvent[] = []
  let pass = 1
  let repeatStart = -1
  let i = 0
  let guard = 0
  const maxIter = seq.length * 6 // 死循环保护
  // adj282：播放遍时钟——反复回跳（:|/&dc）时把 passMs 推进到本遍已播块末，
  // 展开后同一音符第二遍 atMs 不再重叠（此前布局时钟不变 → 音频重叠/高亮错乱）；
  // 单向前跳（&ds/&ty/跳房子第二遍跳过）不推进（时间连续，跳过段不占时）
  let passMs = 0
  let passEndMs = 0
  // adj301：@乐器名 覆盖当前乐器（全局持续）；@@（null）清覆盖（回声部默认）。初始无覆盖 → 各声部用自己 Y 乐器
  let overridden: InstrumentId | null = null
  const keySemitone = parseKey(result.header.key)
  // adj88：连音线内相同音高连续音符连奏合并——上一个已发事件的音符索引与音高；
  // 当前音符若与上一个音高相同、同属某连音线且中间无音符（索引相邻），则时值并入前一事件
  let lastEventNoteIdx = -1
  let lastEventPitch: string | null | undefined = undefined
  while (i < seq.length && guard++ < maxIter) {
    const item = seq[i]
    if (item.kind === 'instrument') {
      // adj301：@乐器名 切换（覆盖声部默认）；@@（name=null）清除覆盖（回声部默认）
      overridden = item.instr?.name != null ? resolveInstrument(item.instr.name) : null
      i++
      continue
    }
    if (item.kind === 'note' && item.note) {
      const placed = item.note
      const token = placed.token
      const durationMs = (tokenDuration(token) * 60000) / bpm
      const pitch = placed.audioPitch
      const curNoteIdx = item.noteIdx ?? -1
      // adj256：每个 event 的 atMs 由所属 group 的拍时钟决定（不受源码顺序累加），
      // 保证同组同 (barIndex, beatPos) 的各声部事件 atMs 相同 → 同步播放
      const g = placed.id.group
      const bi = placed.barIndex
      const bp = placed.beatPos
      // adj282：加播放遍偏移 passMs——同块各声部共享（同步保持），反复回跳后整体平移（不重叠）
      const atMs = passMs + groupStartMs[g] + (barStartMsInGroup[g][bi] ?? 0) + bp * beatMs
      // adj282：本遍已播块末（块时长固定，与音符时值/连音合并无关）——回跳时作为新遍起点
      // adj285：块结束 = 遍偏移 + 块布局起点 + 块时长（此前漏加 groupStartMs →
      // 多曲行谱 totalMs 只算到第一块，播放到后续行中途被 doneTimer 截断）
      passEndMs = Math.max(passEndMs, passMs + groupStartMs[g] + blockDurOfGroup[g])
      // adj89：合并判定——与前一已发事件音高相同、索引相邻（中间无音符）、
      // 且**两者同属同一条连音线**（严格 slur 内连奏）：
      // (2 - | 2/) 的 2 连 2.5 拍；(2 3/ 2/ | 2) 第 3、4 个 2 连奏；
      // (2 3 | 2) 中间隔 3 不合并；**连音线外的同音符不并入**
      // （(2 - | 2) 2 → 播 3 拍再播 1 拍，不连成 4 拍）
      const prevRanges = lastEventNoteIdx >= 0 ? slurOf.get(lastEventNoteIdx) : undefined
      const curRanges = slurOf.get(curNoteIdx)
      const shareSlur =
        prevRanges !== undefined &&
        curRanges !== undefined &&
        [...prevRanges].some((r) => curRanges.has(r))
      if (
        lastEventNoteIdx >= 0 &&
        curNoteIdx === lastEventNoteIdx + 1 &&
        shareSlur &&
        pitch !== null &&
        pitch === lastEventPitch
      ) {
        const prev = events[events.length - 1]
        prev.durationMs += durationMs
        // adj300：连音合并——把被合并音符的拍段并入 prev 的播放拍段（色块可覆盖全时值，
        // 如 (1 - - - | 1) - 0 0 中 1 合并 6 拍，色块依次滑过 1 - - - 1 -）
        const prevBeat = (prev.playheadSegs ?? []).reduce((a, s) => a + s.beats, 0)
        prev.playheadSegs = (prev.playheadSegs ?? []).concat(buildPlayheadSegs(item.note, prevBeat, rightEdgeByNoteIdx.get(item.note.id.index)))
        // adj157：合并时值；atMs 来自拍时钟（每个 event 独立），不需全局 at 累加
        lastEventNoteIdx = curNoteIdx
        i++
        continue
      }
      const instrument = overridden ?? voiceDefaultOf(placed.id.voice)
      // 倚音（adj23）：前倚音提前于主音符、后倚音紧跟主音符，时值 1/8 拍，音高用倚音音符本身
      const gn = token.kind === 'note' ? token.gracenotes : undefined
      const graceMs = (0.125 * 60000) / bpm
      const gracePitches =
        gn && gn.notes.length > 0
          ? gn.notes.map((g) => pitchToName(g.pitch, g.octaveShift, g.accidental, keySemitone))
          : []
      if (gn && !gn.after && gracePitches.length > 0) {
        for (let gi = 0; gi < gn.notes.length; gi++) {
          events.push({
            placed: item.note,
            instrument,
            atMs: Math.max(0, atMs - (gn.notes.length - gi) * graceMs),
            durationMs: graceMs,
            pitch: gracePitches[gi],
          })
        }
      }
      events.push({ placed: item.note, instrument, atMs, durationMs, playheadSegs: buildPlayheadSegs(item.note, 0, rightEdgeByNoteIdx.get(item.note.id.index)) })
      if (gn && gn.after && gracePitches.length > 0) {
        for (let gi = 0; gi < gn.notes.length; gi++) {
          events.push({
            placed: item.note,
            instrument,
            atMs: atMs + durationMs + gi * graceMs,
            durationMs: graceMs,
            pitch: gracePitches[gi],
          })
        }
      }
      lastEventNoteIdx = curNoteIdx
      lastEventPitch = pitch
      i++
      continue
    }
    const bar = item.bar!
    // adj126：小节线修饰符跳转（&fine 曲终结束 / &dc 从头反复 / &ds 跳到花S / &ty 跳到下一大跳跃）
    if (bar.marks?.length) {
      if (bar.marks.includes('fine')) {
        i = seq.length // 曲终：播放到此结束
        continue
      }
      if (bar.marks.includes('dc')) {
        i = 0 // 从头反复
        // adj282：从头反复 → 新遍，遍时钟推进（与 |: 跳回一致，避免 atMs 重叠）
        passMs = passEndMs
        continue
      }
      if (bar.marks.includes('ds')) {
        // 跳到 &hs 花 S 标记位置开始
        const hs = seq.findIndex((it, k) => k > i && it.kind === 'bar' && it.bar?.marks?.includes('hs'))
        i = hs >= 0 ? hs + 1 : i + 1
        continue
      }
      if (bar.marks.includes('ty')) {
        // 跳到下一个 &ty 大跳跃记号（两 ty 中间不演奏）
        const nextTy = seq.findIndex((it, k) => k > i && it.kind === 'bar' && it.bar?.marks?.includes('ty'))
        i = nextTy >= 0 ? nextTy + 1 : i + 1
        continue
      }
    }
    // 跳房子：第二遍跳过 [ 段
    if (bar.voltaStart && pass === 2) {
      i = voltaAfter.get(i) ?? i + 1
      continue
    }
    switch (bar.type) {
      case '|:':
      case '||:':
        repeatStart = i + 1
        i++
        break
      case ':|':
      case ':|:':
        if (pass === 1 && repeatStart >= 0) {
          i = repeatStart
          pass = 2
          // adj282：反复回跳 → 新遍，遍时钟推进到本遍已播块末（展开事件 atMs 不重叠）
          passMs = passEndMs
        } else {
          if (bar.type === ':|:') repeatStart = i + 1 // 新段落起点
          i++
        }
        break
      case '||':
      case '||/':
        i = seq.length // 终止线：结束
        break
      default:
        i++
    }
  }

  // adj282：总时长 = 展开后的实际播放时长（含反复遍；原布局总时长在反复时会中途截断播放）
  totalMs = passEndMs

  // adj88：从指定音符开始——丢弃起点之前的音符事件，其后 atMs 统一减去起点 atMs
  if (startIdxByPage !== null) {
    const from = events.findIndex((e) => e.placed.id.index >= startIdxByPage.index)
    if (from > 0) {
      const base = events[from].atMs
      const sliced = events.slice(from).map((e) => ({ ...e, atMs: Math.max(0, e.atMs - base) }))
      return { events: sliced, totalMs: totalMs - base, bpm }
    }
    if (from === 0) return { events, totalMs, bpm }
    // 起点音符不在事件中（隐藏休止符等）→ 从第一个可播放事件开始
    return { events, totalMs, bpm }
  }

  return { events, totalMs, bpm }
}
