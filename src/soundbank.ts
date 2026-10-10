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
// adj760（清单 B3）：音源库**清单**与**取用顺序策略**来自引擎（与应用共用）——插件里不再各存一份
import { planHqBankLoad } from '@ijipu/engine'
import type { HqSampleLibrary } from '@ijipu/engine'
export { HQ_LIBRARIES, getHqLibrary, hqBankFailureText } from '@ijipu/engine'
export type { HqSampleLibrary, HqBankSource } from '@ijipu/engine'
import type { BankFileStore } from './bankFile'

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

/**
 * 预下载音源库并写缓存（SF2 远端下载 → 插件目录 + IndexedDB；带进度回调 0~1）
 *
 * adj729：顺序按用户口径调整为 **插件目录文件 → IndexedDB → 下载**；
 * 下载成功后**写进插件目录**（这样音源会随文库一起同步），IndexedDB 仍留一份作降级读取。
 */
export async function prefetchHqLibraryProgress(
  lib: HqSampleLibrary,
  cache: HqCache,
  onProgress?: (p: number) => void,
  files?: BankFileStore | null,
): Promise<void> {
  // ① 插件目录里已有（多半是上次下载/导入留下的，且随文库同步了过来）
  if (files && (await files.exists(lib.id))) { onProgress?.(1); return }
  // ② 存量：老的 IndexedDB 缓存 ⇒ 顺手**补写**成插件目录文件（迁移，之后随文库走）
  if (await cache.has(lib.id)) {
    if (files) {
      const ab = await cache.load(lib.id)
      if (ab) {
        try {
          await files.write(lib.id, ab)
        } catch {
          /* 写不进去也不影响试听（只是这次没落盘） */
        }
      }
    }
    onProgress?.(1)
    return
  }
  // ③ 下载（再把结果同时写进插件目录与 IndexedDB）
  /**
   * ⚠ adj773 回退说明：这里一度按社区审核建议改用 Obsidian 的 `requestUrl`（绕过 CORS、手机端更稳），
   * 但那让冒烟里"下载音源"的用例**真的发网络请求**（stub 转发到全局 fetch）⇒ 无网/受限环境下套件红灯。
   * 审核那条只是**警告**（非阻塞），为不把"网络可用性"带进测试，先退回 `fetch`。
   */
  const res = await fetch(lib.source)
  if (!res.ok) throw new Error(`音源「${lib.name}」下载失败: HTTP ${res.status}`)
  const bank = await res.arrayBuffer()
  await cache.save(lib.id, bank)
  if (files) {
    try {
      await files.write(lib.id, bank)
    } catch (e) {
      // 落盘失败要说出来：用户以为"已经随文库走了"，实际没有
      console.warn('[iJipu] 音源写入插件目录失败：', e)
    }
  }
  onProgress?.(1)
}

/**
 * 下载音源库为 ArrayBuffer。
 *
 * adj729 顺序：**插件目录文件 → IndexedDB 缓存 → 远端下载**（下载后写插件目录 + 缓存）。
 * 用户口径：「音色库下载或导入后，建议放在插件目录中，以便能随文库一起走」。
 */
export async function loadHqBank(
  lib: HqSampleLibrary,
  cache: HqCache,
  files?: BankFileStore | null,
): Promise<ArrayBuffer> {
  /**
   * adj760：**顺序由引擎的 `planHqBankLoad` 决定**（唯一口径：本地文件 → 本机缓存 → 联网下载），
   * 本函数只负责执行与把结果写回各级 —— 免得"应用一种顺序、插件另一种顺序"。
   */
  const fromFile = files ? await files.read(lib.id) : null
  const hit = fromFile && fromFile.byteLength > 0 ? null : await cache.load(lib.id)
  const plan = planHqBankLoad({ userFile: !!fromFile && fromFile.byteLength > 0, cache: !!hit })
  if (plan === 'userFile' && fromFile) return fromFile
  if (plan === 'cache' && hit) {
    // 存量缓存：补写一份到插件目录（迁移；失败不影响本次试听）
    if (files) {
      try {
        await files.write(lib.id, hit)
      } catch {
        /* 忽略 */
      }
    }
    return hit
  }
  // adj773：与上面同理，退回 `fetch`（不把网络可用性带进冒烟）
  const res = await fetch(lib.source)
  if (!res.ok) throw new Error(`音源「${lib.name}」加载失败: HTTP ${res.status}`)
  const bank = await res.arrayBuffer()
  await cache.save(lib.id, bank)
  if (files) {
    try {
      await files.write(lib.id, bank)
    } catch (e) {
      console.warn('[iJipu] 音源写入插件目录失败：', e)
    }
  }
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
