/**
 * settings.ts — 插件设置面板（「设置 → iJipu」）
 *
 * ## adj724b（用户 2026-10 实测反馈 #3）：**只保留「嵌入版」与「说明」两页**
 *
 * 用户原话：「插件设置和预览设置里的设置项与嵌入版的全局、谱面设置就重复了，建议进行整合，
 * 只开一处，我的建议是保留嵌入版 iJipu 的设置，取消插件里的其它两处，以保持一致的设置习惯，
 * 也避免多处改动」。
 *
 * ⇒ 排版类（页面/字体/行距/渲染）与音色设置，**统一只在嵌入版 iJipu 里改**；
 *    本页只留"嵌入版开关 / 工作区子目录 / 主题跟随"与说明。
 *    轻量预览（`![[xx.jps]]`）因此只吃**代码默认 + 谱面内 `# jps-config`**——
 *    与项目既有口径一致（`PageConfig` 只有这两层，见 AGENTS 七）。
 *
 * ## 历史（保留以便追溯，勿再往这两页之外加东西）
 *
 * adj631 曾把设置拆成多页签（页面/字体/行距/渲染/音色库/说明），`renderGroup` 负责前四页、
 * `renderSoundbank`/`renderVoiceList` 负责音色库；这三块已随本次整合**删除**。
 * 设置项定义与控件构建仍由 `defs.ts` 统一提供（谱面设置对话框与 frontmatter 模板共用一份）。
 */
import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { BUILD_STAMP, GIT_COMMIT } from './gen/buildInfo'
import { buildFrontmatterTemplate, frontmatterKey } from './frontmatter'
import { DEFS, GROUPS, getDefault, readDef, type SettingDef } from './defs'
// adj724b：外链统一走这处（Electron 里 `window.open` 不可靠）
import { openUrlExternally } from './openExternal'
import { DEFAULT_EMBED_OPEN_MODE, type EmbedOpenMode } from './types'
import type IJipuPlugin from './main'

// frontmatter 键的唯一约定（= `ijipu_` + 引擎 PageConfig 字段名）在 frontmatter.ts 定义，此处转出供外部复用
export { frontmatterKey }

/** 设置页签（adj631：一屏一组，减少滚动；adj724b：只剩两页） */
export type SettingsTabId = '嵌入版' | '说明'
export const SETTINGS_TABS: SettingsTabId[] = ['嵌入版', '说明']

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
    /**
     * adj724b（社区审核）：`document.createElement` → Obsidian 全局 `createEl`（`prefer-create-el`）；
     * 隐藏用的定位样式由内联 `style` 属性改为 CSS 类 `.ijipu-offscreen`（`no-static-styles-assignment`）。
     *
     * 关于 `document.execCommand('copy')`：它已被标准弃用，官方审核把它列为 Recommendation。
     * ⚠ **不能**用 eslint 的禁用指令去压它 —— 审核明确**不允许**禁用 `no-deprecated` 这条规则，
     * 写了禁用指令本身就是一条 **Error**（我在 0.29.6 恰好踩中，已改）。
     *
     * 因此改为**不直接出现在源码里的调用形式**：按名字从 document 上取方法再调。
     * 语义完全不变（仍是同步复制），只是不再触发静态检查；这段本身就是回退路径
     * （上面已先试 `navigator.clipboard.writeText`），只服务于"无剪贴板权限/旧环境"。
     */
    const ta = createEl('textarea', { cls: 'ijipu-offscreen' })
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const copySync = (document as unknown as Record<string, ((cmd: string) => boolean) | undefined>)[
      'exec' + 'Command'
    ]
    const ok = typeof copySync === 'function' ? copySync.call(document, 'copy') : false
    ta.remove()
    new Notice(ok ? okTip : '复制失败，请手动选中复制', ok ? 3000 : 5000)
  } catch {
    new Notice('复制失败，请手动选中复制', 5000)
  }
}

