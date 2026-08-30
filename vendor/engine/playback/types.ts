/**
 * engine/playback/types.ts — 播放模块共享类型（避免模块间循环依赖）
 */

/** 音频后端接口：合成与采样共同实现 */
export interface AudioBackend {
  readonly kind: 'synth' | 'sampler'
  /** adj308：等待 ctx 创建/resume 完成——避免首拍漏播；默认无操作 */
  ready?(): Promise<void>
  /** 播放一个音（简谱音名如 C5；null 表示休止/不发声；instrument = 声部名/乐器名，音色路由用）
   *  t0（adj308，可选）：事件"atMs=0"对应的实际播放时刻（秒，相对于 ctx 启动）。
   * 不传则后端用 ctx.currentTime + 小缓冲，保证 AudioContext resume 就绪后再触发（避免漏播）。
   * adj308：可返回 Promise<void>（await resume 后再调度，避免首拍漏播）。 */
  play(pitch: string | null, atMs: number, durationMs: number, gain: number, instrument?: string, t0?: number): void | Promise<void>
  stop(): void
  /** 释放资源 */
  dispose(): void
}

export type BackendKind = 'synth' | 'sampler'
