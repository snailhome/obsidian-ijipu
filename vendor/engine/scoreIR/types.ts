/**
 * engine/scoreIR/types.ts — 乐谱中间表示（ScoreIR）
 *
 * 为什么要有这一层：`.jps` 是**简谱写法**，MusicXML 是**五线谱交换格式**，两边
 * 的音高/时值/小节/歌词口径不同。直接把文本互转会在"调号、八度、时值、连音线"
 * 四处各写一套判断，必然漂开。所以先转成一份**与写法无关**的语义模型，再由它
 * 分别写回 `.jps` 或 MusicXML：
 *
 *   .jps ──parseJpsToIR──▶ ScoreIR ──irToJps──▶ .jps
 *   MusicXML ──parseMusicXmlToIR──▶ ScoreIR ──irToMusicXml──▶ MusicXML
 *
 * 约束（与引擎其它模块一致）：纯类型 + 纯函数，零 React/DOM 依赖；所有识别结果
 * 通过 `source` 带回「原图 bbox / 置信度 / 元素 id」，供 OMR 应用做三向联动。
 */
import type { BarlineMark, BarlineType } from '../types'

/**
 * 元素在来源里的位置。
 *
 * `.jps` 侧给 `line`/`col`（源码坐标，与 `ParseError` 同口径）；
 * 识图侧给 `page`/`bbox`/`conf`/`elementId`（原图坐标）。两边可以同时存在：
 * 识别出来的音符先有 bbox，转成 `.jps` 后又有源码行号，联动两头都要用。
 */
export interface IRSourcePos {
  /** 1-based 源码行号 */
  line: number
  /** 0-based 行内字符偏移 */
  col: number
  /** 原始 token 文本（便于对账；识图侧可以没有） */
  raw?: string
  /** 页号（0-based；识图侧用） */
  page?: number
  /** 原图 bbox：[x, y, w, h]（识图侧用） */
  bbox?: [number, number, number, number]
  /** 置信度 0–1（识图侧用） */
  conf?: number
  /** 识别元素 id（识图侧用；与 UI 框选联动） */
  elementId?: string
}

/** 倚音（前/后）里的一个音 */
export interface IRGracenote {
  degree: number
  octaveShift: number
  accidental: '#' | '$' | '=' | null
  /** 调号下算出的 MIDI（含变音） */
  midi: number
  diminishCount: number
}

/** 倚音组（`[65]` 前倚音 / `[h65]` 后倚音） */
export interface IRGracenotes {
  after: boolean
  notes: IRGracenote[]
}

/** 音符：保留简谱写法（degree/octave/变音），同时给出 MIDI 供五线谱侧使用 */
export interface IRNote {
  kind: 'note'
  /** 简谱音级 1–7 */
  degree: number
  /** 八度偏移（正数高音点、负数低音点） */
  octaveShift: number
  accidental: '#' | '$' | '=' | null
  /** MIDI 音高（C4=60），按谱面调号算出 */
  midi: number
  /** 增时线数量（每条 +1 拍） */
  augmentCount: number
  /** 减时线数量（n 条 = 1/2^n 拍） */
  diminishCount: number
  /** 附点数量（1 个 ×1.5，2 个 ×1.75） */
  dots: number
  /** 平均连音组的覆盖时值（拍；有值时优先于 augment/diminish/dots） */
  tupletDur?: number
  /** 连音线起点（jps 的 `(`） */
  slurStart?: boolean
  /** 连音线终点（jps 的 `)`） */
  slurEnd?: boolean
  /**
   * 同音高连音线 = 五线谱的 tie。由 `slurPairs` 两端 MIDI 是否相同推出；
   * 单纯「不同音高的连音弧」只置 slurStart/slurEnd，不置 tie。
   */
  tieStart?: boolean
  tieEnd?: boolean
  gracenotes?: IRGracenotes
  /** 装饰符号编码（`&tr` 等，原样保留；MusicXML 只导出能映射的那几个） */
  symbols?: string[]
  /** 音符注释（`1"文字"`） */
  comment?: string
  source?: IRSourcePos
}

/** 休止符：0 可见 / 8 隐藏 */
export interface IRRest {
  kind: 'rest'
  hidden: boolean
  augmentCount: number
  diminishCount: number
  dots: number
  tupletDur?: number
  /** `0{jz N}` 的间奏拍数（只影响播放，不影响排版） */
  interludeBeats?: number
  comment?: string
  source?: IRSourcePos
}

/** 节奏符（`9`，谱面显示 X） */
export interface IRRhythm {
  kind: 'rhythm'
  augmentCount: number
  diminishCount: number
  dots: number
  tupletDur?: number
  symbols?: string[]
  comment?: string
  source?: IRSourcePos
}

