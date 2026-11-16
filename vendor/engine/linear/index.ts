/**
 * engine/linear/index.ts — 连续动态谱（单行滚动谱）模块入口（adj1258）
 *
 * 分层：`measures`（排版 → 源小节表）→ `strip`（按演奏顺序拼成一条线）→ `xmap`（时刻 → x）。
 * 之上才是宿主的事（光栅、合成视频、出片）。
 */
export { buildLinearStrip, stripBarlineTypeOf } from './strip'
export { extractMeasures } from './measures'
export { stripXAt, stripRunAt, stripEndMs } from './xmap'
export { stripBallAt } from './ball'
export type { StripBall, StripBallOptions } from './ball'
export type { LinearStrip, LinearStripOptions, StripRun, StripNote, StripOnset, StripDropped } from './types'
export type { SrcMeasure } from './measures'
