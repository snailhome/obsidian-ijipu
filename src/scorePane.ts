/**
 * scorePane.ts — 谱面面板：**代码块 / .jps 文件视图 / ![[x.jps]] 嵌入** 共用的渲染与交互
 *
 * 抽出来的原因：这三种入口需要完全一致的行为（试听色块、显示模式、来源徽标、⚙ 排版、
 * frontmatter/设置变更即时重渲染、渲染失败提示），各写一份必然漂移。
 *
 * 渲染管线与 iJipu 应用一致：`resolvePageConfig`（含源内 # jps-config）→ `layoutScore`
 * → `renderScoreToSvg`；试听走 `@ijipu/engine` 的 `buildPlaySequence` + SpessaSynth。
 */
import { Notice } from 'obsidian'
import { writeJpsConfig } from '@ijipu/engine'
import { renderScore, playScore, unknownKeyHint, type PlayheadSeg } from './render'
import { resolvePageConfig } from './config'
import { ConfigDialog } from './configDialog'
import { DEFS } from './defs'
import { layoutIcon, modeIcon } from './icons'
import type IJipuPlugin from './main'

type ViewMode = 'page' | 'full' | 'score'
const MODE_LABEL: Record<ViewMode, string> = { page: '整页', full: '满宽', score: '谱面' }
/** 三种显示模式的含义（按钮悬停提示用——图标只表意，文字补足准确含义） */
const MODE_HINT: Record<ViewMode, string> = {
  page: '完整一页（含页边距），宽度撑满内容区',
  full: '谱面撑满笔记宽度（不留页面左右留白）',
  score: '裁掉页边距、只显示内容区（默认）',
}
/** 与 iJipu 应用一致的播放色块配色（按声部半透明；voice1 红，延续单声部红块） */
const PLAYHEAD_COLORS = [
  'rgba(255, 93, 108,',
  'rgba(87, 170, 255,',
  'rgba(63, 122, 46,',
  'rgba(255, 200, 87,',
  'rgba(138, 95, 184,',
]

export type ScorePaneHost = {
  plugin: IJipuPlugin
  /** 渲染容器（挂载时会被清空） */
  container: HTMLElement
  /** 当前源码（.jps 全文 / 代码块正文） */
  getSource: () => string
  /** 笔记 frontmatter（.jps 文件视图与嵌入传 null） */
  getFrontmatter?: () => Record<string, unknown> | null
  /** 把新源码写回（「排版 → 保存到谱面」用）；不提供则不给该入口 */
  writeSource?: (next: string) => void | Promise<void>
  /** 嵌入模式：更紧凑（隐藏页数标签等） */
  embedded?: boolean
}

export type ScorePaneHandle = {
  /** 卸下（停止试听 + 清空容器 + 注销设置监听） */
  destroy: () => void
  /** 重新解析并重画（frontmatter/源码变化时由宿主调用） */
  refresh: () => void
}

/**
 * 挂载一个谱面面板。
 * @returns 句柄：`refresh()` 重画，`destroy()` 卸下
 */
