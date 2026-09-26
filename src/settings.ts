/**
 * settings.ts — 插件设置面板（「设置 → iJipu」）
 *
 * adj631（用户三条要求）：
 *  ① **多页签显示**（"如 linter 插件一样采用多页签的方式显示，以减少滚动"）——
 *     页签 = 页面 / 字体 / 行距 / 渲染 / 音色库 / 说明，一屏只看一组，不再一条长滚动条；
 *  ② **收藏音色改成"流式分类列表"**（与应用「全局设置 → 音色库」一致）——按 GM 14 类分组、
 *     可折叠、每类可整组选/消、顶部「全选 / 全消 / 反选 + 搜索」、右上角实时「已选 N / 128」；
 *  ③ **与预览页面的设置保持同步**：本页签是**本库全局默认**（只对源内/frontmatter 没写的键生效），
 *     预览页面的「⚙ 设置」对话框显示的是**这份谱的生效值**（含 frontmatter / 源内 `# jps-config`）——
 *     两者口径不同、值可以不相等；别处改了插件默认（对话框「保存为插件默认」）时本页签**就地重画**，
 *     避免用户看到"两边不一致"。判据/写入的纯逻辑在 `defs.ts`（`changedDefs`/`isDefaultValue`）。
 *
 * 设置项定义与控件构建由 `defs.ts` 统一提供（设置面板与「⚙ 排版」对话框共用一份，避免两处漂移）。
 */
import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { BUILD_STAMP, GIT_COMMIT } from './gen/buildInfo'
import { buildFrontmatterTemplate, frontmatterKey } from './frontmatter'
import { DEFS, GROUPS, addConfigControl, getDefault, readDef, writeDef, type FieldKey, type SettingDef } from './defs'
import { GM_VOICE_OPTIONS, DEFAULT_HQ_ENABLED, HqCache, getHqLibrary, prefetchHqLibraryProgress } from './soundbank'
import {
  clearVoices,
  filterVoices,
  groupVoices,
  invertVoices,
  normalizeVoices,
  selectAllVoices,
  selectedInGroup,
  setGroupVoices,
  toggleVoice,
  voiceSummary,
  type CollapsedMap,
} from './voiceChooser'
import type IJipuPlugin from './main'

// frontmatter 键的唯一约定（= `ijipu_` + 引擎 PageConfig 字段名）在 frontmatter.ts 定义，此处转出供外部复用
export { frontmatterKey }

/** 设置页签（adj631：一屏一组，减少滚动） */
export type SettingsTabId = '页面' | '字体' | '行距' | '渲染' | '音色库' | '说明'
export const SETTINGS_TABS: SettingsTabId[] = ['页面', '字体', '行距', '渲染', '音色库', '说明']

/** 复制文本到剪贴板（优先 Clipboard API；失败回退 execCommand，桌面/移动端均可用） */
async function copyText(text: string, okTip: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    new Notice(okTip)
    return
  } catch {
    /* 回退到 execCommand */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0;')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    new Notice(ok ? okTip : '复制失败，请手动选中复制', ok ? 3000 : 5000)
  } catch {
    new Notice('复制失败，请手动选中复制', 5000)
  }
}

/**
 * 生成可直接粘贴到笔记顶部的 frontmatter 模板（含当前生效值，按设置面板分组加注释）。
 *
 * adj629q：实现搬到 `frontmatter.ts` 的纯函数 `buildFrontmatterTemplate`（可被冒烟直接核对），
 * 这里只提供"取当前值"的回调（插件设置优先、否则引擎默认）。嵌套字段（`segmentRowGap`）
 * 会合成一行 YAML 流式映射，不会写成三行互相覆盖。
 */
function frontmatterTemplate(valueOf: (def: SettingDef) => unknown): string {
  return buildFrontmatterTemplate(DEFS, GROUPS, (d) => valueOf(d as SettingDef))
}

export class IJipuSettingTab extends PluginSettingTab {
  plugin: IJipuPlugin
  /** 当前页签（会话内保持：重画/切走再回来都停在同一页） */
  private activeTab: SettingsTabId = '页面'
  /** 「收藏音色」的折叠状态（标题 → 是否收起） */
  private collapsed: CollapsedMap = {}

