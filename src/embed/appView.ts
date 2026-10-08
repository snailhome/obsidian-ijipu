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

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: IJipuPlugin,
  ) {
    super(leaf)
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
     * 取本页签"要打开的文件"：`main.ts` 开页签时把令牌放进 `ViewState.state`，
     * `ItemView` 的既有机制会经 `getState()` 交回来。取到即从待办表摘掉（一次性）。
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
      return
    }

    const frame = createEmbedFrame(this.app, contentEl, url)
    fitEmbedFrame(frame)
    this.frame = frame
    /**
     * adj724b：登记这个页签"待打开的文件"。
     *
     * 应用加载完成后会发 `ready`，桥**此刻**才把这个路径推给它——
     * 推早了应用还没装监听，消息会丢（表现为"打开 `.jps` 却是空白/未命名"）。
     */
    this.plugin.bridge.attach(frame, pending)

    // 桥的消息监听：由插件统一注册（见 main.ts），此处只负责登记/摘除 iframe
  }

  async onClose(): Promise<void> {
    if (this.frame) this.plugin.bridge.detach(this.frame)
    this.frame = null
    this.contentEl.empty()
  }
}
