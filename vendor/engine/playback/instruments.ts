/**
 * engine/playback/instruments.ts — 合成乐器预设与路由（adj283）
 *
 * 多声部试听：每个播放事件携带乐器/声部名（PlayEvent.instrument，adj257），
 * 合成后端按名称自动路由到不同「波形 + 泛音 + 包络」预设；UI 也可全局指定一种乐器
 * （auto = 按声部名匹配，匹配失败回退默认钢琴）。
 * 纯数据 + 字符串匹配，无 DOM 依赖，可单测。
 */

/** 合成乐器 id */
export type InstrumentId = 'piano' | 'organ' | 'strings' | 'flute' | 'brass' | 'musicbox'

/** 合成预设：泛音组合 + 包络（时间单位秒） */
export interface InstrumentPreset {
  /** 泛音组合：[倍频, 相对音量, 波形]（基频 1 + 泛音） */
  partials: Array<[number, number, OscillatorType]>
  /** 起音时间（s） */
  attack: number
  /** 持续音色：起音后保持到的相对音量（无则起音后指数衰减——敲击类音色） */
  sustainLevel?: number
  /** sustainLevel 的衰减时间常数（s，越大保持越久） */
  decayTime?: number
}

export const INSTRUMENT_PRESETS: Record<InstrumentId, InstrumentPreset> = {
  // 钢琴：三角波基频 + 2 正弦泛音，快起音、起音后指数衰减（琴弦感）
  piano: { partials: [[1, 1, 'triangle'], [2, 0.5, 'sine'], [3, 0.25, 'sine']], attack: 0.012 },
  // 风琴：锯齿基频 + 正弦叠加，起音后持续（管风琴音栓感）
  organ: { partials: [[1, 1, 'sawtooth'], [1, 0.7, 'sine'], [2, 0.3, 'sine']], attack: 0.02, sustainLevel: 0.85, decayTime: 0.05 },
  // 弦乐：锯齿基频 + 泛音，慢起音、持续（弓弦感）
  strings: { partials: [[1, 1, 'sawtooth'], [2, 0.35, 'sine'], [3, 0.15, 'sine']], attack: 0.08, sustainLevel: 0.7, decayTime: 0.08 },
  // 长笛：正弦为主 + 轻泛音，平滑起音、持续（气息感）
  flute: { partials: [[1, 1, 'sine'], [2, 0.2, 'sine'], [4, 0.06, 'sine']], attack: 0.05, sustainLevel: 0.8, decayTime: 0.06 },
  // 铜管：方波基频 + 锯齿/正弦泛音，快起音、持续（号角感）
  brass: { partials: [[1, 1, 'square'], [2, 0.4, 'sawtooth'], [3, 0.2, 'sine']], attack: 0.03, sustainLevel: 0.6, decayTime: 0.06 },
  // 八音盒：正弦 + 高泛音，极快起音、指数衰减（清脆）
  musicbox: { partials: [[1, 1, 'sine'], [4, 0.25, 'sine'], [8, 0.08, 'sine']], attack: 0.005 },
}

/** 乐器选择项（UI 下拉）：auto = 按声部名自动路由；sampler = 采样后端 */
export const INSTRUMENT_OPTIONS: { id: InstrumentId | 'auto' | 'sampler'; label: string }[] = [
  { id: 'auto', label: '自动（按声部名）' },
  { id: 'piano', label: '钢琴' },
  { id: 'organ', label: '风琴' },
  { id: 'strings', label: '弦乐' },
  { id: 'flute', label: '长笛' },
  { id: 'brass', label: '铜管' },
  { id: 'musicbox', label: '八音盒' },
  { id: 'sampler', label: '采样（钢琴）' },
]

/** 名称关键词表：声部名/乐器名包含任一关键词即路由到该预设（中文优先，含常见英文） */
const INSTRUMENT_KEYWORDS: Record<InstrumentId, string[]> = {
  piano: ['钢琴', 'piano', 'pf'],
  organ: ['风琴', '手风琴', 'organ', 'harmonium', 'accordion'],
  strings: ['弦乐', '提琴', '二胡', 'strings', 'violin', 'viola', 'cello', '胡'],
  flute: ['长笛', '短笛', '笛', 'flute', 'piccolo', '箫'],
  brass: ['铜管', '小号', '圆号', '长号', '大号', '萨克斯', 'trumpet', 'brass', 'horn', 'trombone', 'sax'],
  musicbox: ['八音盒', '钟琴', '钢片琴', 'musicbox', 'music box', 'glockenspiel', '铃'],
}

/** adj301：试听音色库名（与 INSTRUMENT_OPTIONS 合成乐器一致）——乐器指定（Y 默认 / @ 切换）用 */
export const INSTRUMENT_LIB_NAMES: Record<InstrumentId, string> = {
  piano: '钢琴',
  organ: '风琴',
  strings: '弦乐',
  flute: '长笛',
  brass: '铜管',
  musicbox: '八音盒',
}

/** 声部名/乐器名 → 乐器 id（匹配失败回退默认钢琴） */
export function matchInstrument(name: string | undefined): InstrumentId {
  if (!name) return 'piano'
  const n = name.toLowerCase()
  for (const [id, kws] of Object.entries(INSTRUMENT_KEYWORDS) as [InstrumentId, string[]][]) {
    if (kws.some((kw) => n.includes(kw))) return id
  }
  return 'piano'
}

/**
 * adj301：乐器指定（@乐器名 / 描述头 Y）→ 乐器 id。
 * 严格按试听音色库名匹配（钢琴/风琴/弦乐/长笛/铜管/八音盒），不匹配回退默认第一个（钢琴）。
 * 与 matchInstrument（模糊关键词，声部名路由）不同——这是用户显式指定的乐器，需名称一致。
 */
export function resolveInstrument(name: string | undefined): InstrumentId {
  if (!name) return 'piano'
  const n = name.trim()
  for (const [id, lib] of Object.entries(INSTRUMENT_LIB_NAMES) as [InstrumentId, string][]) {
    if (n === lib || n.toLowerCase() === id) return id
  }
  return 'piano'
}
