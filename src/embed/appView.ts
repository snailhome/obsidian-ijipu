/**
 * embed/appView.ts — **iJipu 应用页签**（侧栏图标打开的完整编辑器）
 *
 * 与 `fileView.ts`（`.jps` 文件页签）的区别：
 *  · 本视图 = "打开 iJipu 应用"，工作区 = vault 根（文件树里就是文库里的谱）；
 *  · 文件页签 = 打开**某一个** `.jps`，由宿主把路径推给应用（见 `fileView.ts` 的嵌入分支）。
 * 两者复用同一套服务（`embed/server.ts`）与 iframe 构造（`embed/frame.ts`）。
 */
import { ItemView, WorkspaceLeaf } from 'obsidian'
import type IJipuPlugin from '../main'
import { createEmbedFrame, fitEmbedFrame } from './frame'

export const VIEW_TYPE_IJIPU_APP = 'ijipu-web-view'

/** 应用页签的显示名 */
const DISPLAY_TEXT = '爱记谱'

export class IJipuAppView extends ItemView {
  private frame: HTMLIFrameElement | null = null
  /** adj724b：本页签的令牌（`main.ts` 开页签时随 ViewState 传入），用于取"要打开的文件" */
  private openToken = ''
  /**
   * adj724b：`onOpen()` 完成（iframe 已挂好）后 resolve。
   *
   * 为什么需要：`setViewState()` 返回时 `onOpen` 可能**还没跑完**（它是异步的），
   * 此刻若外部立刻调 `openFile()` 就会因为 `this.frame` 还是 null 而**静默丢掉**这一次打开
   * ——正是用户实测「展开了右栏但没打开文件」的一种成因。
   */
  private frameReady: Promise<void> = Promise.resolve()
  private markFrameReady: (() => void) | null = null
  /** adj724b：本页签当前打开的谱面文件名（`null` = 还没打开任何谱 ⇒ 页签名用「爱记谱」） */
  private activeFileName: string | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: IJipuPlugin,
  ) {
    super(leaf)
    this.frameReady = new Promise<void>((resolve) => {
      this.markFrameReady = resolve
    })
  }

  getViewType(): string {
    return VIEW_TYPE_IJIPU_APP
  }

  /**
   * adj724b（用户要求 #2）：**页签名显示正在编辑的谱面文件名**；没打开文件时显示「爱记谱」。
   *
   * 背景：为**具体文件**打开的视图，Obsidian 的页签名会走"文件名"那条路
   * （`ViewState` 里没有 `title` 字段可用，名字来自 `getDisplayText()`）。
   * 用户口径：「如果在页签中打开 ijipu 时，页签名显示文件名，而不是爱记谱」。
   *
   * 通过 `.jps` 文件视图路由过来的那些页签会被自动关掉（见 `fileView.ts` 的 `routeToIjipu`），
   * 所以这里主要影响"应用页签里当前打开的谱"这个名字。
   */
  getDisplayText(): string {
    // 先问应用"现在打开的是哪一份谱"（`setActiveFile` 由宿主在推 `openFile` 时告知）
    return this.activeFileName ?? DISPLAY_TEXT
  }

  getIcon(): string {
    return 'music'
  }

  /**
   * adj724b：宿主告知"这个页签现在打开的是哪份谱" ⇒ 更新页签名。
   *
   * 为什么由宿主告诉、而不是自己读 `getState()`：本视图是**应用级**页签
   * （可以先后打开很多份谱），而 `ViewState` 只反映"创建它的那一次"。
   *
   * ⚠ Obsidian **没有**公开的"刷新页签标题"API（`obsidian.d.ts` 里只有 `getDisplayText()`
   * 与 `onPaneMenu()`）。所以这里只记状态、更新 `getDisplayText()` 的返回值：
   * 新建/重开页签时一定正确；对**已经显示着**的页签，标题可能要到下次布局变化才刷新
   * （这是宿主没给 API 的限制，不是这里疏漏）。
   */
  setActiveFileName(name: string | null): void {
    if (this.activeFileName === name) return
    this.activeFileName = name
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('ijipu-web-root')

    /**
     * adj724b：本页签的令牌来自 `ViewState.state`（`main.ts` 开页签时放入）。
     * ⚠ 只在**没有**用 `openFile()` 直接驱动的情况下才需要它——见 `openFile()` 的说明：
     * 复用同一个 leaf 时 Obsidian **不会重建视图**，`onOpen` 也不会再跑，
     * 那条路径完全依赖 `plugin.openEmbedLeaf()` 拿到本视图后直接调用。
     */
    const st = this.getState() as { openToken?: string } | null
    this.openToken = typeof st?.openToken === 'string' ? st.openToken : ''
    const pending = this.openToken !== '' ? this.plugin.pendingOpenPaths.get(this.openToken) : undefined
    if (this.openToken !== '') this.plugin.pendingOpenPaths.delete(this.openToken)

    /**
     * adj775（用户报）：「PC 端 jps 文件预览的工具条点击编辑有打开右侧栏/页签，但**没有嵌入版 iJipu 显示出来**」。
     *
     * 根因：这里以前是 `const url = await this.plugin.getEmbedUrl()` 直接 await ——
     * 只要取 URL 的过程中**抛了错**（本机服务启动失败、端口被上一次实例占着、动态导入失败…），
     * `onOpen` 就**中途中断**：页签/右栏开出来了，里面**一片空白**，用户完全不知道发生了什么。
     * 现在整段包 try/catch，失败也**一定画出一块可读的提示 + 重试按钮**（绝不空白）。
     */
    let url: string | null = null
    let failure = ''
    try {
      url = await this.plugin.getEmbedUrl()
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }
    if (!url) {
      const box = contentEl.createDiv({ cls: 'ijipu-web-hint' })
      box.createDiv({
        text: failure
          ? `嵌入版启动失败：${failure}`
          : '嵌入版未启用（请在「设置 → iJipu」里打开「使用嵌入版 iJipu」）',
      })
      // 失败原因与"怎么再试"都写清楚；重试按钮直接重跑本方法（不必让用户去翻设置）
      box.createDiv({ cls: 'ijipu-web-hint-sub', text: '可点下面的「重试」；仍不行请看「设置 → iJipu → 说明」里的诊断信息。' })
      const retry = box.createEl('button', { cls: 'ijipu-btn', text: '重试' })
      retry.addEventListener('click', () => {
        contentEl.empty()
        void this.onOpen()
      })
      this.markFrameReady?.()
      return
    }

    const frame = createEmbedFrame(this.app, contentEl, url)
    fitEmbedFrame(frame)
    this.frame = frame
    this.plugin.bridge.attach(frame)
    // 首次打开时，把"要打开的文件"交给桥（应用 `ready` 后下发；此后 `openFile()` 可直接推）
    if (pending !== undefined && pending !== '') this.plugin.bridge.openFile(frame, pending)
    // 告诉等待者"iframe 已就绪"（此后 `openFile()` 才有 frame 可用）
    this.markFrameReady?.()

    // 桥的消息监听：由插件统一注册（见 main.ts），此处只负责登记/摘除 iframe
  }

  /**
   * adj724b：**让本视图打开一份谱**（由 `main.ts` 的 `openEmbedLeaf()` 直接调用）。
   *
   * 为什么不能只靠 `ViewState.state` + `onOpen()`：**复用同一个 leaf 时 Obsidian 不重建视图**，
   * `onOpen` 不会再跑 ⇒ 令牌没人读 ⇒ 表现为"只展开了右栏、应用里没打开文件"（用户实测 ①②）。
   * 直接拿视图实例调用就没有这个问题：
   *  · 应用**已就绪** ⇒ 桥立刻推 `openFile`；
   *  · 还没就绪（首次打开右栏）⇒ 桥记下来，等 `ready` 补发。
   *
   * 先 `await frameReady`：`setViewState()` 返回时 `onOpen` 可能还没跑完（见字段说明），
   * 不 await 会把这一次打开静默丢掉。
   */
  async openFile(path: string): Promise<void> {
    // adj724b：页签名跟着当前打开的谱走（见 `getDisplayText`）
    this.setActiveFileName(path.split('/').pop() ?? path)
    await this.frameReady
    if (!this.frame) return
    this.plugin.bridge.openFile(this.frame, path)
  }

  async onClose(): Promise<void> {
    if (this.frame) this.plugin.bridge.detach(this.frame)
    this.frame = null
    this.contentEl.empty()
  }
}
