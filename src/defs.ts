/**
 * defs.ts — 设置项定义与控件构建（设置面板 + 谱面「排版」对话框**共用一份**）
 *
 * 拆出来的目的：设置面板（全局默认）与「⚙ 排版」对话框（改这一份谱）必须是同一套字段、
 * 同一套控件，否则两处会漂移（字段名/取值范围/中英文标签不一致）。
 * 字段名就是**引擎 `PageConfig` 的字段名** —— 它同时是写进谱面 `# jps-config:{…}` 的键名
 * （adj738 起不再有 `ijipu_` 前缀的 frontmatter 键：笔记 frontmatter 那一层已删除）。
 *
 * adj629q（用户要求「插件的默认设置与随谱携带项设置应与应用的设置一致」）：
 *  · **字段集与标签**对齐 iJipu 应用「布局 / 字体」两个页签（`PageConfigDialog.tsx` 的 `TAB_CONFIG_KEYS`
 *    与各 `Row label=`）：应用不暴露的字段（如 `bar_gap`）插件设置面板也不再给控件
 *    （它仍在 `PAGE_CONFIG_FIELDS` 里，谱面 `# jps-config` 照旧可携带）；
 *  · **取值范围**取自引擎 `GUIDE_LIMITS` / `GUIDE_LIMITS_EX`（见 `numRanges.ts`，与应用同一份表），
 *    输入越界即钳制——此前插件不钳制，同一字段两处能填出不同范围；
 *  · **默认值**一律来自引擎（`defaultPageConfig` / `SEGMENT_ROW_GAP_DEFAULT`），插件不另立默认。
 */
import { Setting } from 'obsidian'
import { defaultPageConfig, SCORE_FONT_OPTIONS, SEGMENT_ROW_GAP_DEFAULT, configValuesEqual, isDefaultConfigValue, type PageConfig } from '@ijipu/engine'
import { clampNum, rangeOf } from './numRanges'

export type FieldKey = keyof PageConfig
export type FieldValue = PageConfig[FieldKey]

export interface SettingDef {
  key: FieldKey
  /** 嵌套字段的子项名（如 `segmentRowGap` 的 `bz`/`dsb`/`tp`）——无则整字段 */
  sub?: string
  label: string
  type: 'select' | 'number' | 'text' | 'toggle'
  options?: { label: string; value: string }[]
  group: string
}

/** 谱面字体候选（adj-font：由引擎统一提供——每项都是含通用族的完整栈，跨机尽量有且保证有 fallback） */
export const FONTS = SCORE_FONT_OPTIONS

export const GROUPS = ['页面', '字体', '行距', '渲染'] as const

/**
 * 四组设置项（继承 iJipu PageConfig 字段），frontmatter 键 = ijipu_<字段名>。
 * 标签与应用「布局 / 字体」页签逐项对齐（改文案时两处一起改）。
 */
