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
import { DEFAULT_EMBED_OPEN_MODE, type EmbedOpenMode } from './types'
// adj730：微信赞赏码（与应用「关于」页同一张图；构建期内联成 data URI，不联网）
import donateQrPng from '../vendor/icons/good.png'
import type IJipuPlugin from './main'

// adj734（用户要求）：赞赏码只**内联显示**在设置页里（扫码即可），
// 不再给「在浏览器打开」外链 —— 所以这里也不需要 `DONATE_URL` 常量了。
// adj738：`frontmatterKey` 的转出随"笔记 frontmatter 层"一并删除。

/** 设置页签（adj631：一屏一组，减少滚动；adj724b：只剩两页） */
export type SettingsTabId = '嵌入版' | '说明'
export const SETTINGS_TABS: SettingsTabId[] = ['嵌入版', '说明']

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
    new Setting(host)
      .setName('使用嵌入版 iJipu（完整应用）')
      .setDesc(
        '打开后：左侧栏出现「爱记谱」图标，点开即是一个**完整的 iJipu 编辑器**（编辑/排版/试听/导出都在），' +
          '并以**当前 Obsidian 文库**为工作区——不需要再选文件夹、也不需要文件系统授权。' +
          /**
           * adj773/adj775（用户要求「点击 jps 文件显示预览」）：**文案必须跟行为一致**。
           * 这里原来写的是"在库里打开 `.jps` 会用这个完整编辑器打开" —— 改过行为后那句已经不对了：
           * 现在点 `.jps` **一律先给谱面预览**（PC 与手机一致），要用完整编辑器就点预览工具条最右的「编辑」。
           */
          '点库里打开 `.jps` **一律先给谱面预览**（PC 与手机端一致）；要用这个完整编辑器，' +
          '点预览工具条最右的「编辑」即可（笔记里嵌入的 `![[xx.jps]]` 仍是轻量预览）。',
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
     * adj724b：**「谱面」视图的裁剪实况**（运行期诊断）。
     * 用户实测"谱面还是有 A4 那么大空白"时，这一行能立刻区分：
     *  · 显示"按墨迹裁剪 w×h（整页 W×H，高度只剩 N%）" ⇒ 裁剪**已生效**（N 很小说明收得很紧）；
     *  · 显示"退回按边距裁剪" ⇒ 内容盒没量到（渲染时机问题，会自动补量）；
     *  · 显示"（还没渲染过谱面）" ⇒ 打开过的谱面还没渲染过。
     *
     * adj735（用户问「设置-说明 里的这处是做什么用？没看明白」）：
     * 定位一句话说清"它是什么、给谁看、要不要操作"，并把运行期记的那条改成
     * **`HH:MM:SS · 人话`**（见 `scorePane.ts` 的 `noteCrop`）——
     * 旧文案那种"页面内容包围盒：三次重试都没量到（元素始终不在渲染树里？）"既不友好、
     * 也没有时间信息，用户看到只会担心"是不是坏了"。
     */
    new Setting(host)
      .setName('谱面裁剪（诊断信息，无需操作）')
      .setDesc(
        '打开谱面时自动记录的一条信息：说明默认的「**谱面**」视图有没有**按墨迹裁掉四周空白**\n' +
          '（「整页 / 满宽」两个视图不受影响）。看不懂也没关系，它只在排查"谱面周围留白"时有用；\n' +
          '反馈问题时把它连着构建信息一起截图给我即可。\n\n' +
          '最近一次：' +
          (this.plugin.lastCropInfo ?? '（还没打开过谱面）打开任意一份谱，再回到本页即可看到最新一条'),
      )

    /**
     * adj740（用户第二次报「预览区左上工具条在**编辑视图**下还是不可见，只能在阅读视图下可见」）：
     * **工具条显示诊断** —— 与上面那条裁剪诊断同一套路，专治"我看不到真机 DOM"。
     *
     * 记录的是**定位真因所需的最小事实集**：宿主是哪一类（实时预览 / 阅读视图）、
     * 显示类有没有加上去、工具条的最终样式与屏幕坐标、谱面块坐标、以及**裁剪祖先链上每一层发生了什么**。
     * 复现方式：在编辑视图里把鼠标移到谱面上（触发一次显示），再回到本页截图。
     */
    new Setting(host)
      .setName('预览工具条（诊断信息，无需操作）')
      .setDesc(
        '在**编辑视图**里把鼠标移到谱面上（触发一次显示），然后回到本页即可看到最新一条。\n' +
          '它回答"工具条为什么没显示"：宿主类型、显示类、最终样式（opacity/visibility/position）、\n' +
          '屏幕坐标，以及从谱面往上每一层**裁剪祖先**是被放开了还是因为是滚动容器而保留。\n\n' +
          '最近一次：' +
          (this.plugin.lastToolbarInfo ?? '（还没触发过）把鼠标移到谱面上试试'),
      )

    /**
     * adj775（用户报「点编辑开了页签/右栏，但没有嵌入版显示」）：**嵌入版启动诊断**。
     *
     * 为什么必须显示出来：嵌入版要把整页应用放进 iframe，前提是插件的**本机 HTTP 服务**起得来
     * （固定端口 47821，被占则回退随机端口）。起不来时视图会画出"失败原因 + 重试"，
     * 但那条提示会随页签关闭而消失 ⇒ 在这里留一份**最近一次失败原因**，用户可以直接贴给我定位。
     */
    this.containerEl.createEl('h3', { text: '嵌入版 iJipu（预览工具条的「编辑」用它）' })
    new Setting(this.containerEl)
      .setName('嵌入版本地服务（诊断信息，无需操作）')
      .setDesc(
        '最近一次启动失败的原因（成功则为「（无错误）」）：\n' +
          (this.plugin.lastEmbedError ?? '（无错误）') +
          '\n\n若这里显示失败：点一次「编辑」会在页签里给出"重试"按钮；' +
          '仍不行可重载 Obsidian 释放端口（47821）后再试。',
      )

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