  constructor(app: App, plugin: IJipuPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    this.renderHeader(containerEl)

    // —— 页签栏 ——
    const tabsEl = containerEl.createDiv({ cls: 'ijipu-settings-tabs' })
    const panel = containerEl.createDiv({ cls: 'ijipu-settings-panel' })
    const tabs = new Map<SettingsTabId, HTMLButtonElement>()
    const paintActive = (): void => {
      for (const [id, btn] of tabs) btn.toggleClass('is-active', id === this.activeTab)
      panel.empty()
      if (this.activeTab === '音色库') this.renderSoundbank(panel)
      else if (this.activeTab === '说明') this.renderAbout(panel)
      else this.renderGroup(panel, this.activeTab)
    }
    for (const id of SETTINGS_TABS) {
      const btn = tabsEl.createEl('button', { cls: 'ijipu-settings-tab', text: id })
      btn.setAttr('type', 'button')
      btn.onclick = () => {
        this.activeTab = id
        paintActive()
      }
      tabs.set(id, btn)
    }
    paintActive()

    /**
     * adj631（用户报"预览页面的设置与 设置-iJipu 里的设置项不同步"）：
     * 别处改了插件设置（预览对话框的「保存为插件默认」）时**就地重画本页签**，
     * 否则这里还停在旧值上、看起来"两边不一致"。容器已断开（页签已被关掉）则不动。
     */
    this.plugin.registerSettingsRefresh(() => {
      if (this.containerEl.isConnected) this.display()
    })
  }

  /** 页签被切走时解除"别处改动 → 重画"的登记，避免对已销毁的面板做重画 */
  hide(): void {
    this.plugin.registerSettingsRefresh(null)
  }

  // ============================================================
  // 头部 / 谱面设置页签 / 说明页签 / 音色库页签
  // ============================================================

  /** 顶部：标题 + 版本/构建指纹 + 作者 + 说明 + 链接 */
  private renderHeader(containerEl: HTMLElement): void {
    const head = containerEl.createDiv({ cls: 'ijipu-settings-header' })
    head.createEl('h2', { text: '爱记谱（iJipu）' })

    // 版本 / 作者：一律读 manifest.json（发布时自动同步，避免手写版本号漂移）
    // adj407：再补**构建指纹**（日期 时间 + commit）——同一版本号会有多个本地构建（反复修同一个问题时
    // 尤其明显），用户据此才能判断手机/桌面上装的到底是哪一份，也便于复测时对齐。
    const { version, author, authorUrl } = this.plugin.manifest
    const meta = head.createDiv({ cls: 'ijipu-settings-meta' })
    meta.createEl('span', { cls: 'ijipu-settings-version', text: `版本 v${version}` })
    meta.createEl('span', { cls: 'ijipu-settings-sep', text: ' · ' })
    meta.createEl('span', { cls: 'ijipu-settings-build', text: `构建 ${BUILD_STAMP} @${GIT_COMMIT}` })
    meta.createEl('span', { cls: 'ijipu-settings-sep', text: ' · ' })
    const authorEl = meta.createEl(authorUrl ? 'a' : 'span', { cls: 'ijipu-settings-author' })
    if (authorUrl) {
      authorEl.setAttr('href', authorUrl)
      authorEl.setAttr('target', '_blank')
      authorEl.setAttr('title', `作者主页：${authorUrl}`)
    }
    authorEl.setText(`作者 ${author}`)

    head.createEl('p', {
      text: '在 Obsidian 笔记中用 ```jps 代码块把 .jps 简谱脚本渲染为可视化简谱，支持试听（播放时色块跟进音符）与「整页 / 满宽 / 谱面」三种显示模式；设置项与 iJipu 应用一脉传承（页面 / 字体 / 行距 / 渲染）。',
    })
    const a1 = head.createEl('a', { text: 'iJipu 官网' })
    a1.setAttr('href', 'https://ijipu.pages.dev')
    a1.setAttr('target', '_blank')
    head.createEl('span', { text: ' · ' })
    const a2 = head.createEl('a', { text: '脚本规则说明' })
    a2.setAttr('href', 'https://ijipu.pages.dev/doc/jps-spec.html')
    a2.setAttr('target', '_blank')
    head.createEl('span', { text: ' · ' })
    const a3 = head.createEl('a', { text: '支持作者 ❤' })
    a3.setAttr('href', 'https://ijipu.pages.dev/good.png')
    a3.setAttr('target', '_blank')
  }

