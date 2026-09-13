/**
 * configDialog.ts — 「⚙ 排版」对话框：改**这一份谱**的设置
 *
 * 与 iJipu 应用的「排版」对话框同构（同一套四组字段，来自 `defs.ts` 的 DEFS），
 * 但保存去向不同：
 *  - **保存到谱面**（主）：用引擎 `writeJpsConfig` 把整份配置写进源码的 `# jps-config` 行
 *    → 该谱自带设置、优先级最高（与 iJipu「保存设置」行为一致，复制到 iJipu 也一模一样）
 *  - **保存为插件默认**（次）：写入插件设置，作为所有未自带设置谱面的全局默认
 *
 * 对话框只改自己这份草稿，取消即丢弃（与 iJipu「关闭未保存则恢复快照」一致）。
 */
import { App, Modal, Setting } from 'obsidian'
import { defaultPageConfig, type PageConfig } from '@ijipu/engine'
import { DEFS, GROUPS, addConfigControl } from './defs'

/** 保存去向：谱面源码（# jps-config，差量） / 谱面源码（全量固化） / 插件设置（全局默认） */
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
          ? '本谱已自带 # jps-config 行：保存会**原位更新**它（优先级最高，覆盖插件设置与 frontmatter）。'
          : '「保存到谱面」会在源码末尾写入 # jps-config 行（优先级最高，此后改插件设置不影响这一份谱）。',
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
        const row = new Setting(contentEl).setName(def.label).setDesc(`frontmatter 键：${def.key}`)
        addConfigControl(row, def, this.draft[def.key], (k, v) => {
          ;(this.draft as unknown as Record<string, unknown>)[k as string] = v
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
      this.draft = { ...defaultPageConfig }
      this.refresh()
    })
    mk('取消', 'ijipu-btn', () => this.close())
    mk('固化全部到谱面', 'ijipu-btn', () => {
      // adj-font（D1）：差量写入是默认（只写与默认不同的字段）；分享/存档需要"到哪都一样"时用全量
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
