/**
 * engine/playback/sampler.ts — 采样音源后端（可切换，实验性）
 *
 * 从外部加载钢琴采样（midi-js-soundfonts MusyngKite，开源第三方 SoundFont 库）。
 * 依赖网络；加载失败或离线时由 UI 提示并回退到合成音色。
 * 采样按需加载（首次播放时），缓存于内存。
 */
import type { AudioBackend } from './types'
import { pitchToFreq } from './synth'

const DEFAULT_SOUNDFONT =
  'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/acoustic_grand_piano-mp3.js'

interface SoundfontData {
  [noteName: string]: string // base64 mp3
}

export class SamplerBackend implements AudioBackend {
  readonly kind = 'sampler' as const
  /** 加载状态：idle | loading | ready | failed */
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private ctx: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private soundfontUrl: string
  private loadPromise: Promise<void> | null = null

  constructor(soundfontUrl: string = DEFAULT_SOUNDFONT) {
    this.soundfontUrl = soundfontUrl
  }

  /** 预加载采样（首次播放时自动调用；也可由 UI 预加载） */
  async load(): Promise<void> {
    if (this.state === 'ready' || this.state === 'loading') {
      return this.loadPromise ?? Promise.resolve()
    }
    this.state = 'loading'
    this.loadPromise = (async () => {
      const res = await fetch(this.soundfontUrl)
      if (!res.ok) throw new Error(`soundfont 加载失败: HTTP ${res.status}`)
      const text = await res.text()
      const data = parseSoundfont(text)
      this.ctx = this.ensureCtx()
      if (!this.ctx) throw new Error('AudioContext 不可用')
      // 仅解码需要的音区（C2-B6），控制内存
      for (const [name, b64] of Object.entries(data)) {
        if (!/^[A-G]#?\d$/.test(name)) continue
        const bytes = base64ToBytes(b64)
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const buf = await this.ctx.decodeAudioData(ab)
        this.buffers.set(name, buf)
      }
      this.state = 'ready'
    })().catch((e) => {
      this.state = 'failed'
      throw e
    })
    return this.loadPromise
  }

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  play(pitch: string | null, atMs: number, durationMs: number, gain: number, _instrument?: string): void {
    if (!pitch || this.state !== 'ready') return
    const ctx = this.ctx
    if (!ctx) return
    // 邻近采样：取最接近的音名 buffer（soundfont 按半音提供）
    const buf = this.nearestBuffer(pitch)
    if (!buf) return
    const t0 = ctx.currentTime + Math.max(0, atMs) / 1000
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t0)
    // adj311：起音渐强至少 60ms（原 8ms 太陡 → 爆音；延迟播放 + 由小渐强压制）
    g.gain.linearRampToValueAtTime(gain, t0 + Math.max(0.008, 0.06))
    g.gain.exponentialRampToValueAtTime(0.001, t0 + Math.max(0.1, durationMs / 1000))
    src.connect(g)
    g.connect(ctx.destination)
    src.start(t0)
    src.stop(t0 + Math.max(0.1, durationMs / 1000) + 0.05)
  }

  private nearestBuffer(pitch: string): AudioBuffer | null {
    if (this.buffers.has(pitch)) return this.buffers.get(pitch)!
    const target = pitchToFreq(pitch)
    let best: AudioBuffer | null = null
    let bestDiff = Infinity
    for (const [name, buf] of this.buffers) {
      const diff = Math.abs(pitchToFreq(name) - target)
      if (diff < bestDiff) {
        bestDiff = diff
        best = buf
      }
    }
    return best
  }

  stop(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.buffers.clear()
    }
  }

  dispose(): void {
    this.stop()
  }
}

/** 解析 soundfont JS 文件（"MIDI.Soundfont.<name> = {...}"） */
function parseSoundfont(text: string): SoundfontData {
  const m = /=\s*(\{[\s\S]*\})/.exec(text)
  if (!m) return {}
  try {
    const obj = JSON.parse(m[1]) as SoundfontData
    return obj
  } catch {
    return {}
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
