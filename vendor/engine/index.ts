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
// adj629h：歌词行里 `{tp … }` 替谱段的识别（格式化 / 编辑器着色都要在 `C…:` 行里找它）
export { matchSegmentHead, findSegmentEnd } from './parser/tokenizer'
export { tokenDuration, durationMs } from './duration'
// adj594（用户要求）：小节时值校验（纯函数，解析器已自动并入 ParseResult.errors）
export {
  checkMeasureBeats,
  measureBeatsOf,
  meterBeatsOf,
  inlineMeterBeats,
  inlineMeterText,
  DEFAULT_METER_BEATS,
  MEASURE_BEATS_EPSILON,
} from './measures'
export { layoutScore } from './layout'
export { renderScoreToSvg } from './render'
export { buildPlaySequence, inferBpm, countScoreInstrumentSwitches, createBackend, schedulePlay, SynthBackend, SamplerBackend, pitchToFreq, renderSynthNote, INSTRUMENT_OPTIONS, INSTRUMENT_LIB_NAMES, INSTRUMENT_PRESETS, matchInstrument, resolveInstrument, SAMPLER_LIBRARIES, getSamplerLibrary, classifyNetwork, eventsToMidi, pitchToMidiNote, instrumentToProgram, pcmToWav, GmChannelAllocator, GM_MELODIC_CHANNELS, GM_VOICES, gmVoiceProgram, gmVoiceRef } from './playback'
export { codePosToNoteId, noteIdToCodePos, parseNoteId, buildIndexToPage } from './cursorMap'
export { computeRowTops, computeRowGuides, dragDelta, clamp, metaAreaH, GUIDE_ITEMS, GUIDE_LIMITS, GUIDE_LIMITS_EX } from './layout/guides'
export { metaAnchorOf, metaAnchorPt, clampMetaPos, metaCornerOffsets, metaAuthorRowY } from './layout/metaAnchors'
export { splitNoteDur, digitSlotW, dotBodyW, augBodyW, slideBodyW, bracketBodyW, noteBodyW, nonDurGap, accidentalBodyW, hxBodyW, slideGlyphInk, slideExtraW } from './layout/spaceLayout'
export type { NoteDurSplit } from './layout/spaceLayout'
// adj428：临时叠加段（{bz … } / {dsb … }）上下两行纵向间距的默认常量；UI 显示缺省值用
export { SEGMENT_ROW_GAP_DEFAULT } from './layout/spacing'
// adj427：临时段（{bz … } / {dsb … }）拍位包络计算——layout/render 共用，纯函数
export { computeSegments, mainSpans, mainSpansInRange, tokensBeats, segmentBarBeats, beatRatio, isDurational, segmentNoteIndexBase, segmentBarIndexBase, decodeSegmentNoteId, SEG_NOTE_ID_BASE, SEG_BAR_ID_BASE, tpNoteIndexBase, decodeTpNoteId, SEG_TP_NOTE_ID_BASE } from './layout/segments'
export type { SegmentInfo, MainSpan } from './layout/segments'
// adj454：`mergeConfigEdits` = 写回时只并入「用户本次改动」（缓存来源的值不进谱面）；
// `inspectJpsConfig`/`inspectJpsConfigLine` = 设置行的类型校验告警（解析器已并入 ParseResult.errors）
export { extractJpsConfig, mergeJpsConfig, writeJpsConfig, mergeConfigEdits, configCarryover, nonDefaultConfigKeys, inspectJpsConfig, inspectJpsConfigLine, extractLegacyEditorPrefs, JPS_CONFIG_PREFIX, roundPxIntegers, OPTIONAL_CONFIG_FIELDS, defaultConfigForReset } from './settings'
export type { JpsConfigWriteMode, JpsConfigIssue } from './settings'
// adj502：波音（mordent）演奏时值——纯函数，宿主（Obsidian 插件）与 smoke 都要用同一套口径
export { MORDENT_SYMBOLS, ORNAMENT_SHORT_MIN_MS, ORNAMENT_SHORT_MAX_MS, ORNAMENT_SHORT_RATIO, mordentOf, mordentShortMs, neighborDegree, mordentPlan } from './playback/ornaments'
export type { MordentKind, OrnamentStep, MordentPlan, PitchDegree } from './playback/ornaments'
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
export type { AudioBackend, BackendKind, PlayEvent, PlaySequence, InstrumentId, InstrumentPreset, SamplerLibrary, SamplerCache, NetworkClass, NetworkInfo, ParsedVoiceRef, MidiExportOptions, GmVoice } from './playback'
