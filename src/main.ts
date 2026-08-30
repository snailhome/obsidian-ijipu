import { Plugin } from 'obsidian'
import { mergePageConfig, renderScore, playScore } from './render'
import { IJipuSettingTab } from './settings'
import type { IJipuSettings } from './types'
import type { PlacedToken } from '@ijipu/engine'

type ViewMode = 'page' | 'full' | 'score'
const MODE_LABEL: Record<ViewMode, string> = { page: '整页', full: '满宽', score: '谱面' }

/**
 * obsidian-ijipu —— 在 Obsidian 笔记里用 ```jps 代码块渲染可视化简谱并可试听。
 * 复用 @ijipu/engine（引擎源码经 alias 打入本插件），默认设置继承 iJipu 应用 PageConfig。
 * 显示模式：整页（完整一页）/ 满宽（撑满容器宽）/ 谱面（裁掉边距、只显示内容区）。
 * 试听时用 placed 坐标在 SVG 内叠加色块，逐音符跟进高亮。
 */
export default class IJipuPlugin extends Plugin {
  settings: IJipuSettings = {}

  async onload(): Promise<void> {
    await this.loadSettings()
    this.addSettingTab(new IJipuSettingTab(this.app, this))
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

    const toolbar = container.createDiv({ cls: 'ijipu-score-toolbar' })
    toolbar.createSpan({ cls: 'ijipu-page-label', text: `${svgs.length} 页` })

    // —— 试听（播放/停止 + 色块跟进）——
    let playing: { cancel: () => void } | null = null
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play', text: '▶ 试听' })
    const svgEls: SVGSVGElement[] = []

    const clearPlayBlock = (): void => {
      for (const svgEl of svgEls) svgEl.querySelector('.ijipu-play-block')?.remove()
    }

    const highlightNote = (placed: PlacedToken): void => {
      const svgEl = svgEls[placed.id.page]
      if (!svgEl) return
      clearPlayBlock()
      const noteSize = pageConfig.note_size ?? 13
      // placed.x 为占位左缘；右侧优先用 rightX（防止延伸到休止符）
      const x = placed.x
      const right = placed.rightX !== undefined ? placed.rightX : placed.x + placed.width
      const h = noteSize * 1.8
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('class', 'ijipu-play-block')
      rect.setAttribute('x', String(x))
      rect.setAttribute('width', String(Math.max(1, right - x)))
      rect.setAttribute('y', String(placed.y - h))
      rect.setAttribute('height', String(h))
      svgEl.appendChild(rect)
    }

    playBtn.addEventListener('click', () => {
      if (playing) {
        playing.cancel()
        playing = null
        clearPlayBlock()
        playBtn.setText('▶ 试听')
        return
      }
      void playScore(source, pageConfig, highlightNote).then((r) => {
        if (r) {
          playing = r
          playBtn.setText('⏹ 停止')
        } else {
          playBtn.setText('▶ 试听')
        }
      })
    })

    // —— 显示模式切换（整页 / 满宽 / 谱面）——
    const modeBtns: Partial<Record<ViewMode, HTMLButtonElement>> = {}
    for (const [mode, label] of Object.entries(MODE_LABEL) as [ViewMode, string][]) {
      const mb = toolbar.createEl('button', {
        cls: 'ijipu-mode-btn' + (mode === 'page' ? ' is-active' : ''),
        text: label,
      })
      mb.addEventListener('click', () => setMode(mode))
      modeBtns[mode] = mb
    }

    // —— 逐页插入 SVG（存元素，供色块定位与谱面 viewBox 裁剪）——
    const svgWrap = container.createDiv({ cls: 'ijipu-svgs ijipu-mode-page' })
    svgs.forEach((svg, i) => {
      if (svgs.length > 1) {
        container.createDiv({ cls: 'ijipu-page-label', text: `第 ${i + 1} / ${svgs.length} 页` })
      }
      const wrap = svgWrap.createDiv({ cls: 'ijipu-page-svg' })
      wrap.innerHTML = svg
      const svgEl = wrap.querySelector('svg') as SVGSVGElement | null
      if (svgEl) svgEls.push(svgEl)
    })

    const setMode = (next: ViewMode): void => {
      svgWrap.setAttribute('class', `ijipu-svgs ijipu-mode-${next}`)
      for (const [m, btn] of Object.entries(modeBtns) as [ViewMode, HTMLButtonElement][]) {
        btn.classList.toggle('is-active', m === next)
      }
      // 谱面模式：把 viewBox 裁到页边距内（只显示内容区），再撑满容器宽
      for (const svgEl of svgEls) {
        const orig = svgEl.dataset.origVb || svgEl.getAttribute('viewBox') || ''
        svgEl.dataset.origVb = orig
        if (next === 'score') {
          const [, , w, h] = orig.split(/[\s,]+/).map(Number)
          const ml = pageConfig.margin_left ?? 0
          const mt = pageConfig.margin_top ?? 0
          const mr = pageConfig.margin_right ?? 0
          const mb = pageConfig.margin_bottom ?? 0
          svgEl.setAttribute('viewBox', `${ml} ${mt} ${Math.max(1, w - ml - mr)} ${Math.max(1, h - mt - mb)}`)
        } else {
          svgEl.setAttribute('viewBox', orig)
        }
      }
    }
  }
}
