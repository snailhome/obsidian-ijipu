/**
 * defs.ts — 设置项定义与控件构建（设置面板 + 谱面「排版」对话框**共用一份**）
 *
 * 拆出来的目的：设置面板（全局默认）与「⚙ 排版」对话框（改这一份谱）必须是同一套字段、
 * 同一套控件，否则两处会漂移（字段名/取值范围/中英文标签不一致）。
 * frontmatter 键的唯一约定仍来自 `frontmatter.ts`（`ijipu_` + 引擎字段名）。
 */
import { Setting } from 'obsidian'
import { defaultPageConfig, type PageConfig } from '@ijipu/engine'
import { frontmatterKey } from './frontmatter'

export type FieldKey = keyof PageConfig
export type FieldValue = PageConfig[FieldKey]

export interface SettingDef {
  key: FieldKey
  label: string
  type: 'select' | 'number' | 'text' | 'toggle'
  options?: { label: string; value: string }[]
  group: string
}

/** 常用字体（值 = CSS font-family，与 iJipu SYS_FONT 一致） */
export const FONTS = [
  { label: '微软雅黑 / PingFang（默认）', value: "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif" },
  { label: '宋体', value: "'SimSun', serif" },
  { label: '黑体', value: "'SimHei', sans-serif" },
  { label: '楷体', value: "'KaiTi', serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
]

export const GROUPS = ['页面', '字体', '行距', '渲染'] as const

/** 四组设置项（继承 iJipu PageConfig 字段），frontmatter 键 = ijipu_<字段名> */
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
  { group: '页面', key: 'body_margin_top', label: '正文上间距', type: 'number' },
  { group: '页面', key: 'descAreaH', label: '描述头区高', type: 'number' },
  { group: '页面', key: 'bar_gap', label: '小节间距', type: 'number' },
  { group: '页面', key: 'align_min_bars', label: '两端对齐最小小节数', type: 'number' },
  { group: '页面', key: 'noteSpaceLayout', label: '音符布局模式', type: 'select', options: [
    { label: '空间优先', value: 'space' },
    { label: '时值优先', value: 'duration' } ] },
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
  { group: '行距', key: 'height_quci', label: '曲-词间距', type: 'number' },
  { group: '行距', key: 'height_cici', label: '词-词间距', type: 'number' },
  { group: '行距', key: 'height_ciqu', label: '曲-曲间距', type: 'number' },
  { group: '行距', key: 'height_ciqu_lyric', label: '曲-上词间距', type: 'number' },
  { group: '行距', key: 'height_shengbu', label: '声部间距', type: 'number' },
  // —— 渲染 ——
  { group: '渲染', key: 'lyricShrink', label: '歌词压缩(避免重叠)', type: 'toggle' },
  { group: '渲染', key: 'showInstrument', label: '显示乐器名', type: 'toggle' },
  { group: '渲染', key: 'lianyinxian_type', label: '连音线样式', type: 'select', options: [
    { label: '自动', value: '0' },
    { label: '圆弧', value: '1' },
    { label: '平顶', value: '2' } ] },
]

export function getDefault(def: SettingDef): FieldValue {
  return defaultPageConfig[def.key]
}

/** 保存回调：把某项写进目标（对话框草稿 / 插件设置） */
export type SaveValue = (key: FieldKey, value: unknown) => void

/**
 * 构建一行设置（设置面板与「排版」对话框共用；做法与 iJipu 的设置项一致）。
 * @param row 已 setName 的 Setting
 * @param def 字段定义
 * @param cur 当前值
 * @param save 值变更回调（数字为空/非法时不回调）
 */
export function addConfigControl(row: Setting, def: SettingDef, cur: FieldValue, save: SaveValue): void {
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
        if (v !== '' && Number.isFinite(n)) save(def.key, n)
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

/** 供界面显示的 frontmatter 键（= ijipu_<字段名>） */
export { frontmatterKey }
