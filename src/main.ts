import { Events, Keymap, MarkdownRenderChild, MarkdownView, Notice, Platform, Plugin, TFolder, TFile, type MarkdownSectionInformation, type WorkspaceLeaf } from 'obsidian'
import { IJipuSettingTab } from './settings'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { registerJpsEmbeds } from './embed'
import { IJipuFileView, JPS_EXTENSION, VIEW_TYPE_IJIPU } from './fileView'
import { createJpsFile, consumeJpsLinkCreate, materializeJpsFile, planJpsLinkCreate, registerJpsFileCreator, unregisterJpsFileCreator, NEW_JPS_TEMPLATE } from './newFile'
import { replaceCodeBlockBody } from './sourceEdit'
import { canOpenWithDefaultApp, openWithDefaultApp } from './openExternal'
import { DEFAULT_EMBED_OPEN_MODE, type EmbedOpenMode, type IJipuSettings } from './types'
import { IJipuBridge } from './embed/bridge'
import { embedEditLeavesObsidian, planEmbedTarget } from './embed/openPlan'
/**
 * adj741（用户决定：按 P0"一版多端"做，见任务 1）—— **嵌入版 iJipu 的本地服务必须按需加载**。
 *
 * `./embed/server` 里是 `node:http` + `node:crypto`（把嵌入版单文件网页提供给 iframe）。
 * 这两样在 Obsidian **手机端不存在**：静态 `import` 会在**加载插件**时就解析失败 ⇒
 * 整个插件起不来（连"手机端最需要的"普通预览都一起没了）。所以：
 *  · 这里只保留**类型**导入（`import type` 编译期擦除，不产生运行时 require）；
 *  · 真正的 `import('./embed/server')` 放进 `loadEmbedServer()`，且**仅桌面端**调用。
 * 这条由冒烟断言钉住（"手机端路径不得静态引用 node:*"）。
 */
import type { EmbedServer } from './embed/server'
import { IJipuAppView, VIEW_TYPE_IJIPU_APP } from './embed/appView'
import { HQ_LIBRARIES } from './soundbank'
import { createBankFileStore, type BankFileStore } from './bankFile'
// @ts-ignore esbuild 以 text loader 把 worklet 内联为字符串（main.js 单文件自包含，无需插件目录单独 worklet）
import workletCode from '../spessasynth_processor.min.js'

/** 插件内事件广播：设置面板保存后触发，打开中的谱面据此即时重渲染 */
export const SETTINGS_CHANGED = 'settings-changed'
/** 插件内事件广播：「排版辅助虚线」开关变化（所有面板同步） */
export const GUIDES_CHANGED = 'guides-changed'

/**
 * obsidian-ijipu —— 在 Obsidian 笔记里用 ```jps 代码块渲染可视化简谱并可试听。
 *
 * 三种入口共用同一渲染面板（`scorePane.ts`）：
 *  ① ```jps 代码块（正文即 .jps 源码，与 iJipu 打开的文件内容一致）
 *  ② `.jps` 文件视图（插件启用后 Obsidian 把 .jps 识别为简谱文件，`[[xxx.jps]]` 可直接打开）
 *  ③ `![[xxx.jps]]` 嵌入（在笔记里内联渲染该谱）
 * 页面设置优先级：引擎默认 < 插件设置 < 笔记 frontmatter < 谱面源码内 `# jps-config`（最高）。
 * 「⚙ 排版」改的是**当前这一份谱**，保存即写回源码（代码块写回笔记正文、文件/嵌入写回 .jps）。
 */
export default class IJipuPlugin extends Plugin {
  settings: IJipuSettings = {}
  /** 插件内事件广播（当前用于设置变更 → 打开中的谱面即时重渲染） */
  readonly events = new Events()
  /** 「排版辅助虚线」是否显示（与 iJipu 顶栏「排版」按钮同一个开关；所有面板共享、不落盘） */
  showGuides = false
  /** 所有进行中试听的停止函数（切换笔记/卸载时统一停止） */
  private playStops: (() => void)[] = []
  /** 内置 SpessaSynth worklet URL（worklet 代码内联进 main.js → Blob URL，随插件单文件分发） */
  private workletUrl = ''
  /**
   * adj729（用户要求）：**音色库落在插件目录**里的存储层
   * （`<配置目录>/plugins/<插件 id>/soundfonts/<库 id>.sf2`）。
   *
   * 用户原话：「音色库下载或导入后，建议放在插件目录中，以便能随文库一起走」——
   * 此前只存 IndexedDB（还分两个 origin），换机器/换库就没了、也**不随文库同步**。
   */
  private bankFiles: BankFileStore | null = null
  /** adj631：「设置 → iJipu」页签的"就地重画"回调（别处改了插件设置时保持两边显示一致） */
  private settingsRefresh: (() => void) | null = null
  /**
   * adj724b（嵌入版）：本地 HTTP 服务 + 桥。
   *
   * 服务**懒启动**（第一次需要 iframe 时才起），启动中保存 Promise 以便并发调用共享同一次启动。
   * 关掉「使用嵌入版 iJipu」或卸载插件时释放。
   */
  private embedServer: EmbedServer | null = null
  private embedServerStarting: Promise<EmbedServer> | null = null
  /** 桥（vault 读写 + postMessage 路由）；`onload` 里建，因为要读设置 */
  bridge!: IJipuBridge
  /** 左侧栏图标元素（设置开关切换时显隐） */
  private ribbonEl: HTMLElement | null = null
  /** adj724b：每个应用页签"待打开的文件"（`.jps` 的文库相对路径），应用 `ready` 后由桥取走 */
  readonly pendingOpenPaths = new Map<string, string>()
  /** 自增的页签令牌（`WorkspaceLeaf` 没有稳定 id ⇒ 自己发一个，随 ViewState 传给视图） */
  private leafSeq = 0

  /** 切换排版辅助虚线（显示后可拖动虚线调边距/行距），并通知所有面板重画 */
  toggleGuides(): boolean {
    this.showGuides = !this.showGuides
    this.events.trigger(GUIDES_CHANGED)
    return this.showGuides
  }

