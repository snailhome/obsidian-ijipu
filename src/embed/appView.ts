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

  getDisplayText(): string {
    return DISPLAY_TEXT
  }

  getIcon(): string {
    return 'music'
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

    const url = await this.plugin.getEmbedUrl()
    if (!url) {
      contentEl.createDiv({
        cls: 'ijipu-web-hint',
        text: '嵌入版未启用（请在「设置 → iJipu」里打开「使用嵌入版 iJipu」）',
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
