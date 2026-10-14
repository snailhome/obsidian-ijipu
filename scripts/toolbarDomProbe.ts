/**
 * scripts/toolbarDomProbe.ts — adj952 冒烟夹具：在**真 DOM**（无头浏览器）里驱动**真的**谱面面板
 *
 * 为什么非得起浏览器：用户报的是**交互**（「嵌入块、编辑模式下点预览区，工具条显示一下又马上消失」
 * 「每点一次都闪一下」）。显隐是"元素上的类 + 若干监听 + 若干定时器"共同的结果，
 * 源码级正则只能证明"某行还在"，**证不了点一下之后它还在不在**。
 *
 * 夹具只换宿主、**不动 `src/scorePane.ts` 一个字**：
 *  · `scripts/toolbarDomShim.ts` = 浏览器内的 `obsidian` 替身；
 *  · 本文件 = 动作（搭"仿实时预览嵌入块"的 DOM → 挂**真的**面板 → 走真实事件 → 逐步量显隐）。
 *
 * 量到的每一步都记成结构化 JSON（`{revealed, where, vis, op, bars}`），由冒烟的 adj952 一节判：
 *  · `revealed` = 工具条带没带 `is-revealed`（= 面板认定的"显示"）；
 *  · `where` = 它在哪儿（`container` / `body` / `gone`）—— 显示态下会被搬到 `document.body`（adj793c）；
 *  · `vis`/`op` = **真实 `styles.css` 算出来的** visibility / opacity（证明"类在"真的等于"看得见"）；
 *  · `bars` = **整个文档里**这类工具条的条数（旧面板残留会在这一步露出来，见 adj794f）。
 *
 * 时间线（编辑模式与阅读模式**各走一遍**，便于对照）：
 *   init → 手势点击预览区 → 若干帧 → **宿主重排**（容器短暂脱离文档）→ 400ms →
 *   同实例重画（`refresh()`）→ **宿主重建面板**（同一容器上 destroy + 重挂）→ 移动/移出 →
 *   再点一次 → 再点开 → **点块外**
 *
 * ⚠ 合成事件**不会**改焦点（夹具里没有真窗口焦点），所以"失焦延迟收起"那条路径只由 400ms 那一步
 *   间接覆盖（`focusout` 由真实宿主派发）；真机上的最终确认仍要用户重载亲眼看（见提交说明）。
 */

type PaneHandle = { destroy: () => void; refresh: () => void }
type MountFn = (host: Record<string, unknown>) => PaneHandle

/** 一步的量测结果（冒烟按字段断言，不做字符串匹配） */
type Step = { revealed: boolean; where: string; vis: string; op: string; bars: number }

/** 面板真的需要的宿主面（字段名照抄 `src/main.ts` / `src/embed.ts` 传的那份） */
function makeHost(container: HTMLElement, source: string, record: Record<string, unknown>): Record<string, unknown> {
  return {
    plugin: {
      settings: {},
      events: { on: () => ({}), offref: () => undefined },
      register: () => undefined,
      app: { vault: { configDir: '.obsidian' }, workspace: {} },
      lastToolbarInfo: null,
      lastToolbarClick: null,
      lastCropInfo: null,
      lastSvgParse: null,
      lastInk: null,
      showGuides: false,
      toggleGuides: () => undefined,
      setExportRange: () => undefined,
      setImageScale: () => undefined,
      copyScoreImage: async () => undefined,
      copyScoreSource: () => undefined,
      copyScoreSvg: () => undefined,
      saveScorePng: async () => undefined,
      saveScoreSvg: async () => undefined,
      getBankFiles: async () => [],
      getWorkletUrl: () => '',
      openEmbedSoundbank: async () => null,
      registerPlay: () => undefined,
      unregisterPlay: () => undefined,
      /** 诊断的落点：夹具把它们读回来（证明"我们的处理器真的收到了那次点击"） */
      __record: record,
    },
    container,
    getSource: () => source,
    embedded: true,
    embedTitle: '半山听雨',
    filePath: '半山听雨.jps',
    onOpenFile: () => undefined,
    onEdit: () => undefined,
  }
}

