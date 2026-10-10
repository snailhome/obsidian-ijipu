/**
 * engine/playback/clock.ts — **试听时钟**（时间轴推进 / 暂停续播 / 取消语义；纯逻辑，零 DOM）
 *
 * 用户 2026-10 要求（清单 B6）：「播放及色块显示……等共性的功能都可以独立到引擎层面」，
 * 且「应用端也应同样处理」。
 *
 * 现状：两端各写一套时钟 —— 应用用 `timeBase + (performance.now() − startTime)` 自己算并维护
 * `rafRef`/`startTimeRef`/`timeBaseRef` 三个 ref，插件在自己的 RAF tick 里算。时序细节
 * （暂停后续播从哪续、取消后还能不能再来一帧、到点回调会不会重复触发）一旦分叉，
 * 就是"色块多滑一下/播完不复位"这类难查的小毛病。
 *
 * 设计：把"时钟"抽出来，**`now`/`raf` 由宿主注入**（引擎不碰 `performance`/`requestAnimationFrame`），
 * 于是它既能在两端真实运行，也能在冒烟里用**假时钟**把语义钉死。
 */
export interface PlaybackClockOptions {
  /** 总时长；到点触发 `onEnd`（只触发一次）。缺省 = 不自动结束 */
  totalMs?: number
  /** 时间源（宿主注入；默认 `performance.now`） */
  now?: () => number
  /** 帧调度（宿主注入；默认 `requestAnimationFrame`） */
  raf?: (cb: (t: number) => void) => number
  /** 取消帧（宿主注入；默认 `cancelAnimationFrame`） */
  cancelRaf?: (id: number) => void
  /** 每帧回调（时间轴位置，毫秒） */
  onTick?: (ms: number) => void
  /** 到点回调（**恰好一次**；被 `cancel()` 取消后不再触发） */
  onEnd?: () => void
}

export interface PlaybackClock {
  /** 开始（从当前位置） */
  start(): void
  /** 暂停；返回暂停处的时间轴位置 */
  pause(): number
  /** 继续（从暂停处） */
  resume(): void
  /** 取消：停帧、置回 0，且**不再**触发 `onTick`/`onEnd` */
  cancel(): void
  /** 跳到指定位置（时间轴毫秒；播放中会继续走） */
  seek(ms: number): void
  /** 当前时间轴位置（毫秒） */
  ms(): number
  readonly playing: boolean
  readonly totalMs: number
}

export function createPlaybackClock(opts: PlaybackClockOptions = {}): PlaybackClock {
  const now =
    opts.now ??
    (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now())
  const raf =
    opts.raf ??
    (typeof requestAnimationFrame !== 'undefined'
      ? (cb: (t: number) => void) => requestAnimationFrame(cb)
      : (cb: (t: number) => void) => setTimeout(() => cb(now()), 16) as unknown as number)
  const cancelRaf =
    opts.cancelRaf ??
    (typeof cancelAnimationFrame !== 'undefined'
      ? (id: number) => cancelAnimationFrame(id)
      : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>))

  const totalMs = opts.totalMs ?? Number.POSITIVE_INFINITY
  /** 已累计的时间轴位置（暂停时保存"已走多久"） */
  let base = 0
  /** 本次播放段的起算时刻（`now()` 口径）；null = 未在走 */
  let startedAt: number | null = null
  let frame: number | null = null
  let ended = false

  const current = (): number => (startedAt === null ? base : base + (now() - startedAt))

  const stopFrame = (): void => {
    if (frame !== null) {
      cancelRaf(frame)
      frame = null
    }
  }

  const tick = (): void => {
    frame = null
    if (startedAt === null) return
    const ms = current()
    if (ms >= totalMs) {
      base = totalMs
      startedAt = null
      opts.onTick?.(totalMs)
      if (!ended) {
        ended = true
        opts.onEnd?.()
      }
      return
    }
    opts.onTick?.(ms)
    frame = raf(tick)
  }

  const run = (): void => {
    stopFrame()
    startedAt = now()
    frame = raf(tick)
  }

  return {
    start(): void {
      ended = false
      base = 0
      run()
    },
    pause(): number {
      if (startedAt === null) return base
      base = current()
      startedAt = null
      stopFrame()
      return base
    },
    resume(): void {
      if (startedAt !== null || ended) return
      run()
    },
    cancel(): void {
      base = 0
      startedAt = null
      ended = true
      stopFrame()
    },
    seek(ms: number): void {
      const at = Math.max(0, Math.min(ms, totalMs))
      base = at
      if (startedAt !== null) startedAt = now()
    },
    ms: current,
    get playing(): boolean {
      return startedAt !== null
    },
    totalMs,
  }
}
