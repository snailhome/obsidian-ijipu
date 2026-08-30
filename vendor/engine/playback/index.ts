/**
 * engine/playback/index.ts — 播放引擎入口
 *
 * 管线：buildPlaySequence（含反复记号展开）→ AudioBackend 播放。
 * 两种后端（可切换）：
 *  - synth：Web Audio 合成音色（零依赖，默认）
 *  - sampler：钢琴采样（外部 soundfont，需网络，实验性）
 */
import type { PlacedToken } from '../types'
import type { AudioBackend, BackendKind } from './types'
import { SynthBackend } from './synth'
import { SamplerBackend } from './sampler'

export { buildPlaySequence, inferBpm } from './sequence'
export type { PlayEvent, PlaySequence } from './sequence'
export { SynthBackend, renderSynthNote, pitchToFreq } from './synth'
export { SamplerBackend }
export type { AudioBackend, BackendKind } from './types'
// adj283：合成乐器预设与名称路由（多声部按各自乐器同时发声）
export { INSTRUMENT_PRESETS, INSTRUMENT_OPTIONS, INSTRUMENT_LIB_NAMES, matchInstrument, resolveInstrument } from './instruments'
export type { InstrumentId, InstrumentPreset } from './instruments'
// adj289：MIDI 导出（复用播放序列）
export { eventsToMidi, pitchToMidiNote, instrumentToProgram } from './midi'
export type { MidiExportOptions } from './midi'
// adj290：WAV（PCM16）编码——音频导出共用
export { pcmToWav } from './wav'

/** 创建音频后端 */
export function createBackend(kind: BackendKind): AudioBackend {
  if (kind === 'sampler') return new SamplerBackend()
  return new SynthBackend()
}

/**
 * 调度播放：按事件 atMs 调度音频（后端 AudioContext 按 atMs 调度，同 atMs 事件同时响）。
 * adj308：play 是 async — 此处 fire-and-forget（节点已在 ctx 中排程）；PlayBackDialog
 * 在调 schedulePlay 前已 await backend.ensure/resume，避免漏首拍与新旧 ctx 叠加杂音。
 * adj309：firstDelayMs（毫秒，默认 0）—— 整体事件偏移，给听者/演奏准备时间（PlayBackDialog 传 200）。
 *  backend.play(t0) 的 t0 默认用 ctx.currentTime+缓冲，会再加 ctx 启动延迟；
 *  这里 firstDelayMs 是事件相对 0 的额外偏移（与 t0 独立），实现"按播放后延迟 N 毫秒才开始出第一声"。
 */
export function schedulePlay(
  seq: { events: { placed: PlacedToken; atMs: number; durationMs: number; pitch?: string | null; instrument?: string }[] },
  backend: AudioBackend,
  onNote?: (placed: PlacedToken) => void,
  globalInstrument?: string,
  firstDelayMs: number = 0,
): { cancel: () => void; totalMs: number } {
  for (const ev of seq.events) {
    if (!ev.placed.playable || !ev.placed.audioPitch) continue
    const pitch = ev.pitch ?? ev.placed.audioPitch
    if (!pitch) continue
    // adj261：直接用 ev.atMs 调度（此前 bug 传 0，导致音频延迟/不响）；后端 AudioContext 按 atMs 调度，同 atMs 事件同时响
    const instrument = globalInstrument ?? ev.instrument
    // play 返回 Promise — 不 await（fire-and-forget），节点已在 ctx 中排程
    void backend.play(pitch, ev.atMs + firstDelayMs, ev.durationMs, 0.5, instrument)
    onNote?.(ev.placed)
  }
  const lastAt = seq.events.length > 0 ? seq.events[seq.events.length - 1].atMs + 100 : 0
  return {
    cancel: () => backend.stop(),
    totalMs: lastAt + firstDelayMs,
  }
}
