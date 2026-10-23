/**
 * engine/dynamic/index.ts — 动态谱（视频出片 / 后续 H5）的模块入口
 *
 * 分层：`timeline`（时间 → 矩形）→ `flowView`（矩形 → 条带行）→ `frame`（时刻 → 一帧）。
 * `presets` 给画布尺寸与字号。之上才是宿主的事（canvas 光栅 / ffmpeg 编码）。
 */
export { buildRectTrack, rectsActiveAt, RECT_ABOVE_RATIO, RECT_BELOW_RATIO } from './timeline'
export type { RectTrackOptions } from './timeline'
export { buildFlowView } from './flowView'
export type { FlowViewOptions } from './flowView'
export { frameAt, scrollYOfRow, frameTimeMs, frameIndexAt } from './frame'
export { ballAt, beatPhaseOf, BALL_LANDING_TIMING, BALL_SQUASH_X, BALL_SQUASH_Y } from './ball'
export type { BallAnchor, BallPos, BallTiming } from './ball'
export {
  buildCameraTrack,
  cameraAt,
  clampRowCenter,
  CAMERA_FOLLOW_ZOOM,
  CAMERA_INTRO_MS,
  CAMERA_LINE_MS,
  CAMERA_PAN_MS,
  CAMERA_SAFE_HALF,
  CAMERA_WHITE_MARGIN,
} from './camera'
export type { CameraFrame, CameraTrack, CameraOptions, CameraRow, CameraPan, PanMode } from './camera'
export {
  DYNAMIC_PRESETS,
  DEFAULT_DYNAMIC_PRESET,
  dynamicPageConfig,
} from './presets'
export type { DynamicPreset, DynamicPresetId } from './presets'
export type { RectTrack, TimedRect, FlowRow, FlowView, FrameRect, Frame } from './types'