export const DEFS: SettingDef[] = [
  // —— 页面 ——
  { group: '页面', key: 'page', label: '纸张', type: 'select', options: [
    { label: 'A4', value: 'A4' },
    { label: 'A5', value: 'A5' },
    { label: 'A4 横向', value: 'A4_horizontal' },
    { label: 'A5 横向', value: 'A5_horizontal' } ] },
  { group: '页面', key: 'margin_top', label: '上边距', type: 'number' },
  { group: '页面', key: 'margin_bottom', label: '下边距', type: 'number' },
  { group: '页面', key: 'margin_left', label: '左边距', type: 'number' },
  { group: '页面', key: 'margin_right', label: '右边距', type: 'number' },
  { group: '页面', key: 'body_margin_top', label: '首行至描述头间距', type: 'number' },
  { group: '页面', key: 'descAreaH', label: '描述头高', type: 'number' },
  { group: '页面', key: 'align_min_bars', label: '两端对齐最小小节数', type: 'number' },
  { group: '页面', key: 'noteSpaceLayout', label: '布局模式', type: 'select', options: [
    { label: '空间优先', value: 'space' },
    { label: '时值优先', value: 'duration' } ] },
  // adj625（同步主项目）：方框小节序号——开关 + 每隔几个小节显示一个（1~99，默认 4）
  { group: '页面', key: 'showBarCount', label: '显示小节计数', type: 'toggle' },
  { group: '页面', key: 'barCountInterval', label: '序号间隔', type: 'number' },
  // —— 字体 ——
  { group: '字体', key: 'biaoti_font', label: '标题字体', type: 'select', options: FONTS },
  { group: '字体', key: 'biaoti_size', label: '标题字号', type: 'number' },
  { group: '字体', key: 'fubiaoti_font', label: '副标题字体', type: 'select', options: FONTS },
  { group: '字体', key: 'fubiaoti_size', label: '副标题字号', type: 'number' },
  { group: '字体', key: 'miaoshu_font', label: '描述头字体', type: 'select', options: FONTS },
  { group: '字体', key: 'miaoshu_size', label: '描述头字号', type: 'number' },
  { group: '字体', key: 'notes_font', label: '说明文字字体', type: 'select', options: FONTS },
  { group: '字体', key: 'notes_size', label: '说明文字字号', type: 'number' },
  { group: '字体', key: 'geci_font', label: '歌词字体', type: 'select', options: FONTS },
  { group: '字体', key: 'geci_size', label: '歌词字号', type: 'number' },
  { group: '字体', key: 'note_size', label: '音符字号', type: 'number' },
  { group: '字体', key: 'shuzi_font', label: '音符(数字)字体', type: 'select', options: FONTS },
  // —— 行距 ——
  { group: '行距', key: 'height_quci', label: '曲部与词部间距', type: 'number' },
  { group: '行距', key: 'height_cici', label: '词部与词部间距', type: 'number' },
  { group: '行距', key: 'height_ciqu', label: '曲部与曲部间距', type: 'number' },
  { group: '行距', key: 'height_ciqu_lyric', label: '曲部与上词部间距', type: 'number' },
  { group: '行距', key: 'height_shengbu', label: '声部间距', type: 'number' },
  // adj629e/adj629q（同步主项目「布局 → 临时段」三行）：临时叠加段与主旋律 / 歌词行的纵向间距。
  // 默认值取引擎 `SEGMENT_ROW_GAP_DEFAULT`（bz/dsb 22、tp 14），范围取引擎 `GUIDE_LIMITS_EX`。
  { group: '行距', key: 'segmentRowGap', sub: 'bz', label: 'bz 段上下间距', type: 'number' },
  { group: '行距', key: 'segmentRowGap', sub: 'dsb', label: 'dsb 段上下间距', type: 'number' },
  { group: '行距', key: 'segmentRowGap', sub: 'tp', label: '替谱行与下方歌词间距', type: 'number' },
  // —— 渲染 ——
  { group: '渲染', key: 'lyricShrink', label: '歌词压缩', type: 'toggle' },
  { group: '渲染', key: 'showInstrument', label: '乐器显示', type: 'toggle' },
  { group: '渲染', key: 'lianyinxian_type', label: '连音线样式', type: 'select', options: [
    { label: '自动', value: '0' },
    { label: '圆弧', value: '1' },
    { label: '平顶', value: '2' } ] },
]

/** 读某项当前值（含嵌套子项）：`segmentRowGap.bz` 这种取子项，其余整字段 */
export function readDef(settings: Partial<PageConfig>, def: SettingDef): unknown {
  const v = settings[def.key] as unknown
  if (!def.sub) return v
  return v && typeof v === 'object' ? (v as Record<string, unknown>)[def.sub] : undefined
}

/** 写某项（含嵌套子项）：只改动子项，同一对象的其它子项保留 */
export function writeDef(target: Partial<PageConfig>, def: SettingDef, value: unknown): void {
  if (!def.sub) {
    ;(target as unknown as Record<string, unknown>)[def.key as string] = value
    return
  }
  const cur = (target as unknown as Record<string, unknown>)[def.key as string]
  const base = cur && typeof cur === 'object' ? { ...(cur as Record<string, unknown>) } : {}
  base[def.sub] = value
  ;(target as unknown as Record<string, unknown>)[def.key as string] = base
}

/** 默认值一律来自引擎（与应用同一份）：嵌套子项取 `SEGMENT_ROW_GAP_DEFAULT`，其余取 `defaultPageConfig` */
export function getDefault(def: SettingDef): FieldValue | number | undefined {
  if (def.key === 'segmentRowGap' && def.sub) {
    return (SEGMENT_ROW_GAP_DEFAULT as Record<string, number>)[def.sub]
  }
  return defaultPageConfig[def.key]
}

