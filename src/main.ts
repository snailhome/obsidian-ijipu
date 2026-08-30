import { Plugin } from 'obsidian'
import { mergePageConfig, renderScore, playScore } from './render'
import { IJipuSettingTab } from './settings'
import type { IJipuSettings } from './types'
import type { PlacedToken, PlayEvent } from '@ijipu/engine'

type ViewMode = 'page' | 'full' | 'score'
const MODE_LABEL: Record<ViewMode, string> = { page: '整页', full: '满宽', score: '谱面' }
/** 与 iJipu 应用一致的播放色块配色（按声部半透明；voice1 红，延续单声部红块） */
const PLAYHEAD_COLORS = [
  'rgba(255, 93, 108,',
  'rgba(87, 170, 255,',
  'rgba(63, 122, 46,',
  'rgba(255, 200, 87,',
  'rgba(138, 95, 184,',
]

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

    // —— 试听（播放/停止 + RAF 驱动的色块跟随）——
    let playing: { cancel: () => void; totalMs: number } | null = null
    let events: PlayEvent[] = []
    let rafId = 0
    let playStart = 0
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play', text: '▶ 试听' })
    const svgEls: SVGSVGElement[] = []

    const clearPlayBlock = (): void => {
      for (const svgEl of svgEls) svgEl.querySelector('.ijipu-play-block')?.remove()
    }

    const addBlock = (placed: PlacedToken): void => {
      const svgEl = svgEls[placed.id.page]
      if (!svgEl) return
      const color = PLAYHEAD_COLORS[(placed.id.voice - 1) % PLAYHEAD_COLORS.length]
      const noteSize = pageConfig.note_size ?? 13
      const x = placed.x
      const right = placed.rightX !== undefined ? placed.rightX : placed.x + placed.width
      const h = noteSize * 2.6 // 近似曲行高度（音符+歌词），与 iJipu 整曲行色块观感接近
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('class', 'ijipu-play-block')
      rect.setAttribute('x', String(x))
      rect.setAttribute('width', String(Math.max(1, right - x)))
      rect.setAttribute('y', String(placed.y - h + noteSize * 0.4))
      rect.setAttribute('height', String(h))
      rect.setAttribute('fill', `${color}0.32)`)
      rect.setAttribute('stroke', `${color}0.5)`)
      rect.setAttribute('stroke-width', '1')
      svgEl.appendChild(rect)
    }

    const tick = (): void => {
      const elapsed = performance.now() - playStart
      // 当前正在发声的音符：atMs <= elapsed < atMs+durationMs（跨声部 → 多声部同时高亮）
      const cur: PlacedToken[] = []
      for (const ev of events) {
        if (ev.atMs <= elapsed && elapsed < ev.atMs + ev.durationMs) cur.push(ev.placed)
      }
      if (cur.length === 0) {
        // 节拍间隙：退化为最近一个已开始的音符
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].atMs <= elapsed) {
            cur.push(events[i].placed)
            break
          }
        }
      }
      clearPlayBlock()
      for (const p of cur) addBlock(p)
      const total = playing?.totalMs ?? 0
      if (elapsed >= total) {
        clearPlayBlock()
        playing = null
        events = []
        playBtn.setText('▶ 试听')
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    const stopPlay = (): void => {
      playing?.cancel()
      playing = null
      cancelAnimationFrame(rafId)
      events = []
      clearPlayBlock()
      playBtn.setText('▶ 试听')
    }

    playBtn.addEventListener('click', () => {
      if (playing) {
        stopPlay()
        return
      }
      void playScore(source, pageConfig).then((r) => {
        if (!r) {
          playBtn.setText('▶ 试听')
          return
        }
        playing = r
        events = r.events
        playStart = performance.now()
        playBtn.setText('⏹ 停止')
        cancelAnimationFrame(rafId)
        rafId = requestAnimationFrame(tick)
      })
    })

    // —— 显示模式切换（整页 / 满宽 / 谱面，下拉选择）——
    const modeWrap = toolbar.createDiv({ cls: 'ijipu-mode-select-wrap' })
    const modeSel = modeWrap.createEl('select', { cls: 'ijipu-mode-select' })
    for (const [mode, label] of Object.entries(MODE_LABEL) as [ViewMode, string][]) {
      const opt = modeSel.createEl('option', { text: label })
      opt.value = mode
    }
    modeSel.value = 'page'
    modeSel.addEventListener('change', () => setMode(modeSel.value as ViewMode))
    modeWrap.createEl('span', { cls: 'ijipu-mode-caret', text: '▼' })

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
      modeSel.value = next
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
