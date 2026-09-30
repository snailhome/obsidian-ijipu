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
 *
 * 用户要求（本轮，插件侧 UI）：
 *  ① 字段组改成**页签**（页面 / 字体 / 行距 / 渲染）——与「设置 → iJipu」的多页签同款，
 *     一屏只看一组、少滚动；
 *  ② 原先挂在**预览工具条**上的「未随谱携带 N 项」挪到这里，紧跟「谱面自带设置 N 项」那块展示
 *     （工具条只留可点的按钮，提示统一进对话框）。
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
  /**
   * 用户要求：**未随谱携带**的项（源码里没写、值只来自**笔记 frontmatter**）——
   * 引擎 `configCarryover(code, effective, baseline).missing` 的原样透传；空数组 = 已随谱携带。
   *
   * adj639（用户要求"插件的默认值体系与应用保持一致，在应用正常的谱面在插件里不要提示"）：
   * 传了 `baseline`（代码默认 ← 插件设置）之后，**插件设置里的值不再算"未随谱携带"**——
   * 那些值在用户眼里就是"本库默认值"，等价于应用里的代码默认值；提示只剩这篇笔记特有的差异。
   */
  carryover: { key: string; value: unknown }[]
  /** 关闭后回调（点「取消」不触发） */
  onApply: (target: ConfigTarget, config: PageConfig) => void
}

export class ConfigDialog extends Modal {
  private draft: PageConfig
  /** 页签：四组字段各一页 + 一页「说明」（与「设置 → iJipu」的多页签同款） */
  private readonly tabs = [...GROUPS, '说明'] as const
  /** 当前页签（会话内保持：切页签 / 恢复默认重画后都停在同一页） */
  private activeTab: (typeof this.tabs)[number] = GROUPS[0]

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
    // adj631（用户报"预览页面的设置与 设置-iJipu 里的设置项不同步"）：这里显示的是**这一份谱的生效值**，
    // 与「设置 → iJipu」的**本库全局默认**口径不同 ⇒ 值可以不一样（本谱有 frontmatter / 源内设置时尤其明显）。
    hint.createDiv({
      cls: 'ijipu-config-hint-sub',
      text: '下面显示的是**这一份谱的生效值**（含笔记 frontmatter 与源内 `# jps-config`），与「设置 → iJipu」里的**本库全局默认**不是同一层——两者值不同是正常的。',
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

    // adj480（用户要求：从预览工具条挪到这里、紧跟上面那块）：**分享保真提示**——
    // 本谱有"非默认值来自**笔记 frontmatter**、但没随谱携带"的项：
    // 在 Obsidian 里分享整篇笔记时这些值会跟着走，但只复制代码块给他人（或在 iJipu 应用里打开）就不一致。
    // adj639：**插件设置**（本库默认）不再算在内——它在用户眼里等价于应用里的代码默认值，不该提示。
    if (this.opts.carryover.length > 0) {
      const box = contentEl.createDiv({ cls: 'ijipu-config-src ijipu-config-src--carry' })
      box.createDiv({
        cls: 'ijipu-config-src-head',
        text: `未随谱携带 ${this.opts.carryover.length} 项（来自**笔记 frontmatter**，源码里没有写）`,
      })
      const list = box.createEl('ul', { cls: 'ijipu-config-src-list' })
      for (const m of this.opts.carryover) {
        const def = DEFS.find((d) => (d.key as string) === m.key)
        list.createEl('li', { text: `${def ? def.label : m.key}：${m.value === undefined ? '—' : String(m.value)}` })
      }
      box.createDiv({
        cls: 'ijipu-config-hint-sub',
        text: '要把这份谱（或只把代码块）复制给别人也显示一致，用下面的「随谱固化（分享用）」。',
      })
    }

    // —— 字段组页签（用户要求：与「设置 → iJipu」的多页签同款，一屏只看一组）——
    //   外加一页「说明」：把三个保存去向的差别讲清楚（原先挤在对话框顶部，现在各归其位）
    const tabsEl = contentEl.createDiv({ cls: 'ijipu-config-tabs' })
    const panel = contentEl.createDiv({ cls: 'ijipu-config-panel' })
    const buttons = new Map<string, HTMLButtonElement>()
    const paintActive = (): void => {
      for (const [id, btn] of buttons) btn.toggleClass('is-active', id === this.activeTab)
      panel.empty()
      if (this.activeTab === '说明') this.renderAbout(panel)
      else this.renderGroup(panel, this.activeTab)
    }
    for (const id of this.tabs) {
      const btn = tabsEl.createEl('button', { cls: 'ijipu-settings-tab', text: id })
      btn.setAttr('type', 'button')
      btn.onclick = () => {
        this.activeTab = id
        paintActive()
      }
      buttons.set(id, btn)
    }
    paintActive()

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

  /** 「说明」页签：三个保存去向的差别（原先挤在对话框顶部，现在各归其位） */
  private renderAbout(host: HTMLElement): void {
    const note = (text: string): void => {
      host.createDiv({ cls: 'ijipu-settings-note', text })
    }
    note(
      this.opts.sourceFields.length > 0
        ? '**保存到谱面**：本谱已自带 `# jps-config` 行 ⇒ 只更新**本次改动**（原位更新，优先级最高）。'
        : '**保存到谱面**：只写入**本次改动**——不会把插件设置 / frontmatter 的值顺手烧进谱面。',
    )
    note('**随谱固化（分享用）**：把当前生效的**全部非默认项**写进谱面（差量）⇒ 把这份谱或只把代码块复制给别人（或在 iJipu 应用里打开）都显示一致。')
    note('**保存为插件默认**：只把**你在本对话框里改动过的项**写进本库全局默认（不会把这份谱 frontmatter / 源内的值顺手变成全库默认）。')
  }

  /** 渲染**当前页签**那一组字段（草稿是对话框级状态，切页签不丢改动） */
  private renderGroup(host: HTMLElement, group: string): void {
    const items = DEFS.filter((d) => d.group === group)
    if (items.length === 0) {
      host.createDiv({ cls: 'ijipu-settings-empty', text: '（这一组还没有设置项）' })
      return
    }
    for (const def of items) {
      // adj629q：嵌套字段（`segmentRowGap.bz` 等）按子项取值/写值，同一字段的其它子项保留
      const row = new Setting(host)
        .setName(def.label)
        .setDesc(def.sub ? `frontmatter 键：${def.key}（子项 ${def.sub}）` : `frontmatter 键：${def.key}`)
      addConfigControl(row, def, readDef(this.draft, def), (_k, v) => {
        writeDef(this.draft, def, v)
      })
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }

  /** 恢复默认后重画（草稿已换，控件需按新值重建；当前页签保持不变） */
  private refresh(): void {
    this.contentEl.empty()
    this.onOpen()
  }
}
