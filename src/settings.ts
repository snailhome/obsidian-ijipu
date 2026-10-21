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
import { BUILD_DATE, BUILD_STAMP, GIT_COMMIT } from './gen/buildInfo'
// adj741：音色库入口要列出内置音源库（与应用「音色库」同一份清单）
import { HQ_LIBRARIES } from './soundbank'
// adj739：嵌入版应用的版本（设置页头部与插件版本并排显示，见 renderHeader）
import { WEBAPP_META } from './gen/webappAssets'
// adj739：品牌图标与应用同一枚（`ijipu/public/icons/Jianpu.png` → 本仓库 `vendor/icons/Jianpu.png`，
// 逐字节相同，7,183 字节），构建期内联成 data URI ⇒ 设置页不联网、也不依赖嵌入版服务。
import jianpuLogoPng from '../vendor/icons/Jianpu.png'
// adj738：笔记 frontmatter 那一层整体删除（含 `frontmatterKey` 的转出与「复制模板」入口）。
// adj724b：外链统一走这处（Electron 里 `window.open` 不可靠）
import { openUrlExternally } from './openExternal'
import { DEFAULT_EMBED_OPEN_MODE, DEFAULT_EXPORT_RANGE, DEFAULT_IMAGE_SCALE, type EmbedOpenMode } from './types'
// adj730：微信赞赏码（与应用「关于」页同一张图；构建期内联成 data URI，不联网）
import donateQrPng from '../vendor/icons/good.png'
import type IJipuPlugin from './main'

// adj734（用户要求）：赞赏码只**内联显示**在设置页里（扫码即可），
// 不再给「在浏览器打开」外链 —— 所以这里也不需要 `DONATE_URL` 常量了。
// adj738：`frontmatterKey` 的转出随"笔记 frontmatter 层"一并删除。

/** 设置页签（adj631：一屏一组，减少滚动；adj724b：只剩两页） */
export type SettingsTabId = '嵌入版' | '说明' | '诊断'
/**
 * adj788（用户要求）：「将设置里的**所有的测试**归到一个单独的**诊断**页签里，以免干扰其它有用信息，
 * 并且不用截图方式反馈，**允许我点击相关诊断块自动复制诊断块标题和相应信息**，我可以直接贴给你，
 * 省得你再 OCR」。
 *
 * ⇒ 新增第三个页签「诊断」：所有运行期诊断集中在此，且每块**点击即复制（标题 + 内容）**。
 */
export const SETTINGS_TABS: SettingsTabId[] = ['嵌入版', '说明', '诊断']

export class IJipuSettingTab extends PluginSettingTab {
  plugin: IJipuPlugin
  /** 当前页签（会话内保持：重画/切走再回来都停在同一页）；adj724b：默认停在「嵌入版」 */
  private activeTab: SettingsTabId = '嵌入版'

