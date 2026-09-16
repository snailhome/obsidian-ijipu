/**
 * scorePane.ts — 谱面面板：**代码块 / .jps 文件视图 / ![[x.jps]] 嵌入** 共用的渲染与交互
 *
 * 抽出来的原因：这三种入口需要完全一致的行为（试听色块、显示模式、排版辅助虚线、来源徽标、
 * 页面设置、frontmatter/设置变更即时重渲染、渲染失败提示），各写一份必然漂移。
 *
 * 工具条两枚图标按钮（与 iJipu 顶栏一致）：
 *  · **排版**（田字格）＝ 开关**排版辅助虚线**，显示后可**拖动虚线**调边距/行距，
 *    松手即写回谱面源码的 `# jps-config`（与 iJipu「拖动结束即持久化」一致）；
 *  · **页面设置**（滑杆）＝ 打开对话框按字段精确设值（字体/字号等不可拖项）。
 *
 * 渲染管线与 iJipu 应用一致：`resolvePageConfig`（含源内 # jps-config）→ `layoutScore`
 * → `renderScoreToSvg`；试听走 `@ijipu/engine` 的 `buildPlaySequence` + SpessaSynth。
 */
import { Menu, Notice } from 'obsidian'
import { writeJpsConfig, dragDelta, clamp, type PageConfig } from '@ijipu/engine'
import { renderScoreFull, playScore, unknownKeyHint, deprecatedKeyHint, type PlayheadSeg } from './render'
import { instrumentColorMap, playheadBaseOf, playheadPosIn, trackKeysOf, type PlayheadPos } from './playhead'
import { resolvePageConfig } from './config'
import { ConfigDialog } from './configDialog'
import { DEFS } from './defs'
import { layoutIcon, modeIcon, settingsIcon, linkIcon, playIcon, stopIcon } from './icons'
import { computeGuideLines, cropRectFor, guideLimits, guidePlacement, type GuideLine } from './guides'
import { GUIDES_CHANGED, SETTINGS_CHANGED } from './main'
import type IJipuPlugin from './main'

type ViewMode = 'page' | 'full' | 'score'
const MODE_LABEL: Record<ViewMode, string> = { page: '整页', full: '满宽', score: '谱面' }
/** 三种显示模式的含义（按钮悬停提示用——图标只表意，文字补足准确含义） */
const MODE_HINT: Record<ViewMode, string> = {
  page: '完整一页（含页边距），宽度撑满内容区',
  full: '谱面撑满笔记宽度（不留页面左右留白）',
  score: '裁掉页边距、只显示内容区（默认）',
}
/** 与 iJipu 应用一致的播放色块配色与定位（adj452：抽到 playhead.ts 纯函数，可单测） */

export type ScorePaneHost = {
  plugin: IJipuPlugin
  /** 渲染容器（挂载时会被清空） */
  container: HTMLElement
  /** 当前源码（.jps 全文 / 代码块正文） */
  getSource: () => string
  /** 笔记 frontmatter（.jps 文件视图与嵌入传 null） */
  getFrontmatter?: () => Record<string, unknown> | null
  /** 把新源码写回（「排版」拖拽结束 / 「页面设置」保存到谱面时调用）；不提供则无写回入口 */
  writeSource?: (next: string) => void | Promise<void>
  /** 嵌入模式：更紧凑（隐藏页数标签等） */
  embedded?: boolean
  /**
   * 嵌入模式下的谱面名（显示在工具栏**右端**，前置链接图标，点击打开该 .jps）。
   * 插件接管 `![[x.jps]]` 的 `.internal-embed` 后，宿主原本那个"点开文件"的占位块不再出现，
   * 由这里补回入口；容器窄时只留图标（见 styles.css 的 @container 规则）。
   */
  embedTitle?: string
  /** 点击嵌入标题时调用（打开被嵌入的 .jps 文件） */
  onOpenFile?: () => void
}

export type ScorePaneHandle = {
  /** 卸下（停止试听/结束拖拽 + 清空容器 + 注销监听） */
  destroy: () => void
  /** 重新解析并重画（frontmatter/源码变化时由宿主调用） */
  refresh: () => void
}

