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
import type { SamplerLibrary } from './libraries'
import type { SamplerCache } from './sampler-cache'
import { SynthBackend } from './synth'
import { SamplerBackend } from './sampler'

export { buildPlaySequence, inferBpm, countScoreInstrumentSwitches } from './sequence'
export type { PlayEvent, PlaySequence } from './sequence'
export { SynthBackend, renderSynthNote, pitchToFreq } from './synth'
export { SamplerBackend }
export type { AudioBackend, BackendKind } from './types'
// adj323：采样音色库元数据 + 联网分类（纯函数，可单测）
export { SAMPLER_LIBRARIES, getSamplerLibrary } from './libraries'
export type { SamplerLibrary } from './libraries'
export { classifyNetwork } from './network'
export type { NetworkClass, NetworkInfo } from './network'
// adj323：采样色库离线缓存接口（浏览器 IndexedDB / Tauri 文件系统实现，由 src 注入）
export type { SamplerCache } from './sampler-cache'
// adj283：合成乐器预设与名称路由（多声部按各自乐器同时发声）
export { INSTRUMENT_PRESETS, INSTRUMENT_OPTIONS, INSTRUMENT_LIB_NAMES, matchInstrument, resolveInstrument, parseInstrumentRef } from './instruments'
export type { InstrumentId, InstrumentPreset, ParsedVoiceRef } from './instruments'
// adj446：GM 播放通道分配（一个音色独占一个通道——多声部各音色不互相覆盖）
export { GmChannelAllocator, GM_MELODIC_CHANNELS } from './channels'
// adj447：GM 128 音色表（音色名 ↔ program 的唯一来源）；adj455 补 `gmVoiceRef`（program → 音色名 ref）；
// adj631：补 `GM_GROUPS`（14 类分类表，应用与 Obsidian 插件的「音色库」共用一份）
export { GM_VOICES, GM_GROUPS, gmVoiceProgram, gmVoiceRef } from './gmVoices'
export type { GmVoice } from './gmVoices'
// adj289：MIDI 导出（复用播放序列）
export { eventsToMidi, pitchToMidiNote, instrumentToProgram } from './midi'
export type { MidiExportOptions } from './midi'
// adj290：WAV（PCM16）编码——音频导出共用
export { pcmToWav } from './wav'

/** 创建音频后端；采样后端可指定音色库与离线缓存（缺省用默认库，adj323） */
export function createBackend(kind: BackendKind, library?: SamplerLibrary, cache?: SamplerCache): AudioBackend {
  if (kind === 'sampler') return new SamplerBackend(library, cache)
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
  seq: { events: { placed: PlacedToken; atMs: number; durationMs: number; pitch?: string | null; instrument?: string; gain?: number; playVoice?: 'accomp' | 'main' | 'second'; explicitInstrument?: boolean }[] },
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
    // adj427：伴奏/第二声部**不被全局乐器覆盖**（它们用自己的音色，见 AudioBackend.play 的 opts）
    const isSecondary = ev.playVoice === 'accomp' || ev.playVoice === 'second'
    // adj434：曲内 `@乐器名@` 显式指定的音色同样**不被全局覆盖**——它是曲内的、局部的、
    // 明确的演奏指示，应优先于「全局默认音色」（否则谱面里写 `@手风琴@` 在选定试听音色后失效）
    const keepOwn = isSecondary || ev.explicitInstrument === true
    const instrument = keepOwn ? ev.instrument : (globalInstrument ?? ev.instrument)
    // adj427：基础增益 0.5 上乘**按事件的力度倍率**（`gain`，缺省 1）——
    // 重叠的伴奏/第二声部用 0.75，避免盖过主声部；该字段预留给后续力度记号扩展。
    const gain = 0.5 * (ev.gain ?? 1)
    // play 返回 Promise — 不 await（fire-and-forget），节点已在 ctx 中排程
    void backend.play(pitch, ev.atMs + firstDelayMs, ev.durationMs, gain, instrument, undefined, keepOwn ? { keepInstrument: true } : undefined)
    onNote?.(ev.placed)
  }
  // adj381：totalMs 取**所有事件尾端**（atMs + durationMs）的最大值，而不是末事件的起声时刻。
  // 此前用 `末事件.atMs + 100`：末音符时值长时（如末尾 `6,---` 共 4 拍）该值只到它刚起声的位置，
  // 试听收尾定时器（PlaybackDialog 用 job.totalMs + 100）在该音符刚起声时就触发 → 色块轨道与
  // 高亮被清空，**末音符后面的增时线永远没有色块**（用户报告「最后一小节最后一个音符后面的
  // 增时线没有色块」，且对话框显示的总时长与实播时长不一致）。保留 100ms 余量语义不变。
  let endMs = 0
  for (const ev of seq.events) endMs = Math.max(endMs, ev.atMs + ev.durationMs)
  return {
    cancel: () => backend.stop(),
    totalMs: endMs + 100 + firstDelayMs,
  }
}
