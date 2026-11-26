/**
 * engine/scoreIR/index.ts — ScoreIR 子模块的唯一出口
 *
 * 对外只暴露：类型 + 四个转换函数 + 音高/调号工具。内部文件（fromJps/toJps/
 * musicxml/issues）不要被宿主直接 import（与引擎「入口收敛」同一规矩）。
 */
export type {
  IRBarline,
  IREvent,
  IRGracenote,
  IRGracenotes,
  IRIssue,
  IRIssueKind,
  IRKeyChange,
  IRLyricLine,
  IRLyricSlot,
  IRMeasure,
  IRMeta,
  IRNote,
  IRPart,
  IRRest,
  IRRhythm,
  IRSourcePos,
  IRVolta,
  ScoreIR,
} from './types'
export { parseJpsToIR, countEvents } from './fromJps'
export type { JpsToIrResult } from './fromJps'
export { irToJps } from './toJps'
export type { IrToJpsResult } from './toJps'
export { irToMusicXml, parseMusicXmlToIR, eventTicks, ticksToJpsDuration } from './musicxml'
export type { MusicXmlToIrResult } from './musicxml'
export { makeIssue, dedupeIssues, hasMustIssue } from './issues'
export {
  BASE_MIDI,
  DEGREE_SEMITONES,
  keyDisplayNameOf,
  keyFifthsOf,
  keyJpsNameOf,
  keySemitoneOf,
  keySemitoneOfFifths,
  jpsPitchToMidi,
  midiToJpsPitch,
  midiToPitchName,
  parseMeter,
  spellMidiForStaff,
  staffPitchToMidi,
} from './pitch'
export type { JpsPitch, StaffPitch } from './pitch'
