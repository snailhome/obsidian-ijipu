/**
 * engine/dynamic/presets.ts — 动态谱画布预设（9:16 / 1:1 / 16:9）
 *
 * 这里解决一件事：**视频用多大画布、配多大的字**。
 *
 * ## 为什么不是"拿 A4 放大"
 *
 * A4 是 595×842 的纸，一行能塞 4–6 小节、一页 8–10 行。视频要的是「手机上看得清」：
 * 一行 2–4 小节、字号大一倍多。行宽变了，**断行位置就变了**——所以必须让排版按 1080 宽重排，
 * 不能把 A4 的图放大（那样字会挤成一片）。
 *
 * ## 为什么这些预设不写进 `.jps`
 *
 * 它们只服务出片/预览，是一次性计算（L3 会话级）。用户自己的谱面配置（L2）**绝不能**被改写——
 * 见 `docs/DYNAMIC-SCORE-PLAN.md` §七 与 AGENTS 七（`adj480` 的口径）。
 * 调用方拿 `dynamicPageConfig()` 的返回值去 `layoutScore`，**不要** `setPageConfig`。
 *
 * ## 单位
 *
 * `PAPER_SIZE` 里 A4 是 pt，而这三个预设是**像素**（1080×1920 就是 1080 像素宽）。
 * 渲染时按 `scale = 1` 出来就是目标分辨率；要 2 倍图就 `scale = 2`。
 */
import { defaultPageConfig, type PageConfig } from '../types'

/** 预设 id（也是对外暴露的口子，视频参数面板用它） */
export type DynamicPresetId = '9x16' | '1x1' | '16x9'

export interface DynamicPreset {
  id: DynamicPresetId
  /** 给界面看的名字 */
  label: string
  /** 对应 `PageConfig.page`（`PAPER_SIZE` 里的键） */
  page: PageConfig['page']
  width: number
  height: number
  /** 音符字号（px）——竖屏下 56 是"隔着手机也能看清"的量级 */
  noteSize: number
  /** 左右边距 */
  marginX: number
  /**
   * 底部安全区占比（抖音/小红书底部有作者、点赞、评论一排 UI）。
   * 排版把 `margin_bottom` 撑到这么高 ⇒ 谱面墨迹天然不会挤进被遮住的那一条。
   */
  safeBottomPct: number
  /** 右侧安全区占比（点赞/评论竖排图标），只在竖屏有意义 */
  safeRightPct: number
}

/**
 * 三个预设的数值口径：
 *  - 9:16 —— 抖音/小红书竖屏，字号最大、边距最阔，上下各留安全区；
 *  - 1:1  —— 正方形，微信/朋友圈与部分平台的方形封面；
 *  - 16:9 —— 横屏，B站/视频号/投影，一行能多放两小节。
 */
export const DYNAMIC_PRESETS: Record<DynamicPresetId, DynamicPreset> = {
  '9x16': {
    id: '9x16',
    label: '竖屏 9:16（抖音 / 小红书）',
    page: 'DYN_9x16',
    width: 1080,
    height: 1920,
    noteSize: 56,
    marginX: 56,
    safeBottomPct: 0.15,
    safeRightPct: 0.1,
  },
  '1x1': {
    id: '1x1',
    label: '正方形 1:1',
    page: 'DYN_1x1',
    width: 1080,
    height: 1080,
    noteSize: 48,
    marginX: 56,
    safeBottomPct: 0.06,
    safeRightPct: 0.04,
  },
  '16x9': {
    id: '16x9',
    label: '横屏 16:9',
    page: 'DYN_16x9',
    width: 1920,
    height: 1080,
    noteSize: 40,
    marginX: 72,
    safeBottomPct: 0.04,
    safeRightPct: 0.02,
  },
}

/** 默认预设（视频第一版固定竖屏） */
export const DEFAULT_DYNAMIC_PRESET: DynamicPresetId = '9x16'

/**
 * 预设 → 一份**只用于本次出片/预览**的 `PageConfig`。
 *
 * 只覆盖与"画布大小、字号、留白"有关的字段；字体、配色、小节序号等一律沿用 `base`
 * （默认 `defaultPageConfig`，即"用户什么都没配"的那份）。
 *
 * @param id   预设
 * @param base 基准配置（视频预览可直接传当前编辑器配置，让字体/主题跟用户看到的一致）
 */
export function dynamicPageConfig(id: DynamicPresetId, base: PageConfig = defaultPageConfig): PageConfig {
  const p = DYNAMIC_PRESETS[id]
  const s = p.noteSize / 18 // 相对默认字号的比例，用来等比放大行距/字号（18 是默认 note_size）
  const bottom = Math.round(p.height * p.safeBottomPct)
  const right = Math.round(p.width * p.safeRightPct)
  return {
    ...base,
    page: p.page,
    margin_left: p.marginX,
    margin_right: Math.max(p.marginX, right),
    margin_top: Math.round(48 * Math.max(1, s * 0.6)),
    margin_bottom: Math.max(Math.round(48 * Math.max(1, s * 0.6)), bottom),
    body_margin_top: Math.round(20 * s),
    descAreaH: Math.round(80 * s),
    biaoti_size: Math.round(20 * s * 1.6),
    fubiaoti_size: Math.round(15 * s * 1.4),
    miaoshu_size: Math.round(13 * s * 1.5),
    notes_size: Math.round(12 * s * 1.4),
    geci_size: Math.round(11 * s * 2.2),
    note_size: p.noteSize,
    height_quci: Math.round(24 * s),
    height_cici: Math.round(20 * s),
    height_ciqu: Math.round(30 * s),
    height_ciqu_lyric: Math.round(30 * s),
    height_shengbu: Math.round(14 * s),
    bar_gap: Math.round(8 * s),
  }
}
