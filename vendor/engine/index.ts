/**
 * engine/index.ts — 简谱引擎统一入口
 *
 * 引擎设计原则：
 *  - 纯 TypeScript，零 React / 零 DOM 依赖，可在 Node 中单测；
 *  - 数据流单向：source(.jps) → parse → layout → render / playback。
 *
 * 实现独立性：引擎为独立 clean-room 实现，行为对齐 JPS 脚本规范
 * （`docs/JPS-SPEC.md`），不依赖、不包含任何第三方实现的代码片段
 * 或版权素材；规范层面参考「番茄简谱」(.jps V1.0) 脚本以保证语法兼容，
 *  具体算法与代码组织均为本项目原创。
 */
export * from './types'
export { parseJps } from './parser'
export { formatJps, formatLine } from './format/format'
export { tokenDuration, durationMs } from './duration'
export { layoutScore } from './layout'
export { renderScoreToSvg } from './render'
export { buildPlaySequence, inferBpm, createBackend, schedulePlay, SynthBackend, SamplerBackend, pitchToFreq, renderSynthNote, INSTRUMENT_OPTIONS, INSTRUMENT_LIB_NAMES, INSTRUMENT_PRESETS, matchInstrument, resolveInstrument, SAMPLER_LIBRARIES, getSamplerLibrary, classifyNetwork, eventsToMidi, pitchToMidiNote, instrumentToProgram, pcmToWav } from './playback'
export { codePosToNoteId, noteIdToCodePos, parseNoteId, buildIndexToPage } from './cursorMap'
export { computeRowTops, computeRowGuides, dragDelta, clamp, metaAreaH, GUIDE_ITEMS, GUIDE_LIMITS, GUIDE_LIMITS_EX } from './layout/guides'
export { metaAnchorOf, metaAnchorPt, clampMetaPos } from './layout/metaAnchors'
export { splitNoteDur, digitSlotW, dotBodyW, augBodyW, slideBodyW, bracketBodyW, noteBodyW, nonDurGap, accidentalBodyW, hxBodyW } from './layout/spaceLayout'
export type { NoteDurSplit } from './layout/spaceLayout'
export { extractJpsConfig, mergeJpsConfig, writeJpsConfig, extractLegacyEditorPrefs, JPS_CONFIG_PREFIX } from './settings'
export type { JpsConfigWriteMode } from './settings'
// 字体策略（跨机尽量有 / 适合简谱 / 保证有可用字体）+ 分层归属：
// 编辑器偏好属「用户个性」（L1，不进谱面），谱面字体属「谱面级」（L2）
export {
  SYS_FONT,
  SCORE_FONT_OPTIONS,
  SCORE_FONT_FIELDS,
  EDITOR_FONT_OPTIONS,
  EDITOR_FONT_SIZE_RANGE,
  normalizeFontStack,
  defaultEditorPrefs,
  clampEditorFontSize,
  defaultFontOverride,
  applyFontOverride,
} from './fonts'
export type { FontOption, EditorPrefs, FontOverride } from './fonts'

export type { GuideDragSpec } from './layout/guides'
export type { NoteIdParts } from './cursorMap'
export type { AudioBackend, BackendKind, PlayEvent, PlaySequence, InstrumentId, InstrumentPreset, SamplerLibrary, SamplerCache, NetworkClass, NetworkInfo, ParsedVoiceRef, MidiExportOptions } from './playback'
