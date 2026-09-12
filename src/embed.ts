/**
 * embed.ts — `![[xxx.jps]]` 嵌入支持
 *
 * Obsidian 对注册了扩展名的文件通常会直接用对应视图渲染嵌入，但插入时机是异步的，
 * 且不同版本行为不完全一致。这里做**兜底**：
 *  - 先标记容器，等一拍后确认：若嵌入里已经有 `.ijipu-score`（说明 Obsidian 已用 .jps
 *    文件视图渲染）就什么都不做；否则自己读文件并用共用面板渲染一份。
 *  - 读文件用 `cachedRead`（不触发磁盘 IO 抖动），并在 `onunload` 里卸下面板（停试听）。
 *  - 找不到文件（链接失效/改名）会给出行内提示，而不是留一个空白块。
 */
import { MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from 'obsidian'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { jpsLinkpath } from './sourceEdit'
import type IJipuPlugin from './main'

/** 等待一拍再确认（Obsidian 异步插入嵌入内容） */
const CONFIRM_DELAY_MS = 100

/** 注册 `![[xxx.jps]]` 嵌入处理器（在插件 onload 里调用） */
export function registerJpsEmbeds(plugin: IJipuPlugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx: MarkdownPostProcessorContext) => {
    const embeds = Array.from(el.querySelectorAll<HTMLElement>('.internal-embed[src]'))
    for (const emb of embeds) {
      const linkpath = jpsLinkpath(emb.getAttribute('src') ?? '')
      if (!linkpath) continue
      if (emb.dataset.ijipuEmbed === 'mounted') continue
      emb.dataset.ijipuEmbed = 'mounted'
      ctx.addChild(new JpsEmbed(plugin, emb, linkpath, ctx.sourcePath))
    }
  })
}

/** 单个嵌入的渲染组件（随所在段落卸载而清理） */
class JpsEmbed extends MarkdownRenderChild {
  private pane: ScorePaneHandle | null = null
  private source = ''

  constructor(
    private plugin: IJipuPlugin,
    containerEl: HTMLElement,
    private linkpath: string,
    private sourcePath: string,
  ) {
    super(containerEl)
  }

  onload(): void {
    window.setTimeout(() => {
      if (!this.containerEl.isConnected) return
      // 已由 .jps 文件视图渲染（Obsidian 的默认嵌入行为）→ 不重复渲染
      if (this.containerEl.querySelector('.ijipu-score')) return
      void this.render()
    }, CONFIRM_DELAY_MS)
  }

  onunload(): void {
    this.pane?.destroy()
    this.pane = null
  }

  private async render(): Promise<void> {
    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(this.linkpath, this.sourcePath)
    if (!(file instanceof TFile)) {
      this.containerEl.createDiv({ cls: 'ijipu-error', text: `⚠ 找不到谱面文件：${this.linkpath}` })
      return
    }
    try {
      this.source = await this.plugin.app.vault.cachedRead(file)
    } catch (e) {
      this.containerEl.createDiv({
        cls: 'ijipu-error',
        text: `⚠ 读取谱面失败：${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }
    if (!this.containerEl.isConnected) return
    this.containerEl.addClass('ijipu-embed')
    this.pane = mountScorePane({
      plugin: this.plugin,
      container: this.containerEl,
      getSource: () => this.source,
      getFrontmatter: () => null,
      embedded: true,
      // 「排版 → 保存到谱面」直接改写被嵌入的 .jps 文件
      writeSource: async (next) => {
        this.source = next
        await this.plugin.app.vault.modify(file, next)
      },
    })
  }
}
