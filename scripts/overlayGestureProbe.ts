/**
 * scripts/overlayGestureProbe.ts — OVL 水印/背景手势的**真浏览器**夹具（`adj965d` / EP-13）
 *
 * ## 为什么非得起浏览器
 *
 * 手势这一套是"事件 → 判定 → 改草稿 → 重画 → 停顿落盘"五段接力，**源码级正则只能证明某行还在**，
 * 证不了"滚一下之后谱面源码真的变了"。`toolbarDomProbe.ts` 是同款先例（那条是给工具条用的）。
 *
 * ## 夹具怎么搭
 *
 * · `scripts/toolbarDomShim.ts` = 浏览器内的 `obsidian` 替身；`src/scorePane.ts` **一个字不改**
 *   （只把相对导入挪到 `../src/`，与 `adj952` 的样板同）；
 * · 宿主里 `getSource`/`writeSource` 由本文件提供：**`writeSource` 真的把源码换掉并 `refresh()`**
 *   —— 与真实宿主一样，这样"落盘之后那一层还在不在""提醒消没消"也都是真量到的；
 * · 图：配置里给一个**解析不了**的 `bgImage`（假 app 的 vault 里没有那份文件）⇒
 *   取图那条路会走到"未找到"分支（弹一句 `Notice`、层仍按配置算"可调"），
 *   于是"两层都可调 ⇒ 出现切换器"这条也能验，而**不需要真图片文件**。
 *
 * ## 量到的东西（冒烟按字段断言，不做字符串匹配）
 *
 * `setup`（svg / 虚线 / 提示条 / 切换器 / 红字提醒）→ `zoom`（Alt+滚轮）→ `rotate`（Alt+Shift+滚轮）
 * → `pan`（**在辅助虚线上** Alt+拖动）→ `off`（排版关掉之后按 Alt：一个字都不该写）。
 * 每一步都把"宿主收到的源码里的 `# jps-config`"读回来，并记下**写了几个键**。
 *
 * ## 两条夹具纪律（都是第一版翻车换来的，别改回去）
 *
 * 1. **每次派发前重新取活元素**：写回源码 ⇒ 宿主 `refresh()` ⇒ 面板重画 ⇒ 旧 `svg` 已**脱离文档**，
 *    在它上面派发的 `wheel` **不会冒泡**到容器上的监听（症状："旋转那一步什么都没写"）。
 * 2. **要看"重画之后"的 DOM 就显式 `pane.refresh()`**：无头 + `--virtual-time-budget` 下
 *    `requestAnimationFrame` 不一定被投递（所以 `frames()` 里那个 `setTimeout` 兜底才存在）——
 *    否则读到的是上一代 DOM（症状："点了切换器，chip 还停在原处"，但其实状态已经切了）。
 */

type PaneHandle = { destroy: () => void; refresh: () => void }
type MountFn = (host: Record<string, unknown>) => PaneHandle

/** 一帧（rAF + 超时兜底：虚拟时钟下也不至于卡住） */
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

/** 源码里的 `# jps-config` 解析成对象（读不到就是 `{}`） */
function configOf(src: string): Record<string, unknown> {
  const m = /# jps-config:(.*)/.exec(src)
  if (m === null) return {}
  try {
    return JSON.parse(m[1] ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 一次滚轮（`altKey`/`shiftKey` 由参数给；`deltaY` 负数 = 向上滚 = 放大/角度变大） */
function wheelOn(el: Element, deltaY: number, mods: { alt?: boolean; shift?: boolean } = {}): void {
  el.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode: 0,
      altKey: mods.alt === true,
      shiftKey: mods.shift === true,
    }),
  )
}

/** 一次 `Alt+左键拖动`（真事件顺序：pointerdown → pointermove×2 → pointerup） */
function dragOn(el: Element, dx: number, dy: number): void {
  const base = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', altKey: true }
  const r = el.getBoundingClientRect()
  const x0 = Math.round(r.left + r.width / 2)
  const y0 = Math.round(r.top + r.height / 2)
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, clientX: x0, clientY: y0 }))
  for (const f of [0.5, 1]) {
    window.dispatchEvent(
      new PointerEvent('pointermove', { ...base, buttons: 1, clientX: Math.round(x0 + dx * f), clientY: Math.round(y0 + dy * f) }),
    )
  }
  window.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, clientX: x0 + dx, clientY: y0 + dy }))
}