  async onload(): Promise<void> {
    await this.loadSettings()
    this.workletUrl = this.makeWorkletUrl()
    // adj729：音色库文件的落点 = 插件自己的目录（`manifest.dir` 由 Obsidian 给出）
    this.bankFiles = createBankFileStore(this.app, this.manifest.dir ?? '.obsidian/plugins/ijipu')
    // adj741：留一份设置页实例的引用，供"打开音色库"（手机端）把设置面板切到「说明」页签
    this.settingsTab = new IJipuSettingTab(this.app, this)
    this.addSettingTab(this.settingsTab)

    // ① .jps 文件识别：注册专用视图 → 打开 .jps（含 [[xxx.jps]] 链接）即渲染为简谱
    this.registerView(VIEW_TYPE_IJIPU, (leaf) => new IJipuFileView(leaf, this))
    this.registerExtensions([JPS_EXTENSION], VIEW_TYPE_IJIPU)
    // ② ![[xxx.jps]] 嵌入兜底（Obsidian 已渲染则不重复渲染）
    registerJpsEmbeds(this)
    // ③ ```jps 代码块
    this.registerMarkdownCodeBlockProcessor('jps', (source, el, ctx) => {
      ctx.addChild(new IJipuBlock(this, source, el, ctx.sourcePath, () => safeSectionInfo(ctx, el)))
    })

    /**
     * ④ 文件列表里**文件夹右键菜单** → 「新建 JPS 文件」（用户要求）。
     *
     * `file-menu` 对文件与文件夹都会触发，这里只认文件夹（`TFolder`）；
     * 建好即打开（`.jps` 已注册为简谱视图 ⇒ 直接进谱面），命名与模板见 `newFile.ts`。
     * `setSection('action-primary')` = Obsidian 自带「新建笔记 / 新建文件夹」同一组
     * （从 `obsidian.asar` 核实的 section 名，见 `docs/RELEASE-NOTES.md`），排在它们之后。
     */
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder)) return
        menu.addItem((item) =>
          item
            .setTitle('新建 JPS 文件')
            .setSection('action-primary')
            .setIcon('file-plus')
            .onClick(() => void createJpsFile(this.app, file)),
        )
      }),
    )

    /**
     * ⑤ 点击**指向不存在的 `.jps` 的内部链接**（`[[谱名.jps]]`）→ 自动建文件并打开（用户要求）。
     *
     * 为什么用 document 上的**捕获**阶段监听：Obsidian 自己的链接点击处理挂在 `<a>` 元素上
     * （`t.onClickEvent(...)`，内部还看 `e.defaultPrevented`），捕获阶段先跑才能把它拦下来
     * ——这一步必须**同步**完成，所以判断逻辑抽成了纯函数 `planJpsLinkCreate`；
     * 建文件是异步的，放到拦截之后。
     */
    this.registerDomEvent(document, 'click', (evt) => this.onLinkClick(evt), { capture: true })

    /**
     * ⑥ 让 Obsidian 自己也把 `[[谱名.jps]]` 认成 **`.jps` 文件**（用户报：此前会建成 `谱名.jps.md`）。
     *
     * 注册创建器后，**非点击**路径（`Ctrl+Enter` 跟随链接、悬浮预览里的"打开链接"、
     * 其它插件调 `openLinkText`）也会正确建成 `谱名.jps`（落在链接所在笔记的同级目录）。
     * 那条路径建出来是**空文件** ⇒ 建完补默认模板。
     */
    registerJpsFileCreator(this.app)
    this.register(() => unregisterJpsFileCreator(this.app))
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile) || file.extension !== JPS_EXTENSION) return
        if (!consumeJpsLinkCreate()) return
        if (file.stat.size === 0) void this.app.vault.modify(file, NEW_JPS_TEMPLATE)
      }),
    )

    // 切换笔记时自动结束所有试听（避免试听继续却失去控制）
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.stopAll()))

    /**
     * adj748（用户报：「jps 文件的源码模式切回**阅读模式**，还是源码，只是显示方式不同，
     * 而不是我们所希望的**预览视图**」）：
     *
     * 起因是 `adj744`：手机端「✎ 源码」把那个页签换成了**宿主的 markdown 视图**（源码模式）。
     * 于是用户再切"阅读模式"时，宿主的 markdown **阅读视图**又把这个 `.jps` 当 markdown 渲染
     * ⇒ 看到的还是源码（只是排版不同），**不是我们的谱面预览**。
     *
     * 期望的心智模型（用户原话）：**源码模式 = 宿主编辑器；阅读模式 = 我们的预览视图**。
     * 做法：监听布局变化，凡是"**某个 `.jps` 文件正躺在 markdown 视图的阅读模式里**"，
     * 就把它按扩展名重新打开 —— `.jps` 注册给本插件的文件视图 ⇒ 自动换回**谱面预览**。
     * （不监听源码模式：那条正是用户要的编辑态，保持不动；因此也不会来回打架。）
     */
    const schedulePreviewRestore = (): void => {
      if (this.previewRestorePending) return
      this.previewRestorePending = true
      window.requestAnimationFrame(() => {
        this.previewRestorePending = false
        this.restoreJpsPreview()
      })
    }
    this.registerEvent(this.app.workspace.on('layout-change', schedulePreviewRestore))
    this.registerEvent(this.app.workspace.on('active-leaf-change', schedulePreviewRestore))
    this.registerEvent(this.app.workspace.on('file-open', schedulePreviewRestore))

    /**
     * ⑦ adj724b（嵌入版）：完整 iJipu 应用页签。
     *
     * 三件事：
     *  ① 建桥（vault 读写 + postMessage 路由）——需要设置，故在 `loadSettings` 之后；
     *  ② 注册应用视图 + 左侧栏图标（图标显隐由设置项控制，见 `syncEmbedRibbon`）；
     *  ③ 全局收一条 `message` 监听（两个页签的 iframe 共用同一个桥）。
     */
    this.bridge = new IJipuBridge({
      app: this.app,
      token: '', // 服务启动后由 syncEmbedToken 填
      root: '',
      theme: () => (document.body.classList.contains('theme-dark') ? 'dark' : 'light'),
      // adj724b：把设置里的「跟随 Obsidian 主题」告知应用（它据此决定覆盖还是尊重用户选择）
      followTheme: () => this.settings.embedFollowTheme !== false,
      // adj724b：应用侧偏好/设置 → 插件 `data.json`（与 iframe 的 origin/端口解耦）
      kv: {
        all: async () => ({ ...this.embedKv }),
        get: (k) => this.embedKvGet(k),
        set: (k, v) => this.embedKvSet(k, v),
        remove: (k) => this.embedKvRemove(k),
      },
      /**
       * adj729（用户要求）：**音色库落在插件目录**——把"按 id 取的音源 URL"与"由插件导入"交给应用：
       *  · `bankUrls()`：应用不再自己下 32 MB，直接取插件目录里那份（随文库同步）；
       *  · `importSoundbank(id)`：应用里点「导入音色文件」时，由**插件**弹文件选择器并写进插件目录
       *    （32 MB 走 postMessage 要 base64 ≈43 MB，慢且吃内存 —— 让插件自己挑、自己写盘最省）。
       */
      bankUrls: () => this.bankUrls(),
      importSoundbank: (id) => this.importSoundfont(id),
    })
    // adj741：嵌入版 iJipu 的**完整编辑器视图**只注册在桌面端（它依赖本地 HTTP 服务）
    if (Platform.isDesktopApp) this.registerView(VIEW_TYPE_IJIPU_APP, (leaf) => new IJipuAppView(leaf, this))
    this.registerDomEvent(window, 'message', (ev) => {
      void this.bridge.handle(ev)
    })
    this.addCommand({
      id: 'open-app',
      name: '打开爱记谱',
      callback: () => void this.openIjipuApp(),
    })
    /**
     * adj746（用户要求：「源码如果能够按我们应用的规范格式化就更好了」）：
     * 命令面板入口（手机上尤其有用——不必去点文件工具条）。
     * 只对**当前打开的 `.jps` 文件视图**生效；代码块里的谱面请在谱面工具条上点「↹ 格式化」。
     */
    this.addCommand({
      id: 'format-jps',
      name: '格式化当前 .jps 源码（应用规范）',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(IJipuFileView)
        if (!view) return false
        if (!checking) view.formatSource()
        return true
      },
    })
    this.syncEmbedRibbon()

    /**
     * adj724b：**把"库里的 `.jps` 被改了"推给嵌入版**（用户口径：外部修改要能被发现并提示）。
     *
     * 注意：嵌入版**自己每次即时保存也会触发这个事件**。所以这里不做判断，
     * 一律推给应用，由应用**比对内容**决定要不要提示（内容一致 ⇒ 我们自己写的 ⇒ 不打扰）。
     */
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!this.embedEnabled) return
        if (!(file instanceof TFile) || file.extension !== JPS_EXTENSION) return
        this.bridge.broadcast('fileChanged', { path: file.path })
      }),
    )
  }

  /**
   * 链接点击：只有「未解析 + `.jps` + 文件确实不存在」才接管。
   *
   * 与 Obsidian 的跟随语义保持一致：**源码模式**（非实时预览）下要按住 Ctrl/Cmd 才跟随链接，
   * 这里同样要求修饰键——否则点一下链接想放光标，却把文件建出来了。
   */
  private onLinkClick(evt: MouseEvent): void {
    const el = evt.target as HTMLElement | null
    const a = el?.closest?.('a.internal-link') as HTMLAnchorElement | null
    if (!a || !a.classList.contains('is-unresolved')) return
    const inEditor = a.closest('.cm-editor') !== null
    const livePreview = a.closest('.is-live-preview') !== null
    if (inEditor && !livePreview && !evt.ctrlKey && !evt.metaKey) return
    const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? ''
    const plan = planJpsLinkCreate(href, this.linkSourcePath(a), (p) => this.app.vault.getAbstractFileByPath(p) !== null)
    if (!plan) return
    // 同步拦下这次点击（再异步建文件）：否则事件会继续冒泡到 Obsidian 的链接处理器
    evt.preventDefault()
    evt.stopPropagation()
    void (async () => {
      const file = await materializeJpsFile(this.app, plan.path)
      if (file) await this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file)
    })()
  }

  /** 链接所在笔记的路径（嵌入 `![[笔记]]` 里的链接要按**被嵌入那篇**的目录算） */
  private linkSourcePath(el: HTMLElement): string {
    const embed = el.closest('.internal-embed, .markdown-embed') as HTMLElement | null
    const src = embed?.getAttribute('src')
    if (src) return src.split('#')[0]
    return this.app.workspace.getActiveFile()?.path ?? ''
  }

  onunload(): void {
    // 插件卸载（禁用/重载）时兜底停止所有试听
    this.stopAll()
    // adj724b：把嵌入版偏好的最后一次改动立即落盘（防抖窗口内的改动别丢）
    this.flushEmbedKv()
    // adj724b：释放本地服务（不释放会占着端口直到 Obsidian 退出）
    void this.disposeEmbed()
  }

  /** 停止所有进行中的试听 */
  stopAll(): void {
    for (const stop of this.playStops) stop()
    this.playStops = []
  }

  // ───────────────────────── adj724b：嵌入版（完整 iJipu） ─────────────────────────

  /** 嵌入版是否启用（设置开关；未设置视为开，符合"装上就能用"的预期） */
  get embedEnabled(): boolean {
    return this.settings.embedIjuipu !== false
  }

  /**
   * adj741：**按需加载**嵌入版本地服务模块（`node:http`/`node:crypto` 只存在于桌面端）。
   *
   * 手机端直接返回 `null`（调用方据此回退到原生渲染）；桌面端只加载一次并记住模块，
   * 同时把 `SOUNDFONT_URL_PREFIX` 记下来供同步函数 `bankUrls()` 用（它不能 await）。
   */
  private embedServerModule: typeof import('./embed/server') | null = null
  /** adj741：设置页实例（手机端"打开音色库"要把它切到「说明」页签） */
  private settingsTab: IJipuSettingTab | null = null
  /** adj748：`restoreJpsPreview()` 的合并标记（布局事件会连续来好几次，一帧只处理一次） */
  private previewRestorePending = false

  /**
   * adj748：把"躺在 markdown **阅读模式**里的 `.jps`"换回本插件的**谱面预览**。
   *
   * 判据三件：① 该 leaf 是 markdown 视图；② 它的文件扩展名是 `jps`；③ 视图模式是 `preview`（阅读模式）。
   * 命中就 `leaf.openFile(file)` —— `.jps` 在本插件里注册为专用视图，于是自动换成谱面预览。
   * ⚠ 只在阅读模式下动作：源码模式是用户要的编辑态（`adj744`），绝不打扰，因此不会来回切。
   */
  private restoreJpsPreview(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as unknown as { file?: TFile | null; getMode?: () => string }
      const file = view.file
      if (!file || file.extension !== JPS_EXTENSION) continue
      if (typeof view.getMode === 'function' && view.getMode() !== 'preview') continue
      void leaf.openFile(file)
    }
  }

  /**
   * adj741：打开本插件的设置面板并切到指定页签（手机端点"打开音色库"时用）。
   * 走 Obsidian 的 `app.setting.open()` + `openTabById`（这是官方入口；拿不到就静默跳过）。
   */
  openSettingsTab(tab: '嵌入版' | '说明'): void {
    const setting = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void }
    }).setting
    setting?.open()
    setting?.openTabById(this.manifest.id)
    this.settingsTab?.activate(tab)
  }
  /** adj741：从按需加载的模块里取到的音源路径前缀（`bankUrls()` 同步用） */
  private soundfontPrefix = 'soundbanks/'

  private async loadEmbedServer(): Promise<typeof import('./embed/server') | null> {
    if (!Platform.isDesktopApp) return null
    if (!this.embedServerModule) {
      this.embedServerModule = await import('./embed/server')
      this.soundfontPrefix = this.embedServerModule.SOUNDFONT_URL_PREFIX
    }
    return this.embedServerModule
  }

  /**
   * 取 iframe 要加载的 URL；**懒启动**本地服务。
   *
   * 并发调用共享同一次启动（`embedServerStarting`），避免两个页签同时打开时起两个服务。
   * 服务启动后把 token 与工作区根告知桥。
   *
   * adj741：手机端**没有** `node:http` ⇒ 这里直接返回 `null`（调用方回退原生预览），
   * 而不是让静态导入把整个插件拖垮。
   */
  async getEmbedUrl(): Promise<string | null> {
    if (!this.embedEnabled && this.embedServer === null) return null
    if (!Platform.isDesktopApp) return null
    if (!this.embedServerStarting) {
      const mod = await this.loadEmbedServer()
      if (!mod) return null
      this.embedServerStarting = mod
        .startEmbedServer({
          workletCode,
          // adj729：把插件目录里的音源文件按路径交给嵌入版应用（同一个文件，随文库同步）
          readSoundfont: (id) => this.readSoundfont(id),
        })
        .then((s) => {
          this.embedServer = s
          this.bridge.setToken(s.token)
          /**
           * 工作区根一律是 **`''`（文库根）**：宿主按"文库相对路径"读写，
           * 应用侧记录的 `path` 也存文库相对路径 ⇒ 两者同口径。
           * 设置里的「子目录」是**进入工作区后的初始目录**，由应用侧 `makeVaultWorkspaceRecord`
           * 的 `path` 表达（这样"换目录"仍是应用内的正常导航，不会把用户锁死在子目录里）。
           */
          this.bridge.setRoot('')
          return s
        })
    }
    const s = await this.embedServerStarting
    return s.url
  }

  /**
   * 同步版本的 URL（只读已启动的服务）。
   *
   * `.jps` 文件视图的 `render()` 是**同步**的（`TextFileView` 的既有约定），
   * 没法 `await` 服务启动 ⇒ 用这个：**已启动**就给 URL，没启动就触发一次启动并返回 `null`
   * （该次渲染回退到轻量渲染，服务就绪后用户再打开就是完整版）。
   */
  peekEmbedUrl(): string | null {
    if (this.embedServer) return this.embedServer.url
    void this.getEmbedUrl() // 预热：下次打开即完整版
    return null
  }

  /**
   * adj724b：**嵌入版的偏好/设置存储**（落在插件自己的 `data.json`）。
   *
   * 为什么不能只用浏览器的 `localStorage`：它按 **origin** 隔离，而嵌入页面的 origin 是
   * `http://127.0.0.1:<port>` —— 端口一变就是"另一个站点" ⇒ 设置读不回来
   * （用户实测：「嵌入版本的全局设置没有保存，ob 重启后恢复为默认」）。
   * 存进插件设置文件后，与端口/origin 彻底解耦（换电脑/换浏览器都不丢）。
   */
  private embedKv: Record<string, string> = {}
  private embedKvSaveTimer = 0

  /** 读一条（同步，供桥的 `kvGet` 用） */
  embedKvGet(key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.embedKv, key) ? this.embedKv[key] : undefined
  }

  /** 写一条（防抖落盘：设置面板连续改动时不要每次都写文件） */
  embedKvSet(key: string, value: string): void {
    if (key === '') return
    this.embedKv[key] = value
    this.scheduleEmbedKvSave()
  }

  embedKvRemove(key: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.embedKv, key)) return
    delete this.embedKv[key]
    this.scheduleEmbedKvSave()
  }

  /** 防抖 300ms 落盘（与 Obsidian 自身设置写入同一 `data.json`，不额外建文件） */
  private scheduleEmbedKvSave(): void {
    if (this.embedKvSaveTimer !== 0) window.clearTimeout(this.embedKvSaveTimer)
    this.embedKvSaveTimer = window.setTimeout(() => {
      this.embedKvSaveTimer = 0
      void this.saveSettings({ from: 'embedKv' })
    }, 300)
  }

  /** 立即落盘（插件卸载时调，别丢最后一次改动） */
  flushEmbedKv(): void {
    if (this.embedKvSaveTimer === 0) return
    window.clearTimeout(this.embedKvSaveTimer)
    this.embedKvSaveTimer = 0
    void this.saveSettings({ from: 'embedKv' })
  }

  /** 左侧栏图标：按设置开关显隐（Obsidian 的 `addRibbonIcon` 返回元素，直接 detach/append） */
  syncEmbedRibbon(): void {    if (this.embedEnabled) {
      if (!this.ribbonEl) {
        this.ribbonEl = this.addRibbonIcon('music', '打开爱记谱', () => void this.openIjipuApp())
        this.ribbonEl.addClass('ijipu-ribbon')
        // 开发/排错用：控制台直接看到服务地址，便于在浏览器里对照排查
        void this.getEmbedUrl().then((u) => {
          if (u) console.log(`[iJipu] 嵌入版服务已就绪：${u}`)
        })
      } else if (!this.ribbonEl.isConnected) {
        // 之前被移除过：重新挂回左侧栏（`addRibbonIcon` 只在首次创建元素）
        document.querySelector('.workspace-ribbon .side-dock-actions')?.appendChild(this.ribbonEl)
      }
    } else if (this.ribbonEl) {
      this.ribbonEl.detach()
    }
  }

  /** 打开「爱记谱」应用页签（已开则聚焦） */
  async openIjipuApp(): Promise<void> {
    await this.openIjipuFile(null)
  }

  /**
   * adj724b（用户要求）：按设置里的「打开 .jps 的方式」打开（`null` = 只开应用，不指定文件）。
   *
   * 用户原话：「在嵌入版页签中添加一个下拉列表选择，默认打开方式，添加以下几个打开方式选择：
   * ① 右侧栏 ② 新的页签 ③ 当前页签 ④ 默认应用；并实现相应的打开方式，**默认选择为右侧栏**」。
   *
   * @param sourceLeaf 从 `.jps` 文件视图路由过来时传**它自己那个 leaf**——
   *   "当前页签"要的就地替换靠它，而不是靠猜（见 `openEmbedLeaf` 的说明）。
   */
  async openIjipuFile(file: TFile | null, sourceLeaf: WorkspaceLeaf | null = null): Promise<void> {
    const mode = this.settings.embedOpenMode ?? DEFAULT_EMBED_OPEN_MODE
    // adj727：判据收敛到纯函数（同一口径也用于"嵌入区工具栏要不要保留那枚链接"）
    if (embedEditLeavesObsidian(mode)) {
      if (!file) return // 没指定文件时"默认应用"无从谈起（侧栏图标就是这种情况）
      if (!canOpenWithDefaultApp(this.app)) {
        new Notice('「默认应用」仅在桌面端可用；已改为在右侧栏打开')
        await this.openEmbedLeaf(file, 'right', sourceLeaf)
        return
      }
      await openWithDefaultApp(this.app, file.path)
      return
    }
    await this.openEmbedLeaf(file, mode, sourceLeaf)
  }

  /**
   * adj728（用户要求）：**打开嵌入版 iJipu 的「设置 → 音色库」**。
   *
   * 用途：插件那条"试听失败"提示上的按钮。音源（GeneralUser GS，32MB）自动下载在部分网络
   * 不可达，唯一出路是**手动下载 + 导入**，而导入入口在嵌入版应用的「设置 → 音色库」里
   * （面板上还有「打开下载页」按钮与三步引导）。
   *
   * 时序：与 `openFile` 同一条约束 —— **iframe 装好监听（`ready`）才推事件**，否则会丢。
   * 所以这里先把应用开起来（必要时等它 ready），再推 `openSoundbankSettings`。
   */
  async openEmbedSoundbank(): Promise<void> {
    /**
     * adj741（手机端 P0）：手机端没有嵌入版 ⇒ 这里改为**打开插件设置** ——
     * 「说明」页签里新加了「音色库（高保真试听的音源）」入口（导入 `.sf2` + 显示就位状态），
     * 否则手机用户点了"打开音色库"会什么都没发生。
     */
    if (!Platform.isDesktopApp) {
      this.openSettingsTab('说明')
      return
    }
    await this.openIjipuFile(null)
    // 只推给**已 ready**的帧；这一轮一个都没推出去（应用还在启动）就过 400ms 再试，最多三次
    const push = (attempt = 0): void => {
      if (!this.bridge) return
      const sent = this.bridge.openSoundbankSettings()
      if (!sent && attempt < 3) window.setTimeout(() => push(attempt + 1), 400)
    }
    window.setTimeout(() => push(), 200)
  }

  /**
   * adj724b：按设置把嵌入版开在**右侧边栏 / 新页签 / 当前页签**；给了 `file` 就打开那份 `.jps`。
   *
   * ## `sourceLeaf`：从文件视图路由过来时，把**它自己那个 leaf** 交进来
   *
   * 这是本方法最关键的参数。用户实测「当前页签没生效」说明：
   * 靠 `getMostRecentLeaf()` / `getLeaf(false)` 去**猜**"当前页签"不可靠——
   * Obsidian 的 leaf 调度、以及"右栏是否已有 iJipu 页签"都会改变结果。
   *
   * 而点 `.jps` 的真实语义是确定的：**Obsidian 为它创建了一个文件视图页签**。于是：
   *  · 「当前页签」⇒ **就地替换那个 leaf**（它正是用户点开的页签，最符合预期）；
   *  · 「新页签」  ⇒ 另开一个，并把那个中间页签**关掉**；
   *  · 「右侧栏」  ⇒ 在右栏开，并把那个中间页签**关掉**。
   *
   * 不给 `sourceLeaf`（例如点侧栏图标打开应用）时才退回 `getLeaf(...)` 的猜法。
   */
  async openEmbedLeaf(
    file: TFile | null,
    mode: EmbedOpenMode = DEFAULT_EMBED_OPEN_MODE,
    sourceLeaf: WorkspaceLeaf | null = null,
  ): Promise<void> {
    /**
     * adj741（手机端 P0）：嵌入版完整编辑器依赖本地 HTTP 服务 ⇒ **只在桌面端可用**。
     * 手机端给一句明确提示后返回（而不是让 `setViewState` 指向一个没注册的视图类型）。
     */
    if (!Platform.isDesktopApp) {
      new Notice('完整编辑器（嵌入版 iJipu）仅桌面端可用；手机端请直接看谱面预览与试听。')
      return
    }
    const { workspace } = this.app
    /**
     * "开在哪里"由**纯函数**决定（`embed/openPlan.ts`）——这样它可被直接断言，
     * 而不是像此前那样只能对 `main.ts` 做**字符串匹配**（脆、且注释里写同样的字会误判）。
     */
    const plan = planEmbedTarget(mode, sourceLeaf !== null)
    /**
     * adj724b：**决策日志**。
     *
     * 用户实测反复"没生效"时，日志是唯一能看清"到底选了哪个 leaf"的手段——
     * 这个环境里我无法运行 Obsidian，只能靠这条日志把运行时事实带回来。
     */
    console.info(
      `[iJipu] 打开方式=${mode} 来源页签=${sourceLeaf ? sourceLeaf.getViewState().type : '（无）'}` +
        ` ⇒ 动作=${plan.kind} detachSource=${plan.detachSource}`,
    )
    let target: WorkspaceLeaf | null
    if (plan.kind === 'replace-source') {
      // 「当前页签」：
      //  · 由文件视图路由而来 ⇒ 就地替换**它自己**那个 leaf（语义确定，最符合预期）；
      //  · 否则取**主编辑区最近使用的** leaf。
      //    ⚠ 不能用 `getLeaf(false)`：它的语义是"返回一个**可导航的既有 leaf**"，
      //      当 iJipu 已占着右栏 leaf 时它会**优先返回那个**（用户实测踩到）。
      target = sourceLeaf ?? workspace.getMostRecentLeaf(workspace.rootSplit) ?? workspace.getLeaf(false)
      if (!sourceLeaf && !target) return
    } else if (plan.kind === 'right-sidebar') {
      target = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab')
      workspace.rightSplit?.expand()
    } else {
      target = workspace.getLeaf('tab')
    }
    if (!target) return

    /**
     * 切到目标 leaf 并**直接驱动视图**打开文件。
     *
     * 早先的做法是把路径塞进 `pendingOpenPaths` 并靠 `ViewState.state` 里的令牌让
     * `onOpen()` 去取——但那依赖"`setViewState()` 会重建视图"这个不成立的假设：
     * **复用同一个 leaf 时 Obsidian 不会重建视图**，`onOpen` 不再跑 ⇒ 令牌没人读 ⇒
     * 表现为"只展开了右栏/切了页签，应用里没打开文件"（用户实测）。
     */
    const isSameLeaf = sourceLeaf !== null && target === sourceLeaf
    await target.setViewState({ type: VIEW_TYPE_IJIPU_APP, active: true })
    await workspace.revealLeaf(target)
    if (file) {
      const view = target.view as unknown as { openFile?: (path: string) => void | Promise<void> }
      if (typeof view.openFile === 'function') {
        await view.openFile(file.path)
      } else {
        // 兜底：视图实现变了（拿不到 `openFile`）⇒ 退回令牌机制
        const token = `ijipu-${++this.leafSeq}`
        this.pendingOpenPaths.set(token, file.path)
        await target.setViewState({ type: VIEW_TYPE_IJIPU_APP, active: true, state: { openToken: token } })
      }
    }
    /**
     * 关掉中间页签（Obsidian 因 `registerExtensions` 为 `.jps` 必然创建的那个）。
     * 放在**最后**、且与"目标 leaf"分开判断：这一步此前因调度顺序没生效，
     * 用户看到的现象是"多余页签还在 / 像开在新页签"。
     */
    if (plan.detachSource && !isSameLeaf && sourceLeaf) {
      console.info(`[iJipu] 打开方式=${mode}：已在新位置打开，关闭中间页签（${sourceLeaf.getViewState().type}）`)
      sourceLeaf.detach()
    } else if (isSameLeaf) {
      console.info(`[iJipu] 打开方式=${mode}：就地替换来源页签（不关）`)
    }
  }

  /** 释放嵌入版服务（关掉开关 / 卸载插件时） */
  async disposeEmbed(): Promise<void> {
    const s = this.embedServer
    this.embedServer = null
    this.embedServerStarting = null
    if (s) await s.dispose()
  }

  /** 登记/注销一个试听停止函数（供 active-leaf-change 与卸载时统一停止） */
  registerPlay(stop: () => void): void {
    this.playStops.push(stop)
  }

  unregisterPlay(stop: () => void): void {
    this.playStops = this.playStops.filter((f) => f !== stop)
  }

  /** 内置 worklet 的 Blob URL（供试听时 addModule） */
  getWorkletUrl(): string {
    return this.workletUrl
  }

  /** adj729：音色库文件的存储层（插件目录；见 `bankFile.ts` 的说明） */
  getBankFiles(): BankFileStore | null {
    return this.bankFiles
  }

  /** adj729：音色库文件的路径（诊断/设置页显示用；未初始化时给空串） */
  soundfontPath(id: string): string {
    return this.bankFiles?.pathOf(id) ?? ''
  }

  /** adj729：把服务端的音源 URL 交给嵌入版应用（见 `BridgeHost.bankUrls`） */
  bankUrls(): Record<string, string> {
    const base = this.embedServer?.url
    if (!base) return {}
    const out: Record<string, string> = {}
    // adj741：前缀来自按需加载的服务模块（桌面端已加载时才有真值；手机端恒走不到这里）
    for (const lib of HQ_LIBRARIES) out[lib.id] = `${base}${this.soundfontPrefix}${lib.id}.sf2`
    return out
  }

  /** adj729：嵌入版应用要的音源字节（服务端按路径读插件目录里的文件；读不到给 null） */
  async readSoundfont(id: string): Promise<Buffer | null> {
    const ab = await this.bankFiles?.read(id)
    return ab ? Buffer.from(ab) : null
  }

  /**
   * adj729（用户要求）：**由插件导入音源文件**（嵌入版应用里点「导入音色文件」时走这里）。
   *
   * 为什么不让应用把字节发过来：SF2 有 32 MB，`postMessage` 传 ArrayBuffer 要 base64，
   * 慢且吃内存。插件在 Obsidian 主窗口里弹一次文件选择器、直接写进插件目录最省。
   * 导入后写进插件目录 ⇒ **随文库一起走**（用户口径），应用随后从这个 URL 取用。
   */
  async importSoundfont(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
    if (!this.bankFiles) return { ok: false, error: '插件未就绪' }
    return this.bankFiles.importFromPicker(id)
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, await this.loadData())
    /**
     * adj724b：取出嵌入版的偏好/设置表（应用侧 `localStorage` 的替身）。
     * 单独一个键存着，避免与 `IJipuSettings` 的字段混在一起（那是个平铺对象）。
     */
    const raw = (this.settings as { embedKv?: unknown }).embedKv
    this.embedKv = raw && typeof raw === 'object' ? ({ ...(raw as Record<string, string>) } as Record<string, string>) : {}
  }

  /**
   * 保存插件设置。
   *
   * @param opts.from 调用方标识：`'settingsTab'` = 「设置 → iJipu」页签自己改的。
   *   adj631（用户报"预览页面的设置与 设置-iJipu 里的设置项不同步"）：
   *   别处（谱面预览对话框「保存为插件默认」）改完设置后，**让开着的设置页签就地重画**，
   *   否则那一页还停在旧值上、看起来两边不一致；页签自己改的不重画——会打断正在输入的控件焦点。
   */
  async saveSettings(opts?: { from?: 'settingsTab' | 'embedKv' }): Promise<void> {
    /**
     * adj724b：把嵌入版偏好表一并落盘。放在 `this.settings` 的一个专用键下，
     * 不污染 `IJipuSettings` 的平铺字段（那些是插件自己的渲染设置）。
     */
    ;(this.settings as { embedKv?: Record<string, string> }).embedKv = this.embedKv
    await this.saveData(this.settings)
    // 设置面板改动后广播：打开中的谱面即时按新设置重渲染（此前要重开笔记才生效）
    this.events.trigger(SETTINGS_CHANGED)
    // 嵌入版存储的落盘**不触发**设置页重画（那是插件设置，跟它无关，重画会打断输入焦点）
    if (opts?.from !== 'settingsTab' && opts?.from !== 'embedKv') this.settingsRefresh?.()
  }

  /** 登记/注销「设置 → iJipu」页签的重画回调（页签 `display()` 时登记、`hide()` 时注销） */
  registerSettingsRefresh(fn: (() => void) | null): void {
    this.settingsRefresh = fn
  }

  /**
   * adj724b：「谱面」视图的**裁剪实况**（最近一次渲染写回，供设置页显示）。
   *
   * 为什么要有：裁剪依赖运行时的 `getBBox()` 量取，而我无法在本地复现 Obsidian 宿主环境。
   * 把「页面尺寸 → 裁剪后尺寸 / 是否退回边距兜底」显示在设置页，用户一句话就能区分
   * 「代码没生效（多为未重新构建）」与「裁剪生效但仍有空白」。
   * 内存字段即可——它是运行期诊断，不需要持久化。
   */
  lastCropInfo: string | null = null

  /**
   * adj740（用户报「插件的预览区左上工具条在**编辑视图**下还是不可见，只能在阅读视图下可见」）：
   * **预览工具条为什么没显示**的实测快照。
   *
   * 为什么需要它：工具条浮在谱面块**外侧**，而宿主在悬停时会给若干层祖先套 `overflow: hidden`
   * （`app.css` 里 `.cm-embed-block:hover{overflow:hidden}` 是最外层那一条）。到底**哪一层**在裁、
   * 或者**根本没触发显示**，只有在真机的实时预览 DOM 里量得出来 —— 我在本地没有 Obsidian 宿主，
   * 所以把实时预览的祖先链、逐层的 `overflow`/`contain`、以及工具条与裁剪区的几何关系记下来，
   * 用户截一张设置页的图就能定位（与 `lastCropInfo` 同一套路）。
   *
   * 内存字段即可——运行期诊断，不持久化。
   */
  lastToolbarInfo: string | null = null

  /**
   * adj725d：**SVG 走的是哪条解析路径**（最近一次渲染写回）——`'xml'` / `'html-fallback（…）'`。
   *
   * 为什么要记：Obsidian 的 `sanitizeHTMLToDom`（DOMPurify）会剥掉 `dominant-baseline`
   * 等 SVG 属性（详见 `scorePane.ts` 的 `svgToDom()`），所以插件改走 `DOMParser`；
   * 但只要有一次回退到 HTML 解析，就等于那个属性又丢了 ⇒ 真机验证要断言"每次都是 XML"。
   */
  lastSvgParse: string | null = null

  /** 由内嵌 worklet 代码构造 Blob URL（不再依赖插件目录单独文件；供 audioWorklet.addModule） */
  private makeWorkletUrl(): string {
    try {
      const blob = new Blob([workletCode], { type: 'application/javascript' })
      return URL.createObjectURL(blob)
    } catch {
      return ''
    }
  }
}

