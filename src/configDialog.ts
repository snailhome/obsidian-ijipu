/**
 * configDialog.ts — 「⚙ 排版」对话框：改**这一份谱**的设置
 *
 * 与 iJipu 应用的「排版」对话框同构（同一套四组字段，来自 `defs.ts` 的 DEFS），
 * 但保存去向更多：
 *  - **保存到谱面**（主）：用引擎 `mergeConfigEdits` + `writeJpsConfig` 把**本次改动**写进源码
 *    `# jps-config` 行（adj480 起与应用同口径：插件设置 / frontmatter 带来的值不会被顺手烧进谱面）
 *  - **随谱固化**（分享/存档）：把**与引擎默认不同的全部生效项**写进谱面 ⇒ 这份谱自包含，
 *    复制给别人（或只复制代码块到 iJipu 应用）显示一致
 *  - **保存为插件默认**（次）：写入插件设置，作为所有未自带设置谱面的本库全局默认
 *
 * 对话框只改自己这份草稿，取消即丢弃（与 iJipu「关闭未保存则恢复快照」一致）。
 */
import { App, Modal, Setting } from 'obsidian'
import { defaultConfigForReset, type PageConfig } from '@ijipu/engine'
import { DEFS, GROUPS, addConfigControl, readDef, writeDef } from './defs'

/** 保存去向：谱面源码（# jps-config，只写本次改动） / 谱面源码（随谱固化 = 非默认项全量） / 插件设置（本库全局默认） */
export type ConfigTarget = 'score' | 'score-full' | 'plugin'

export interface ConfigDialogOptions {
  /** 当前生效配置（默认 < 插件设置 < frontmatter < 源内）——对话框的初值 */
  current: PageConfig
  /** 谱面源码 `# jps-config` 行里显式写了的字段（优先级最高） */
  sourceFields: string[]
  /** 与 `sourceFields` 对应的取值（用于列表展示） */
  sourceValues: Record<string, unknown>
  /** 关闭后回调（点「取消」不触发） */
  onApply: (target: ConfigTarget, config: PageConfig) => void
}

export class ConfigDialog extends Modal {
  private draft: PageConfig

  constructor(
    app: App,
    private opts: ConfigDialogOptions,
  ) {
    super(app)
    this.draft = { ...opts.current }
  }

  onOpen(): void {
    const { contentEl, titleEl, modalEl } = this
    modalEl.addClass('ijipu-config-modal')
    titleEl.setText('排版设置（这一份谱）')

    const hint = contentEl.createDiv({ cls: 'ijipu-config-hint' })
    hint.createDiv({ text: '优先级：引擎默认 < 插件设置 < 笔记 frontmatter < 谱面自带 # jps-config' })
    hint.createDiv({
      cls: 'ijipu-config-hint-sub',
      text:
        this.opts.sourceFields.length > 0
          ? '本谱已自带 # jps-config 行：「保存到谱面」只更新**本次改动**（原位更新，优先级最高）；要把插件设置 / frontmatter 的差异也写进去（分享给他人显示一致）用「随谱固化」。'
          : '「保存到谱面」只会写入**本次改动**（不把插件设置 / frontmatter 顺手烧进谱面）；要把当前生效的全部非默认项写进谱面（复制给他人也一模一样）用「随谱固化」。',
    })

    // 「谱面自带设置 N 项」——原先挂在谱面工具栏上（挤占按钮位置、详情只能悬停看），
    // 移到对话框里：既能一眼看到哪几项、值是多少，也正好解释下面控件的初值从哪来。
    if (this.opts.sourceFields.length > 0) {
      const box = contentEl.createDiv({ cls: 'ijipu-config-src' })
      box.createDiv({
        cls: 'ijipu-config-src-head',
        text: `谱面自带设置 ${this.opts.sourceFields.length} 项（来自源码 # jps-config 行，优先级最高）`,
      })
      const list = box.createEl('ul', { cls: 'ijipu-config-src-list' })
      for (const key of this.opts.sourceFields) {
        const def = DEFS.find((d) => (d.key as string) === key)
        const value = this.opts.sourceValues[key]
        list.createEl('li', { text: `${def ? def.label : key}：${value === undefined ? '—' : String(value)}` })
      }
    }

    for (const group of GROUPS) {
      const items = DEFS.filter((d) => d.group === group)
      if (items.length === 0) continue
      new Setting(contentEl).setName(group).setHeading()
      for (const def of items) {
        // adj629q：嵌套字段（`segmentRowGap.bz` 等）按子项取值/写值，同一字段的其它子项保留
        const row = new Setting(contentEl)
          .setName(def.label)
          .setDesc(def.sub ? `frontmatter 键：${def.key}（子项 ${def.sub}）` : `frontmatter 键：${def.key}`)
        addConfigControl(row, def, readDef(this.draft, def), (_k, v) => {
          writeDef(this.draft, def, v)
        })
      }
    }

    const footer = contentEl.createDiv({ cls: 'ijipu-config-footer' })
    const mk = (text: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = footer.createEl('button', { text, cls })
      b.addEventListener('click', fn)
      return b
    }
    mk('恢复默认', 'ijipu-btn', () => {
      // adj629s：用引擎的 `defaultConfigForReset()`（默认值 + **移除可选字段**）——
      // 直接 `{ ...defaultPageConfig }` 会把 `metaPos`/`heights`/`segmentRowGap` 等可选字段留在草稿里，
      // 保存时它们又算"与默认不同" ⇒ 点了恢复默认仍会往 `# jps-config` 写一条（用户报）。
      this.draft = { ...defaultConfigForReset() }
      this.refresh()
    })
    mk('取消', 'ijipu-btn', () => this.close())
    mk('随谱固化（分享用）', 'ijipu-btn', () => {
      // adj480：把"与引擎默认不同的全部生效项"写进谱面（差量模式 + 生效配置）——
      // 只多写真正影响外观的项，既保真又不把与默认相同的项钉进文件。
      const cfg = this.draft
      this.close()
      this.opts.onApply('score-full', cfg)
    })
    mk('保存为插件默认', 'ijipu-btn', () => {
      const cfg = this.draft
      this.close()
      this.opts.onApply('plugin', cfg)
    })
    mk('保存到谱面', 'ijipu-btn mod-cta', () => {
      // adj480：只写本次改动（基线 = 打开时的生效配置）
      const cfg = this.draft
      this.close()
      this.opts.onApply('score', cfg)
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }

  /** 恢复默认后重画（草稿已换，控件需按新值重建） */
  private refresh(): void {
    this.contentEl.empty()
    this.onOpen()
  }
}
