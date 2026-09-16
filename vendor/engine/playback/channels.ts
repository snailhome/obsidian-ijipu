/**
 * engine/playback/channels.ts — GM 播放通道分配（adj446）
 *
 * 背景：**MIDI 通道同时只能承载一个音色（program）**——同一通道上后设的 `programChange`
 * 会改变该通道**其后所有音符**（多数合成器上连正在发声的音符也一起变）的音色。
 * 所以「多个声部各自一种音色」的前提是：**每个音色独占一个通道**。
 *
 * 旧实现按「乐器族」映射通道（钢琴族→0、风琴族→1、弦乐族→2 …，未识别的族→0），
 * 同族的两个音色（钢琴/电钢琴、小提琴/大提琴、长笛/竖笛…）必然撞在同一通道上：
 * 后设的音色把先前声部一起改掉，且已设过的 program 不再补发 ⇒ 多声部听起来只剩一种音色
 * （用户报「描述区指定多个 `Y:` 音色，多声部演奏时只使用了第一个音色」；
 * 实测两声道 17 个事件里 11 个用错音色）。
 *
 * 本模块只做纯分配（零 DOM/零 MIDI 依赖，可单测）；实际补发 `programChange` 由后端按
 * 「该通道当前音色是否等于本音」在**触发时刻**决定（见 `src/playback/spessaSynthBackend.ts`）。
 */

/** 可用于旋律音色的 GM 通道（0 基）——跳过 9（GM 规定的打击乐通道） */
export const GM_MELODIC_CHANNELS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]

/**
 * 音色（GM program）→ 独占通道 的分配器（一次播放会话一个实例）。
 *
 *  - 同一 program 反复取到同一通道（不浪费通道，也让 `programChange` 只发一次）；
 *  - 新 program 优先取**空闲**通道；
 *  - 通道用尽（同时出现 >15 种音色）时按 `program % 通道数` 复用——此时该通道会被多个音色
 *    共用，调用方**必须**逐音核对并补发 `programChange`，不能只发一次。
 */
export class GmChannelAllocator {
  private byProgram = new Map<number, number>()
  private used = new Set<number>()

  /** 取该音色的播放通道 */
  channelFor(program: number): number {
    const hit = this.byProgram.get(program)
    if (hit !== undefined) return hit
    const free = GM_MELODIC_CHANNELS.find((c) => !this.used.has(c))
    // abs + 取模：program 理论上 0~127，异常值也不越界
    const ch = free ?? GM_MELODIC_CHANNELS[Math.abs(program) % GM_MELODIC_CHANNELS.length]
    this.byProgram.set(program, ch)
    this.used.add(ch)
    return ch
  }

  /** 清空分配（新建会话 / 重建合成器时调用） */
  reset(): void {
    this.byProgram.clear()
    this.used.clear()
  }
}