/** 取代码块行区间（阅读模式/某些视图下可能为 null 或抛错——统一包一层） */
function safeSectionInfo(
  ctx: { getSectionInfo: (el: HTMLElement) => MarkdownSectionInformation | null },
  el: HTMLElement,
): MarkdownSectionInformation | null {
  try {
    return ctx.getSectionInfo(el)
  } catch {
    return null
  }
}

/**
 * 一个 ```jps 代码块的渲染组件。
 *
 *  - **随 frontmatter 与插件设置变化即时重渲染**（Obsidian 不会因 frontmatter 变化重跑代码块处理器）
 *  - **「⚙ 排版」保存时把新源码写回该代码块**：优先走编辑器 `replaceRange`（保留撤销栈、光标），
 *    否则用 `vault.process` 做整文件事务写（阅读模式可用）
 *  - **adj725：块右上角的 `</>` 把光标送回这段源码**（见 `revealSource`）——编辑交给 Obsidian 自己
 */
class IJipuBlock extends MarkdownRenderChild {
  private pane: ScorePaneHandle | null = null

  constructor(
    private plugin: IJipuPlugin,
    private source: string,
    containerEl: HTMLElement,
    private sourcePath: string,
    private sectionInfo: () => MarkdownSectionInformation | null,
  ) {
    super(containerEl)
  }