/** 保存回调：把某项写进目标（对话框草稿 / 插件设置） */
export type SaveValue = (key: FieldKey, value: unknown) => void

/**
 * 构建一行设置（设置面板与「排版」对话框共用；做法与 iJipu 的设置项一致）。
 * 数值项越界即按引擎范围钳制（与应用 `NumInput` 同口径，见 `numRanges.ts`）。
 * @param row 已 setName 的 Setting
 * @param def 字段定义
 * @param cur 当前值
 * @param save 值变更回调（数字为空/非法时不回调）
 */
export function addConfigControl(row: Setting, def: SettingDef, cur: unknown, save: SaveValue): void {
  if (def.type === 'select') {
    row.addDropdown((dd) => {
      def.options!.forEach((o) => dd.addOption(o.value, o.label))
      dd.setValue(String(cur)).onChange((v) => save(def.key, def.key === 'lianyinxian_type' ? Number(v) : v))
    })
  } else if (def.type === 'toggle') {
    row.addToggle((t) => t.setValue(Boolean(cur)).onChange((v) => save(def.key, v)))
  } else if (def.type === 'number') {
    row.addText((t) => {
      t.setValue(String(cur ?? ''))
      t.onChange((v) => {
        const n = Number(v)
        if (v !== '' && Number.isFinite(n)) save(def.key, clampNum(def.key as string, def.sub, n))
      })
    })
  } else {
    // text（字体 font-family）
    row.addText((t) => {
      t.setValue(String(cur))
      t.onChange((v) => save(def.key, v))
    })
  }
}

/** 该字段是否有硬范围（供冒烟/界面提示用） */
export const hasRange = (def: SettingDef): boolean => rangeOf(def.key as string, def.sub) !== undefined

/**
 * adj766（清单 B8）：值等价 / "是否等于默认" 的**规则**已下沉引擎（`configValuesEqual` /
 * `isDefaultConfigValue`）—— 应用与本插件共用一份，免得"应用认为该项是默认、插件认为不是"
 * 从而多写一条 `# jps-config`。这里只保留**界面字段到引擎值的映射**（`getDefault`/`readDef`），
 * 那属于宿主界面层。
 */
export const sameConfigValue = configValuesEqual

/**
 * adj631（用户报告："预览页面的设置与 设置-iJipu 里的设置项不同步"）：
 * **两个配置之间被改动过的字段**（`before` = 打开对话框那一刻的生效配置，`after` = 用户改完的草稿）。
 *
 * 为什么要它：「保存为插件默认」此前把**整份草稿**写进插件设置，而草稿的初值是"这份谱的**生效值**"
 * （含源码 `# jps-config`）⇒ 点一下就把**本谱专属的值**变成了**全库默认**：
 * 「设置 → iJipu」随即显示出一堆你从没在那里设过的值，别的笔记观感也跟着变（用户看到的就是"两边不同步"）。
 * 现在只写**真正动过的项**——与 iJipu 应用"只固化用户改动"（`mergeConfigEdits`）同一口径。
 */
export function changedDefs(before: Partial<PageConfig>, after: Partial<PageConfig>): SettingDef[] {
  const b = before as unknown as Record<string, unknown>
  const a = after as unknown as Record<string, unknown>
  return DEFS.filter((def) => !configValuesEqual(readDef(a as never, def), readDef(b as never, def)))
}

/**
 * 某项的值是否**等于引擎默认**（等于就不必存进插件设置——稀疏存储让"跟随引擎默认"保持显式）。
 * 可选字段（`showInstrument`/`lyricShrink`）的默认是"未设置"，`false`/`undefined` 都算默认（与 E-2026-294 同口径）。
 * adj766：规则在引擎（`isDefaultConfigValue`），这里只把界面字段的默认值取出来传进去。
 */
export function isDefaultValue(def: SettingDef, value: unknown): boolean {
  return isDefaultConfigValue(getDefault(def), value)
}

// adj738：原来这里转出 `frontmatterKey`（`ijipu_<字段名>`）供界面显示；
// 笔记 frontmatter 那一层已删除 ⇒ 字段名本身就是谱面 `# jps-config` 的键名，不需要再拼前缀。