/** 挂载一个谱面面板（详见文件头说明） */
export function mountScorePane(host: ScorePaneHost): ScorePaneHandle {
  const { plugin, container } = host
  let stopPlay: (() => void) | null = null
  let rafId = 0
  let rafPending = false
  // —— 面板级状态（跨重画保持）——
  let paneMode: ViewMode = 'score'
  let modeBeforeGuides: ViewMode = 'page'
  /** 拖拽中的草稿配置（拖完写回源码后清空） */
  let draft: PageConfig | null = null
  /** 当前拖拽的 window 监听清理函数 */
  let endDragListeners: (() => void) | null = null

  const stopRuntime = (): void => {
    stopPlay?.()
    stopPlay = null
    cancelAnimationFrame(rafId)
  }

  /** 全量重画（工具条 + 谱面 + 辅助虚线）；拖拽期间按帧节流 */
  const paint = (): void => {
    stopRuntime()
    container.empty()
    container.addClass('ijipu-score')
    if (host.embedded) container.addClass('ijipu-embedded')

    const source = host.getSource()
    const fm = host.getFrontmatter?.() ?? null
    // 优先级：默认 < 插件设置 < frontmatter < 源内 # jps-config（源内最高）
    const resolved = resolvePageConfig(source, plugin.settings, fm)
    const cfg = draft ?? resolved.config
    const { svgs, layout: layoutMaybe, error, warnings, errorIssues } = renderScoreFull(source, cfg)

    if (error || !layoutMaybe) {
      // adj394：错误也给出「正确写法」（引擎 hint）——不只告诉用户哪里错了
      const errBox = container.createDiv({ cls: 'ijipu-error', text: `⚠ 简谱解析失败：\n${error ?? '无排版结果'}` })
      for (const e of errorIssues ?? []) {
        if (e.hint) errBox.createDiv({ cls: 'ijipu-hint', text: `正确写法：${e.hint}` })
      }
      return
    }
    // adj394：告警（warning 级）不阻断渲染，但要在谱面下方看得见——
    // 此前插件把任何 errors 都当致命（`errors.length > 0`），一条告警就整页不渲染
    if (warnings && warnings.length > 0) {
      const warnBox = container.createDiv({ cls: 'ijipu-warn' })
      const head = warnBox.createDiv({ cls: 'ijipu-warn-head', text: `⚠ ${warnings.length} 条语法告警（不影响显示）` })
      const list = warnBox.createEl('ul', { cls: 'ijipu-warn-list' })
      for (const w of warnings) {
        const li = list.createEl('li', { cls: 'ijipu-warn-item' })
        li.createSpan({ cls: 'ijipu-warn-text', text: w.text })
        // adj394：告警下方给出正确语法规则（引擎 hint，含最小示例）
        if (w.hint) li.createSpan({ cls: 'ijipu-hint', text: `正确写法：${w.hint}` })
      }
      let open = false
      list.toggleClass('is-open', open)
      head.onclick = () => {
        open = !open
        list.toggleClass('is-open', open)
      }
      head.setAttr('title', '点击展开/收起告警明细（含正确写法）')
    }
    // 收窄为常量：闭包（虚线层/拖拽）里也要用，TS 不会跨函数保留 null 判定
    const layout = layoutMaybe

    // —— 工具条 ——
    // 注：「谱面自带设置 N 项」不再占工具栏位置 —— 移到「设置」对话框里（见 ConfigDialog）
    const toolbar = container.createDiv({ cls: 'ijipu-score-toolbar' })
    if (!host.embedded) toolbar.createSpan({ cls: 'ijipu-page-label', text: `${svgs.length} 页` })
    if (resolved.applied.length > 0) {
      const badge = toolbar.createSpan({ cls: 'ijipu-fm-badge', text: `frontmatter 覆盖 ${resolved.applied.length} 项` })
      badge.setAttr(
        'title',
        `来自笔记 frontmatter（只对谱面未自带设置的键生效）：\n${resolved.applied
          .map((a) => `${a.key} = ${String(a.value)}`)
          .join('\n')}`,
      )
    }

    // —— 试听（播放/停止 + RAF 驱动色块跟随，与 iJipu 一致）——
    let playing: { cancel: () => void; totalMs: number; track: PlayheadSeg[] } | null = null
    let playStart = 0
    // 试听按钮：图标 + 文字（窄容器里文字由 @container 规则隐藏，只留图标）
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play' })
    const playIconEl = playBtn.createSpan({ cls: 'ijipu-btn-icon' })
    const playLabel = playBtn.createSpan({ cls: 'ijipu-btn-label', text: '试听' })
    /** 切换试听按钮的「图标 + 文字 + 悬停说明」（三者必须同步换，否则窄容器下会显示错） */
    const setPlayState = (isPlaying: boolean): void => {
      playIconEl.empty()
      playIconEl.appendChild(isPlaying ? stopIcon(15) : playIcon(15))
      playLabel.setText(isPlaying ? '停止' : '试听')
      playBtn.setAttr('title', isPlaying ? '停止试听' : '试听这一份谱（可边听边看高亮色块）')
    }
    setPlayState(false)
    const svgEls: SVGSVGElement[] = []

    const clearPlayBlock = (): void => {
      for (const svgEl of svgEls) svgEl.querySelectorAll('.ijipu-play-block').forEach((el) => el.remove())
    }

    /** 与 iJipu PreviewPane.playheadPosOf 完全一致：按拍段定位整曲行色块（每组独立；多声部各行） */

    /**
     * 绘制一个色块（adj452）：颜色优先取**声部角色**（`playVoice`：bz 伴奏蓝 / dsb 下层绿 /
     * dsb 上层红），否则按**音色**着色（与 iJipu 应用 `playheadBaseOf` 同一规则）。
     */
    const addBlock = (pageIndex: number, pos: PlayheadPos, colorMap: Map<string, number>): void => {
      const svgEl = svgEls[pageIndex]
      if (!svgEl) return
      const color = playheadBaseOf(pos, colorMap)
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
      setPlayState(false)
      plugin.unregisterPlay(stopPlayFn)
    }

    const tick = (): void => {
      const currentMs = performance.now() - playStart - 200 // 与 iJipu 一致的 200ms 起播延迟
      const noteSize = cfg.note_size ?? 13
      const track = playing?.track ?? []
      clearPlayBlock()
      if (currentMs > 0 && track.length) {
        // adj452：按 (页, 曲行, 声部, 音色, 声部角色) **逐组建色块**——与 iJipu 应用同规则：
        // 多声部各声部一块；重叠区（bz 伴奏 / dsb 上下层）在同一曲行里同时发声也各有各的块
        // （旧实现"每个曲行只取一个当前拍段"只画得出一块，且高度用硬编码、不按音色配色）。
        const colorMap = instrumentColorMap(track)
        for (const [key, segs] of trackKeysOf(track)) {
          const pageIndex = Number(key.split('|')[0])
          if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= svgEls.length) continue
          const pos = playheadPosIn(segs, currentMs, pageIndex, noteSize)
          if (pos) addBlock(pageIndex, pos, colorMap)
        }
      }
      const total = playing?.totalMs ?? 0
      if (currentMs >= total) {
        clearPlayBlock()
        playing = null
        setPlayState(false)
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
      void playScore(source, cfg, { hqVoice: plugin.settings.hqVoice, workletUrl: plugin.getWorkletUrl() })
        .then((r) => {
          if (!r) {
            setPlayState(false)
            return
          }
          playing = r
          playStart = performance.now()
          setPlayState(true)
          cancelAnimationFrame(rafId)
          rafId = requestAnimationFrame(tick)
          plugin.registerPlay(stopPlayFn)
        })
        .catch((e) => {
          setPlayState(false)
          new Notice(`试听失败：${e instanceof Error ? e.message : String(e)}`, 6000)
        })
    })

    // —— 排版（田字格）：开关"排版辅助虚线"，显示后可拖动虚线调边距/行距 ——
    const guidesBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-guides-btn' })
    guidesBtn.setAttr(
      'title',
      plugin.showGuides
        ? '排版：隐藏辅助虚线（虚线可直接拖动调整边距/行距）'
        : '排版：显示辅助虚线（拖动虚线调整边距/行距，松手即写入谱面设置；自动切到整页视图）',
    )
    guidesBtn.appendChild(layoutIcon(15))
    guidesBtn.createSpan({ cls: 'ijipu-btn-label', text: '排版' })
    guidesBtn.classList.toggle('is-active', plugin.showGuides)
    guidesBtn.addEventListener('click', () => {
      const on = plugin.toggleGuides()
      if (on) {
        // 边距在「谱面（裁掉边距）」模式下看不见，故显示虚线时切到整页视图，关闭后恢复
        modeBeforeGuides = paneMode
        if (paneMode === 'score') paneMode = 'page'
      } else if (paneMode !== modeBeforeGuides) {
        paneMode = modeBeforeGuides
      }
      paint()
    })

    // —— 页面设置（滑杆）：对话框按字段精确设值（字体/字号等不可拖项） ——
    if (host.writeSource) {
      const cfgBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-config-btn' })
      cfgBtn.setAttr('title', '页面设置：按字段精确设值（字体/字号/行距/渲染开关；可保存到谱面或存为插件默认）')
      cfgBtn.appendChild(settingsIcon(15))
      cfgBtn.createSpan({ cls: 'ijipu-btn-label', text: '设置' })
      cfgBtn.addEventListener('click', () => {
        new ConfigDialog(plugin.app, {
          current: resolved.config,
          // 「谱面自带设置 N 项」不再挂工具栏，改写进对话框（含具体是哪几项、值是什么）
          sourceFields: resolved.sourceFields,
          sourceValues: resolved.config as unknown as Record<string, unknown>,
          onApply: (target, next) => {
            if (target === 'plugin') {
              const bag = plugin.settings as unknown as Record<string, unknown>
              const src = next as unknown as Record<string, unknown>
              for (const def of DEFS) bag[def.key as string] = src[def.key as string]
              void plugin.saveSettings().then(() => new Notice('已保存为插件默认（对未自带设置的谱生效）'))
              return
            }
            // adj-font（D1）：'score' = 差量写入（只写与默认不同）；'score-full' = 固化全部（分享/存档）
            const full = target === 'score-full'
            void Promise.resolve(host.writeSource?.(writeJpsConfig(host.getSource(), next, full ? { mode: 'full' } : undefined)))
              .then(() => {
                new Notice(full ? '已把全部设置固化到谱面（# jps-config，全量）' : '已写入谱面 # jps-config（差量：只记录与默认不同的项）')
                paint()
              })
              .catch((e) => new Notice(`写入谱面失败：${e instanceof Error ? e.message : String(e)}`, 6000))
          },
        }).open()
      })
    }

    // —— 显示模式：下拉列表（整页 / 满宽 / 谱面）——
    // 用普通按钮 + Obsidian 的 Menu，而**不是**原生 <select>：
    //  · 原生 select 会给下拉箭头预留内边距、宽度收不紧（在嵌入容器等上下文里还会参与布局，
    //    导致按钮比"图标 + 文字 + 箭头"宽一截）；
    //  · 它的弹层底色/文字色由平台决定，深色主题下会变成浅底浅字。
    // 自绘这三部分后宽度严格等于内容，菜单则完全跟随主题配色（且自带当前项勾选）。
    const modeWrap = toolbar.createEl('button', { cls: 'ijipu-mode-select-wrap' })
    modeWrap.setAttr('type', 'button')
    modeWrap.setAttr('aria-label', '显示模式')
    modeWrap.setAttr('aria-haspopup', 'menu')
    const modeIconEl = modeWrap.createSpan({ cls: 'ijipu-mode-icon' })
    modeIconEl.appendChild(modeIcon(paneMode, 15))
    const modeTextEl = modeWrap.createSpan({ cls: 'ijipu-mode-text', text: MODE_LABEL[paneMode] })
    modeWrap.createSpan({ cls: 'ijipu-mode-caret', text: '▼' })
    modeWrap.addEventListener('click', () => {
      const rect = modeWrap.getBoundingClientRect()
      const menu = new Menu()
      for (const mode of Object.keys(MODE_LABEL) as ViewMode[]) {
        menu.addItem((item) =>
          item.setTitle(MODE_LABEL[mode]).setChecked(paneMode === mode).onClick(() => setMode(mode)),
        )
      }
      // 按按钮下沿对齐展开（鼠标点、键盘 Enter 都适用）
      menu.showAtPosition({ x: rect.left, y: rect.bottom })
    })

    // —— 工具栏右端：打开谱面文件（仅嵌入模式；容器窄时只留链接图标）——
    if (host.embedded && host.embedTitle) {
      const link = toolbar.createEl('button', { cls: 'ijipu-embed-link' })
      link.setAttr('title', `打开谱面文件：${host.embedTitle}`)
      link.setAttr('aria-label', `打开谱面文件：${host.embedTitle}`)
      link.appendChild(linkIcon(15))
      link.createSpan({ cls: 'ijipu-embed-link-text', text: host.embedTitle })
      link.addEventListener('click', () => host.onOpenFile?.())
    }

    if (resolved.unknown.length > 0) {
      container.createDiv({ cls: 'ijipu-fm-warn', text: `⚠ 未识别的 frontmatter 键：${unknownKeyHint(resolved.unknown)}` })
    }
    // 已降级为「用户个性」的旧键（编辑器偏好等）：明确说明"为什么不生效"（不再随谱保存）
    if (resolved.deprecated.length > 0) {
      container.createDiv({ cls: 'ijipu-fm-warn', text: `ℹ 已不再随谱保存的设置：${deprecatedKeyHint(resolved.deprecated)}` })
    }
    if (plugin.showGuides) {
      container.createDiv({
        cls: 'ijipu-guide-hint',
        text: '排版：拖动虚线调整边距/行距（松手即写入谱面设置）',
      })
    }

    // —— 逐页插入 SVG + 辅助虚线 ——
    const svgWrap = container.createDiv({ cls: `ijipu-svgs ijipu-mode-${paneMode}` })
    svgs.forEach((svg, i) => {
      if (svgs.length > 1 && !host.embedded) {
        container.createDiv({ cls: 'ijipu-page-label', text: `第 ${i + 1} / ${svgs.length} 页` })
      }
      const wrap = svgWrap.createDiv({ cls: 'ijipu-page-svg' })
      wrap.innerHTML = svg
      const svgEl = wrap.querySelector('svg') as SVGSVGElement | null
      if (!svgEl) return
      svgEls.push(svgEl)
      applyViewBox(svgEl, paneMode, cfg)
      if (plugin.showGuides) addGuideLayer(wrap, svgEl, i, cfg)
    })

    /** 按显示模式设置 viewBox（'score' 裁到内容区并去掉纸张宽高，交给 CSS 撑满） */
    function applyViewBox(svgEl: SVGSVGElement, mode: ViewMode, c: typeof cfg): void {
      const orig = svgEl.dataset.origVb || svgEl.getAttribute('viewBox') || ''
      svgEl.dataset.origVb = orig
      if (mode === 'score') {
        const [, , w, h] = orig.split(/[\s,]+/).map(Number)
        const ml = c.margin_left ?? 0
        const mt = c.margin_top ?? 0
        const mr = c.margin_right ?? 0
        const mb = c.margin_bottom ?? 0
        svgEl.setAttribute('viewBox', `${ml} ${mt} ${Math.max(1, w - ml - mr)} ${Math.max(1, h - mt - mb)}`)
        svgEl.removeAttribute('width')
        svgEl.removeAttribute('height')
      } else {
        svgEl.setAttribute('viewBox', orig)
      }
    }

    function setMode(next: ViewMode): void {
      paneMode = next
      svgWrap.setAttribute('class', `ijipu-svgs ijipu-mode-${next}`)
      // 按钮上的文字、图标、悬停说明跟着走（图标三种形状见 icons.ts，与菜单项一一对应）
      modeTextEl.setText(MODE_LABEL[next])
      modeIconEl.empty()
      modeIconEl.appendChild(modeIcon(next, 15))
      modeWrap.setAttr('title', `显示模式：${MODE_LABEL[next]}（${MODE_HINT[next]}）`)
      for (const svgEl of svgEls) applyViewBox(svgEl, next, cfg)
    }

    /** 生成一页的辅助虚线层（可拖拽） */
    function addGuideLayer(wrap: HTMLElement, svgEl: SVGSVGElement, pageIndex: number, c: typeof cfg): void {
      const page = layout.pages[pageIndex]
      if (!page) return
      const layer = wrap.createDiv({ cls: 'ijipu-guide-layer' })
      const lines = computeGuideLines(layout, c, pageIndex)
      const boxW = svgEl.getBoundingClientRect().width || page.width
      const crop = cropRectFor(paneMode, c, page.width, page.height)
      for (const line of lines) {
        const { style, scale } = guidePlacement(line, crop, page.width, page.height, boxW)
        const el = layer.createDiv({
          cls: `ijipu-guide-line ${line.dir === 'v' ? 'ijipu-guide-h' : 'ijipu-guide-v'}${line.readonly ? ' is-readonly' : ''}`,
        })
        for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v)
        el.setAttr('title', line.title)
        if (line.readonly) continue
        el.addEventListener('mousedown', (e) => startGuideDrag(e, line, scale))
      }
    }

    /**
     * 拖动虚线：按下记初值 → 移动按 `dragDelta` 改草稿并即时重画 → 松手写回谱面源码
     * （与 iJipu 一致：拖动中不落盘，松手才持久化到 `# jps-config`）。
     */
    function startGuideDrag(e: MouseEvent, line: GuideLine, scale: number): void {
      if (line.readonly || !host.writeSource) return
      e.preventDefault()
      e.stopPropagation()
      endDragListeners?.()
      const base = draft ?? resolved.config
      const startValue = Number((base as unknown as Record<string, unknown>)[line.key] ?? 0)
      const startX = e.clientX
      const startY = e.clientY
      const [min, max] = guideLimits(line.key)
      const onMove = (ev: MouseEvent): void => {
        const delta = dragDelta({ key: line.key, dir: line.dir, invert: line.invert }, startX, startY, ev.clientX, ev.clientY, scale)
        const value = clamp(Math.round((startValue + delta) * 10) / 10, min, max)
        draft = { ...(draft ?? base), [line.key]: value } as typeof base
        schedulePaint()
      }
      const onUp = (): void => {
        endDragListeners?.()
        endDragListeners = null
        const finalCfg = draft
        draft = null
        if (!finalCfg) return
        void Promise.resolve(host.writeSource?.(writeJpsConfig(host.getSource(), finalCfg)))
          .then(() => {
            new Notice(`排版已保存：${line.key} = ${String((finalCfg as unknown as Record<string, unknown>)[line.key])}`, 2500)
            paint()
          })
          .catch((err) => {
            new Notice(`保存失败：${err instanceof Error ? err.message : String(err)}`, 6000)
            paint()
          })
      }
      endDragListeners = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    /** 拖拽期间的按帧节流重画 */
    function schedulePaint(): void {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        paint()
      })
    }

    // 初始显示模式
    setMode(paneMode)
  }

  // 插件设置 / 排版虚线开关变化 → 本面板重画
  const settingsRef = plugin.events.on(SETTINGS_CHANGED, () => paint())
  const guidesRef = plugin.events.on(GUIDES_CHANGED, () => paint())
  paint()

  return {
    refresh: () => paint(),
    destroy: () => {
      stopRuntime()
      endDragListeners?.()
      endDragListeners = null
      plugin.events.offref(settingsRef)
      plugin.events.offref(guidesRef)
      container.empty()
    },
  }
}
