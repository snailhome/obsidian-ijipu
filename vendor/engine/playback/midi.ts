/**
 * engine/playback/midi.ts — MIDI 导出（标准 .mid 文件，纯函数可单测）
 *
 * 复用播放序列（PlayEvent：atMs / durationMs / pitch / instrument / voice）：
 *  - format 1：第一条元数据轨（标题 + 速度）+ 每声部一条音符轨
 *  - tick 分辨率 480（每四分音符）
 *  - 音高名（C4 / F#5）→ MIDI 音符号（C4 = 60）
 *  - 乐器名 → GM 程序号（缺省钢琴 0，adj283 同名匹配）
 * 零 DOM 依赖（TextEncoder Node/浏览器均有），可单测。
 */
import type { PlayEvent } from './sequence'
import { matchInstrument, type InstrumentId } from './instruments'

/** 简谱音名（如 C4 / F#5）→ MIDI 音符号（C4 = 60） */
export function pitchToMidiNote(name: string): number {
  const m = /^([A-G])(#?)(-?\d+)$/.exec(name)
  if (!m) return 60
  const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  return (Number(m[3]) + 1) * 12 + semis[m[1]] + (m[2] === '#' ? 1 : 0)
}

/** 乐器 id → GM 程序号（0 钢琴 / 16 风琴 / 48 弦乐 / 73 长笛 / 56 铜管 / 10 八音盒） */
const GM_PROGRAMS: Record<InstrumentId, number> = {
  piano: 0,
  organ: 16,
  strings: 48,
  flute: 73,
  brass: 56,
  musicbox: 10,
}

/** 乐器/声部名 → GM 程序号（匹配失败回退钢琴 0） */
export function instrumentToProgram(name: string | undefined): number {
  return GM_PROGRAMS[matchInstrument(name)] ?? 0
}

/** MIDI 变长量（delta-time 编码） */
function vlq(n: number): number[] {
  const bytes = [n & 0x7f]
  let v = n >> 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

/** UTF-8 字节（TextEncoder：Node 全局与浏览器均有） */
const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)]

/** 文本元数据事件：FF 01-06 type len text */
function metaText(type: number, text: string): number[] {
  const bytes = utf8(text)
  return [0xff, type, bytes.length, ...bytes]
}

export interface MidiExportOptions {
  /** 拍速（拍/分）——决定 tick 换算与速度元数据 */
  bpm: number
  /** 标题（写入元数据轨；缺省不写） */
  title?: string
}

/**
 * 播放事件序列 → 标准 MIDI 文件字节。
 * 每声部（voice）一条音符轨：轨首 Program Change（该声部乐器）+ 按 tick 排序的
 * Note On/Off（同 tick 时 Off 优先，保证叠音门限正确）。
 */
export function eventsToMidi(events: PlayEvent[], opts: MidiExportOptions): Uint8Array {
  const DIV = 480 // tick / 四分音符
  const beatMs = 60000 / opts.bpm
  const toTick = (ms: number) => Math.max(0, Math.round((ms / beatMs) * DIV))

  // 可发声事件 → 音符（按声部分组）
  const voices = [...new Set(events.map((e) => e.placed.id.voice))].sort((a, b) => a - b)
  const notesByVoice = new Map<number, { tick: number; durTick: number; note: number }[]>()
  const programByVoice = new Map<number, number>()
  for (const e of events) {
    if (!e.placed.playable || !e.placed.audioPitch) continue
    const pitch = e.pitch ?? e.placed.audioPitch
    if (!pitch) continue
    const v = e.placed.id.voice
    if (!notesByVoice.has(v)) {
      notesByVoice.set(v, [])
      programByVoice.set(v, instrumentToProgram(e.instrument))
    }
    notesByVoice.get(v)!.push({
      tick: toTick(e.atMs),
      durTick: Math.max(1, toTick(e.durationMs)),
      note: pitchToMidiNote(pitch),
    })
  }

  // 元数据轨：标题 + 速度（每个事件前带 delta-time 0，符合 MIDI 规范）
  const track0: number[] = []
  if (opts.title) track0.push(...vlq(0), ...metaText(0x03, opts.title))
  const tempo = Math.round(60000000 / opts.bpm) // 微秒 / 四分音符
  track0.push(...vlq(0), 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff)
  track0.push(...vlq(0), 0xff, 0x2f, 0x00)

  // 每声部一条音符轨
  const noteTracks = voices.map((v, ti) => {
    const chan = ti % 16
    const events2: { tick: number; type: 'on' | 'off'; note: number }[] = []
    for (const n of notesByVoice.get(v) ?? []) {
      events2.push({ tick: n.tick, type: 'on', note: n.note })
      events2.push({ tick: n.tick + n.durTick, type: 'off', note: n.note })
    }
    events2.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1))
    const bytes: number[] = []
    bytes.push(...vlq(0), 0xc0 | chan, programByVoice.get(v) ?? 0) // Program Change（delta 0）
    let prev = 0
    for (const s of events2) {
      bytes.push(...vlq(s.tick - prev))
      prev = s.tick
      bytes.push(s.type === 'on' ? 0x90 | chan : 0x80 | chan, s.note, 90)
    }
    bytes.push(...vlq(0), 0xff, 0x2f, 0x00)
    return bytes
  })

  // 组装文件：MThd + 各 MTrk
  const chunks: number[] = []
  chunks.push(...utf8('MThd'), ...u32(6), ...u16(1), ...u16(1 + noteTracks.length), ...u16(DIV))
  for (const tb of [track0, ...noteTracks]) {
    chunks.push(...utf8('MTrk'), ...u32(tb.length), ...tb)
  }
  return new Uint8Array(chunks)
}
