import { App, PluginSettingTab, Setting } from 'obsidian'
import { defaultPageConfig, type PageConfig } from '@ijipu/engine'
import type IJipuPlugin from './main'

type FieldKey = keyof PageConfig
type FieldValue = PageConfig[FieldKey]

interface SettingDef {
  key: FieldKey
  label: string
  type: 'select' | 'number' | 'text' | 'toggle'
  options?: { label: string; value: string }[]
  group: string
}

/** 常用字体（值 = CSS font-family，与 iJipu SYS_FONT 一致） */
const FONTS = [
  { label: '微软雅黑 / PingFang（默认）', value: "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif" },
  { label: '宋体', value: "'SimSun', serif" },
  { label: '黑体', value: "'SimHei', sans-serif" },
  { label: '楷体', value: "'KaiTi', serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
]

const GROUPS = ['页面', '字体', '行距', '渲染'] as const

/** 四组设置项（继承 iJipu PageConfig 字段），frontmatter 键 = ijipu_<字段名> */
const DEFS: SettingDef[] = [
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

export function frontmatterKey(key: FieldKey): string {
  return `ijipu_${key}`
}

function getDefault(def: SettingDef): FieldValue {
  return defaultPageConfig[def.key]
}

export class IJipuSettingTab extends PluginSettingTab {
  plugin: IJipuPlugin

  constructor(app: App, plugin: IJipuPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // 插件头部：标题 + 说明 + 链接
    const head = containerEl.createDiv({ cls: 'ijipu-settings-header' })
    head.createEl('h2', { text: 'iJipu 爱记谱' })
    head.createEl('p', {
      text: '在 Obsidian 笔记中用 ```jps 代码块把 .jps 简谱脚本渲染为可视化简谱，支持试听（播放时色块跟进音符）与「整页 / 满宽 / 谱面」三种显示模式；设置项与 iJipu 应用一脉传承（页面 / 字体 / 行距 / 渲染），并可用笔记 frontmatter（ijipu_* 前缀）覆盖。',
    })
    const a1 = head.createEl('a', { text: 'iJipu 官网' })
    a1.setAttr('href', 'https://ijipu.pages.dev')
    a1.setAttr('target', '_blank')
    head.createEl('span', { text: ' · ' })
    const a2 = head.createEl('a', { text: '脚本规则说明' })
    a2.setAttr('href', 'https://ijipu.pages.dev/doc/jps-spec.html')
    a2.setAttr('target', '_blank')
    head.createEl('div')

    for (const group of GROUPS) {
      const items = DEFS.filter((d) => d.group === group)
      if (items.length === 0) continue
      new Setting(containerEl).setName(group).setHeading()
      for (const def of items) {
        const cur = this.plugin.settings[def.key] ?? getDefault(def)
        const row = new Setting(containerEl)
          .setName(def.label)
          .setDesc(`frontmatter 键：${frontmatterKey(def.key)}`)
        this.addControl(row, def, cur)
      }
    }
  }

  private addControl(row: Setting, def: SettingDef, cur: FieldValue): void {
    const save = (v: unknown) => {
      ;(this.plugin.settings as Record<string, unknown>)[def.key as string] = v
      void this.plugin.saveSettings()
    }
    if (def.type === 'select') {
      row.addDropdown((dd) => {
        def.options!.forEach((o) => dd.addOption(o.value, o.label))
        dd.setValue(String(cur)).onChange((v) => save(def.key === 'lianyinxian_type' ? Number(v) : v))
      })
    } else if (def.type === 'toggle') {
      row.addToggle((t) => t.setValue(Boolean(cur)).onChange((v) => save(v)))
    } else if (def.type === 'number') {
      row.addText((t) => {
        t.setValue(String(cur ?? ''))
        t.onChange((v) => {
          const n = Number(v)
          if (v !== '' && Number.isFinite(n)) save(n)
        })
      })
    } else {
      // text（字体 font-family）
      row.addText((t) => {
        t.setValue(String(cur))
        t.onChange((v) => save(v))
      })
    }
  }
}
