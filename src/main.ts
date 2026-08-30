import { Plugin } from 'obsidian'
import { mergePageConfig, renderScore, playScore } from './render'
import { IJipuSettingTab } from './settings'
import type { IJipuSettings } from './types'

/**
 * obsidian-ijipu —— 在 Obsidian 笔记里用 ```jps 代码块渲染可视化简谱并可试听。
 * 复用 @ijipu/engine（引擎源码经 esbuild alias 打入本插件），默认设置继承 iJipu 应用 PageConfig。
 */
export default class IJipuPlugin extends Plugin {
  settings: IJipuSettings = {}

  async onload(): Promise<void> {
    await this.loadSettings()
    this.addSettingTab(new IJipuSettingTab(this.app, this))

    // 注册 ```jps 代码块处理器
    this.registerMarkdownCodeBlockProcessor('jps', (source, el, ctx) => {
      this.renderBlock(source, el, ctx.sourcePath)
    })
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  private renderBlock(source: string, el: HTMLElement, sourcePath: string): void {
    const frontmatter = this.app.metadataCache.getCache(sourcePath)?.frontmatter ?? {}
    const pageConfig = mergePageConfig(this.settings, frontmatter)

    const container = el.createDiv({ cls: 'ijipu-score' })
    const { svgs, error } = renderScore(source, pageConfig)

    if (error) {
      container.createDiv({ cls: 'ijipu-error', text: `⚠ 简谱解析失败：\n${error}` })
      return
    }

    // 工具栏（页数 + 试听按钮）
    const toolbar = container.createDiv({ cls: 'ijipu-score-toolbar' })
    toolbar.createSpan({ cls: 'ijipu-page-label', text: `${svgs.length} 页` })

    let playing: { cancel: () => void } | null = null
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play', text: '▶ 试听' })
    playBtn.addEventListener('click', () => {
      if (playing) {
        playing.cancel()
        playing = null
        playBtn.setText('▶ 试听')
        return
      }
      void playScore(source, pageConfig).then((r) => {
        if (r) {
          playing = r
          playBtn.setText('⏹ 停止')
        } else {
          playBtn.setText('▶ 试听')
        }
      })
    })

    // 逐页插入 SVG
    svgs.forEach((svg, i) => {
      if (svgs.length > 1) {
        container.createDiv({ cls: 'ijipu-page-label', text: `第 ${i + 1} / ${svgs.length} 页` })
      }
      const wrap = container.createDiv({ cls: 'ijipu-page-svg' })
      wrap.innerHTML = svg
    })
  }
}