export function mountScorePane(host: ScorePaneHost): ScorePaneHandle {
  const { plugin, container } = host
  let stopPlay: (() => void) | null = null
  let rafId = 0

  /** 清掉本次渲染的运行时状态（试听/RAF/色块），不碰容器 */
  const stopRuntime = (): void => {
    stopPlay?.()
    stopPlay = null
    cancelAnimationFrame(rafId)
  }

  const paint = (): void => {
    stopRuntime()
    container.empty()
    container.addClass('ijipu-score')
    if (host.embedded) container.addClass('ijipu-embedded')

    const source = host.getSource()
    const fm = host.getFrontmatter?.() ?? null
    // 优先级：默认 < 插件设置 < frontmatter < 源内 # jps-config（源内最高）
    const { config: pageConfig, applied, unknown, sourceFields } = resolvePageConfig(source, plugin.settings, fm)
    const { svgs, error } = renderScore(source, pageConfig)

    if (error) {
      container.createDiv({ cls: 'ijipu-error', text: `⚠ 简谱解析失败：\n${error}` })
      return
    }

    // —— 工具条 ——
    const toolbar = container.createDiv({ cls: 'ijipu-score-toolbar' })
    if (!host.embedded) toolbar.createSpan({ cls: 'ijipu-page-label', text: `${svgs.length} 页` })
    // 源内设置徽标：这份谱自带 # jps-config（优先级最高，覆盖插件设置与 frontmatter）
    if (sourceFields.length > 0) {
      const badge = toolbar.createSpan({
        cls: 'ijipu-fm-badge ijipu-src-badge',
        text: `谱面自带设置 ${sourceFields.length} 项`,
      })
      badge.setAttr(
        'title',
        `来自源码 # jps-config 行（优先级最高，覆盖插件设置与 frontmatter）：\n${sourceFields
          .map((f) => `${f} = ${String((pageConfig as unknown as Record<string, unknown>)[f])}`)
          .join('\n')}`,
      )
    }
    // frontmatter 覆盖可见化（只对源内未写的键生效）
    if (applied.length > 0) {
      const badge = toolbar.createSpan({ cls: 'ijipu-fm-badge', text: `frontmatter 覆盖 ${applied.length} 项` })
      badge.setAttr(
        'title',
        `来自笔记 frontmatter（只对谱面未自带设置的键生效）：\n${applied
          .map((a) => `${a.key} = ${String(a.value)}`)
          .join('\n')}`,
      )
    }

    // —— 试听（播放/停止 + RAF 驱动色块跟随，与 iJipu 一致）——
    let playing: { cancel: () => void; totalMs: number; track: PlayheadSeg[] } | null = null
    let playStart = 0
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play', text: '▶ 试听' })
    const svgEls: SVGSVGElement[] = []

    const clearPlayBlock = (): void => {
      for (const svgEl of svgEls) svgEl.querySelectorAll('.ijipu-play-block').forEach((el) => el.remove())
    }

    /** 与 iJipu PreviewPane.playheadPosOf 完全一致：按拍段定位整曲行色块（每组独立；多声部各行） */
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

    const stopPlayFn = (): void => {
      playing?.cancel()
      playing = null
      cancelAnimationFrame(rafId)
      clearPlayBlock()
      playBtn.setText('▶ 试听')
      plugin.unregisterPlay(stopPlayFn)
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
        plugin.unregisterPlay(stopPlayFn)
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    stopPlay = stopPlayFn

    playBtn.addEventListener('click', () => {
      if (playing) {
        stopPlayFn()
        return
      }
      void playScore(source, pageConfig, { hqVoice: plugin.settings.hqVoice, workletUrl: plugin.getWorkletUrl() })
        .then((r) => {
          if (!r) {
            playBtn.setText('▶ 试听')
            return
          }
          playing = r
          playStart = performance.now()
          playBtn.setText('⏹ 停止')
          cancelAnimationFrame(rafId)
          rafId = requestAnimationFrame(tick)
          plugin.registerPlay(stopPlayFn) // 可全局停止（切换笔记时自动结束）
        })
        .catch((e) => {
          playBtn.setText('▶ 试听')
          new Notice(`试听失败：${e instanceof Error ? e.message : String(e)}`, 6000)
        })
    })

    // —— 排版（改这一份谱：写回源码 # jps-config；也可存为插件默认）——
    // 图标用**田字格**（与 iJipu 应用顶栏「排版」按钮同一形状），不用齿轮 emoji
    if (host.writeSource) {
      const cfgBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-config-btn' })
      cfgBtn.setAttr('title', '排版：调整这一份谱的设置（保存到源码 # jps-config 行，与 iJipu 一致）')
      cfgBtn.appendChild(layoutIcon(15))
      cfgBtn.createSpan({ text: '排版' })
      cfgBtn.addEventListener('click', () => {
        new ConfigDialog(plugin.app, {
          current: pageConfig,
          hasSourceConfig: sourceFields.length > 0,
          onApply: (target, cfg) => {
            if (target === 'plugin') {
              // 只把对话框里编辑的字段写入插件设置（全局默认），不夹带其它键
              const bag = plugin.settings as unknown as Record<string, unknown>
              const src = cfg as unknown as Record<string, unknown>
              for (const def of DEFS) bag[def.key as string] = src[def.key as string]
              void plugin.saveSettings().then(() => new Notice('已保存为插件默认（对未自带设置的谱生效）'))
              return
            }
            const next = writeJpsConfig(host.getSource(), cfg)
            void Promise.resolve(host.writeSource?.(next))
              .then(() => new Notice('已写入谱面 # jps-config（该谱自带设置，优先级最高）'))
              .catch((e) => new Notice(`写入谱面失败：${e instanceof Error ? e.message : String(e)}`, 6000))
          },
        }).open()
      })
    }

    // —— 显示模式切换（整页 / 满宽 / 谱面：图标表意 + 悬停说明，互斥选中态）——
    const modeWrap = toolbar.createDiv({ cls: 'ijipu-mode-group' })
    const modeBtns = new Map<ViewMode, HTMLButtonElement>()
    for (const mode of Object.keys(MODE_LABEL) as ViewMode[]) {
      const btn = modeWrap.createEl('button', { cls: 'ijipu-mode-btn' })
      btn.setAttr('title', `${MODE_LABEL[mode]}：${MODE_HINT[mode]}`)
      btn.setAttr('aria-label', MODE_LABEL[mode])
      btn.appendChild(modeIcon(mode, 15))
      btn.addEventListener('click', () => setMode(mode))
      modeBtns.set(mode, btn)
    }

    // 未识别的 ijipu_* 键：显式提示 + 最近键名建议（不再静默忽略）
    if (unknown.length > 0) {
      container.createDiv({ cls: 'ijipu-fm-warn', text: `⚠ 未识别的 frontmatter 键：${unknownKeyHint(unknown)}` })
    }

    // —— 逐页插入 SVG ——
    const svgWrap = container.createDiv({ cls: 'ijipu-svgs ijipu-mode-score' })
    svgs.forEach((svg, i) => {
      if (svgs.length > 1 && !host.embedded) {
        container.createDiv({ cls: 'ijipu-page-label', text: `第 ${i + 1} / ${svgs.length} 页` })
      }
      const wrap = svgWrap.createDiv({ cls: 'ijipu-page-svg' })
      wrap.innerHTML = svg
      const svgEl = wrap.querySelector('svg') as SVGSVGElement | null
      if (svgEl) svgEls.push(svgEl)
    })

    const setMode = (next: ViewMode): void => {
      svgWrap.setAttribute('class', `ijipu-svgs ijipu-mode-${next}`)
      // 选中态（图标按钮组互斥）
      for (const [m, btn] of modeBtns) btn.classList.toggle('is-active', m === next)
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

  // 插件设置变更 → 本面板重画（不必等宿主重渲染）
  const settingsRef = plugin.events.on('settings-changed', () => paint())
  paint()

  return {
    refresh: () => paint(),
    destroy: () => {
      stopRuntime()
      plugin.events.offref(settingsRef)
      container.empty()
    },
  }
}