  /** 「页面 / 字体 / 行距 / 渲染」四个页签：该组的谱面设置项 */
  private renderGroup(host: HTMLElement, group: string): void {
    // adj631：把"这一页是本库全局默认"讲清楚——它是用户报"与预览页面不同步"的根源（口径不同，值可以不等）
    host.createDiv({
      cls: 'ijipu-settings-note',
      text: '下列是**本库全局默认**：只对"谱面源码没写 `# jps-config`、笔记 frontmatter 也没写"的键生效。预览页面「⚙ 设置」里显示的是**这一份谱的生效值**（含 frontmatter / 源内设置），两者值不同是正常的。',
    })
    const items = DEFS.filter((d) => d.group === group)
    if (items.length === 0) {
      host.createDiv({ cls: 'ijipu-settings-empty', text: '（这一组还没有设置项）' })
      return
    }
    for (const def of items) {
      // adj629q：嵌套字段（`segmentRowGap.bz` 等）按子项取值/写值，不再整字段互相覆盖
      const cur = readDef(this.plugin.settings, def) ?? getDefault(def)
      const row = new Setting(host).setName(def.label)
      row.setDesc(this.keyDesc(def.key, def.sub))
      this.addControl(row, def, cur)
    }
  }

  /** 「说明」页签：优先级说明 + frontmatter 键复制工具 */
  private renderAbout(host: HTMLElement): void {
    new Setting(host)
      .setName('设置优先级（源内最高）')
      .setDesc(
        '① 引擎默认 → ② 本插件设置（本库全局默认） → ③ 笔记 frontmatter（ijipu_*，笔记级兜底） → ' +
          '④ **谱面源码内的 `# jps-config` 行**（该曲谱自带设置，优先级最高）。' +
          'iJipu 应用侧没有"本机默认层"（adj480：谱面自包含），它保存时只把与默认不同的项写进那一行；' +
          '本页设置与 frontmatter 只对**源内没写的键**生效，因此**不随谱走**——' +
          '要把这份谱（或只把代码块）复制给别人也显示一致，点谱面工具条的「⚙ 排版 → 随谱固化」。',
      )

    new Setting(host)
      .setName('frontmatter 键（一键复制）')
      .setDesc(
        '每项设置下方的键名**可点击复制**；也可一次复制全部键名，或复制一份带当前值的 frontmatter 模板（粘贴到笔记顶部 `---` 之间即可生效）。',
      )
      .addButton((b) =>
        b
          .setButtonText('复制全部键名')
          .setTooltip(`复制 ${new Set(DEFS.map((d) => d.key)).size} 个 ijipu_* 键名（每行一个）`)
          .onClick(() =>
            void copyText(
              [...new Set(DEFS.map((d) => frontmatterKey(d.key)))].join('\n'),
              `已复制 ${new Set(DEFS.map((d) => d.key)).size} 个 frontmatter 键名`,
            ),
          ),
      )
      .addButton((b) =>
        b
          .setButtonText('复制 frontmatter 模板')
          .setTooltip('带当前值的 YAML，可直接粘贴到笔记顶部')
          .onClick(() =>
            void copyText(
              frontmatterTemplate((d) => readDef(this.plugin.settings, d) ?? getDefault(d)),
              '已复制 frontmatter 模板：粘贴到笔记顶部（--- 之间）即可生效',
            ),
          ),
      )

    new Setting(host)
      .setName('本库全局默认的改法')
      .setDesc(
        '① 就在这个设置页改（逐项即时保存）；② 或在谱面预览里点「⚙ 设置」调好这一份谱，再点对话框底部的「保存为插件默认」' +
          '（**只记录你在该次对话框里改动过的项**，不会把这份谱 frontmatter / 源内的值顺手写成全库默认）。',
      )
  }

  /** 「音色库」页签：默认音色 + 收藏音色（流式分类列表）+ 高保真音源缓存 */
  private renderSoundbank(host: HTMLElement): void {
    new Setting(host)
      .setName('默认音色')
      .setDesc(
        '试听默认使用的高保真音色；「自动」= 按声部名 @乐器 / Y 默认路由（多声部各声部独立）。' +
          // adj450：与 iJipu 应用同一口径——选定具体音色会**覆盖谱面 Y:**（用户曾据此误判「谱面 Y: 不生效」）
          '选了具体音色会覆盖谱面里的 Y: 乐器（要按谱面各声部音色演奏，请选「自动」）。',
      )
      .addDropdown((dd) => {
        dd.addOption('auto', '自动（按声部名）')
        GM_VOICE_OPTIONS.forEach((v) => dd.addOption(String(v.program), v.label))
        dd.setValue(this.plugin.settings.hqVoice == null ? 'auto' : String(this.plugin.settings.hqVoice))
        dd.onChange((v) => {
          this.plugin.settings.hqVoice = v === 'auto' ? null : Number(v)
          void this.plugin.saveSettings({ from: 'settingsTab' })
        })
      })

    new Setting(host)
      .setName('收藏音色（可用音色）')
      .setDesc('勾选试听可用的音色——只有勾上的音色会出现在试听下拉里（与 iJipu 应用「音色库」同一套分类）。')
    this.renderVoiceList(host)

    // —— 音源缓存：是否存在缓存判断 + 下载缓存按钮（adj353）——
    const hqCache = new HqCache()
    const hqLib = getHqLibrary()
    const cacheSetting = new Setting(host).setName('高保真音源缓存').setDesc('检测中…')
    cacheSetting.addButton((b) =>
      b.setButtonText('下载并缓存').onClick(async () => {
        b.setButtonText('下载中…').setDisabled(true)
        try {
          await prefetchHqLibraryProgress(hqLib, hqCache)
          cacheSetting.setDesc('✓ 已缓存（约 30MB，离线可用）')
          new Notice('音色库已下载并缓存')
        } catch (e) {
          cacheSetting.setDesc(`✗ 下载失败：${e instanceof Error ? e.message : String(e)}`)
          new Notice('音色库下载失败', 5000)
        } finally {
          b.setButtonText('下载并缓存').setDisabled(false)
        }
      }),
    )
    void hqCache.has(hqLib.id).then((ok) => {
      cacheSetting.setDesc(ok ? '✓ 已缓存（约 30MB，离线可用）' : '未缓存——点击「下载并缓存」（约 30MB）后试听即可用。')
    })
  }

