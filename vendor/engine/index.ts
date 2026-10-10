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
// adj752：`.jps` 源码**分词规则**（应用渲染 HTML、Obsidian 插件渲染 CM6 decoration，共用这一份口径）
export { tokenizeJpsLine, tokenizeJpsMusic, tokenizeJpsLyric, jpsHeaderOf } from './highlight/jpsHighlight'
export type { JpsToken, JpsTokenClass } from './highlight/jpsHighlight'
// adj757：错误/告警 → 源码"块"区间的换算（应用渲染 HTML 外框、插件打 CM6 decoration，共用这一份）
export { jpsBlockSpan, jpsBlockMarks, jpsSeverityOf } from './highlight/jpsProblems'
export type { JpsBlockMark } from './highlight/jpsProblems'
// adj758（清单 B1）：试听**色块**的位置/分组/配色（应用与插件共用这一份；两端只做绘制）
export {
  PLAYHEAD_COLORS,
  segVoiceColor,
  trackKeysOf,
  instrumentColorMap,
  playheadBaseOf,
  playheadPosIn,
} from './playback/playhead'
export type { PlayheadPos, PlayheadSegAt } from './playback/playhead'
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
export { buildPlaySequence, inferBpm, countScoreInstrumentSwitches, createBackend, schedulePlay, SynthBackend, SamplerBackend, pitchToFreq, renderSynthNote, INSTRUMENT_OPTIONS, INSTRUMENT_LIB_NAMES, INSTRUMENT_PRESETS, matchInstrument, resolveInstrument, SAMPLER_LIBRARIES, getSamplerLibrary, classifyNetwork, eventsToMidi, pitchToMidiNote, instrumentToProgram, pcmToWav, GmChannelAllocator, GM_MELODIC_CHANNELS, GM_VOICES, GM_GROUPS, gmVoiceProgram, gmVoiceRef } from './playback'
export { codePosToNoteId, noteIdToCodePos, parseNoteId, buildIndexToPage } from './cursorMap'
export { computeRowTops, computeRowGuides, dragDelta, clamp, metaAreaH, GUIDE_ITEMS, GUIDE_LIMITS, GUIDE_LIMITS_EX } from './layout/guides'
export { metaAnchorOf, metaAnchorPt, clampMetaPos, metaCornerOffsets, metaAuthorRowY } from './layout/metaAnchors'
export { splitNoteDur, digitSlotW, dotBodyW, augBodyW, slideBodyW, bracketBodyW, noteBodyW, nonDurGap, accidentalBodyW, accidentalPenDx, accidentalInkLeftDx, accidentalInkRightDx, accidentalFontSize, accidentalGlyphOf, braceInkRightOffset, BRACE_LINE_DX, hxBodyW, slideGlyphInk, slideExtraW, graceSlotLayout, graceSlideInk, mordentInkW } from './layout/spaceLayout'
// adj630b：谱尾说明（`S:`）的行基线——渲染端与预览端拖拽基准共用（不得各写一份）
export { notesRowBaseline, NOTES_LINE_H_RATIO, NOTES_BOTTOM_GAP, NOTES_DESCENT_RATIO } from './layout/spacing'
export type { NoteDurSplit } from './layout/spaceLayout'
// adj647：变音角标的字形度量（宿主实测 ⇒ 引擎算占宽/锚点）——两处共用的类型与解析函数
export { ACC_INK_W_RATIO, ACC_INK_LSB_RATIO, ACCIDENTAL_FONT_RATIO, ACC_GAP_PX, ACC_GAP_BASE_SIZE, accidentalGap, accidentalInkOf, isValidAccidentalInk } from './layout/spacing'
export type { AccidentalGlyphInk, AccidentalInkMetrics } from './layout/spacing'
export { accidentalGeometry } from './layout/spaceLayout'
export type { LayoutFontMeta } from './layout/index'
// adj638：渲染端可选入参（宿主实测的 `1 = ` / ♯ / ♩ 宽）——应用与插件都按同一份口径传
export type { RenderFontMeta } from './render/index'
// adj647：音符字体栈（宿主实测字形时必须与渲染用同一串 font-family）
export { noteFontFamily } from './render/index'
// adj428：临时叠加段（{bz … } / {dsb … }）上下两行纵向间距的默认常量；UI 显示缺省值用
export { SEGMENT_ROW_GAP_DEFAULT } from './layout/spacing'
// adj672：歌词注释的几何（布局避让与渲染锚点共用同一把尺子；smoke 也用它核对避让结果）
export { lyricCommentFontSize, lyricCommentWidth, LYRIC_COMMENT_GAP } from './layout/spacing'
// adj427：临时段（{bz … } / {dsb … }）拍位包络计算——layout/render 共用，纯函数
export { computeSegments, mainSpans, mainSpansInRange, tokensBeats, segmentBarBeats, beatRatio, isDurational, segmentNoteIndexBase, segmentBarIndexBase, decodeSegmentNoteId, SEG_NOTE_ID_BASE, SEG_BAR_ID_BASE, tpNoteIndexBase, decodeTpNoteId, SEG_TP_NOTE_ID_BASE, segmentRowExtra } from './layout/segments'
export type { SegmentInfo, MainSpan, SegmentRowExtra } from './layout/segments'
// adj454：`mergeConfigEdits` = 写回时只并入「用户本次改动」（缓存来源的值不进谱面）；
// `inspectJpsConfig`/`inspectJpsConfigLine` = 设置行的类型校验告警（解析器已并入 ParseResult.errors）
export { extractJpsConfig, mergeJpsConfig, writeJpsConfig, mergeConfigEdits, configCarryover, nonDefaultConfigKeys, inspectJpsConfig, inspectJpsConfigLine, extractLegacyEditorPrefs, JPS_CONFIG_PREFIX, roundPxIntegers, OPTIONAL_CONFIG_FIELDS, defaultConfigForReset } from './settings'
export type { JpsConfigWriteMode, JpsConfigIssue } from './settings'
// adj502：波音（mordent）演奏时值——纯函数，宿主（Obsidian 插件）与 smoke 都要用同一套口径
export { MORDENT_SYMBOLS, ORNAMENT_SHORT_MIN_MS, ORNAMENT_SHORT_MAX_MS, ORNAMENT_SHORT_RATIO, mordentOf, mordentShortMs, neighborDegree, mordentPlan } from './playback/ornaments'
export type { MordentKind, OrnamentStep, MordentPlan, PitchDegree } from './playback/ornaments'
// adj635：竹笛/葫芦丝的传统装饰音（打音 `&da` / 叠音 `&die`）+ **演奏型装饰**统一入口
export {
  PORT_SYMBOLS,
  ORNAMENT_PORT_RATIO,
  ORNAMENT_PORT_MIN_MS,
  ORNAMENT_PORT_MAX_MS,
  ORNAMENT_SYMBOLS,
  portOf,
  portShortMs,
  portPlan,
  ornamentOf,
  ornamentPlan,
} from './playback/ornaments'
export type { PortKind, OrnamentKind } from './playback/ornaments'
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