  onload(): void {
    this.paint()
    // adj738：这里原来还监听 `metadataCache.on('changed')`（为了"改笔记 frontmatter 即时重渲染"）。
    // 笔记 frontmatter 那一层已删除 ⇒ 该监听没有用途（代码块内容变化时 Obsidian 自己会重跑处理器）。
  }

  onunload(): void {
    this.pane?.destroy()
    this.pane = null
  }

  /** 重画本代码块的谱面（设置变更由面板自行处理，这里只负责结构/源码变化） */
  private paint(): void {
    this.pane?.destroy()
    this.pane = null
    this.containerEl.empty()
    this.pane = mountScorePane({
      plugin: this.plugin,
      container: this.containerEl,
      getSource: () => this.source,
      writeSource: (next) => this.writeSource(next),
      /**
       * adj741：`</>`（切回笔记源码）只在桌面端给 —— 它走 `revealSource()`（CM6 编辑器操作）。
       * 手机端不传 ⇒ 面板不会挂这个按钮（触屏上"编辑此块"由 Obsidian 自己的机制负责）。
       */
      ...(Platform.isDesktopApp ? { onEditSource: () => void this.revealSource() } : {}),
    })
  }

  /**
   * adj725（用户要求）：**切到笔记源码**，把光标放进本代码块。
   *
   * 用户口径：「切源码方式是在预览的笔记源码间切换，源码如图，不要再单独的 textarea」
   * ⇒ 不在预览里编辑（那是插件自己造的一套编辑器：样式、撤销栈、"打字跳回开头"都得自己兜），
   * 而是**切回笔记**，用 Obsidian 自带编辑器改。
   *
   * 实现等价于 Obsidian 自己那个「编辑此块」按钮（`EmbedWidget.addEditButton` → `selectElement`）：
   *  ① 阅读视图下先切到**实时预览**（`mode:'source', source:false`）——这是"预览 ↔ 笔记源码"的切换；
   *  ② 光标落到**首行源码**（`lineStart + 1`：`lineStart` 是 ```jps 那一行）；
   *  ③ 把整块滚进视野并聚焦 —— 光标在块内时，实时预览**原生**就会显示源码（含语法高亮、
   *     与其它代码块完全一致的编辑体验），光标移出块又自动回到谱面。
   *
   * ⚠ 顺序与"落两次"：切模式会让 CM6 重建 DOM，光标偶发不生效 ⇒ 同步落一次、
   * 下一帧再落一次（第二次是幂等的）。
   */
  private async revealSource(): Promise<void> {
    const info = this.sectionInfo()
    if (!info) {
      new Notice('无法定位这段源码的位置（请回到笔记的编辑视图重试）', 5000)
      return
    }
    const view = this.markdownViewOfNote()
    if (!view) {
      new Notice('这份笔记没有打开在任何可编辑的页签里', 5000)
      return
    }
    if (view.getMode() === 'preview') {
      // 阅读视图 → 实时预览（正是用户在界面上点「编辑」时 Obsidian 做的事）
      await view.setState({ mode: 'source', source: false }, { history: false })
    }
    const place = (): void => {
      const ed = view.editor
      const line = Math.min(info.lineStart + 1, ed.lastLine())
      ed.setCursor({ line, ch: 0 })
      ed.scrollIntoView({ from: { line: info.lineStart, ch: 0 }, to: { line: info.lineEnd, ch: 0 } }, true)
      ed.focus()
    }
    place()
    window.setTimeout(place, 0)
  }

