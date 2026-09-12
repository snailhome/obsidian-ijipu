/**
 * embed.ts — `![[xxx.jps]]` 嵌入支持
 *
 * Obsidian 的嵌入内容**在 markdown post-processor 之后异步填充**：对未知扩展名（.jps 不属于
 * Obsidian 内置可嵌入类型），它会插入一个"未知嵌入"占位块——正好覆盖掉我们在 post-processor 里
 * 渲染好的谱面（用户看到的就是"一个未知的嵌入块，没有谱面"）。
 *
 * 因此这里的策略是「**立即挂载 + 被覆盖就重挂**」：
 *  1. `onload` 立刻渲染一次（不等待）；
 *  2. 用 `MutationObserver` 盯住容器：一旦发现我们渲染的 `.ijipu-score` 不见了（被 Obsidian 的
 *     占位块替换），就清空并重新挂载（有次数上限，避免与宿主互相覆盖形成死循环）；
 *  3. 另在 120ms / 600ms 各兜一次（占位块插入时机因 vault 大小而异）。
 * 渲染顺序：**先读文件、再清空容器并挂载**——读文件期间宿主若插入占位块，也会被随后的清空带走。
 */
import { MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from 'obsidian'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { jpsLinkpath } from './sourceEdit'
import type IJipuPlugin from './main'

/** 兜底重挂的时间点（ms）——覆盖 Obsidian 占位块可能晚于 post-processor 插入的情况 */
const RETRY_DELAYS_MS = [120, 600]
/** 重挂次数上限（防与宿主互相覆盖死循环） */
const MAX_REMOUNTS = 5

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

/** 判断容器里是否已经是"我们的谱面" */
function hasScore(el: HTMLElement): boolean {
  return el.querySelector('.ijipu-score') !== null
}

/** 单个嵌入的渲染组件（随所在段落卸载而清理） */
class JpsEmbed extends MarkdownRenderChild {
  private pane: ScorePaneHandle | null = null
  private source = ''
  private observer: MutationObserver | null = null
  private timers: number[] = []
  private remounts = 0
  private mounting = false

  constructor(
    private plugin: IJipuPlugin,
    containerEl: HTMLElement,
    private linkpath: string,
    private sourcePath: string,
  ) {
    super(containerEl)
  }

  onload(): void {
    // ① 立即渲染
    void this.mount()
    // ② 被宿主占位块覆盖时重挂
    this.observer = new MutationObserver(() => this.ensureMounted())
    this.observer.observe(this.containerEl, { childList: true })
    // ③ 占位块可能稍后插入，再兜两次
    for (const d of RETRY_DELAYS_MS) this.timers.push(window.setTimeout(() => this.ensureMounted(), d))
  }

  onunload(): void {
    for (const t of this.timers) window.clearTimeout(t)
    this.timers = []
    this.observer?.disconnect()
    this.observer = null
    this.pane?.destroy()
    this.pane = null
  }

  /** 若容器里已不是我们的谱面（被宿主覆盖 / 首次尚未渲染），重新挂载一次 */
  private ensureMounted(): void {
    if (!this.containerEl.isConnected || this.mounting) return
    if (hasScore(this.containerEl)) return
    if (this.remounts >= MAX_REMOUNTS) return
    this.remounts++
    void this.mount()
  }

  private async mount(): Promise<void> {
    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(this.linkpath, this.sourcePath)
    if (!(file instanceof TFile)) {
      this.containerEl.empty()
      this.containerEl.createDiv({ cls: 'ijipu-error', text: `⚠ 找不到谱面文件：${this.linkpath}` })
      return
    }
    this.mounting = true
    let text: string
    try {
      // 先读文件（期间宿主插入的占位块会在下面的 empty() 里被清掉）
      text = await this.plugin.app.vault.cachedRead(file)
    } catch (e) {
      this.mounting = false
      this.containerEl.empty()
      this.containerEl.createDiv({
        cls: 'ijipu-error',
        text: `⚠ 读取谱面失败：${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }
    if (!this.containerEl.isConnected) {
      this.mounting = false
      return
    }
    this.source = text
    // 清掉宿主占位块与上一次的渲染，再挂我们的面板
    this.pane?.destroy()
    this.pane = null
    this.containerEl.empty()
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
    this.mounting = false
  }
}