/** 一帧（rAF；给一条超时兜底，免得虚拟时钟下卡住 ⇒ 整份结果读不回来） */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const fin = (): void => {
      if (done) return
      done = true
      resolve()
    }
    requestAnimationFrame(() => fin())
    setTimeout(fin, 40)
  })
}
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame()
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 一次**完整手势**（真鼠标点击的派发顺序）—— 用来抓"一次点击被切换好几下"那类双触发 */
function gesture(el: Element, type: 'click' | 'hover' = 'click'): void {
  const base: PointerEventInit = { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: 'mouse' }
  if (type === 'hover') {
    for (const t of ['pointerover', 'pointerenter', 'pointermove', 'mouseover', 'mouseenter', 'mousemove']) {
      const ev = t.startsWith('pointer') ? new PointerEvent(t, base) : new MouseEvent(t, base)
      el.dispatchEvent(ev)
    }
    for (const t of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
      const ev = t.startsWith('pointer') ? new PointerEvent(t, base) : new MouseEvent(t, base)
      el.dispatchEvent(ev)
    }
    return
  }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }))
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', base))
}

export async function runToolbarProbe(mount: MountFn, source: string, sweep: () => void): Promise<void> {
  const out = document.getElementById('out') as HTMLElement | null
  const result: Record<string, unknown> = { done: false, step: 'init' }
  /** 每步都写一次：即使虚拟时钟提前 dump，也能看出跑到哪一步了（`done` 是"跑完"的标记） */
  const flush = (): void => {
    if (out) out.textContent = JSON.stringify(result)
  }
  flush()
  try {
    result.edit = await scenario(mount, source, 'edit', sweep)
    result.step = 'edit-done'
    flush()
    result.read = await scenario(mount, source, 'read', sweep)
    result.step = 'read-done'
    result.done = true
    flush()
  } catch (e) {
    result.error = e instanceof Error ? e.message + '｜' + (e.stack ?? '') : String(e)
    flush()
  }
}

