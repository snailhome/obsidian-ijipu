import { Notice, Plugin } from 'obsidian'
import { mergePageConfig, renderScore, playScore } from './render'
import { IJipuSettingTab } from './settings'
import type { IJipuSettings } from './types'
import type { PlayheadSeg } from './render'

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
  /** 所有进行中试听的停止函数（切换笔记时统一停止） */
  private playStops: (() => void)[] = []
  /** 内置 SpessaSynth worklet URL（插件目录读取 → Blob URL；缺失则试听高保真不可用） */
  private workletUrl = ''

  async onload(): Promise<void> {
    await this.loadSettings()
    this.workletUrl = await this.loadWorklet()
    this.addSettingTab(new IJipuSettingTab(this.app, this))
    this.registerMarkdownCodeBlockProcessor('jps', (source, el, ctx) => {
      this.renderBlock(source, el, ctx.sourcePath)
    })
    // 切换笔记时自动结束所有试听（避免试听继续却失去控制）
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        for (const stop of this.playStops) stop()
        this.playStops = []
      }),
    )
  }

  onunload(): void {
    // 插件卸载（禁用/重载）时兜底停止所有试听
    for (const stop of this.playStops) stop()
    this.playStops = []
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  /** 读取内置 SpessaSynth worklet 处理器（插件目录文件 → Blob URL，供 audioWorklet.addModule） */
  private async loadWorklet(): Promise<string> {
    try {
      const p = `.obsidian/plugins/${this.manifest.id}/spessasynth_processor.min.js`
      if (!(await this.app.vault.adapter.exists(p))) return ''
      const buf = await this.app.vault.adapter.readBinary(p)
      const blob = new Blob([buf], { type: 'application/javascript' })
      return URL.createObjectURL(blob)
    } catch {
      return ''
    }
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

    // —— 试听（播放/停止 + RAF 驱动整曲行色块跟随，与 iJipu 一致）——
    let playing: { cancel: () => void; totalMs: number; track: PlayheadSeg[] } | null = null
    let rafId = 0
    let playStart = 0
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play', text: '▶ 试听' })
    const svgEls: SVGSVGElement[] = []

    const clearPlayBlock = (): void => {
      for (const svgEl of svgEls) svgEl.querySelectorAll('.ijipu-play-block').forEach((el) => el.remove())
    }

    // 与 iJipu PreviewPane.playheadPosOf 完全一致：按拍段定位整曲行色块（每组独立；多声部各行）
    const playheadPosOf = (
      track: PlayheadSeg[],
      currentMs: number,
      pageIndex: number,
      noteSize: number,
      group: number,
    ): { x: number; yTop: number; yBottom: number; width: number; voice: number } | null => {
      if (track.length === 0 || currentMs <= 0) return null
      const segs = track.filter((t) => t.group === group)
      if (segs.length === 0) return null
      let lo = 0
      let hi = segs.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (segs[mid].atMs <= currentMs) lo = mid + 1
        else hi = mid
      }
      const i = lo - 1
      if (i < 0 || i >= segs.length) return null
      const a = segs[i]
      if (currentMs >= a.atMs + a.durationMs) return null
      if (a.pageIndex !== pageIndex) return null
      const ext = noteSize * 0.5
      const yTop = a.y - noteSize * 1.1 - ext
      const yBottom = a.y - noteSize * 1.1 + noteSize * 1.7 + ext
      return { x: a.x, yTop, yBottom, width: a.width, voice: a.voice }
    }

    const addBlock = (
      pageIndex: number,
      pos: { x: number; yTop: number; yBottom: number; width: number; voice: number },
    ): void => {
      const svgEl = svgEls[pageIndex]
      if (!svgEl) return
      const color = PLAYHEAD_COLORS[(pos.voice - 1) % PLAYHEAD_COLORS.length]
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('class', 'ijipu-play-block')
      rect.setAttribute('x', String(pos.x))
      rect.setAttribute('width', String(Math.max(1, pos.width)))
      rect.setAttribute('y', String(pos.yTop))
      rect.setAttribute('height', String(Math.max(1, pos.yBottom - pos.yTop)))
      rect.setAttribute('fill', `${color}0.32)`)
      rect.setAttribute('stroke', `${color}0.5)`)
      rect.setAttribute('stroke-width', '1')
      svgEl.appendChild(rect)
    }

    const tick = (): void => {
      const currentMs = performance.now() - playStart - 200 // 与 iJipu 一致的 200ms 起播延迟
      const noteSize = pageConfig.note_size ?? 13
      const track = playing?.track ?? []
      clearPlayBlock()
      if (currentMs > 0 && track.length) {
        for (let pageIndex = 0; pageIndex < svgEls.length; pageIndex++) {
          const pageGroups = [...new Set(track.filter((t) => t.pageIndex === pageIndex).map((t) => t.group))]
          for (const g of pageGroups) {
            const pos = playheadPosOf(track, currentMs, pageIndex, noteSize, g)
            if (pos) addBlock(pageIndex, pos)
          }
        }
      }
      const total = playing?.totalMs ?? 0
      if (currentMs >= total) {
        clearPlayBlock()
        playing = null
        playBtn.setText('▶ 试听')
        this.playStops = this.playStops.filter((f) => f !== stopPlay)
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    const stopPlay = (): void => {
      playing?.cancel()
      playing = null
      cancelAnimationFrame(rafId)
      clearPlayBlock()
      playBtn.setText('▶ 试听')
      this.playStops = this.playStops.filter((f) => f !== stopPlay) // 从全局停止列表移除
    }

    playBtn.addEventListener('click', () => {
      if (playing) {
        stopPlay()
        return
      }
      void playScore(source, pageConfig, { hqVoice: this.settings.hqVoice, workletUrl: this.workletUrl }).then((r) => {
        if (!r) {
          playBtn.setText('▶ 试听')
          return
        }
        playing = r
        playStart = performance.now()
        playBtn.setText('⏹ 停止')
        cancelAnimationFrame(rafId)
        rafId = requestAnimationFrame(tick)
        this.playStops.push(stopPlay) // 登记为可全局停止（切换笔记时自动结束）
      }).catch((e) => {
        // adj353：试听失败原因可见（不再静默无声）
        playBtn.setText('▶ 试听')
        new Notice(`试听失败：${e instanceof Error ? e.message : String(e)}`, 6000)
      })
    })

    // —— 显示模式切换（整页 / 满宽 / 谱面，下拉选择）——
    const modeWrap = toolbar.createDiv({ cls: 'ijipu-mode-select-wrap' })
    const modeSel = modeWrap.createEl('select', { cls: 'ijipu-mode-select' })
    for (const [mode, label] of Object.entries(MODE_LABEL) as [ViewMode, string][]) {
      const opt = modeSel.createEl('option', { text: label })
      opt.value = mode
    }
    modeSel.value = 'score'
    modeSel.addEventListener('change', () => setMode(modeSel.value as ViewMode))
    modeWrap.createEl('span', { cls: 'ijipu-mode-caret', text: '▼' })

    // —— 逐页插入 SVG（存元素，供色块定位与谱面 viewBox 裁剪）——
    const svgWrap = container.createDiv({ cls: 'ijipu-svgs ijipu-mode-score' })
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
          // 移除纸张原生宽高，交由 viewBox + CSS 完全控制，确保只显示内容区（消除上下左右边距）
          svgEl.removeAttribute('width')
          svgEl.removeAttribute('height')
        } else {
          svgEl.setAttribute('viewBox', orig)
        }
      }
    }

    // 默认显示模式：谱面（消除边距，最大化有效观看面积）
    setMode('score')
  }
}
