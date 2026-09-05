/**
 * engine/playback/libraries.ts — 采样音色库元数据（adj323）
 *
 * 采样音色库 = 一种乐器的采样包（midi-js-soundfonts，MusyngKite 集合）。
 * 每个库有独立 id / 名称 / 来源 URL / 体积估计 / 音符范围，
 * 供试听对话框「音色库」下拉选择与离线缓存决策（缓存目录/键用 id）。
 * 纯数据，零 DOM 依赖，可单测。
 */

/** 采样音色库 */
export interface SamplerLibrary {
  /** 稳定 id（缓存目录名 / 持久化键用） */
  id: string
  /** 面向用户的中文名 */
  name: string
  /** 采样包来源 URL（midi-js-soundfonts MusyngKite *-mp3.js） */
  source: string
  /** 体积（字节，估算值，仅用于 UI 展示缓存上下限） */
  sizeBytes: number
  /** 音符范围（简谱音名，code 解码音域控制，避免全量解码占内存） */
  noteRange: [string, string]
}

const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/'
const sf = (name: string) => `${SF_BASE}${name}-mp3.js`

/** 可用的采样音色库（第一个为默认）。URL 为 GM 标准乐器名，MusyngKite 集合均含。 */
export const SAMPLER_LIBRARIES: SamplerLibrary[] = [
  { id: 'grand_piano', name: '三角钢琴', source: sf('acoustic_grand_piano'), sizeBytes: 2_400_000, noteRange: ['C2', 'C6'] },
  { id: 'bright_piano', name: '明亮钢琴', source: sf('bright_acoustic_piano'), sizeBytes: 2_300_000, noteRange: ['C2', 'C6'] },
  { id: 'violin', name: '小提琴', source: sf('violin'), sizeBytes: 2_800_000, noteRange: ['C3', 'C6'] },
  { id: 'strings', name: '弦乐组', source: sf('string_ensemble_1'), sizeBytes: 2_800_000, noteRange: ['C2', 'C6'] },
  { id: 'cello', name: '大提琴', source: sf('cello'), sizeBytes: 2_600_000, noteRange: ['C2', 'C5'] },
  { id: 'flute', name: '长笛', source: sf('flute'), sizeBytes: 2_200_000, noteRange: ['C3', 'C6'] },
  { id: 'pan_flute', name: '排箫', source: sf('pan_flute'), sizeBytes: 2_400_000, noteRange: ['C3', 'C6'] },
  { id: 'trumpet', name: '小号', source: sf('trumpet'), sizeBytes: 2_400_000, noteRange: ['C3', 'C6'] },
  { id: 'clarinet', name: '单簧管', source: sf('clarinet'), sizeBytes: 2_400_000, noteRange: ['C3', 'C6'] },
]

/** 按 id 查采样库（找不到回退默认第一个——保证「音色库」下拉必有可选库） */
export function getSamplerLibrary(id?: string | null): SamplerLibrary {
  if (id) {
    const found = SAMPLER_LIBRARIES.find((l) => l.id === id)
    if (found) return found
  }
  return SAMPLER_LIBRARIES[0]
}
