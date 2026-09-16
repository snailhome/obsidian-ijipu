/**
 * obsidian-ijipu/src/soundbank.ts — 音色库：GM 音色 + 高保真音源库 + IndexedDB 缓存（adj352）
 *
 * 与 iJipu 应用「音色库」机制一致：
 *  - GM_VOICE_OPTIONS：GM 全集（program 0-127，中文名），供「默认音色」下拉与「收藏音色」选择
 *  - DEFAULT_HQ_ENABLED：默认收藏的常用音色（初次即可用）
 *  - HQ_LIBRARIES：高保真音源库（GeneralUser GS），SF2 从远端下载（不随插件打包，32MB）
 *  - HqCache：IndexedDB 缓存（SF2 ArrayBuffer 落盘，仅首次下载、之后直接用）
 *  - prefetchHqLibraryProgress / loadHqBank：远端下载 + 写缓存（带进度回调）
 *  - SpessaSynthBackend：spessasynth_lib 合成器后端（动态加载，worklet 由插件提供）
 */
import { WorkletSynthesizer } from 'spessasynth_lib'
import { instrumentToProgram, pitchToMidiNote, GmChannelAllocator, GM_VOICES } from '@ijipu/engine'
import type { GmVoice } from '@ijipu/engine'

/** 高保真音源库（SF2/SF3/DLS）元数据 */
export interface HqSampleLibrary {
  id: string
  name: string
  source: string
  fallbackSource?: string
  sizeBytes: number
  format: 'sf2' | 'sf3' | 'dls'
}

/** 高保真音源库列表——通用音源（GeneralUser GS）。默认库 source 为远端 raw（插件不打包 32MB SF2）；有 R2 公开桶时换上更快 URL。 */
export const HQ_LIBRARIES: HqSampleLibrary[] = [
  {
    id: 'generaluser_gs',
    name: '通用音源（GeneralUser GS）',
    source: 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2',
    fallbackSource: '',
    sizeBytes: 32_319_396,
    format: 'sf2',
  },
]
export function getHqLibrary(id?: string | null): HqSampleLibrary {
  if (id) {
    const f = HQ_LIBRARIES.find((l) => l.id === id)
    if (f) return f
  }
  return HQ_LIBRARIES[0]
}

/**
 * GM 全集（program 0-127，中文名）——音色设置用。
 * adj450：表已收敛到 engine 的 `GM_VOICES`（**唯一来源**，与 iJipu 应用同一份），
 * 避免"设置里看到的名称"与"谱面 Y: / @乐器名@ 能解析的名称"两处分叉。
 */
export const GM_VOICE_OPTIONS: GmVoice[] = GM_VOICES

/** 默认收藏的常用音色（初次即可用）——大钢琴/八音盒/小提琴/弦乐/小号/单簧管/长笛 */
export const DEFAULT_HQ_ENABLED: number[] = [0, 10, 40, 48, 56, 71, 73]

/** SF2/SF3 音源离线缓存（IndexedDB 存 ArrayBuffer，键=库 id） */
export class HqCache {
  private db: IDBDatabase | null = null
  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db)
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ijipu-soundfonts', 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('banks')) req.result.createObjectStore('banks')
      }
      req.onsuccess = () => { this.db = req.result; resolve(req.result) }
      req.onerror = () => reject(req.error)
    })
  }
  private get(id: string): Promise<ArrayBuffer | null> {
    return this.open().then(
      (db) => new Promise<ArrayBuffer | null>((resolve) => {
        const r = db.transaction('banks', 'readonly').objectStore('banks').get(id)
        r.onsuccess = () => resolve(r.result instanceof ArrayBuffer ? r.result : null)
        r.onerror = () => resolve(null)
      }),
    )
  }
  async load(id: string): Promise<ArrayBuffer | null> { return this.get(id) }
  async has(id: string): Promise<boolean> {
    // 极快：只查键是否存在（getKey，不读 32MB 全量）
    const db = await this.open()
    return new Promise<boolean>((resolve) => {
      const r = db.transaction('banks', 'readonly').objectStore('banks').getKey(id)
      r.onsuccess = () => resolve(r.result !== undefined)
      r.onerror = () => resolve(false)
    })
  }
  async save(id: string, ab: ArrayBuffer): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('banks', 'readwrite')
      tx.objectStore('banks').put(ab, id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
  async remove(id: string): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('banks', 'readwrite')
      tx.objectStore('banks').delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
}

/** 预下载音源库并写缓存（SF2 远端下载 → IndexedDB；已缓存 getKey 极快判断；带进度回调 0~1） */
export async function prefetchHqLibraryProgress(
  lib: HqSampleLibrary,
  cache: HqCache,
  onProgress?: (p: number) => void,
): Promise<void> {
  if (await cache.has(lib.id)) { onProgress?.(1); return }
  const res = await fetch(lib.source)
  if (!res.ok) throw new Error(`音源「${lib.name}」下载失败: HTTP ${res.status}`)
  const bank = await res.arrayBuffer() // 浏览器内部线程下载，主线程不逐块处理
  await cache.save(lib.id, bank)
  onProgress?.(1)
}