  // ============================================================
  // 收藏音色：流式分类列表（adj631，对齐应用「音色库」）
  // ============================================================

  /** 当前勾选的音色（缺省 = 内置常用音色） */
  private voiceState(): number[] {
    return normalizeVoices(this.plugin.settings.hqEnabled ?? DEFAULT_HQ_ENABLED)
  }

  /** 写回勾选结果（稀疏：与内置默认相同则不落一个冗余的键） */
  private applyVoices(next: number[]): void {
    const normalized = normalizeVoices(next)
    this.plugin.settings.hqEnabled = normalized
    void this.plugin.saveSettings({ from: 'settingsTab' })
  }

  /**
   * 构建「收藏音色」流式分类列表。
   *
   * 结构（与应用 `VoicePickerDialog` 对齐）：工具条（全选/全消/反选 + 搜索 + 已选计数）
   * → 每个 GM 分类一段（标题可点折叠、右侧 `n/总数` 与「选本组/消本组」）→ 组内音色**流式排布**
   * （`flex-wrap`，不做 128 行长列表）。
   *
   * 勾选/整组操作**就地更新**（不重建 DOM）⇒ 滚动位置与焦点不丢；只有搜索过滤才重建音色行。
   */
  private renderVoiceList(host: HTMLElement): void {
    const wrap = host.createDiv({ cls: 'ijipu-voice' })
    const toolbar = wrap.createDiv({ cls: 'ijipu-voice-toolbar' })
    const sumEl = toolbar.createSpan({ cls: 'ijipu-voice-sum' })
    const mkBtn = (text: string, fn: () => void): void => {
      const b = toolbar.createEl('button', { cls: 'ijipu-btn', text })
      b.setAttr('type', 'button')
      b.onclick = fn
    }
    mkBtn('全选', () => this.setVoicesAndSync(selectAllVoices(), sync))
    mkBtn('全消', () => this.setVoicesAndSync(clearVoices(), sync))
    mkBtn('反选', () => this.setVoicesAndSync(invertVoices(this.voiceState()), sync))
    const search = toolbar.createEl('input', { cls: 'ijipu-voice-search', type: 'search', placeholder: '搜索音色名…' })

    const groupsHost = wrap.createDiv({ cls: 'ijipu-voice-groups' })
    /** program → 复选框（就地同步用） */
    const boxes = new Map<number, HTMLInputElement>()
    /** 分类标题 → 该类的 `n/总数` 文本元素 */
    const counts = new Map<string, HTMLElement>()

    /** 用当前勾选值刷新所有复选框与计数（不重建 DOM） */
    const sync = (): void => {
      const enabled = new Set(this.voiceState())
      for (const [program, box] of boxes) box.checked = enabled.has(program)
      for (const g of groupVoices()) {
        const el = counts.get(g.title)
        if (el) el.setText(`${selectedInGroup([...enabled], g.range)}/${g.voices.length}`)
      }
      sumEl.setText(voiceSummary([...enabled]))
    }

    /** 重建分类与音色行（搜索变化时调用） */
    const renderGroups = (keyword: string): void => {
      groupsHost.empty()
      boxes.clear()
      counts.clear()
      const matched = filterVoices(keyword)
      // 搜索时**平铺**（与应用一致：有关键词就不分组，避免"结果散落在十几个折叠块里"）
      if (keyword.trim()) {
        const flat = groupsHost.createDiv({ cls: 'ijipu-voice-rows' })
        for (const v of matched) this.addVoiceChip(flat, v.program, v.label, boxes, sync)
        return
      }
      for (const g of groupVoices(matched)) {
        const sec = groupsHost.createDiv({ cls: 'ijipu-voice-group' })
        const headEl = sec.createDiv({ cls: 'ijipu-voice-group-head' })
        const caret = headEl.createSpan({ cls: 'ijipu-voice-caret', text: this.collapsed[g.title] ? '▸' : '▾' })
        headEl.createSpan({ cls: 'ijipu-voice-group-title', text: g.title })
        const countEl = headEl.createSpan({ cls: 'ijipu-voice-group-count' })
        counts.set(g.title, countEl)
        const gbtn = headEl.createEl('button', { cls: 'ijipu-btn is-mini', text: '选本组' })
        gbtn.setAttr('type', 'button')
        gbtn.onclick = (e) => {
          e.stopPropagation()
          this.setVoicesAndSync(setGroupVoices(this.voiceState(), g.range, true), sync)
        }
        const cbtn = headEl.createEl('button', { cls: 'ijipu-btn is-mini', text: '消本组' })
        cbtn.setAttr('type', 'button')
        cbtn.onclick = (e) => {
          e.stopPropagation()
          this.setVoicesAndSync(setGroupVoices(this.voiceState(), g.range, false), sync)
        }
        const rows = sec.createDiv({ cls: 'ijipu-voice-rows' })
        for (const v of g.voices) this.addVoiceChip(rows, v.program, v.label, boxes, sync)
        sec.toggleClass('is-collapsed', !!this.collapsed[g.title])
        headEl.onclick = () => {
          this.collapsed[g.title] = !this.collapsed[g.title]
          caret.setText(this.collapsed[g.title] ? '▸' : '▾')
          sec.toggleClass('is-collapsed', !!this.collapsed[g.title])
        }
      }
    }

    search.oninput = () => {
      renderGroups(search.value)
      sync()
    }
    renderGroups('')
    sync()
  }

