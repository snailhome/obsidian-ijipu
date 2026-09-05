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
import type { WorkletSynthesizer } from 'spessasynth_lib'
import { instrumentToProgram, pitchToMidiNote } from '@ijipu/engine'

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

/** GM 全集（program 0-127，中文名）——音色设置用（与 iJipu 一致） */
export const GM_VOICE_OPTIONS: { program: number; label: string }[] = [
  { program: 0, label: '0 大钢琴' }, { program: 1, label: '1 亮音钢琴' }, { program: 2, label: '2 电钢琴' }, { program: 3, label: '3 酒吧钢琴' },
  { program: 4, label: '4 电钢琴1' }, { program: 5, label: '5 电钢琴2' }, { program: 6, label: '6 拨弦古钢琴' }, { program: 7, label: '7 击弦古钢琴' },
  { program: 8, label: '8 钟琴' }, { program: 9, label: '9 钢片琴' }, { program: 10, label: '10 八音盒' }, { program: 11, label: '11 颤音琴' },
  { program: 12, label: '12 马林巴' }, { program: 13, label: '13 木琴' }, { program: 14, label: '14 管钟' }, { program: 15, label: '15 杜西玛琴' },
  { program: 16, label: '16 拉杆风琴' }, { program: 17, label: '17 打击风琴' }, { program: 18, label: '18 摇滚风琴' }, { program: 19, label: '19 教堂风琴' },
  { program: 20, label: '20 簧风琴' }, { program: 21, label: '21 手风琴' }, { program: 22, label: '22 口琴' }, { program: 23, label: '23 探戈手风琴' },
  { program: 24, label: '24 民谣吉他' }, { program: 25, label: '25 电吉他(清音)' }, { program: 26, label: '26 电吉他(闷音)' }, { program: 27, label: '27 电吉他(过载)' },
  { program: 28, label: '28 电吉他(失真)' }, { program: 29, label: '29 电吉他(泛音)' }, { program: 30, label: '30 中音吉他' }, { program: 31, label: '31 爵士吉他' },
  { program: 32, label: '32 声学贝斯' }, { program: 33, label: '33 电贝斯(指弹)' }, { program: 34, label: '34 电贝斯(拨片)' }, { program: 35, label: '35 无品贝斯' },
  { program: 36, label: '36 击弦倍低音' }, { program: 37, label: '37 闷音电贝斯' }, { program: 38, label: '38 电贝斯1' }, { program: 39, label: '39 电贝斯2' },
  { program: 40, label: '40 小提琴' }, { program: 41, label: '41 中提琴' }, { program: 42, label: '42 大提琴' }, { program: 43, label: '43 低音提琴' },
  { program: 44, label: '44 拨奏弦乐' }, { program: 45, label: '45 竖琴' }, { program: 46, label: '46 定音鼓' }, { program: 47, label: '47 弦乐合奏' },
  { program: 48, label: '48 弦乐合奏1' }, { program: 49, label: '49 弦乐合奏2' }, { program: 50, label: '50 合成弦乐1' }, { program: 51, label: '51 合成弦乐2' },
  { program: 52, label: '52 合唱啊音' }, { program: 53, label: '53 人声"哦"音' }, { program: 54, label: '54 合成人声' }, { program: 55, label: '55 管弦打击' },
  { program: 56, label: '56 小号' }, { program: 57, label: '57 长号' }, { program: 58, label: '58 大号' }, { program: 59, label: '59 闷音小号' },
  { program: 60, label: '60 法国号' }, { program: 61, label: '61 铜管组' }, { program: 62, label: '62 合成铜管1' }, { program: 63, label: '63 合成铜管2' },
  { program: 64, label: '64 高音萨克斯' }, { program: 65, label: '65 中音萨克斯' }, { program: 66, label: '66 次中音萨克斯' }, { program: 67, label: '67 上低音萨克斯' },
  { program: 68, label: '68 双簧管' }, { program: 69, label: '69 英国号' }, { program: 70, label: '70 巴松管' }, { program: 71, label: '71 单簧管' },
  { program: 72, label: '72 短笛' }, { program: 73, label: '73 长笛' }, { program: 74, label: '74 泛音笛' }, { program: 75, label: '75 竖笛' },
  { program: 76, label: '76 巴乌笛' }, { program: 77, label: '77 尺八' }, { program: 78, label: '78 民族笛' }, { program: 79, label: '79 哨笛' },
  { program: 80, label: '80 排箫' }, { program: 81, label: '81 吹瓶声' }, { program: 82, label: '82 口哨' }, { program: 83, label: '83 民族排箫' },
  { program: 84, label: '84 尺八(合成)' }, { program: 85, label: '85 合成主音1' }, { program: 86, label: '86 合成主音2' }, { program: 87, label: '87 合成主音3' },
  { program: 88, label: '88 合成垫音1' }, { program: 89, label: '89 合成垫音2' }, { program: 90, label: '90 合成垫音3' }, { program: 91, label: '91 合成垫音4' },
  { program: 92, label: '92 合成垫音5' }, { program: 93, label: '93 合成垫音6' }, { program: 94, label: '94 合成垫音7' }, { program: 95, label: '95 合成垫音8' },
  { program: 96, label: '96 合成雨声' }, { program: 97, label: '97 合成音轨' }, { program: 98, label: '98 合成水晶音' }, { program: 99, label: '99 合成氛围声' },
  { program: 100, label: '100 合成明亮音' }, { program: 101, label: '101 合成妖精声' }, { program: 102, label: '102 合成回声' }, { program: 103, label: '103 合成科幻声' },
  { program: 104, label: '104 西塔尔琴' }, { program: 105, label: '105 班卓琴' }, { program: 106, label: '106 三味线' }, { program: 107, label: '107 十三弦琴' },
  { program: 108, label: '108 卡林巴' }, { program: 109, label: '109 风笛' }, { program: 110, label: '110 民族琴' }, { program: 111, label: '111 印尼锣' },
  { program: 112, label: '112 锡塔尔' }, { program: 113, label: '113 钢鼓' }, { program: 114, label: '114 木鱼' }, { program: 115, label: '115 陶鼓' },
  { program: 116, label: '116 民族鼓' }, { program: 117, label: '117 合成鼓' }, { program: 118, label: '118 合成镲' }, { program: 119, label: '119 民族打击' },
  { program: 120, label: '120 吉他滑音' }, { program: 121, label: '121 呼吸声' }, { program: 122, label: '122 海浪声' }, { program: 123, label: '123 鸟鸣声' },
  { program: 124, label: '124 电话铃' }, { program: 125, label: '125 直升机' }, { program: 126, label: '126 拍手声' }, { program: 127, label: '127 枪声' },
]

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
  private programSet = new Set<number>()
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
      // adj352：动态加载 spessasynth_lib（大库）——试听时才按需引入
      const { WorkletSynthesizer } = await import('spessasynth_lib')
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
  play(pitch: string | null, atMs: number, durationMs: number, gain: number, instrument?: string): void {
    const synth = this.synth
    if (!pitch || !synth || this.state !== 'ready') return
    const note = pitchToMidiNote(pitch)
    const program = this.voiceOverride ?? instrumentToProgram(instrument)
    const ch = program % 16
    const key = ch * 128 + program
    const velocity = Math.max(1, Math.min(127, Math.round(127 * gain)))
    const onFn = () => {
      if (!this.programSet.has(key)) { synth.programChange(ch, program); this.programSet.add(key) }
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
    this.programSet.clear()
  }
  dispose(): void {
    this.stop()
    this.synth?.disconnect()
    this.synth = null
    if (this.ctx) { void this.ctx.close().catch(() => {}); this.ctx = null }
  }
}