/** 下载音源库为 ArrayBuffer（优先缓存；未缓存则远端下载并写缓存） */
export async function loadHqBank(lib: HqSampleLibrary, cache: HqCache): Promise<ArrayBuffer> {
  const hit = await cache.load(lib.id)
  if (hit) return hit
  const res = await fetch(lib.source)
  if (!res.ok) throw new Error(`音源「${lib.name}」加载失败: HTTP ${res.status}`)
  const bank = await res.arrayBuffer()
  await cache.save(lib.id, bank)
  return bank
}

/**
 * SpessaSynth 高保真后端（obsidian 版）。
 * 用 spessasynth_lib 的 WorkletSynthesizer（AudioWorklet，独立线程）播放 SF2/SF3/DLS。
 * worklet 处理器由插件提供（setWorkletUrl / load 参数），SoundBank 为 ArrayBuffer。
 */
export class SpessaSynthBackend {
  readonly kind = 'sampler' as const
  readonly hq = true
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private voiceOverride: number | null = null
  private ctx: AudioContext | null = null
  private synth: WorkletSynthesizer | null = null
  /**
   * adj450：**一个音色独占一个 MIDI 通道**（与 iJipu 应用 adj446 同一套 `GmChannelAllocator`）。
   * 旧实现是 `ch = program % 16`：不同音色会撞同一通道（0 与 16、4 与 20…），
   * 而 MIDI 通道同时只能有一个 program ⇒ 后设的音色把先前声部一起改掉、且「发过就不再发」
   * 让先设的 program 永不恢复，多声部听起来只剩一种音色；此外 `program % 16 === 9`
   * （如 9 钢片琴）会落到 GM **打击乐通道**，音色完全走样。
   */
  private channels = new GmChannelAllocator()
  /** adj450：各通道**当前已设**的 program——按触发时刻核对，避免重复 programChange */
  private channelProgram = new Map<number, number>()
  private timers = new Set<number>()

  async ready(): Promise<void> {
    if (!(await this.ensureCtx())) throw new Error('AudioContext 不可用')
  }
  setVoice(program: number | null): void { this.voiceOverride = program }
  private async ensureCtx(): Promise<AudioContext | null> {
    if (!this.ctx) { try { this.ctx = new AudioContext() } catch { return null } }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume() } catch { return null } }
    return this.ctx
  }
  /** 加载音源：注册 worklet（workletUrl 由插件提供）→ 加载 SoundBank → 等 isReady */
  async load(bank: ArrayBuffer, workletUrl: string): Promise<void> {
    if (this.state === 'ready' || this.state === 'loading') return
    this.state = 'loading'
    try {
      const ctx = await this.ensureCtx()
      if (!ctx) throw new Error('AudioContext 不可用')
      // adj354：spessasynth_lib 用静态 import（避免构建拆出 dist-*.js chunk——Obsidian 插件目录只有 main.js，
      // 缺失 chunk 导致 Cannot find module；静态导入随 main.js 单文件内联）
      if (!this.synth) {
        await ctx.audioWorklet.addModule(workletUrl)
        const synth = new WorkletSynthesizer(ctx)
        await synth.soundBankManager.addSoundBank(bank, 'main')
        synth.connect(ctx.destination)
        this.synth = synth
      }
      await (this.synth as unknown as { isReady: Promise<unknown> }).isReady
      this.state = 'ready'
    } catch (e) {
      this.state = 'failed'
      throw e
    }
  }
  /**
   * 播放一个音。
   * adj450：`opts.keepInstrument`（引擎 `schedulePlay` 会对**伴奏/第二声部**与曲内 `@乐器名@`
   * 显式音色传 true）：保留事件自带音色，不被「默认音色」覆盖——与 iJipu 应用 adj427/adj434 口径一致。
   */
  play(
    pitch: string | null,
    atMs: number,
    durationMs: number,
    gain: number,
    instrument?: string,
    _t0?: number,
    opts?: { keepInstrument?: boolean },
  ): void {
    const synth = this.synth
    if (!pitch || !synth || this.state !== 'ready') return
    const note = pitchToMidiNote(pitch)
    const program = opts?.keepInstrument
      ? instrumentToProgram(instrument)
      : (this.voiceOverride ?? instrumentToProgram(instrument))
    const ch = this.channels.channelFor(program)
    const velocity = Math.max(1, Math.min(127, Math.round(127 * gain)))
    const onFn = () => {
      // 触发时刻核对「本通道当前音色」：独占通道时只发一次；通道复用（>15 音色）时逐音补发
      if (this.channelProgram.get(ch) !== program) {
        synth.programChange(ch, program)
        this.channelProgram.set(ch, program)
      }
      synth.noteOn(ch, note, velocity)
    }
    const offFn = () => synth.noteOff(ch, note)
    this.timers.add(window.setTimeout(onFn, Math.max(0, atMs)))
    this.timers.add(window.setTimeout(offFn, Math.max(0, atMs) + Math.max(100, durationMs)))
  }
  stop(): void {
    for (const t of this.timers) window.clearTimeout(t)
    this.timers.clear()
    this.synth?.stopAll(true)
    // adj450：`stopAll(true)` 会重置合成器状态 ⇒ 已设 program 记录一起清掉，否则下次播放跳过 programChange
    this.channelProgram.clear()
  }
  dispose(): void {
    this.stop()
    this.channels.reset()
    this.synth?.disconnect()
    this.synth = null
    if (this.ctx) { void this.ctx.close().catch(() => {}); this.ctx = null }
  }
}