async function scenario(
  mount: MountFn,
  source: string,
  mode: 'edit' | 'read',
  sweep: () => void,
): Promise<Record<string, unknown>> {
  const steps: Record<string, Step> = {}
  const record: Record<string, unknown> = {}
  /** 面板 id 是自增的（`paneSeq`）⇒ 本场景的工具条 = 文档里 id 最大的那一条（每次重挂都会更大） */
  let maxPaneId = 0
  const bar = (): HTMLElement | null => {
    let best: HTMLElement | null = null
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('.ijipu-score-toolbar[data-ijipu-pane]'))) {
      const id = Number(b.dataset.ijipuPane ?? 0)
      if (id >= maxPaneId) {
        maxPaneId = id
        best = b
      }
    }
    return best
  }
  const stateOf = (): Step => {
    const b = bar()
    const bars = document.querySelectorAll('.ijipu-score-toolbar').length
    if (b === null) return { revealed: false, where: 'gone', vis: 'gone', op: 'gone', bars }
    const cs = getComputedStyle(b)
    const where =
      b.parentElement === document.body
        ? 'body'
        : b.parentElement === container
          ? 'container'
          : b.isConnected
            ? 'other'
            : 'detached'
    return { revealed: b.classList.contains('is-revealed'), where, vis: cs.visibility, op: cs.opacity, bars }
  }
  const snap = (label: string): void => {
    steps[label] = stateOf()
  }
  /** 每次手势之后把宿主的诊断读数抄一份（`lastToolbarClick`）——它在真机上就是用户能贴回来的那一行 */
  const clickLog: string[] = []
  const logClick = (): void => {
    const v = latestPlugin.lastToolbarClick
    clickLog.push(typeof v === 'string' ? v : '')
  }

  // —— 搭 DOM：编辑模式 = CM6 实时预览里的一块 `![[x.jps]]`；阅读模式 = 预览视图里的同一个嵌入 ——
  const host = document.getElementById('host') as HTMLElement
  host.textContent = ''
  const root = document.createElement('div')
  const container = document.createElement('div')
  container.id = 'emb-' + mode
  container.className = 'internal-embed ijipu-embed is-loaded'
  container.setAttribute('src', '半山听雨.jps')
  container.style.minHeight = '220px'
  if (mode === 'edit') {
    root.className = 'markdown-source-view cm-s-obsidian mod-cm6 is-live-preview'
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const scroller = document.createElement('div')
    scroller.className = 'cm-scroller'
    scroller.style.overflow = 'auto'
    const content = document.createElement('div')
    content.className = 'cm-content'
    content.setAttribute('contenteditable', 'true')
    const line = document.createElement('div')
    line.className = 'cm-line'
    const block = document.createElement('div')
    block.className = 'cm-embed-block'
    block.appendChild(container)
    line.appendChild(block)
    const outsideLine = document.createElement('div')
    outsideLine.className = 'cm-line'
    outsideLine.id = 'outside-' + mode
    outsideLine.textContent = '块外：同一篇笔记的普通文本行'
    content.appendChild(line)
    content.appendChild(outsideLine)
    scroller.appendChild(content)
    editor.appendChild(scroller)
    root.appendChild(editor)
  } else {
    root.className = 'markdown-reading-view'
    const view = document.createElement('div')
    view.className = 'markdown-preview-view markdown-rendered'
    const section = document.createElement('div')
    section.className = 'markdown-preview-section'
    const p1 = document.createElement('div')
    p1.className = 'el-p'
    p1.appendChild(container)
    const p2 = document.createElement('div')
    p2.className = 'el-p'
    p2.id = 'outside-' + mode
    p2.textContent = '块外：同一篇笔记的普通段落'
    section.appendChild(p1)
    section.appendChild(p2)
    view.appendChild(section)
    root.appendChild(view)
  }
  host.appendChild(root)

  /** 当前这一代宿主的 plugin 对象（诊断字段写在它身上 ⇒ 量回来当证据） */
  let latestPlugin: Record<string, unknown> = {}
  const mountPane = (): PaneHandle => {
    const h = makeHost(container, source, record)
    latestPlugin = h.plugin as Record<string, unknown>
    return mount(h)
  }
  let pane = mountPane()
  await frames(2)
  /**
   * 夹具自检（**在销毁之前**量）：谱面真的画出来了吗？工具条真的存在吗？
   * 若谱面解析失败，`paint()` 会在建工具条之**前**就 `return`（错误提示分支）⇒ 后面所有量测都无意义 ⇒
   * 冒烟必须能看到这个区别，而不是把"没跑到"当成"没问题"。
   */
  const selfCheck = {
    svg: container.querySelectorAll('svg').length,
    toolbarInDoc: document.querySelectorAll('.ijipu-score-toolbar').length,
    hasCmBlock: container.closest('.cm-embed-block') !== null,
    containerRect: (() => {
      const r = container.getBoundingClientRect()
      return [Math.round(r.width), Math.round(r.height), Math.round(r.top)]
    })(),
  }

  const target = (): Element => container.querySelector('.ijipu-svgs') ?? container
  const outside = (): Element => document.getElementById('outside-' + mode) as Element

  snap('init')
  gesture(target())
  snap('click1')
  logClick()
  /**
   * ⚠ 这里只等**一帧**（≈16ms；兜底 40ms）：`revealToolbar(true)` 还会在 **50ms** 后复查一次落位，
   * 而下面那一步要让容器在那次复查**之前**就脱离文档（编辑模式里宿主重建 widget 的真实时序）
   * ⇒ 等两帧的话，50ms 那次复查可能已经跑完（跑在容器还连着的时候），测不到"脱离文档期间"的行为。
   */
  await frames(1)
  snap('click1_frames')

  /**
   * **宿主重排**：实时预览里 CM6 会重建这块 widget —— 我们的容器会**短暂脱离文档**
   * （`src/embed.ts` 里写着这个事实："先在脱离文档的容器里跑完 … 再由 CodeMirror 插进文档"）。
   *
   * 这里故意让它脱离 **250ms**（远长于 `revealToolbar` 里那两个复查 = 下一帧 + 50ms，
   * 又远短于孤儿判定的宽限期）：旧代码会在这段时间里把刚点开的工具条收掉/删掉，
   * 且没有任何后续动作把它放回来 ⇒ 这一步能**稳定**量到"消失"（不是踩时序运气）。
   */
  const parent = container.parentElement as HTMLElement
  const next = container.nextSibling
  container.remove()
  snap('detach_0')
  /**
   * 直接调一次**孤儿清理**（`sweepOrphanBodyToolbars`，就是 `mountScorePane` 在挂载/每次摆位时
   * 会调的那个出口）：容器此刻**脱离文档**，但面板还活着 —— 这一步把"清理会不会误杀它"
   * 变成一个**不依赖 rAF/定时器时序**的确定性量（这是本轮修的那条真凶）。
   */
  sweep()
  await frames(1)
  snap('detach_sweep')
  await wait(60)
  sweep()
  await frames(1)
  snap('detach_sweep2')
  /** 让脱离状态持续到 ~250ms：`revealToolbar` 里那两个复查（下一帧 + 50ms）也都在这一段里跑过 */
  await wait(190)
  parent.insertBefore(container, next)
  await frames(2)
  snap('relayout')

  await wait(300)
  snap('t400')

  /** 同实例重画：`refresh()` 就是 `paint()`（工具条元素会被**重建**） */
  pane.refresh()
  await frames(2)
  snap('refresh')

  /**
   * **滚动/尺寸事件**：`revealToolbar` 每次显示都会往 `window` 上挂一条跟随监听
   * （`followToolbar`）。`paint()` 每次重画都会新建一代闭包 ⇒ 老一代的监听**还挂在 window 上**，
   * 若不加"只有最新一代能改显隐/落位"的守卫，它们会各自去摆自己那条**已被丢弃**的工具条
   * ⇒ 文档里出现**两条**（用户实测过的"残留两条工具条"）。这一步把那个缺陷变成可判定的量。
   */
  window.dispatchEvent(new Event('scroll'))
  window.dispatchEvent(new Event('resize'))
  await frames(2)
  snap('scroll')

  /** 宿主重建面板：照 `JpsEmbedHost.mount()` 的顺序（destroy → empty → 同一容器上重挂） */
  pane.destroy()
  container.textContent = ''
  pane = mountPane()
  await frames(2)
  snap('remount')

  /** 移动 / 移出：不许开、也不许关（用户口径：不引入悬停显隐） */
  gesture(target(), 'hover')
  await frames(1)
  snap('hover_move')

  gesture(target())
  await frames(2)
  snap('click2')
  logClick()

  gesture(target())
  await frames(2)
  snap('click3')
  logClick()
  gesture(outside())
  await frames(2)
  snap('outside')
  logClick()

  /** 收尾：把本场景的面板销毁掉，别影响下一个场景（也顺便量一次"销毁后有没有残留"） */
  pane.destroy()
  await frames(1)
  steps.afterDestroy = stateOf()
  /**
   * 销毁之后**还留在文档里**的工具条（应当为空）：把每条的 `data-ijipu-pane` 与父节点打出来，
   * 一旦不为空就能直接看出"是谁留下的、留在哪儿"（不用再猜）。
   */
  const leftovers = Array.from(document.querySelectorAll<HTMLElement>('.ijipu-score-toolbar')).map((b) => ({
    pane: b.dataset.ijipuPane ?? '?',
    parent: b.parentElement === document.body ? 'body' : (b.parentElement?.className ?? '?').split(/\s+/)[0],
    id: container.id,
  }))

  return {
    steps,
    leftovers,
    diag: {
      lastClick: (latestPlugin.lastToolbarClick as string | null) ?? null,
      lastInfo: (latestPlugin.lastToolbarInfo as string | null) ?? null,
      log: clickLog,
    },
    selfCheck,
  }
}
