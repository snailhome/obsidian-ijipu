import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { BUILD_STAMP, GIT_COMMIT } from './gen/buildInfo'
import { buildFrontmatterTemplate, frontmatterKey } from './frontmatter'
// 设置项定义与控件构建由 defs.ts 统一提供（设置面板与谱面「⚙ 排版」对话框共用一份，避免两处漂移）
import { DEFS, GROUPS, addConfigControl, getDefault, readDef, writeDef, type FieldKey, type SettingDef } from './defs'
import { GM_VOICE_OPTIONS, DEFAULT_HQ_ENABLED, HqCache, getHqLibrary, prefetchHqLibraryProgress } from './soundbank'
import type IJipuPlugin from './main'

// frontmatter 键的唯一约定（= `ijipu_` + 引擎 PageConfig 字段名）在 frontmatter.ts 定义，此处转出供外部复用
export { frontmatterKey }

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

  constructor(app: App, plugin: IJipuPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // 插件头部：标题 + 版本/作者 + 说明 + 链接
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
      text: '在 Obsidian 笔记中用 ```jps 代码块把 .jps 简谱脚本渲染为可视化简谱，支持试听（播放时色块跟进音符）与「整页 / 满宽 / 谱面」三种显示模式；设置项与 iJipu 应用一脉传承（页面 / 字体 / 行距 / 渲染）。优先级：引擎默认 < 本页设置 < 笔记 frontmatter（ijipu_*）< 谱面源码内的 # jps-config 行——把 iJipu 里带设置行的 .jps 直接复制进来，即渲染成一模一样。',
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
    head.createEl('div')

    // —— 设置优先级说明（源内 # jps-config 最高；与 iJipu 应用一致）——
    new Setting(containerEl)
      .setName('设置优先级（源内最高）')
      .setDesc(
        '① 引擎默认 → ② 本页设置（全局默认） → ③ 笔记 frontmatter（ijipu_*，笔记级兜底） → ' +
          '④ **谱面源码内的 `# jps-config` 行**（该曲谱自带设置，优先级最高）。' +
          'iJipu 应用侧没有"本机默认层"（adj480：谱面自包含），它保存时只把与默认不同的项写进那一行；' +
          '本页设置与 frontmatter 只对**源内没写的键**生效，因此**不随谱走**——' +
          '要把这份谱（或只把代码块）复制给别人也显示一致，点谱面工具条的「⚙ 排版 → 随谱固化」。',
      )

    // —— frontmatter 键：一键复制（点每项下方的键名复制单个；此处整批复制）——
    new Setting(containerEl)
      .setName('frontmatter 键（一键复制）')
      .setDesc('每项设置下方的键名**可点击复制**；也可一次复制全部键名，或复制一份带当前值的 frontmatter 模板（粘贴到笔记顶部 `---` 之间即可生效）。')
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

    for (const group of GROUPS) {
      const items = DEFS.filter((d) => d.group === group)
      if (items.length === 0) continue
      new Setting(containerEl).setName(group).setHeading()
      for (const def of items) {
        // adj629q：嵌套字段（`segmentRowGap.bz` 等）按子项取值/写值，不再整字段互相覆盖
        const cur = readDef(this.plugin.settings, def) ?? getDefault(def)
        const row = new Setting(containerEl).setName(def.label)
        row.setDesc(this.keyDesc(def.key, def.sub))
        this.addControl(row, def, cur)
      }
    }

    // —— 音色库（adj352：与 iJipu 一致——默认音色 + 收藏音色 + 高保真音源缓存）——
    new Setting(containerEl).setName('音色库').setHeading()
    new Setting(containerEl)
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
        dd.onChange((v) => { this.plugin.settings.hqVoice = v === 'auto' ? null : Number(v); void this.plugin.saveSettings() })
      })
    new Setting(containerEl)
      .setName('收藏音色（可用音色）')
      .setDesc('勾选试听可用的音色（默认常用音色；列表可滚动）。')
    const editVoice = this.plugin.settings.hqEnabled == null ? DEFAULT_HQ_ENABLED.slice() : [...this.plugin.settings.hqEnabled]
    const favWrap = containerEl.createDiv({ cls: 'ijipu-soundbanks' })
    favWrap.setAttr('style', 'max-height:300px;overflow:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:4px;background:var(--background-primary);')
    for (const v of GM_VOICE_OPTIONS) {
      const row = favWrap.createEl('label', { cls: 'ijipu-voice-row' })
      row.setAttr('style', 'display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:13px;cursor:pointer;')
      const cb = row.createEl('input')
      cb.type = 'checkbox'
      cb.checked = editVoice.includes(v.program)
      row.appendText(v.label)
      cb.addEventListener('change', () => {
        const cur = this.plugin.settings.hqEnabled ?? DEFAULT_HQ_ENABLED.slice()
        this.plugin.settings.hqEnabled = cb.checked ? [...cur, v.program] : cur.filter((x) => x !== v.program)
        void this.plugin.saveSettings()
      })
    }

    // —— 音源缓存：是否存在缓存判断 + 下载缓存按钮（adj353）——
    const hqCache = new HqCache()
    const hqLib = getHqLibrary()
    const cacheSetting = new Setting(containerEl).setName('高保真音源缓存').setDesc('检测中…')
    cacheSetting.addButton((b) =>
      b
        .setButtonText('下载并缓存')
        .onClick(async () => {
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
      void this.plugin.saveSettings()
    })
  }
}