  /** 单个音色的复选框（`N 名称`；点标签即切换） */
  private addVoiceChip(
    host: HTMLElement,
    program: number,
    label: string,
    boxes: Map<number, HTMLInputElement>,
    sync: () => void,
  ): void {
    const chip = host.createEl('label', { cls: 'ijipu-voice-chip' })
    const box = chip.createEl('input')
    box.type = 'checkbox'
    box.checked = this.voiceState().includes(program)
    box.onchange = () => {
      this.applyVoices(toggleVoice(this.voiceState(), program))
      sync()
    }
    chip.createSpan({ text: label })
    boxes.set(program, box)
  }

  /** 应用一批新的勾选值并同步界面（写盘 + 就地刷新） */
  private setVoicesAndSync(next: number[], sync: () => void): void {
    this.applyVoices(next)
    sync()
  }

  // ============================================================
  // 行控件 / 键名说明
  // ============================================================

  /**
   * 「frontmatter 键：<code>ijipu_xxx</code>」描述——**点键名即复制**（键盘 Enter/Space 亦可）。
   * 诉求来源：手抄 `ijipu_note_size` 这类键名容易写错，而写错会被静默忽略。
   * adj629q：嵌套字段（`segmentRowGap`）的 frontmatter 键仍是**整字段**那一个
   * （frontmatter 里按 `ijipu_segmentRowGap: {bz: …}` 写），只是多标一下子项名便于对照。
   */
  private keyDesc(key: FieldKey, sub?: string): DocumentFragment {
    const k = frontmatterKey(key)
    return createFragment((frag) => {
      frag.appendText('frontmatter 键：')
      const chip = frag.createEl('code', { cls: 'ijipu-fm-key', text: k })
      chip.setAttr('title', `点击复制：${k}`)
      chip.setAttr('role', 'button')
      chip.setAttr('tabindex', '0')
      chip.addEventListener('click', () => void copyText(k, `已复制 ${k}`))
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void copyText(k, `已复制 ${k}`)
        }
      })
      if (sub) frag.appendText(`（子项 ${sub}）`)
    })
  }

  /** 设置面板的一行控件（与「⚙ 排版」对话框共用 defs.ts 的同一实现） */
  private addControl(row: Setting, def: SettingDef, cur: unknown): void {
    addConfigControl(row, def, cur, (_key, value) => {
      // adj629q：嵌套字段按子项写入（`readDef`/`writeDef` 是唯一的口径）
      writeDef(this.plugin.settings, def, value)
      // adj631：`from: 'settingsTab'` —— 本页签自己改的不触发"重画本页签"（否则输入焦点会被打断）
      void this.plugin.saveSettings({ from: 'settingsTab' })
    })
  }
}