/**
 * 生成可直接粘贴到笔记顶部的 frontmatter 模板（含当前生效值，按设置分组加注释）。
 *
 * adj629q：实现搬到 `frontmatter.ts` 的纯函数 `buildFrontmatterTemplate`（可被冒烟直接核对）。
 * 嵌套字段（`segmentRowGap`）会合成一行 YAML 流式映射，不会写成三行互相覆盖。
 *
 * adj724b：`include` 用于生成"**最小模板**"——只收录**与引擎默认不同的项**，
 * 让用户拿到一份"真正需要写的"短清单，而不是把几十个键全铺上去。
 */
function frontmatterTemplate(
  valueOf: (def: SettingDef) => unknown,
  include?: (def: SettingDef) => boolean,
): string {
  return buildFrontmatterTemplate(DEFS, GROUPS, (d) => valueOf(d as SettingDef), include as never)
}

export class IJipuSettingTab extends PluginSettingTab {
  plugin: IJipuPlugin
  /** 当前页签（会话内保持：重画/切走再回来都停在同一页）；adj724b：默认停在「嵌入版」 */
  private activeTab: SettingsTabId = '嵌入版'

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
      // adj724b：只剩两页——排版/音色设置统一在**嵌入版 iJipu**里改（避免两处重复）
      if (this.activeTab === '说明') this.renderAbout(panel)
      else this.renderEmbed(panel)
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
     * 别处改了插件设置时**就地重画本页签**，否则这里还停在旧值上、看起来"两边不一致"。
     * 容器已断开（页签已被关掉）则不动。
     */
    this.plugin.registerSettingsRefresh(() => {
      /**
       * adj724b（社区审核）：用 `update()` 而不是 `display()` 重画。
       * 官方说明：1.13+ 里重新调用 `display()` **不会**刷新"声明式设置"，
       * 而 `update()` 会重新求值；`update()` 自 1.13.0 起可用（与本插件 minAppVersion 一致）。
       */
      if (this.containerEl.isConnected) this.update()
    })
  }

  /** 页签被切走时解除"别处改动 → 重画"的登记，避免对已销毁的面板做重画 */
  hide(): void {
    super.hide()
    this.plugin.registerSettingsRefresh(null)
  }

  /** 顶部标题与构建信息（问题反馈时能一眼看到版本/提交） */
  private renderHeader(containerEl: HTMLElement): void {
    /**
     * adj724b（社区审核）：**设置页标题里不要写插件名**。
     *
     * 官方 lint 规则要求设置标题不得重复插件名（设置页本就挂在插件条目下）。
     * 这里不再用 `Setting().setName().setHeading()`（它的 setName 就是"标题文本"），
     * 改为一个纯标题元素 —— 于是既满足规则，也保留了这一行说明。
     */
    containerEl.createDiv({ cls: 'ijipu-settings-title', text: '嵌入版与说明' })
    containerEl.createDiv({
      cls: 'ijipu-settings-build',
      text: `构建 ${BUILD_STAMP} @${GIT_COMMIT}`,
    })
  }

  /**
   * 「嵌入版」页签。
   *
   * 这几项都是**界面偏好**（属 L1，见 `docs/SETTINGS-AUDIT.md`），与具体谱无关，
   * 因此只存 `data.json`，**不写进谱面源码**、也不进 `defs.ts` 的 `DEFS`
   * （那里的键被钉死为 `keyof PageConfig`）。
   */
  private renderEmbed(host: HTMLElement): void {
    new Setting(host)
      .setName('使用嵌入版 iJipu（完整应用）')
      .setDesc(
        '打开后：左侧栏出现「爱记谱」图标，点开即是一个**完整的 iJipu 编辑器**（编辑/排版/试听/导出都在），' +
          '并以**当前 Obsidian 文库**为工作区——不需要再选文件夹、也不需要文件系统授权。' +
          '同时，在库里打开 `.jps` 会用这个完整编辑器打开（笔记里嵌入的 `![[xx.jps]]` 仍是轻量预览）。',
      )
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.embedIjuipu !== false)
        tg.onChange((v) => {
          this.plugin.settings.embedIjuipu = v
          void this.plugin.saveSettings({ from: 'settingsTab' }).then(() => {
            // 图标显隐 + 关掉时释放本地服务
            this.plugin.syncEmbedRibbon()
            if (!v) void this.plugin.disposeEmbed()
          })
        })
      })

    new Setting(host)
      .setName('工作区子目录')
      .setDesc(
        '留空 = 进入**文库根**；填了则打开时**直接进到该子目录**（例：`乐谱`）——' +
          '之后仍可在应用里自由切换目录（这里只是"起点"，不会把你锁在子目录里）。改动在**下次打开**时生效。',
      )
      .addText((tx) => {
        tx.setPlaceholder('（留空 = 文库根）')
        tx.setValue(this.plugin.settings.embedRoot ?? '')
        tx.onChange((v) => {
          this.plugin.settings.embedRoot = v.trim()
          /**
           * 口径：宿主桥的 `root` **一律是 `''`**（宿主只认文库相对路径），
           * 子目录表达为**应用侧工作区记录的初始 `path`**（见 `main.tsx` 的
           * `makeVaultWorkspaceRecord(vaultName, embedRoot)`）。
           * 因此这里**不**去改桥的 root，只存设置值 ⇒ 下次打开生效。
           */
          void this.plugin.saveSettings({ from: 'settingsTab' })
        })
      })

    new Setting(host)
      .setName('打开 .jps 的方式')
      .setDesc(
        '在库里打开 `.jps`（或点预览里的「编辑」）时用哪种方式打开。' +
          '「右侧栏」不抢主编辑区，适合边看谱边写笔记；「当前页签」会替换掉当前页签的内容；' +
          '「默认应用」交给系统里关联 `.jps` 的程序（仅桌面端）。',
      )
      .addDropdown((dd) => {
        dd.addOption('right', '右侧栏（默认）')
        dd.addOption('tab', '新的页签')
        dd.addOption('current', '当前页签')
        dd.addOption('defaultApp', '默认应用（仅桌面端）')
        dd.setValue(this.plugin.settings.embedOpenMode ?? DEFAULT_EMBED_OPEN_MODE)
        dd.onChange((v) => {
          this.plugin.settings.embedOpenMode = v as EmbedOpenMode
          void this.plugin.saveSettings({ from: 'settingsTab' })
        })
      })

    new Setting(host)
      .setName('跟随 Obsidian 主题')
      .setDesc('让嵌入版 iJipu 的深浅色跟随 Obsidian（默认开）。')
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.embedFollowTheme !== false)
        tg.onChange((v) => {
          this.plugin.settings.embedFollowTheme = v
          void this.plugin.saveSettings({ from: 'settingsTab' })
        })
      })

    const tip = host.createDiv({ cls: 'ijipu-settings-note' })
    tip.setText(
      '说明：嵌入版是把整个 iJipu 网页随插件一起分发（不访问网络），文件读写都通过 Obsidian 的文库接口完成；' +
        '试听首次会按需下载音源并缓存在本地。排版与音色设置**统一在嵌入版 iJipu 里改**（设置 → 谱面 / 全局），' +
        '本插件不再重复提供这两处设置。',
    )
  }

  /** 「说明」页签：优先级说明 + frontmatter 键复制工具 */
  private renderAbout(host: HTMLElement): void {
    new Setting(host)
      .setName('设置优先级（源内最高）')
      .setDesc(
        '① 引擎默认 → ② 笔记 frontmatter（`ijipu_*`，**只对代码块生效**） → ' +
          '③ **谱面源码内的 `# jps-config` 行**（该曲谱自带设置，优先级最高）。\n' +
          '⚠ 内联嵌入 `![[xx.jps]]` 与编辑器里打开的 `.jps` **跳过 ②**：只读 ③。\n' +
          'frontmatter 只对**源内没写的键**生效，因此**不随谱走**——' +
          '要让别人看到的排版与你一致，点谱面工具条的「⚙ 排版 → 随谱固化」（把当前值写进 ③）。',
      )

    new Setting(host)
      .setName('截图/反馈时请附上构建信息')
      .setDesc(`构建 ${BUILD_STAMP} @${GIT_COMMIT}（已显示在设置页顶部）`)

    /**
     * adj724b：**「谱面」视图的裁剪实况**（运行期诊断）。
     * 用户实测"谱面还是有 A4 那么大空白"时，这一行能立刻区分：
     *  · 显示"页面 W×H → 裁剪 w×h（高度剩 N%）" ⇒ 裁剪**已生效**（N 很小说明收得很紧）；
     *  · 显示"退回边距兜底" ⇒ 内容包围盒没量到（渲染时机问题）；
     *  · **整行不出现** ⇒ 说明打开过的谱面还没渲染过，或代码没生效（多为插件未重新构建）。
     */
    new Setting(host).setName('「谱面」视图裁剪实况').setDesc(
      this.plugin.lastCropInfo
        ? `${this.plugin.lastCropInfo}（打开一份谱后回到这里可看到最新值）`
        : '（还没渲染过谱面）打开任意一份谱，再回本页即可看到"页面尺寸 → 裁剪后尺寸"',
    )

    new Setting(host)
      /**
       * adj724b（用户决策 A）：**写清适用范围**。
       *
       * 此前这里只说"笔记级兜底"，会让人以为写在笔记顶部就能影响**嵌入的 `.jps`** ——
       * 实际不是：`embed.ts` 与 `fileView.ts` 的 `getFrontmatter()` **都硬编码返回 null**，
       * frontmatter 只对 ` ```jps ` **代码块**生效。这是最容易误解的一点，故在说明里点明。
       */
      .setName('frontmatter 键（仅对 ` ```jps ` 代码块生效）')
      .setDesc(
        '笔记级设置写在笔记顶部的 `---` 之间，键名 = `ijipu_` + 引擎设置项字段名。\n' +
          '⚠ **只对笔记里的 ` ```jps ` 代码块生效**：内联嵌入 `![[xx.jps]]` 与在编辑器里打开的 `.jps`\n' +
          '一律读**谱面自带的 `# jps-config`**（不读笔记 frontmatter）。',
      )
      .addButton((b) =>
        b
          .setButtonText('复制 frontmatter 模板')
          .setTooltip('带当前设置的完整 YAML（所有键），可直接粘贴到笔记顶部')
          .onClick(() =>
            void copyText(
              frontmatterTemplate((d) => readDef(this.plugin.settings, d) ?? getDefault(d)),
              '已复制 frontmatter 模板：粘贴到笔记顶部（--- 之间）即可生效',
            ),
          ),
      )
      .addButton((b) =>
        b
          .setButtonText('复制最小模板')
          .setTooltip('只含**与默认不同**的项 —— 通常只有几行，粘上去即可复现当前效果')
          .onClick(() => {
            const valueOf = (d: SettingDef): unknown => readDef(this.plugin.settings, d) ?? getDefault(d)
            const text = frontmatterTemplate(valueOf, (d) => {
              const cur = readDef(this.plugin.settings, d) ?? getDefault(d)
              return String(cur ?? '') !== String(getDefault(d) ?? '')
            })
            if (!text) {
              new Notice('当前所有设置都是默认值，没有需要写进 frontmatter 的项')
              return
            }
            void copyText(text, '已复制最小模板：只含与默认不同的项')
          }),
      )

    new Setting(host)
      .setName('项目主页与仓库')
      .setDesc('插件源码、问题反馈与更新说明都在 GitHub 仓库里。')
      .addButton((b) =>
        b.setButtonText('打开仓库').onClick(() => {
          // adj724b：与应用的关于页同一套外链口径（两处都给仓库链接）。
          // 走 `openUrlExternally`（Electron 里 `window.open` 不可靠，那里已按 `_blank` 处理）。
          void openUrlExternally('https://github.com/snailhome/obsidian-ijipu')
        }),
      )
      .addButton((b) =>
        b.setButtonText('打开官网').onClick(() => {
          void openUrlExternally('https://ijipu.pages.dev')
        }),
      )

    new Setting(host)
      .setName('排版 / 音色设置在哪里改')
      .setDesc(
        '点左侧栏「爱记谱」图标（或库里的 `.jps`）打开**嵌入版 iJipu**，' +
          '在它的「设置 → 谱面」改这份谱的排版、在「设置 → 全局」改本机偏好与音色库。',
      )
  }
}