  constructor(app: App, plugin: IJipuPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  /**
   * adj741（手机端 P0）：**从别处把设置页切到指定页签**（手机端点"打开音色库"时用）。
   *
   * 为什么需要：手机端没有嵌入版应用，`openEmbedSoundbank()` 改为打开本页的「说明」页签
   * （那里面有新加的「音色库（高保真试听的音源）」导入入口）。`activateSettingsTab` 负责
   * 打开设置面板本身，这里只负责落到正确页签并重画。
   */
  activate(tab: SettingsTabId): void {
    this.activeTab = tab
    if (this.containerEl.isConnected) this.update()
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
      /**
       * adj922（用户报「说明页签里、赞赏图后面多出了『嵌入版』页签的内容」）：**三个页签必须是
       * 一条 if / else if / else 链、一支命中**。原来是 `if (this.activeTab === '说明') …` 下面
       * **另起一句** `if (this.activeTab === '诊断') … else this.renderEmbed(panel)` ⇒ 停在「说明」时
       * 两句都成立：先 `renderAbout`、紧接着又 `renderEmbed`，把整个嵌入版**追加到同一个 `panel`** 上
       * （用户看到的就是这一串：赞赏图之后跟着嵌入版的 5 个设置项和那句尾注）。
       *
       * 写法与 `configDialog.ts` 的页签分派同款（那里是 `if … else …`）——页签只能命中一支。
       *
       * adj724b：排版/音色设置**只在嵌入版 iJipu 里改**，本页不重复提供（这里只管本页怎么分派）。
       */
      if (this.activeTab === '说明') this.renderAbout(panel)
      else if (this.activeTab === '诊断') this.renderDiagnostics(panel)
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

  /**
   * 顶部品牌头 + 版本与构建信息（问题反馈时能一眼看到"插件是哪一版、里面的嵌入版是哪一版"）。
   *
   * adj724b（社区审核）：**不要用 `Setting().setName().setHeading()` 当标题** ——
   * 那条 lint 规则要求设置标题不得重复插件名。这里用纯元素自绘（也便于做品牌排布）。
   *
   * adj739（用户要求）：「设置-说明 的前面标题和构建，应该显示如图2 和版本信息如
   * `v0.31.1 (2026-10-09 @6ac8b3eb)` 的内容才对呀」——即**照抄应用「关于」页的品牌头**：
   * 图标（与应用同一枚 `Jianpu.png`）+「爱记谱（iJipu）」+ 标语「码即成，谱自现」，
   * 版本串也**逐字对齐**应用的 `APP_VERSION_FULL` 格式：`v{版本} ({日期} @{提交})`。
   *
   * 另加一行**嵌入版应用的版本**（`WEBAPP_META.appVersion`）：这正是 0.31.1 那次
   * 「插件是 0.31.0、嵌入版还是 0.49.0」最容易看错的地方 —— 现在两条版本并排显示。
   */
  private renderHeader(containerEl: HTMLElement): void {
    const brand = containerEl.createDiv({ cls: 'ijipu-settings-brand' })
    brand.createEl('img', {
      cls: 'ijipu-settings-logo',
      attr: { src: jianpuLogoPng, alt: '爱记谱 iJipu Logo' },
    })
    const text = brand.createDiv({ cls: 'ijipu-settings-brand-text' })
    text.createDiv({ cls: 'ijipu-settings-brand-title', text: '爱记谱（iJipu）' })
    text.createDiv({ cls: 'ijipu-settings-brand-tagline', text: '码即成，谱自现' })

    // 与应用 `APP_VERSION_FULL` 同格式：插件自己的版本（`manifest.version` 即市场里那一版）
    containerEl.createDiv({
      cls: 'ijipu-settings-build',
      text: `v${this.plugin.manifest.version} (${BUILD_DATE} @${GIT_COMMIT})`,
    })
    // 嵌入版应用的版本：与上面那条并排，避免"插件版本 / 嵌入版版本"混看（E-2026-374 的由来）
    containerEl.createDiv({
      cls: 'ijipu-settings-build',
      text: `嵌入版 iJipu：v${WEBAPP_META.appVersion}（打包于 ${WEBAPP_META.generatedAt.slice(0, 10)}）`,
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
    /**
     * adj813（B2 收尾）/ **adj868（用户要求改名 + 持久化）**：**嵌入版通道**总开关。
     *
     * 它**不是**只给开发者用的东西 —— 它是「嵌入版 iJipu（应用）↔ 插件」**两条** postMessage 通道
     * 的总开关，而用户平时点的「导出 PNG / 导出 MIDI / 复制为图片」正好走**插件 → 应用**那一条。
     *
     * 旧名字「开发者：允许嵌入版调用插件能力」只描述了**应用 → 插件**那一半（而且那一半目前
     * 应用侧根本没有调用方）⇒ 用户会以为与自己无关，真去导出图片失败时也找不到原因。
     * 现在名字与说明都把两个方向写清；并**记住**开关状态（原来仅本会话有效，每次重启都要点一次）。
     *
     * 安全不变：默认关闭；打开后仍受**来源校验 + 方法白名单 + 参数校验**约束（闸门 `adj808`/`adj810`）。
     */
    new Setting(host)
      .setName('嵌入版通道（导出图片 / MIDI 需要）')
      .setDesc(
        '打开后，插件与**嵌入版 iJipu（应用）**才能互相请对方做事：\n' +
          '· 插件 → 应用：**导出 PNG / 导出 MIDI / 复制为图片**（渲染要用应用里的画布、合成要用音色库）；\n' +
          '· 应用 → 插件：能力探测与渲染（**目前仅供开发与将来使用**，日常用不到）。\n' +
          '默认关闭（安全优先）：这条通道能让页面里的代码驱动插件。打开后仍只认**本插件自己打开的嵌入版窗口**，' +
          '且方法在白名单内、参数逐项校验。\n' +
          '本开关**会记住**（存在插件设置里）；关掉它**不影响**导出 SVG / 复制 SVG 文本（那两条走插件自己的引擎）。',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.allowExternalApi).onChange((v) => {
          this.plugin.allowExternalApi = v
          new Notice(v ? 'iJipu：嵌入版通道已开启（导出图片 / MIDI 可用）' : 'iJipu：嵌入版通道已关闭')
        }),
      )

    new Setting(host)
      .setName('使用嵌入版 iJipu（完整应用）')
      .setDesc(
        '打开后：左侧栏出现「爱记谱」图标，点开即是一个**完整的 iJipu 编辑器**（编辑/排版/试听/导出都在），' +
          '并以**当前 Obsidian 文库**为工作区——不需要再选文件夹、也不需要文件系统授权。' +
          /**
           * adj773/adj775 立的口径是「点 `.jps` 先给预览、点「编辑」才进这个完整编辑器」⇒ 文案照此写。
           *
           * ⚠ adj923（用户 2026-10-13 要求 ②）**推翻了前半句**：「点击 ob 左侧的文件管理器里的 `.jps`
           * 文件，对于 **PC 端**，建议还是**直接用嵌入版 iJipu 打开**，而不是先预览 jps 文件再其它操作」。
           * ⇒ 桌面端点 `.jps` 现在**直接**进完整编辑器（按下面「打开 .jps 的方式」分派）；
           * 手机端与 `![[xx.jps]]` 内嵌不变。文案必须跟行为一起改 —— 否则用户按文案操作却得不到
           * 那个结果（adj775 当时加这条断言，防的就是这个）。
           */
          '桌面端**点库里打开 `.jps` 会直接进这个完整编辑器**（按下面「打开 .jps 的方式」分派）；\n' +
          '手机端仍是**先给谱面预览**，要用完整编辑器就点预览工具条最右的「编辑」。\n' +
          '（笔记里嵌入的 `![[xx.jps]]` 两端都仍是轻量预览。）',
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

    /**
     * adj1009（用户要求）：**预览跟随嵌入版主题**。
     *
     * 只作用于 `.jps` 文件 / ` ```jps ` 代码块的预览（背景 + 墨色）；
     * 导出/复制仍走引擎产物与导出设置，**不受这里影响**。
     */
    new Setting(host)
      .setName('预览跟随嵌入版主题')
      .setDesc(
        '`.jps` 文件与 jps 代码块的预览背景/墨色，跟随嵌入版 iJipu 的「自动 / 浅色 / 深色」设置。' +
          '**仅预览**：导出 / 复制仍按引擎产物与导出设置，不受影响。',
      )
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.previewFollowEmbedTheme !== false)
        tg.onChange((v) => {
          this.plugin.settings.previewFollowEmbedTheme = v
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

  /** 「说明」页签：设置写在哪 + 构建信息 + 运行期诊断 */
  private renderAbout(host: HTMLElement): void {
    new Setting(host)
      .setName('设置优先级（源内最高）')
      .setDesc(
        '① 引擎默认 → ② **谱面源码内的 `# jps-config` 行**（这份谱自带、跟谱走、**优先级最高**）。\n' +
          '点谱面工具条的「设置」按钮改排版时，插件会把差异写回 ② —— 所以**每一份谱都是自包含的**：' +
          '把源码复制给别人，看到的排版与你一致。',
      )

    new Setting(host)
      .setName('截图/反馈时请附上构建信息')
      .setDesc(`构建 ${BUILD_STAMP} @${GIT_COMMIT}（已显示在设置页顶部）`)

    /**
     * adj863（T-3 定稿）/ adj873（默认值改造）：**导出范围** —— 导出/复制时的画布口径。
     *
     * 三种口径（用户定名）：
     *  · **跟随视图**（`view`，**默认**，用户 2026-10-11 定稿）：与当前显示模式一致；
     *  · **导出页面**（`page`）：整页 + 四周留白 —— 与改动前完全一致；
     *  · **导出谱面**（`score`）：**墨迹包围盒 + 每边 2px**（不保留页宽）。
     *
     * 几何一律走引擎 `rangeBox()`（应用与 CLI 同一份 ✓）；`score` 需要"面板实测到的墨迹盒"，
     * 量不到时命令会**明确报错并说明原因**（不猜、也不静默退回整页 ✗）。
     */
    new Setting(host)
      .setName('导出范围（导出 / 复制时的画布口径）')
      .setDesc(
        '「跟随视图」（默认）= 与当前显示模式一致（谱面模式 ⇒ 按谱面、整页/满宽 ⇒ 按整页）；' +
          '「导出页面」= 整页 + 四周留白；「导出谱面」= **墨迹包围盒 + 每边 2px**（不保留页宽）。\n' +
          '与 `⋯ 更多 → 导出范围` 是**同一个值**。选「导出谱面」时，需要先在预览里显示过这份谱' +
          '（面板会实测墨迹盒）；量不到时会明确报错而不是猜一个尺寸。',
      )
      .addDropdown((dd) => {
        dd.addOption('view', '跟随视图（与当前显示模式一致，默认）')
        dd.addOption('page', '导出页面（整页 + 留白）')
        dd.addOption('score', '导出谱面（墨迹 + 每边 2px）')
        dd.setValue(this.plugin.settings.exportRange ?? DEFAULT_EXPORT_RANGE)
        dd.onChange((v) => {
          this.plugin.settings.exportRange = v === 'view' ? 'view' : v === 'score' ? 'score' : 'page'
          void this.plugin.saveSettings({ from: 'settingsTab' })
        })
      })

    /**
     * adj912（用户 2026-10-13 定稿）：**图片分辨率**（1× / 2× / 4×）—— 与菜单「分辨率」组是**同一个值**。
     *
     * 只作用于**位图**出口（「复制图片」与「保存为 PNG」）；SVG 是矢量 ⇒ **不受分辨率影响**
     * （「复制 SVG 文本」「保存为 SVG」不看这个值）。默认 2×（= 144 DPI），缺省值只在 `types.ts` 定义一处。
     */
    new Setting(host)
      .setName('图片分辨率（复制图片 / 保存为 PNG）')
      .setDesc(
        '`1×` = 72 DPI（体积最小，只够屏幕看）；`2×` = 144 DPI（**默认**，常见文档插图足够清晰）；' +
          '`4×` = 288 DPI（最清晰、体积最大）。\n' +
          '与 `⋯ 更多 → 分辨率` 是**同一个值**。只作用于**位图**出口（「复制图片」「保存为 PNG」）；' +
          '「复制 SVG 文本」「保存为 SVG」是**矢量**，不受分辨率影响。',
      )
      .addDropdown((dd) => {
        dd.addOption('1', '1×（72 DPI）')
        dd.addOption('2', '2×（144 DPI，默认）')
        dd.addOption('4', '4×（288 DPI）')
        dd.setValue(String(this.plugin.settings.imageScale ?? DEFAULT_IMAGE_SCALE))
        dd.onChange((v) => {
          this.plugin.settings.imageScale = v === '1' ? 1 : v === '4' ? 4 : 2
          void this.plugin.saveSettings({ from: 'settingsTab' })
        })
      })

    /**
     * adj788（用户要求）：**运行期诊断全部搬到「诊断」页签**（见 `renderDiagnostics`），
     * 并且改成**点击即复制（标题 + 内容）**，反馈时可以直接粘贴、不必截图 ⇒ 这里不再放诊断块。
     */
    this.renderAboutTail(host)
  }

  /**
   * adj788：「诊断」页签 —— 所有运行期诊断集中于此，**点击某一块即复制"标题 + 内容"**。
   *
   * 设计要点（都是为了让"反馈问题"变便宜）：
   *  · 每块都是**自描述**的：复制出来的第一行是 `【标题】`，后面跟内容 ⇒ 我拿到就能定位是哪条诊断；
   *  · 顶部有**一键复制全部**：一次性把构建信息 + 全部诊断贴成一段，省得逐块点；
   *  · 仍是"无需操作"的信息，但不再和「说明」里的有用内容混在一起（用户原话："以免干扰其它有用信息"）。
   */
  private renderDiagnostics(host: HTMLElement): void {
    /**
     * adj796（用户要求）：「要有一个相对缜密的诊断方式，不要一直来回交互，手机反馈诊断并不方便」
     * ⇒ 这里放**一个按钮**：一次取样得到"环境 + 滚动链路 + 工具条实物 + 面板布局 + 最近记录"的完整报告，
     * 且**自动复制**到剪贴板。用户点一次、粘贴一次即可定位（不必逐项截图、不必来回操作）。
     */
    new Setting(host)
      .setName('生成完整诊断报告（推荐）')
      .setDesc(
        '一次取样：环境（版本/平台/视口）＋**滚动链路**（谁可滚、谁在裁剪、沿途 overflow/touch-action）\n' +
          '＋**工具条实物**（在 DOM 哪里、是否显示、坐标、内联样式）＋面板布局＋最近交互记录。\n' +
          '点下面按钮即**自动复制**到剪贴板，直接粘贴反馈即可。',
      )
      .addButton((btn) =>
        btn
          .setButtonText('生成并复制')
          .setCta()
          .onClick(() => {
            const text = this.plugin.buildDiagnosticsReport()
            void navigator.clipboard?.writeText(text).then(
              () => new Notice(`已复制完整诊断报告（${text.length} 字符），直接粘贴即可`, 4000),
              () => new Notice('复制失败：请再点一次，或手动选中下方文本复制', 6000),
            )
          }),
      )

    new Setting(host)
      .setName('一键复制全部诊断')
      .setDesc('把「构建信息 + 下面所有诊断块」合成一段复制到剪贴板，直接粘贴反馈即可。')
      .addButton((btn) =>
        btn.setButtonText('复制全部').onClick(() => {
          const text = this.diagnosticsText()
          void navigator.clipboard?.writeText(text).then(
            () => new Notice(`已复制全部诊断（${text.length} 字符）`),
            () => new Notice('复制失败（可逐块点击复制）'),
          )
        }),
      )

    /** 构建信息放在最前 —— 我诊断问题时第一眼就要它 */
    this.diagBlock(
      host,
      '构建信息',
      `构建 ${BUILD_STAMP} @${GIT_COMMIT}\n插件版本 ${this.plugin.manifest.version}（嵌入版 ${WEBAPP_META.appVersion}）`,
    )
    /**
     * adj994（**用户 2026-10-19 口径**）：「诊断里的那些辅助调整的块如果不再需要，可以去掉，
     * 或者留一个**综合可看全貌**的就好，现在诊断块太多太杂」
     *
     * ⇒ 原来「谱面裁剪 / 预览工具条 / 点击预览区显隐工具条」三块**合成一块**，一行一项、可整块复制；
     *   三项都还是"最近一次"的记录，内容一个不丢（`生成完整诊断报告` 里也仍逐项全量输出）。
     *   仍单列的只剩两块：**构建信息**（第一眼要看）与 **嵌入版本地服务**（真会失败的那条链，属故障信息）。
     */
    this.diagBlock(
      host,
      '渲染与交互（综合 · 最近一次）',
      '这一块把原来三块（谱面裁剪 / 预览工具条 / 点击预览区显隐工具条）合成一行一项：\n' +
        `工具条：${this.plugin.lastToolbarInfo ?? '（还没触发过）点一下预览区让工具条显示一次，再回到本页'}\n` +
        `点击/滚动：${this.plugin.lastToolbarClick ?? '（还没触发过）点一下预览区试试'}\n` +
        `裁剪：${this.plugin.lastCropInfo ?? '（还没打开过谱面）打开任意一份谱，再回到本页即可看到最新一条'}`,
    )
    this.diagBlock(
      host,
      '嵌入版本地服务（诊断信息，无需操作）',
      '嵌入版（工具条的「编辑」用它）依赖插件的**本机 HTTP 服务**。这里记最近一次启动失败的原因。\n' +
        `最近一次：${this.plugin.lastEmbedError ?? '（无错误）'}\n` +
        '若显示失败：点一次「编辑」会在页签里给出"重试"按钮；仍不行可重载 Obsidian 释放端口后再试。',
    )
  }

  /**
   * adj788：渲染一个**可点击复制**的诊断块。
   *
   * 复制文本 = `【标题】\n内容`（自描述 ⇒ 我拿到就知道是哪条诊断、哪个版本的产物）。
   * 同时支持键盘（`role=button` + Enter/Space），否则纯键盘用户点不到。
   */
  private diagBlock(host: HTMLElement, title: string, body: string): void {
    const setting = new Setting(host).setName(title)
    setting.settingEl.addClass('ijipu-diag')
    const box = setting.descEl.createDiv({ cls: 'ijipu-diag-box' })
    box.setAttr('role', 'button')
    box.setAttr('tabindex', '0')
    box.setAttr('title', '点击复制（标题 + 内容）')
    box.createDiv({ cls: 'ijipu-diag-body', text: body })
    box.createDiv({ cls: 'ijipu-diag-hint', text: '点击此处复制（标题 + 内容），可直接粘贴反馈' })
    const copy = (): void => {
      const text = `【${title}】\n${body}`
      void navigator.clipboard?.writeText(text).then(
        () => new Notice(`已复制诊断：${title}`),
        () => new Notice('复制失败（可手动选中文本复制）'),
      )
    }
    box.addEventListener('click', copy)
    box.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      copy()
    })
  }

  /** adj788：「一键复制全部诊断」用的整段文本（构建信息 + 各诊断块，自带标题） */
  private diagnosticsText(): string {
    /**
     * adj994（用户口径：诊断块太多太杂 ⇒ 综合成一块）：这里的文本也跟着合并，
     * 否则"复制全部"与设置页上看到的块**对不上**（用户拿起两段对比会以为其中一段过期了）。
     */
    const blocks: Array<[string, string]> = [
      ['构建信息', `构建 ${BUILD_STAMP} @${GIT_COMMIT}\n插件版本 ${this.plugin.manifest.version}（嵌入版 ${WEBAPP_META.appVersion}）`],
      [
        '渲染与交互（综合 · 最近一次）',
        `工具条：${this.plugin.lastToolbarInfo ?? '（还没触发过）'}\n` +
          `点击/滚动：${this.plugin.lastToolbarClick ?? '（还没触发过）'}\n` +
          `裁剪：${this.plugin.lastCropInfo ?? '（还没打开过谱面）'}`,
      ],
      ['嵌入版本地服务（诊断信息，无需操作）', this.plugin.lastEmbedError ?? '（无错误）'],
    ]
    return blocks.map(([t, b]) => `【${t}】\n${b}`).join('\n\n')
  }

    /**
     * adj736（用户判断）：**取消 frontmatter 这一块**。
     *
     * 用户原话：「这处的复制最小模板对于用户来说意义不大；复制 frontmatter 模板，对于用户来说太复杂，
     * 用户根据不知道什么时候用什么，没有变量的说明。我的意见是这块 jps 文件用不上，对于多 jps 代码块的
     * 笔记又显粗糙，考虑一下，取消 frontmatter 这块的内容，jps 代码块里也使用 `# jps-config:{}` 还携带设置更佳」。
     *
     * 查证（用户判断正确）：`.jps` 文件视图与内联嵌入**本来就传 `null`**（`fileView.ts` / `embed.ts` 的
     * `getFrontmatter()` 都硬编码 null）⇒ 笔记 frontmatter 只对 ` ```jps ` 代码块生效；
     * 而它是**笔记级**的（一个笔记里多个 ` ```jps ` 块会被同一套值一起覆盖 ⇒ 正是用户说的"显粗糙"），
     * 且**不随谱走**（别人拿到同一份谱看不到同样排版）。
     * 相反，**源内的 `# jps-config:{…}`** 既"跟着谱走"、又能**逐块**写 —— 它本来就是引擎与本插件的唯一口径。
     *
     * 所以这里只留一句指引（写在哪、怎么改、多个块怎么办），并撤掉那两个"复制模板"按钮：
     * 它们要求用户先理解"frontmatter 是什么、什么时候用完整模板/最小模板"，对使用者没有价值。
     */
  /**
   * adj788：原 `renderAbout` 的**后半段**（与诊断无关的有用信息）——拆出来只是为了让"诊断搬家"这一步
   * 改动面最小；内容一字未动。
   */
  private renderAboutTail(host: HTMLElement): void {
    new Setting(host)
      .setName('谱面设置写在哪里（跟着谱走）')
      .setDesc(
        '**写在谱面里**：代码块里用 `# jps-config:{…}` 一行携带这份谱的设置，' +
          '别人打开同一份谱看到的排版就与你一致。\n' +
          '不必手写 JSON：点谱面工具条的「**设置**」按钮，图形界面改完会**自动写回**这一行' +
          '（只写与默认不同的项）。\n' +
          '⚠ 一个笔记里有多个 ` ```jps ` 块时，**每块各自写自己的** `# jps-config`；' +
          '`.jps` 文件同理（写在文件里）。',
      )

    /**
     * adj741（手机端 P0）：**音源（音色库）入口**。
     *
     * 桌面端这套 UI 原本只在"嵌入版 iJipu"里（`设置 → 全局 → 音色库`），而手机端没有嵌入版
     * ⇒ 手机用户**够不着**任何导入入口，只能走 32 MB 联网下载（流量 + 内存都不友好）。
     * 而用户明确交代过：**音源默认走插件目录里的文件**。所以这里补一个最小入口：
     *  · 说明默认顺序（插件目录文件 → 本机缓存 → 联网下载）；
     *  · 一个「导入 .sf2…」按钮（复用 `plugin.importSoundfont`，写入插件目录，
     *    该文件在「配置目录/plugins/ijipu/soundfonts/」下，可随文库一起同步）；
     *  · 异步补一行"当前插件目录里已有哪些文件"。
     */
    /**
     * adj772（Obsidian 社区审核）：提示文案里**不再硬编码 `.obsidian`** ——
     * 配置目录可由用户改名（审核点：`Vault#configDir`），所以按实际值拼出来给用户看。
     */
    const bankDirHint = `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/soundfonts/<id>.sf2`
    const bank = new Setting(host)
      .setName('音色库（高保真试听的音源）')
      .setDesc(
        `试听优先用**插件目录里的文件**：\`${bankDirHint}\`\n` +
          '（顺序：插件目录文件 → 本机缓存 → 联网下载；想完全离线就先把文件导入进来）。\n\n' +
          '当前：正在读取…',
      )
      .addButton((b) =>
        b.setButtonText('导入 .sf2…').onClick(() => {
          void (async () => {
            const r = await this.plugin.importSoundfont(HQ_LIBRARIES[0]?.id ?? 'generaluser_gs')
            new Notice(
              r.ok
                ? '已导入音色库文件（试听将直接用它，不再联网）'
                : r.canceled
                  ? '已取消导入'
                  : `导入失败：${r.error ?? '未知原因'}`,
              4000,
            )
            // adj724b（社区审核 1.13+）：重画设置页用 `update()`，它是声明式设置的正规刷新入口
            this.update()
          })()
        }),
      )
    void (async () => {
      const lines: string[] = []
      for (const lib of HQ_LIBRARIES) {
        const p = this.plugin.soundfontPath(lib.id)
        const ab = await this.plugin.readSoundfont(lib.id)
        if (ab) {
          lines.push(`${lib.name}：已就位（${(ab.byteLength / 1024 / 1024).toFixed(1)} MB，${p}）`)
        } else {
          lines.push(`${lib.name}：未导入（首次试听会联网下载约 32 MB）`)
        }
      }
      bank.setDesc(
        `试听优先用**插件目录里的文件**：\`${bankDirHint}\`\n` +
          '（顺序：插件目录文件 → 本机缓存 → 联网下载；想完全离线就先把文件导入进来）。\n\n' +
          `当前：\n${lines.join('\n')}`,
      )
    })()

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

    /**
     * adj730（用户报「插件里『支持』里的微信赞赏码不见了」）：**恢复赞赏入口**。
     *
     * 查证：这条入口在 `6934155` 加过（设置页顶部一个 `支持作者 ❤` 外链），
     * 后来 `ebb0e5c`（adj724b"设置整并"）把它一起删掉了 —— 本轮补回。
     *
     * 用户随后要求：「good.png 已经缩到 320 宽，请放宽 gitignore 的限制，并加入内联」——
     * 于是这里**把赞赏码直接显示出来**（设置页里就能扫，不必点开浏览器）：
     *  · 图片与应用**同一张**（`ijipu/public/icons/good.png` → 本仓库 `vendor/icons/good.png`，
     *    320×320 / 约 39 KB，逐字节相同），构建期内联成 data URI ⇒ **不联网、不加载远程资源**；
     *  · `.gitignore` 里原来把 `good.png` 当"应用资源误拷"排除掉了，现已放宽（该段注释写明了原因）——
     *    ⚠ 这一点是**硬约束**：被忽略的文件进不了仓库，而 CI 从干净检出构建 main.js，
     *    解析不到 ⇒ 发版直接失败（冒烟有一条断言专门钉住 .gitignore 不得再忽略它）。
     *  · 白底由 CSS 给（`.ijipu-donate-qr`）：二维码在深色主题的深色底上扫不动。
     *
     * adj734（用户要求）：**文案改成一句、并去掉「在浏览器打开」按钮** ——
     * 码就在正下方，再给一个外链既是多余入口、也把说明拖长（原文案还把 URL 摊在设置页里）。
     * 现在的说明：「如果这个插件帮到了你，欢迎扫码下方的微信赞赏码支持一下。」
     */
    new Setting(host).setName('支持作者 ❤').setDesc('如果这个插件帮到了你，欢迎扫码下方的微信赞赏码支持一下。')
    const qrWrap = host.createDiv({ cls: 'ijipu-donate-qr-wrap' })
    qrWrap.createEl('img', {
      cls: 'ijipu-donate-qr',
      attr: { src: donateQrPng, alt: '微信赞赏码', title: '微信扫码赞赏' },
    })
    qrWrap.createDiv({ cls: 'ijipu-donate-hint', text: '微信扫码赞赏 · 谢谢支持' })
  }
}