export async function runOverlayGestureProbe(mount: MountFn, baseSource: string): Promise<void> {
  const out = document.getElementById('out') as HTMLElement | null
  const result: Record<string, unknown> = { done: false, step: 'init' }
  /** 每步都写一次：虚拟时钟提前 dump 时也能看出跑到哪一步 */
  const flush = (): void => {
    if (out) out.textContent = JSON.stringify(result)
  }
  flush()
  try {
    // ── 宿主：源码可写回（`writeSource` 真换源码并重画，与真实宿主同） ──
    let sourceNow = baseSource
    const writes: string[] = []
    const pluginStub: Record<string, unknown> = {
      /**
       * 插件设置 = "新谱默认值"那一层：把水印 **只放在这里**（源码里不写）
       * ⇒ 正是"这一层还没写进谱面"的状态（与应用里"只在设置面板草稿里"等价）。
       * 背景给一个解析不了的路径：用来验"两层都可调 ⇒ 出现切换器"，不需要真图。
       */
      settings: { wmEnabled: true, wmText: '草稿', bgEnabled: true, bgImage: '图.png' },
      events: { on: () => ({}), offref: () => undefined },
      register: () => undefined,
      app: {
        vault: {
          configDir: '.obsidian',
          /**
           * adj965g：**这里刻意让图读不到**（`exists → false`）。
           *
           * 夹具测不了图片链（无头 + 虚拟时钟下 `img.decode()` 不落地，见 `doMount` 上面那段），
           * 与其让它"看起来在测"而恒真，不如明确：图片资源的缓存语义由**源码层闸门**守
           * （冒烟 `adj965g` 节：`destroy()` 里不许清缓存 + 负对照）。图读不到时弹的
           * `Notice`（"未找到图片"）不在断言范围内，不影响别的判据。
           */
          adapter: { exists: async () => false, readBinary: async () => new ArrayBuffer(0) },
        },
        metadataCache: { getFirstLinkpathDest: () => null },
        workspace: {},
      },
      lastToolbarInfo: null,
      lastToolbarClick: null,
      lastCropInfo: null,
      lastSvgParse: null,
      lastInk: null,
      showGuides: true,
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
    }
    const hostEl = document.getElementById('host') as HTMLElement
    hostEl.textContent = ''
    const root = document.createElement('div')
    root.className = 'markdown-source-view cm-s-obsidian mod-cm6 is-live-preview'
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const scroller = document.createElement('div')
    scroller.className = 'cm-scroller'
    scroller.style.overflow = 'auto'
    const content = document.createElement('div')
    content.className = 'cm-content'
    const line = document.createElement('div')
    line.className = 'cm-line'
    const block = document.createElement('div')
    block.className = 'cm-embed-block'
    const container = document.createElement('div')
    container.id = 'emb-overlay'
    container.className = 'internal-embed ijipu-embed is-loaded'
    container.style.minHeight = '320px'
    block.appendChild(container)
    line.appendChild(block)
    content.appendChild(line)
    scroller.appendChild(content)
    editor.appendChild(scroller)
    root.appendChild(editor)
    hostEl.appendChild(root)

    let pane: PaneHandle | null = null
    /**
     * ⚠ **宿主按真机语义重建面板**：`writeSource` 改的是笔记里的代码块正文 ⇒ Obsidian 会
     * **重渲染那个代码块** ⇒ 面板被 `destroy()` 后**重新挂载**（`toolbarDomProbe` 的时间线里
     * 也有"宿主重建面板"这一步，说明这是真机会发生的事）。
     *
     * 第一版这里只调了 `pane.refresh()`（同实例重画）⇒ 把用户实报的那个 bug 放过去了：
     * **面板内**保存的"调整对象"会在重建时回到默认（背景）⇒ 用户"切到水印再 Alt+拖动"
     * 动到的却是背景。夹具必须复刻"重建"这一步，否则这条链根本测不到。
     */
    const imageAtMount: boolean[] = []
    const doMount = (): PaneHandle => {
      const h = mount({
        plugin: pluginStub,
        container,
        getSource: () => sourceNow,
        writeSource: (next: string) => {
          writes.push(next)
          sourceNow = next
          pane?.destroy()
          pane = doMount()
        },
        embedded: true,
        embedTitle: '半山听雨',
        filePath: '半山听雨.jps',
        containerPath: '乐谱/半山听雨.md',
        onOpenFile: () => undefined,
        onEdit: () => undefined,
      })
      imageAtMount.push(container.querySelectorAll('image').length > 0)
      return h
    }
    pane = doMount()
    await frames(3)
    /**
     * ⚠ **本夹具不测"图片资源"那条链**（`adj965g` 的缓存判据改在 `src` 层做，见冒烟的 `adj965g` 节）。
     *
     * 原因：无头 Chrome + `--virtual-time-budget` 下 `createEl('img').decode()` **不落地**
     * （轮询 3 秒仍 `ready=false`，实测），图永远解析不出来 ⇒ 任何"第一帧有没有 `<image>`"的判据
     * 都会**恒真/恒假**，是假闸门。真机（Obsidian）里这条链是好的（用户截图可见背景图与重复水印）。
     * 这里只保留 `imageAtMount` 的**记录**，供失败时看上下文，不参与断言。
     */
    result.assetsNotExercised = { note: '图片链在本夹具里解析不出来（无头+虚拟时钟），改由 src 层闸门守', mounts: imageAtMount.length }
    flush()

    const q = <T extends Element>(sel: string): T | null => container.querySelector<T>(sel)
    /**
     * ⚠ **每次派发前重新取活元素**：写回源码后宿主会 `refresh()` → 面板重画 → 之前抓到的
     * `svg` 已经**脱离文档**，在它上面派发的 `wheel` **不会冒泡**到容器上的监听
     * （第一版就是这么翻车的：旋转那一步"什么都没写"）。容器本身跨重画不变 ⇒ 兜底用它。
     */
    const liveTarget = (): Element => q('.ijipu-svgs svg') ?? container
    const hintState = (): Record<string, unknown> => ({
      hint: q('.ijipu-overlay-hint') !== null,
      chips: container.querySelectorAll('.ijipu-overlay-chip').length,
      active: q('.ijipu-overlay-chip.is-active')?.textContent ?? '',
      chipTexts: Array.from(container.querySelectorAll('.ijipu-overlay-chip')).map((el) => el.textContent ?? ''),
      unsaved: q('.ijipu-overlay-unsaved') !== null,
    })
    result.setup = {
      svg: container.querySelectorAll('svg').length,
      guideLines: container.querySelectorAll('.ijipu-guide-line').length,
      ...hintState(),
      writes: writes.length,
    }
    /** adj965g：这里只留个记录（见上面那段"本夹具不测图片链"的说明），不参与断言 */

    // ① 切到「水印」那一层（切换器点一下）——同时验"切换器真的在切"
    const chipWm = Array.from(container.querySelectorAll<HTMLElement>('.ijipu-overlay-chip')).find(
      (el) => el.textContent === '水印',
    )
    result.chipFound = chipWm !== undefined
    chipWm?.click()
    /**
     * ⚠ **无头 + 虚拟时钟下 `requestAnimationFrame` 不一定被投递**（`toolbarDomProbe` 的 `frames()`
     * 里那个 `setTimeout` 兜底就是为这个加的）⇒ 想看"重画之后"的 DOM 就**显式 `refresh()`**
     * （它直接调 `paint()`）。否则会读到上一代的 DOM：第一版就是这么误判的
     * ——状态其实已经切到水印了（看后面的手势写回就知道），但 chip 还停在"背景"。
     */
    await wait(50)
    pane.refresh()
    await frames(1)
    result.switchToWm = hintState()
    flush()

    // ② `Alt+滚轮` ⇒ 缩放该层（文本水印缩的是字号；累计 120px ⇒ 正好一档）
    wheelOn(liveTarget(), -120, { alt: true })
    await wait(700) // 停顿落盘（引擎里 400ms）
    /**
     * 落盘会让宿主**重建面板**（见 `doMount` 上那条 ⚠）⇒ 这里同时量"选中的那一层还在不在"。
     * 这一条就是用户实报的 bug：重建后回到默认（背景），于是下一次 `Alt+拖动` 动到了背景。
     */
    result.zoom = { writes: writes.length, cfg: configOf(sourceNow), ...hintState() }
    flush()

    // ③ `Alt+Shift+滚轮` ⇒ 旋转（⚠ 重新取活元素：上一步写回已经让面板重画过）
    wheelOn(liveTarget(), -120, { alt: true, shift: true })
    await wait(700)
    result.rotate = { writes: writes.length, cfg: configOf(sourceNow) }
    flush()

    // ④ `Alt+拖动` **落在辅助虚线上** ⇒ 必须是"平移层"，不能被虚线拖拽抢走
    const guideLine = q<HTMLElement>('.ijipu-guide-line')
    if (guideLine) dragOn(guideLine, 40, 26)
    await wait(300)
    result.pan = { writes: writes.length, cfg: configOf(sourceNow), onGuideLine: guideLine !== null }
    flush()

    // ⑤ 负向：关掉「排版」之后按 Alt ⇒ 一个字都不该写
    pluginStub.showGuides = false
    const before = writes.length
    wheelOn(liveTarget(), -120, { alt: true })
    await wait(700)
    result.off = { wrote: writes.length - before }
    flush()

    pane.destroy()
    result.assetsFinal = { mounts: imageAtMount.length, firstPaint: [...imageAtMount] }
    result.step = 'done'
    result.done = true
    flush()
  } catch (e) {
    result.error = e instanceof Error ? e.message + '｜' + (e.stack ?? '') : String(e)
    flush()
  }
}
