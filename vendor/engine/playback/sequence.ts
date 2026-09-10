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
import { parseInstrumentRef } from './instruments'

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
  // adj343：无 J 时默认 70 拍/分（有指定以乐谱为准）
  return 70
}

interface SeqItem {
  kind: 'note' | 'bar' | 'instrument'
  note?: PlacedToken
  /** 音符全局索引（slur 区间用；bar 项无） */
  noteIdx?: number
  /** adj301/351：乐器切换指令（@乐器名 / @@）——记录所属声部（voice），多声部各声部独立切换 */
  instr?: { name: string | null; voice: number }
  bar?: {
    type: BarlineType
    marks?: BarlineMark[]
    voltaStart?: PlacedBarline['voltaStart']
    voltaEnd?: boolean
    /** adj360：|]/ 房子右侧未封闭——该房子延续到其后第一个跳跃小节线(:|)或结束小节线(||) */
    voltaEndSlash?: boolean
  }
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
  defaultInstrumentRef?: string,
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
  // adj339：Y 行默认乐器支持 `@库id:乐器名["显示名"]`（parseInstrumentRef 剥库前缀/显示名/可选 @），
  // 缺省仍是旧写法（如 `钢琴` / `@小提琴`），路由交给播放端。
  // adjNN：@@ 恢复默认音色 = 第一音色——优先描述头第一个 Y；无 Y 时用调用方传入的「试听音色列表
  // 第一音色」（defaultInstrumentRef）；仍空则回退 ''（播放端路由 → 第一音色库第一音色，钢琴）。
  const yInstruments = result.header.instruments
  const yRef = yInstruments?.[0] ? parseInstrumentRef(yInstruments[0]).ref : ''
  const defaultInstrument = yRef !== '' ? yRef : defaultInstrumentRef?.trim() || ''
  const voiceDefaultOf = (voice: number): string => {
    const y = yInstruments?.[voice - 1]
    return y !== undefined ? parseInstrumentRef(y).ref : defaultInstrument
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
          bar: {
            type: token.type,
            marks: token.marks,
            voltaStart: token.voltaStart,
            voltaEnd: token.voltaEnd,
            voltaEndSlash: token.voltaEndSlash,
          },
        })
      } else if (token.kind === 'instrument') {
        // adj301/351：乐器切换指令纳入播放序列（不产生音符事件）——按所属声部（voice）记录，
        // 多声部各声部独立切换乐器（下一组同声部延续）
        seq.push({ kind: 'instrument', instr: { name: token.name, voice: group.music.voice } })
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

  // 3. 跳房子配对：voltaStart 的 seq 索引 → 对应 voltaEnd 的 seq 索引
  // adj359：指向 voltaEnd「本小节线」而非其后一位——使 `:|]["2."`（共用一根线：volta1 结束 + volta2 开始）
  // 在跳过 volta1 后仍能处理该线上的 volta2 番号
  const voltaAfter = new Map<number, number>()
  const pendingStarts: number[] = []
  seq.forEach((item, si) => {
    if (item.kind !== 'bar') return
    // 先收尾（voltaEnd 出栈配对）再开新（voltaStart 入栈）——`:|]["2."` 同一根线上
    // 同时有 voltaEnd（结束上一房子）与 voltaStart（开始下一房子）时，若先入栈会把自身配成自己的末尾（死循环）
    if (item.bar?.voltaEnd && pendingStarts.length > 0) {
      const start = pendingStarts.pop()!
      // adj360：未封闭房子（|]/）延续到其后第一个「跳跃小节线 :|/：|:」或「结束小节线 ||/||/」处；
      // 已封闭房子（|]）就以该末尾小节线为界
      if (item.bar.voltaEndSlash) {
        const ext = seq.findIndex(
          (it, k) =>
            k > si &&
            it.kind === 'bar' &&
            (it.bar?.type === ':|' || it.bar?.type === ':|:' || it.bar?.type === '||' || it.bar?.type === '||/'),
        )
        voltaAfter.set(start, ext >= 0 ? ext : si)
      } else {
        voltaAfter.set(start, si)
      }
    }
    if (item.bar?.voltaStart) pendingStarts.push(si)
  })

  // 3b. adj359：跳跃展开的预计算
  // - 花 S（&hs）位置：&ds 跳到「全曲第一个 hs」之后（hs 通常写在 ds 之前）
  // - 是否有大反复（&dc/&ds）：决定 &fine 是否生效、&ty 是否跳越
  // - 每个 :| 的反复遍数 = 「本段内到该线为止出现的 :| 个数 + 1」
  //   （`|: A :|` 2 遍；`|: A |[1. B :|][2. C :|] D` 该段两个 :| → 3 遍，末遍两 volta 皆跳过）
  const segnoIdx = seq.findIndex((it) => it.kind === 'bar' && it.bar?.marks?.includes('hs'))
  const hasBigRepeat = seq.some(
    (it) => it.kind === 'bar' && (it.bar?.marks?.includes('dc') || it.bar?.marks?.includes('ds')),
  )
  const voltaNumOf = (it: SeqItem): number => {
    if (it.kind !== 'bar' || !it.bar?.voltaStart) return 1
    const m = /(\d+)/.exec(it.bar.voltaStart.comment ?? '')
    return m ? Number(m[1]) : 1 // 无番号按第 1 遍（第 2 遍起跳过）
  }
  const repeatCountAt = new Map<number, number>()
  {
    let endCount = 0
    seq.forEach((it, k) => {
      if (it.kind !== 'bar') return
      if (it.bar?.type === '|:' || it.bar?.type === '||:') endCount = 0
      if (it.bar?.type === ':|' || it.bar?.type === ':|:') {
        endCount++
        repeatCountAt.set(k, endCount + 1)
      }
    })
  }

  // 4. 展开反复（支持两层：反复内嵌跳房子）
  // adj258：按 voiceBlocks 分块——多声部块内 group 共享 blockStartMs（同一组 Q1/Q2 同时播放），
  // 跨块顺序累加。单声部 group 不在任何 voiceBlock 内，自成块（blockStartMs = 累加）。
  // adj307：多组多声部（同一 voice 在不同 voiceBlock 多次出现）— 不再用全局 voice→首 group
  // 索引共享（会导致第二组覆盖第一组 ms）；改为按 voiceBlocks 顺序，每个 voice
  // 在该 vb 内取"下一个未处理"的 group 索引，使每组 ms 独立累加、同步正确。
  const beatMs = 60000 / bpm
  const groupStartMs: number[] = new Array(result.groups.length).fill(0)
  const barStartMsInGroup: number[][] = result.groups.map(() => [])
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
      ms += bb * beatMs
    }
    totalMs = ms
  }

  const events: PlayEvent[] = []
  let pass = 1 // 当前反复遍次（1 起；决定演奏哪个 volta）
  let repeatStart = 0 // 反复起点（无 |: 时默认从头反复）
  let bigRepeatDone = false // adj359：&dc/&ds 是否已发生过（大反复；之后 &fine 生效、&ty 跳越、dc/ds 不再重复跳）
  let landedByVoltaSkip = -1 // adj359：因跳过某 volta 而落在的小节线索引（该线上不再触发 :| 回跳，只处理其 volta 番号）
  let i = 0
  let guard = 0
  const maxIter = seq.length * 6 // 死循环保护
  // adj361：无缝跳跃——跳跃（回跳/前跳）后从「当前播放时刻」继续，而不是按布局时钟累计。
  // 原 adj282 用 passMs = passEndMs（= 遍偏移 + 该组布局起点 + 整组时长）→ 回跳后整体多等
  // 「本组布局起点 + 整组时长」，且前跳（&ds/&ty/跳房子跳过）不改 passMs 而布局时钟已跳到后面
  // → 跳过段被当成空档 → 出现十几~几十秒延迟。现改为：跳跃时记下待跳时刻 = lastEndMs（当前播放时刻），
  // 下一个事件生成时把 passMs 对齐（使该事件 atMs 正好 = 待跳时刻），所有跳跃皆无缝。
  let passMs = 0
  let lastEndMs = 0 // 已生成事件的最大结束时刻（= 当前播放时刻）
  let pendingJumpMs = -1 // 跳跃后要对齐到的播放时刻（下一个事件落在此刻）
  // adj301/351：@乐器名 覆盖当前乐器——**各声部独立**（多声部 Q1/Q2/Q3 各自延续；@@ 清该声部覆盖回 Y 默认）。
  // adj334：保留原始名（可为 `音色名` 或 `库id:音色名`），由 instrumentToProgram 在播放端路由，
  // 不再压缩成固定 6 种——否则动态采样音色名会丢失。
  const overriddenByVoice = new Map<number, string | null>()
  const keySemitone = parseKey(result.header.key)
  // adj88：连音线内相同音高连续音符连奏合并——上一个已发事件的音符索引与音高；
  // 当前音符若与上一个音高相同、同属某连音线且中间无音符（索引相邻），则时值并入前一事件
  let lastEventNoteIdx = -1
  let lastEventPitch: string | null | undefined = undefined
  while (i < seq.length && guard++ < maxIter) {
    const item = seq[i]
    if (item.kind === 'instrument') {
      // adj301/351：@乐器名 切换（覆盖该声部默认）；@@（name=null）清除该声部覆盖（回声部默认）
      overriddenByVoice.set(item.instr!.voice, item.instr!.name ?? null)
      i++
      continue
    }
    if (item.kind === 'note' && item.note) {
      const placed = item.note
      const token = placed.token
      const durationMs = (tokenDuration(token) * 60000) / bpm
      const pitch = placed.audioPitch
      const curNoteIdx = item.noteIdx ?? -1
      // adj282：每个 event 的 atMs 由所属 group 的拍时钟决定（不受源码顺序累加），
      // 保证同组同 (barIndex, beatPos) 的各声部事件 atMs 相同 → 同步播放
      const g = placed.id.group
      const bi = placed.barIndex
      const bp = placed.beatPos
      const clock = groupStartMs[g] + (barStartMsInGroup[g][bi] ?? 0) + bp * beatMs
      // adj361：若有待跳时刻，先把 passMs 对齐（使本事件 atMs = 待跳时刻 → 无缝衔接）
      if (pendingJumpMs >= 0) {
        passMs = pendingJumpMs - clock
        pendingJumpMs = -1
      }
      const atMs = passMs + clock
      lastEndMs = Math.max(lastEndMs, atMs + durationMs)
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
        lastEndMs = Math.max(lastEndMs, prev.atMs + prev.durationMs) // adj361：合并后当前播放时刻随之前移
        // adj300：连音合并——把被合并音符的拍段并入 prev 的播放拍段（色块可覆盖全时值，
        // 如 (1 - - - | 1) - 0 0 中 1 合并 6 拍，色块依次滑过 1 - - - 1 -）
        const prevBeat = (prev.playheadSegs ?? []).reduce((a, s) => a + s.beats, 0)
        prev.playheadSegs = (prev.playheadSegs ?? []).concat(buildPlayheadSegs(item.note, prevBeat, rightEdgeByNoteIdx.get(item.note.id.index)))
        // adj157：合并时值；atMs 来自拍时钟（每个 event 独立），不需全局 at 累加
        lastEventNoteIdx = curNoteIdx
        i++
        continue
      }
      // adj351：按声部取覆盖乐器（该声部最近一次 @ 结果；未设置/@@ 清空 → 用该声部 Y 默认乐器）
      const voiceInst = overriddenByVoice.get(placed.id.voice)
      const instrument =
        typeof voiceInst === 'string' && voiceInst.length > 0
          ? parseInstrumentRef(voiceInst).ref
          : voiceDefaultOf(placed.id.voice)
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
    // adj359：跳房子——本遍不演奏该 volta（volta 番号 = 遍次；无番号按第 1 遍）时，跳到其末尾小节线
    // （停在末尾线上而非其后一位：`:|]["2."` 共用一根线时，仍需处理该线上的 volta2 番号）
    const trySkipVolta = (): boolean => {
      if (!(bar.voltaStart && voltaNumOf(item) !== pass)) return false
      const target = voltaAfter.get(i) ?? i + 1
      landedByVoltaSkip = target
      i = target
      pendingJumpMs = lastEndMs // adj361：被跳过的房子不占时，从当前播放时刻无缝接上
      return true
    }
    // 因跳过 volta 而落在的小节线：不再触发该线的 :| 回跳（该反复已在跳过时越过），只处理其 volta 番号后前进
    if (i === landedByVoltaSkip) {
      landedByVoltaSkip = -1
      if (trySkipVolta()) continue
      i++
      continue
    }
    // adj359：小节线修饰符跳转（&fine 曲终 / &dc 从头反复 / &ds 跳花S / &ty 跳越）
    // 规则（用户规范）：&dc/&ds「大反复」全曲各只跳一次（之后再遇不跳，续播到 Fine/终止线，避免死循环）；
    // &ty 第一次遇到忽略，大反复之后再次遇到才跳到下一个 &ty（两 ty 之间不演奏）；
    // &fine 在有 dc/ds 时仅于大反复之后生效（第一遍穿过 Fine 走到大反复）。
    if (bar.marks?.length) {
      if (bar.marks.includes('fine') && (!hasBigRepeat || bigRepeatDone)) {
        i = seq.length // 曲终：播放到此结束
        continue
      }
      if (bar.marks.includes('dc')) {
        if (!bigRepeatDone) {
          i = 0 // 从头反复
          bigRepeatDone = true
          pass = 1
          repeatStart = 0
          pendingJumpMs = lastEndMs // adj361：从当前播放时刻无缝接上（从头反复）
          continue
        }
        i++
        continue
      }
      if (bar.marks.includes('ds')) {
        if (!bigRepeatDone) {
          i = segnoIdx >= 0 ? segnoIdx + 1 : 0 // 跳到花 S 之后（hs 通常写在 ds 之前）
          bigRepeatDone = true
          pass = 1
          repeatStart = 0
          pendingJumpMs = lastEndMs // adj361：跳到花 S 后从当前播放时刻无缝接上
          continue
        }
        i++
        continue
      }
      if (bar.marks.includes('ty')) {
        if (bigRepeatDone) {
          const nextTy = seq.findIndex((it, k) => k > i && it.kind === 'bar' && it.bar?.marks?.includes('ty'))
          if (nextTy >= 0) {
            i = nextTy + 1 // 跳到下一个 &ty 之后（两 ty 之间不演奏）
            pendingJumpMs = lastEndMs // adj361：跳越段不占时，从当前播放时刻无缝接上
            continue
          }
        }
        i++
        continue
      }
    }
    // 反复结束线 :| —— 优先于 volta 跳过：`:|]["2."` 共用一根线时（volta1 结束 + volta2 开始），
    // 正常演奏到该线应先按反复回跳；只有「因跳过 volta1 而落在此线」时才越过回跳、转去判断 volta2 番号
    if (bar.type === ':|' || bar.type === ':|:') {
      const count = repeatCountAt.get(i) ?? 2 // 本段内到该线的第几个 :|（+1 = 总遍数）
      if (pass < count) {
        i = repeatStart
        pass++
        pendingJumpMs = lastEndMs // adj361：反复回跳→从当前播放时刻无缝接上（新遍）
        continue
      }
      if (bar.type === ':|:') {
        repeatStart = i + 1 // 新段落起点
        pass = 1
      }
      i++
      continue
    }
    if (trySkipVolta()) continue
    switch (bar.type) {
      case '|:':
      case '||:':
        repeatStart = i + 1
        pass = 1 // 新段落起点 → 遍次从 1 起
        i++
        break
      case '||':
      case '||/':
        i = seq.length // 终止线：结束
        break
      default:
        i++
    }
  }

  // adj361：总时长 = 实际播放到的时刻（= 所有事件的最大结束时刻，含反复遍）
  totalMs = lastEndMs

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
