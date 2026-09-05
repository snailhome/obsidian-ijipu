/**
 * engine/playback/sampler.ts — 采样音源后端（adj323：从单一钢琴升级为「音色库」模型）
 *
 * 从外部加载采样包（midi-js-soundfonts MusyngKite，原站同源方案）。
 * 依赖网络；加载失败或离线时由 UI 提示并回退到合成音色。
 * 采样按需加载（首次播放时），缓存于内存。构造函数接收一个音色库对象
 * （source + noteRange），使同一后端可切换不同采样库。
 * adj326：① 实现 ready()（await AudioContext resume）——此前未实现，PlaybackDialog 的
 * `await backend.ready?.()` 被跳过 → ctx 未真正 resume 就调度音符 → 无声；
 * ② stop() 重置 state='idle'——stop 会关闭 ctx 并清空缓冲，若 state 仍 'ready'，
 * 下次 load() 会被短路跳过 → nearestBuffer 找不到缓冲 → 再次播放无声。
 */
import type { AudioBackend } from './types'
import type { SamplerLibrary } from './libraries'
import { getSamplerLibrary } from './libraries'
import type { SamplerCache } from './sampler-cache'
import { pitchToFreq } from './synth'

interface SoundfontData {
  [noteName: string]: string // base64 mp3
}

export class SamplerBackend implements AudioBackend {
  readonly kind = 'sampler' as const
  /** 加载状态：idle | loading | ready | failed */
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private ctx: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  /** 当前音色库（含 source / noteRange，缓存键取 id） */
  readonly library: SamplerLibrary
  /** 离线缓存（可选）：命中则离线可试听，未命中再联网下载并写回 */
  private cache: SamplerCache | null
  private loadPromise: Promise<void> | null = null

  constructor(library?: SamplerLibrary, cache?: SamplerCache) {
    this.library = library ?? getSamplerLibrary()
    this.cache = cache ?? null
  }

  /** adj326：等待 AudioContext 创建/resume——避免首拍漏播（PlaybackDialog 在 play 前 await） */
  async ready(): Promise<void> {
    const ctx = await this.ensureCtx()
    if (!ctx) throw new Error('AudioContext 不可用')
  }

  /** 预加载采样（首次播放时自动调用；也可由 UI 预加载）。跨库切换 → 重新 load。
   *  优先读离线缓存；未命中则联网下载并写回缓存。 */
  async load(): Promise<void> {
    if (this.state === 'ready' || this.state === 'loading') {
      return this.loadPromise ?? Promise.resolve()
    }
    this.state = 'loading'
    this.loadPromise = (async () => {
      let data: SoundfontData
      if (this.cache) {
        const cached = await this.cache.loadText(this.library.id)
        if (cached != null) {
          data = parseSoundfont(cached)
        } else {
          const fetched = await this.fetchText()
          data = parseSoundfont(fetched)
          // 写回缓存（失败不阻断播放——下次仍联网）
          await this.cache.saveText(this.library.id, fetched).catch(() => {})
        }
      } else {
        data = parseSoundfont(await this.fetchText())
      }
      const ctx = await this.ensureCtx()
      if (!ctx) throw new Error('AudioContext 不可用')
      this.ctx = ctx
      // 仅解码需要的音区（noteRange），控制内存；单个音符解码失败跳过，不拖垮整库
      const [lo, hi] = this.library.noteRange
      let decoded = 0
      for (const [name, b64] of Object.entries(data)) {
        if (!/^[A-G](?:#|b)?\d$/.test(name)) continue
        if (noteNameToSemitone(name) < noteNameToSemitone(lo) || noteNameToSemitone(name) > noteNameToSemitone(hi)) continue
        try {
          const bytes = base64ToBytes(b64)
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const buf = await ctx.decodeAudioData(ab)
          this.buffers.set(name, buf)
          decoded++
        } catch {
          /* 单个音符解码失败——跳过，其余照常（避免一个坏音符导致整库回退） */
        }
      }
      // 整库解码后无可用音符（内容损坏/格式不匹配）→ 明确失败，避免"无声但无提示"
      if (decoded === 0) throw new Error(`音色库「${this.library.name}」解码后无可用音符`)
      this.state = 'ready'
    })().catch((e) => {
      this.state = 'failed'
      throw e
    })
    return this.loadPromise
  }

  /** 联网下载音色库源文本（可能很大，约 2~3MB） */
  private async fetchText(): Promise<string> {
    const res = await fetch(this.library.source)
    if (!res.ok) throw new Error(`音色库「${this.library.name}」加载失败: HTTP ${res.status}`)
    return res.text()
  }

  /** 创建/恢复 AudioContext，并 await resume 完成（adj326：避免 suspended 下无声；
   *  adj327：resume 失败返回 null → 由 load 明确报错回退，避免挂起在"加载中…"） */
  private async ensureCtx(): Promise<AudioContext | null> {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch {
        return null
      }
    }
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

  /** adj326：stop 后重置 state='idle' —— close ctx + 清空缓冲后必须允许下次重新 load */
  stop(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.buffers.clear()
    }
    this.state = 'idle'
  }

  dispose(): void {
    this.stop()
  }
}

/** 解析 soundfont 文本：直接提取全部「音名: base64」键值对（无视外层 var/文件结构，鲁棒） */
function parseSoundfont(text: string): SoundfontData {
  const out: SoundfontData = {}
  // 真实文件常以 `var MIDI = {};MIDI.Soundfont.x = {...}` 开头——旧正则误把首个 `{}` 当对象、
  // 贪婪吃到文件末尾导致 JSON.parse 失败。改为扫描所有 `"音名": "base64"` 键值对（音名亦可带 #/b）。
  const re = /"([A-G](?:#|b)?\d)":\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[2]) out[m[1]] = m[2]
  }
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  // 兼容 data:*;base64, 前缀（部分 soundfont 用 data URI 而非纯 base64）
  const comma = b64.indexOf('base64,')
  const raw = comma >= 0 ? b64.slice(comma + 7) : b64
  const bin = atob(raw)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 音名（如 C4 / F#5 / Db4）→ 半音相对数（C-1 = 0），用于音域上下限比较（兼容升号 # 与降号 b） */
function noteNameToSemitone(name: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name)
  if (!m) return 0
  const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return (Number(m[3]) + 1) * 12 + semis[m[1]] + acc
}