  /** 找**这份笔记**的 MarkdownView（优先当前活动的那个；其次在页签里按路径找） */
  private markdownViewOfNote(): MarkdownView | null {
    const app = this.plugin.app
    const active = app.workspace.getActiveViewOfType(MarkdownView)
    if (active?.file?.path === this.sourcePath) return active
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view
      if (view instanceof MarkdownView && view.file?.path === this.sourcePath) return view
    }
    return null
  }

  /** 把新的代码块正文写回笔记 */
  private async writeSource(next: string): Promise<void> {
    const info = this.sectionInfo()
    if (!info) throw new Error('无法定位代码块位置（请在编辑视图中重试）')
    const app = this.plugin.app
    const body = next.replace(/\n+$/, '')
    // ① 编辑器可见（实时预览 / 源码模式）：替换块内文本，保留撤销栈
    const view = app.workspace.getActiveViewOfType(MarkdownView)
    if (view && view.file?.path === this.sourcePath) {
      view.editor.replaceRange(`${body}\n`, { line: info.lineStart + 1, ch: 0 }, { line: info.lineEnd, ch: 0 })
      this.source = body
      this.pane?.refresh()
      return
    }
    // ② 阅读模式等无编辑器场景：整文件事务写
    const file = app.vault.getAbstractFileByPath(this.sourcePath)
    if (!(file instanceof TFile)) throw new Error(`找不到文件：${this.sourcePath}`)
    await app.vault.process(file, (data) => replaceCodeBlockBody(data, info.lineStart, info.lineEnd, body))
    this.source = body
    this.pane?.refresh()
  }
}
