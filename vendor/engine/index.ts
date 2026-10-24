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
// adj965d（方案 OVL，EP-13）：水印/背景层的**手势口径**——应用与 Obsidian 插件共用这一份
// （插件经 `vendor/engine` 逐字节同步；两端各自只负责"接线"）
export {
  OVERLAY_SCALE_RANGE,
  OVERLAY_ROTATE_RANGE,
  OVERLAY_TEXT_SIZE_RANGE,
  OVERLAY_WHEEL_STEP_PX,
  OVERLAY_COMMIT_DELAY_MS,
  overlayLayerVisible,
  activeOverlayLayer,
  bothOverlayLayersVisible,
  overlayLayerPersisted,
  wheelDeltaPx,
  overlayWheelSteps,
  overlayWheelMode,
  overlayOffsetOf,
  overlayGestureBase,
  applyOverlayWheel,
  applyOverlayDrag,
} from './overlayGesture'
export type { OverlayLayer, OverlayWheelMode } from './overlayGesture'
// adj965（方案 OVL，EP-09）：取图策略（白名单/上限/路径归一/mime/base64）——应用、插件、
// 桌面端三处必须逐字一致，所以只写引擎这一份（插件经 vendor/engine 同步）
export {
  MAX_ASSET_BYTES,
  ASSET_MAX_EDGE,
  ASSET_REENCODE_BYTES,
  ASSET_REENCODE_QUALITY,
  overlayAssetRefs,
  // adj969：这份配置里"必须靠基准目录才读得到"的引用（决定要不要向用户要一个文件夹）
  localAssetRefs,
  ALLOWED_ASSET_EXT,
  assetPathOf,
  extOf,
  isAllowedAssetPath,
  mimeOf,
  splitAssetPath,
  toBase64,
  fromBase64,
  dataUriOf,
} from './overlayAsset'
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
// adj1118：伴奏对拍的纯数学（锚点 → 拍速/偏移；拍 ↔ 音频毫秒；界面/出片/命令行共用）
export {
  fitSync,
  audioMsOfBeat,
  beatOfAudioMs,
  residualBeatsOf,
  bpmOfFit,
  inTrimRange,
  displayBpm,
  sessionMsOfAudioMs,
} from './playback/sync'
export type { SyncAnchor, SyncSegmentStat, SyncFit, SyncTrim } from './playback/sync'
export { INTERLUDE_COLOR } from './playback/playhead'
// 动态谱（视频出片 / 后续 H5）：时间轴 → 流式视图 → 帧；画布预设
export {
  buildRectTrack,
  rectsActiveAt,
  RECT_ABOVE_RATIO,
  RECT_BELOW_RATIO,
  buildFlowView,
  frameAt,
  scrollYOfRow,
  frameTimeMs,
  frameIndexAt,
  ballAt,
  beatPhaseOf,
  primaryVoiceOf,
  BALL_LANDING_TIMING,
  BALL_SQUASH_X,
  BALL_SQUASH_Y,
  buildCameraTrack,
  cameraAt,
  clampRowCenter,
  CAMERA_FOLLOW_ZOOM,
  CAMERA_INTRO_MS,
  CAMERA_LINE_MS,
  CAMERA_PAN_MS,
  CAMERA_SAFE_HALF,
  CAMERA_WHITE_MARGIN,
  DYNAMIC_PRESETS,
  DEFAULT_DYNAMIC_PRESET,
  dynamicPageConfig,
} from './dynamic'
export type { RectTrack, TimedRect, RectTrackOptions, FlowRow, FlowView, FrameRect, Frame, DynamicPreset, DynamicPresetId, CameraFrame, CameraTrack, CameraOptions, CameraRow, CameraPan, PanMode, BallAnchor, BallPos, BallTiming } from './dynamic'
// adj759（清单 B2）：解析问题的分级/排序/计数/展示行（应用与插件共用；宿主可传自己的品牌标签）
export {
  DEFAULT_PROBLEM_LABELS,
  problemRowOf,
  summarizeProblems,
  splitParseIssues,
  problemHintLines,
  offsetOf,
} from './diagnostics/problems'
export type { ProblemSeverity, ProblemLabels, ProblemRow, ProblemSummary } from './diagnostics/problems'
// adj760（清单 B3）：音源库**清单**与**取用顺序策略**（列表/顺序/失败文案共用；IO 留宿主）
// adj1009：补 `findKnownLibrary`（找不到返回 undefined，不再默默回退默认库）与
// `hqBankManualOnlyText`（只能手动下载的库，如 FluidR3），并把两个旧符号标为迁移期保留。
export { HQ_LIBRARIES, RECOMMENDED_BANKS, BASE_BANK, findKnownLibrary, getHqLibrary, resolveActiveLibrary, planHqBankLoad, hqBankFailureText, hqBankManualOnlyText } from './playback/soundbanks'
export type { HqSampleLibrary, HqBankSource, ActiveLibrary } from './playback/soundbanks'
// adj1009（多音色库 P1）：读 SF2 头部（库名/预设表）的纯函数——"音色数量与名字"的唯一出处。
// 只读 RIFF 的 INFO 与 pdta/phdr，不碰采样数据；smoke 用手搓夹具 + 真文件双重断言。
export { isSf2, isGitLfsPointer, readSf2Info, readSf2Presets, summarizeSf2Presets, matchKnownLibrary } from './playback/sf2'
export type { Sf2Info, Sf2Preset, Sf2PresetSummary } from './playback/sf2'
// adj1019：民族乐器的**拟声**映射（GM 里没有二胡/琵琶/古筝；显示一律带「（拟）」）
export { ETHNIC_ALIASES, ethnicAliasOf, ethnicLabel, ethnicGmLabel } from './playback/ethnicVoices'
export type { EthnicAlias } from './playback/ethnicVoices'
// adj762（清单 B4）：整篇/逐行**高亮模型**（token + 行头 + 错误块 + 行级级别）——两端只做渲染映射
export { highlightModel, highlightLineModel, groupBlocksByLine, lineLevelOf } from './highlight/model'
export type { JpsLineModel, JpsHighlightModel, ProblemLevel } from './highlight/model'
// adj763（清单 B5）：源码高亮/问题提示**配色的唯一来源**（两端 CSS 用断言与它绑定）
export { JPS_HIGHLIGHT_COLORS, JPS_PLAIN_COLORS, JPS_PROBLEM_COLORS, JPS_HL_CSS_VAR } from './highlight/palette'
export type { JpsPaletteClass, JpsHighlightPalette } from './highlight/palette'
// adj764（清单 B6）：试听**时钟**（推进 / 暂停续播 / 取消 / 到点恰好一次）——now/raf 由宿主注入
export { createPlaybackClock } from './playback/clock'
export type { PlaybackClock, PlaybackClockOptions } from './playback/clock'
// adj765（清单 B7）：新建空白谱的**模板文本**（唯一来源；应用侧那支 .jps 文件与插件常量都由断言钉住）
export { DEFAULT_NEW_JPS_TEMPLATE, DEFAULT_NEW_JPS_BASE, JPS_EXT } from './samples/template'
// adj766（清单 B8）：设置分层的**判定规则**（值等价 / 是否等于默认 / 哪些键变了）——两端共用
export { configValuesEqual, isDefaultConfigValue, changedConfigKeys } from './settings/layers'
// adj629h：歌词行里 `{tp … }` 替谱段的识别（格式化 / 编辑器着色都要在 `C…:` 行里找它）
export { matchSegmentHead, findSegmentEnd } from './parser/tokenizer'
// adj1118：间奏标记 `{jz N}` 的识别（格式化 / 高亮 / 解析三处共用同一套判定）
export { matchInterludeHead } from './parser/tokenizer'
// adj1118：间奏时长的**唯一口径**（`{jz N}` 与注记 `间奏N拍`；播放/校验/宿主都问它）
export { interludeBeatsOf, interludeExtraBeats, interludeDiagnostics } from './interlude'
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
export { renderScoreToSvg, keySignatureOf } from './render'
// adj863（T-3）：**范围**（整页 / 墨迹 ± 每边 N px）的唯一实现 + SVG 外框改写（插件预览与导出、应用导出、
// CLI `render --crop` 都消费这一份；墨迹盒由有 DOM 的宿主量好传进来，引擎不瞎估）
export { rangeBox, applyRangeToSvg, readViewBoxOf, normalizeRangePad, normalizeMinInk, minInkFor, RANGE_PAD_DEFAULT, MIN_INK_FALLBACK, NEAR_PAGE_RATIO } from './render/range'
export type { ExportRange, RangeBox, RangeRequest, RangeOutcome } from './render/range'
// adj873（T-3 补落点）：**由布局推墨迹盒**——Node CLI 没有 DOM、量不到 `getBBox()`，
// 于是从 `ScoreLayout` 反推一个**估算盒**（宁可多留白、绝不裁掉内容）交给 `rangeBox({ range:'score' })`。
// 留白/回退/SVG 外框依旧只在 `range.ts` 一处 ✓（本模块只产 `ink`，不产几何口径）。
export { inkBoxOfLayout, inkBoxesOfLayout, INK_ESTIMATE_SLACK } from './render/inkBox'
// adj864：「复制/导出为图片」要写 **pHYs（DPI）**，否则 Word/微信按 96 DPI 兜底、把 2× 的谱插成巨图。
// 纯字节运算（零 DOM/canvas）⇒ 放引擎，插件（剪贴板）/应用/CLI 共用同一份；CRC32 有已知向量断言守着。
export { insertPngPhys, readPngPhys, crc32, isPng, dpiForScale, pixelsPerMeterFor } from './png'
export { buildPlaySequence, inferBpm, countScoreInstrumentSwitches, noteIdStringOf, slicePlaySequenceByNoteRange, resolvePracticeRange, slicePlaySequenceByRange, extendRangeEndToSlurEnd, createBackend, schedulePlay, SynthBackend, SamplerBackend, pitchToFreq, renderSynthNote, INSTRUMENT_OPTIONS, INSTRUMENT_LIB_NAMES, INSTRUMENT_PRESETS, matchInstrument, resolveInstrument, SAMPLER_LIBRARIES, getSamplerLibrary, classifyNetwork, eventsToMidi, pitchToMidiNote, instrumentToProgram, pcmToWav, GmChannelAllocator, GM_MELODIC_CHANNELS, GM_VOICES, GM_GROUPS, gmVoiceProgram, gmVoiceRef } from './playback'
export { codePosToNoteId, noteIdToCodePos, parseNoteId, buildIndexToPage } from './cursorMap'
export { computeRowTops, computeRowGuides, dragDelta, clamp, metaAreaH, GUIDE_ITEMS, GUIDE_LIMITS, GUIDE_LIMITS_EX, computeDebugBounds } from './layout/guides'
// adj1101：全局小节号/拍位的**唯一口径**（界面标记段显示 `33:1 - 34:2` 与命令行 `--from 33:1` 共用）
export { flattenScoreNotes, totalBarsOf, measureSpotOf, spotOfIn, hasNoteId, resolveBarBeatRange, BEAT_EPS } from './layout/measureMap'
export type { ScoreSpotNote, BarBeatRange } from './layout/measureMap'
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
export type { RenderFontMeta, KeySignature } from './render/index'
// adj965（方案「OVL」）：水印/背景层的运行时资源类型——宿主解析好图片后按这个形状传给引擎
export type { RenderAssets, RenderOpts, OverlayAsset } from './render/index'
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