export type IREvent = IRNote | IRRest | IRRhythm

/** 跳房子起点（`[` 后的修饰） */
export interface IRVolta {
  open: boolean
  slash?: boolean
  plus?: number
  minus?: number
  comment?: string
}

/** 临时转调（小节线备注里的 `"d:<key>"`） */
export interface IRKeyChange {
  /** 新调号根音半音偏移（C=0） */
  targetKey?: number
  /** `d:` 单独出现 ⇒ 恢复描述头调号 */
  clear?: boolean
  /** 用户写的调名原文（如 `Ab` / `F#` / `$B`） */
  keyText?: string
  plus?: number
  minus?: number
}

/** 小节线（含反复/跳房子/转调备注） */
export interface IRBarline {
  type: BarlineType
  marks?: BarlineMark[]
  voltaStart?: IRVolta
  voltaEnd?: boolean
  voltaEndSlash?: boolean
  voltaOnly?: boolean
  bareAnnotation?: boolean
  keyChange?: IRKeyChange
  comment?: string
}

/**
 * 一小节。
 *
 * `groupIndex` 是「源码里第几个曲词组」——多声部是**同一组里 Q1/Q2 同时演奏**，
 * 而两个多声部块是**两组先后演奏**。写回 `.jps` 时必须知道分组，否则会把
 * "先后"写成"同时"（这是这一层最容易丢的信息，所以放在小节上）。
 */
export interface IRMeasure {
  /** 本 part 内的序号（0 起） */
  index: number
  /** 源码曲词组序号（0 起；同时演奏的声部共用） */
  groupIndex: number
  events: IREvent[]
  /** 小节线（末小节没有收尾线时为 null） */
  barline: IRBarline | null
  /** 行首/块首的小节线（`|:` 反复开始、行首跳房子等） */
  startBarline?: IRBarline
}

/** 一个声部（`Q1:` / `Q2:` / 五线谱的 part） */
export interface IRPart {
  /** 稳定 id：`P<voice>`（MusicXML 的 part id 直接用它） */
  id: string
  /** 简谱声部号（Q 后的数字；`Q:` = 1） */
  voice: number
  /** 声部名（`Q1"女声":`） */
  name?: string
  /** 乐器（`Y:` 行 / `@乐器名`） */
  instrument?: string
  measures: IRMeasure[]
}

/** 歌词的一格（对应一个发声音符/休止） */
export interface IRLyricSlot {
  text: string
  /** `@` 跳过（不画字） */
  skip: boolean
  punctuation: boolean
  /** 紧跟本字的标点（不占音符位） */
  trailing?: string
  /** 本字前的引号注释 */
  note?: string
}

/**
 * 一行歌词。
 *
 * `slots` 按**本声部所有发声音符**（音符/休止/节奏符）的顺序对齐，缺位为 null——
 * 与 `.jps` 的 `C:` 行同口径，也与五线谱的 `<lyric>` 逐音对齐口径一致。
 */
export interface IRLyricLine {
  voice: number
  /** 第几段词（0 起；`C1:`/`C2:` 的顺序，MusicXML 的 `<lyric number>` 用 +1） */
  verse: number
  slots: (IRLyricSlot | null)[]
}

/** 描述头 */
export interface IRMeta {
  title?: string
  /** 副标题（`B:` 的后续行） */
  subtitles: string[]
  /** 作者（`Z:`，可多行） */
  authors: string[]
  /** 调号原文（`D:`，如 `C` / `$E` / `F#`） */
  key: string
  /** 拍号原文（`P:`，如 `4/4` / `6/8 (2/4)`） */
  meter: string
  /** 节拍数字（`J: 96` → 96；只有文字时为 undefined） */
  tempo?: number
  /** 节拍文字（`J: 欢快地`） */
  tempoText?: string
  instruments: string[]
}

/** 转换过程中发现的问题（不静默丢弃；UI 必须能看见） */
export type IRIssueKind =
  | 'parse'
  | 'unsupported'
  | 'meterDenominator'
  | 'lyricOnRest'
  | 'chord'
  | 'approxDuration'
  | 'lostOnWrite'

export interface IRIssue {
  id: string
  /** must = 必须处理；review = 建议复核 */
  severity: 'must' | 'review'
  kind: IRIssueKind
  message: string
  source?: IRSourcePos
  /** 关联元素（识别 id / 源码位置字符串） */
  refs?: string[]
}

/** 整份乐谱 */
export interface ScoreIR {
  meta: IRMeta
  parts: IRPart[]
  lyrics: IRLyricLine[]
  issues: IRIssue[]
}
