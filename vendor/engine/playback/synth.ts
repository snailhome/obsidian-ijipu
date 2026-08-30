/**
 * engine/playback/synth.ts — Web Audio 合成音色后端（零外部依赖）
 *
 * 用振荡器 + 泛音 + 包络模拟乐器；按事件携带的乐器/声部名自动路由到预设
 * （adj283：多声部按各自乐器同时发声，见 instruments.ts）。
 * AudioContext 惰性创建（首次播放时，满足浏览器用户手势要求）。
 * adj308：await resume 避免点击音符触发试听时漏首拍；stop 同步 disconnect 旧 osc 避免与新 ctx 叠加杂音。
 */
import type { AudioBackend } from './types'
import { INSTRUMENT_PRESETS, matchInstrument } from './instruments'

/** 简谱音名（如 C4 / F#5）→ 频率 */
export function pitchToFreq(name: string): number {
  const m = /^([A-G])(#?)(-?\d+)$/.exec(name)
  if (!m) return 261.63
  const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const base = semis[m[1]] + (m[2] === '#' ? 1 : 0)
  const octave = Number(m[3])
  // C4 = 261.63Hz
  return 261.63 * Math.pow(2, octave - 4 + base / 12)
}

/**
 * adj290：在任意 BaseAudioContext（在线 AudioContext / 离线 OfflineAudioContext）上
 * 渲染一个合成音符（多乐器预设）。返回创建的振荡器列表（在线后端用其管理停止清理，
 * 离线渲染可忽略）。不管理生命周期——节点结束（onended）自动断开。
 *  adj308：t0（可选）= 事件"atSec=0"对应的实际播放时刻（秒），不传则用 ctx.currentTime +
 * 小缓冲（让 AudioContext resume 就绪，避免漏首拍）。
 */
export function renderSynthNote(
  ctx: BaseAudioContext,
  pitch: string,
  atSec: number,
  durSec: number,
  gain: number,
  instrument?: string,
  t0?: number,
  output?: AudioNode,
): OscillatorNode[] {
  const startAt = t0 ?? ctx.currentTime + 0.08 // adj308：80ms 缓冲保证 resume 就绪后再触发
  const tStart = startAt + Math.max(0, atSec)
  const dur = Math.max(0.06, durSec)
  const freq = pitchToFreq(pitch)
  // adj283：按乐器/声部名路由到预设（匹配失败回退默认钢琴）
  const p = INSTRUMENT_PRESETS[matchInstrument(instrument)]
  const oscs: OscillatorNode[] = []
  for (const [mult, vol, type] of p.partials) {
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq * mult
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, tStart)
    // adj311：起音渐强至少 60ms（原 attack 最短 5ms 太陡 → 起音瞬间从 0 跳到峰值产生"炸音"；
    // 如之前项目解法"延迟播放 + 由小渐强"，拉长 attack 压制爆音）
    const atk = Math.max(p.attack, 0.06)
    g.gain.linearRampToValueAtTime(gain * vol, tStart + atk)
    // 持续音色：起音后保持到 sustainLevel（时变常数控制），末尾指数收尾；
    // 敲击音色（无 sustainLevel）：起音后直接指数衰减
    if (p.sustainLevel !== undefined) {
      g.gain.setTargetAtTime(gain * vol * p.sustainLevel, tStart + atk, p.decayTime ?? 0.05)
    }
    g.gain.exponentialRampToValueAtTime(0.001, tStart + dur)
    osc.connect(g)
    g.connect(output ?? ctx.destination)
    osc.start(tStart)
    osc.stop(tStart + dur + 0.05)
    osc.onended = () => {
      g.disconnect()
      osc.disconnect()
    }
    oscs.push(osc)
  }
  return oscs
}

export class SynthBackend implements AudioBackend {
  readonly kind = 'synth' as const
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private activeOscs = new Set<OscillatorNode>()

  /** adj312：主增益——所有音符经此输出；在 ctx 创建/resume 时做 300ms 整体淡入（由小渐强），
   *  把音色本身的起音瞬间/点击音符时的初始调度全部包住，彻底压制"炸音"（叠加在音符 60ms 渐强之上） */
  private ensureMaster(ctx: AudioContext): GainNode {
    if (!this.master) {
      const m = ctx.createGain()
      m.connect(ctx.destination)
      // 主增益从 0 → 1，300ms 渐强（覆盖 ctx 启动瞬间的任何初始高幅）
      m.gain.setValueAtTime(0, ctx.currentTime)
      m.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.3)
      this.master = m
    }
    return this.master
  }

  /** adj308：异步创建/恢复 AudioContext——await resume 完成避免新调度早于 ctx 启动；
   *  检测 ctx.state==='closed'（adj309：stop 后异步关闭完成）以释放旧 ctx 引用，允许下次重建
   *  避免新旧 ctx 同时发声（之前 stop 后 this.ctx=null 太早，新 ctx 在旧 ctx 关闭中创建 → 叠加杂音） */
  async ensure(): Promise<AudioContext | null> {
    if (this.ctx && this.ctx.state === 'closed') {
      this.ctx = null
      this.master = null
    }
    if (!this.ctx) {
      try {
        // 新建 ctx 时先重置 master（下次播放重新淡入）
        this.master = null
        this.ctx = new AudioContext()
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch {
        return this.ctx
      }
    }
    return this.ctx
  }

  /** adj308：公开 ensure 别名（接口 ready? 调用）——等待 ctx resume 完成避免首拍漏播 */
  async ready(): Promise<void> {
    await this.ensure()
  }

  /** adj308：t0（可选）= 事件"atMs=0"对应的实际播放时刻（秒），不传则用 ctx.currentTime + 缓冲 */
  async play(pitch: string | null, atMs: number, durationMs: number, gain: number, instrument?: string, t0?: number): Promise<void> {
    if (!pitch) return
    const ctx = await this.ensure()
    if (!ctx) return
    const master = this.ensureMaster(ctx)
    const oscs = renderSynthNote(ctx, pitch, Math.max(0, atMs) / 1000, durationMs / 1000, gain, instrument, t0, master)
    for (const o of oscs) {
      this.activeOscs.add(o)
      const prev = o.onended
      o.onended = (ev) => {
        prev?.call(o, ev)
        this.activeOscs.delete(o)
      }
    }
  }

  /** adj308：同步立即停所有活动 osc + 异步 close ctx（adj309：保留 this.ctx 引用直到 close 完成）——
   *  旧 osc 立即断开避免与新 ctx 同时发声杂音；ensure 检测 ctx.state==='closed' 后释放 this.ctx 重建。
   * this.ctx 不立即置 null（旧 ctx 关闭中若被新 ctx 替换，叠加导致杂音）。 */
  stop(): void {
    if (this.ctx) {
      const oscs = [...this.activeOscs]
      this.activeOscs.clear()
      for (const o of oscs) {
        try { o.stop() } catch { /* 已停 */ }
        try { o.disconnect() } catch { /* 可能已断开 */ }
      }
      if (this.master) {
        try { this.master.disconnect() } catch { /* 已断开 */ }
        this.master = null
      }
      const oldCtx = this.ctx
      void oldCtx.close().catch(() => {})
      // this.ctx 不置 null；ensure 检测 state==='closed' 时设为 null 并重建
    }
  }

  dispose(): void {
    this.stop()
  }
}
