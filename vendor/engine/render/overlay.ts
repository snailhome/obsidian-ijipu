/**
 * render/overlay.ts — 水印层与背景层（adj965；完整方案见 `docs/OVERLAY-PLAN.md`「OVL」）
 *
 * ## 层序（用户要求：从上到下 = 曲谱层 → 水印层 → 背景层）
 *
 * `renderPage` 里的拼装顺序就是这个层级：白底 rect → **背景层** → **水印层** → 曲谱 body
 * （后画的盖在上面 ⇒ 背景在最底、曲谱在最上 ✓）。
 *
 * ## 四条口径（全部是用户裁定，见方案 §二）
 *
 * 1. **"显示比率"的 100% = 页面宽度**：图形宽度 = `页宽 × scale/100`，高度按**原图长宽比**推算
 *    ⇒ 所以必须由**宿主**量好 `naturalWidth/Height` 一并传进来（引擎零 DOM，见下）。
 * 2. **位置 = 元素中心相对页面中心的偏移**：`(0,0)` ⇒ 居中，负值向左/上。
 * 3. **旋转绕自身中心**（矩形中心）⇒ `rotate(deg cx cy)` 的 `cx/cy` 就是元素中心。
 * 4. **只显示页面内**：两层都用本页页面矩形做 `clipPath`（不依赖 viewBox 的隐式裁剪——
 *    插件会改 viewBox、导出范围也会改）；**每页都画**，位置相对**该页**页面框。
 *
 * ## 为什么引擎不自己读图（本模块只收"已解析好的字符串"）
 *
 * 引擎有机器闸门 `adj770`：禁 `document` / `createElement` / `Image` ⇒ **量不到图片宽高、也读不到字节**。
 * 所以宿主（应用/插件/CLI）负责"路径 → data URI + 宽高"，引擎只负责画。
 * 这与既有先例同款：`renderScoreToSvg(layout, opts?: RenderFontMeta)` 的字体度量也是宿主实测、引擎消费。
 *
 * ⚠ `href` **必须是 data URI**：PNG/JPG/PDF 三条导出都是把 SVG 交给 `new Image()` 栅格化
 * （`src/export/export.ts` 的 `svgToCanvas`），而**以图片方式加载的 SVG 不允许引用外部资源**。
 *
 * 本模块**零依赖、零 DOM**（只用 `svgUtil` 的共用格式化工具）。
 */
import type { PageConfig, ScorePage } from '../types'
import { r1n, r2n, xmlEsc } from './svgUtil'

/** 宿主解析好的图片资源（`href` 一律 data URI；`w/h` = 原图像素尺寸，用来推长宽比） */
export interface OverlayAsset {
  href: string
  w: number
  h: number
}

/** 两层的运行时资源（缺省 ⇒ 不画任何层，输出与改动前逐字节相同） */
export interface RenderAssets {
  bg?: OverlayAsset
  wm?: OverlayAsset
}

/**
 * 取一个"有限数并钳到区间"的值；非有限数（手改坏成 `NaN`/字符串）回退该字段的默认值。
 * 钳制放在渲染端而不是校验端：`.jps` 是纯文本，用户/别的工具可能手改出越界值，
 * 而"越界值不该产生离谱画面"这一条必须在最后一道关口保证。
 */
function numOr(v: number, lo: number, hi: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return Math.min(hi, Math.max(lo, v))
}

/** 本页的裁剪路径（**id 按页唯一**：每页是独立 SVG 字符串，同 id 在同一页内不能重复） */
function clipDef(page: ScorePage): string {
  return `<clipPath id="ovl-clip-${page.index}"><rect x="0" y="0" width="${r1n(page.width)}" height="${r1n(page.height)}"/></clipPath>`
}

/**
 * 不透明度：100（默认）时不写 `opacity` 属性，少一段字节、也更容易看出来"没设"。
 *
 * ⚠ **必须用 2 位小数**（`r2n`）：透明度是 0~100 的整数百分比、要换算成 SVG 的 0~1。
 * 第一版用了坐标那套 1 位小数（`r1n`）⇒ 默认的 25% 被写成 `opacity="0.3"`（**25% 变 30%**，
 * 相对误差 20%）——实测一条 `-s wmText=…` 的产物才看出来。2 位小数对**所有整数百分比**都是精确的。
 */
const opacityAttr = (opacity: number): string => (opacity >= 100 ? '' : ` opacity="${r2n(opacity / 100)}"`)

/** 旋转：0° 时不写 `transform`（同理，默认值不该在产物里留下痕迹） */
const rotateAttr = (deg: number, cx: number, cy: number): string =>
  deg === 0 ? '' : ` transform="rotate(${r1n(deg)} ${r1n(cx)} ${r1n(cy)})"`

/**
 * 图形层（背景图 / 图形水印共用）。
 *
 * @param kind `'bg'` 或 `'wm'` —— 既决定取哪组配置，也决定 `data-overlay` 标记（宿主据此排除它们）
 */
function imageLayer(kind: 'bg' | 'wm', config: PageConfig, page: ScorePage, asset: OverlayAsset): string {
  const isBg = kind === 'bg'
  const scale = numOr(isBg ? config.bgScale : config.wmScale, 10, 1000, 100)
  const rotate = numOr(isBg ? config.bgRotate : config.wmRotate, -180, 180, isBg ? 0 : 45)
  const opacity = numOr(isBg ? config.bgOpacity : config.wmOpacity, 0, 100, isBg ? 100 : 25)
  const offX = numOr(isBg ? config.bgOffsetX : config.wmOffsetX, -1e6, 1e6, 0)
  const offY = numOr(isBg ? config.bgOffsetY : config.wmOffsetY, -1e6, 1e6, 0)

  const w = (page.width * scale) / 100
  // 长宽比来自**宿主实测的原图尺寸**；拿不到（w/h 非正）就按正方形兜底，不抛错
  const ratio = asset.w > 0 && asset.h > 0 ? asset.h / asset.w : 1
  const h = w * ratio
  const cx = page.width / 2 + offX
  const cy = page.height / 2 + offY

  /** 画一张（中心在 `(x, y)`）——`preserveAspectRatio="none"`：w/h 已按原图比例算好，不再加 letterbox 语义 */
  const oneAt = (x: number, y: number): string =>
    `<image href="${asset.href}" x="${r1n(x - w / 2)}" y="${r1n(y - h / 2)}" width="${r1n(w)}" height="${r1n(h)}" preserveAspectRatio="none"${rotateAttr(rotate, x, y)}/>`

  // adj965b（用户 2026-10-15）：**重复水印**（图形水印同样适用；背景图不重复——它不是水印）
  const body =
    kind === 'wm' && config.wmRepeat === true
      ? tileMarkup(page, w, h, config.wmRepeatGap, oneAt)
      : oneAt(cx, cy)

  return `<g data-overlay="${kind}" clip-path="url(#ovl-clip-${page.index})"${opacityAttr(opacity)}>${body}</g>`
}

/**
 * 文本水印。
 *
 *  · 字号走**独立字段** `wmSize`（用户裁定）——不共用图形的 `wmScale`（那个是"占页宽百分比"）；
 *  · 多行（`\n`）用多个 `<tspan>` 画成**整块垂直居中**；否则换行会被静默吞掉（本项目最忌"静默忽略"）；
 *  · 颜色固定黑（`#000000`）+ 透明度：经典水印观感，也是打印/导出最稳的一种。
 *    ⚠ 深色主题预览下会偏淡（页面白底在深色下被透明化）——颜色设置属方案里的"待定"项，先不做。
 */
function textLayer(config: PageConfig, page: ScorePage): string {
  const text = String(config.wmText ?? '')
  if (text.trim() === '') return ''
  const size = numOr(config.wmSize, 6, 400, 36)
  const rotate = numOr(config.wmRotate, -180, 180, -45)
  const opacity = numOr(config.wmOpacity, 0, 100, 25)
  const cx = page.width / 2 + numOr(config.wmOffsetX, -1e6, 1e6, 0)
  const cy = page.height / 2 + numOr(config.wmOffsetY, -1e6, 1e6, 0)

  const lines = text.split('\n')
  const lineH = size * 1.2
  const textWidth = estimateTextWidth(lines, size)
  const textHeight = lineH * lines.length

  /** 把整块画在 `(x, y)` 为中心的锚点上（`dominant-baseline="central"` ⇒ y 是行视觉中心） */
  const blockAt = (x: number, y: number): string => {
    const y0 = y - ((lines.length - 1) * lineH) / 2
    const spans = lines
      .map((ln, i) => `<tspan x="${r1n(x)}" y="${r1n(y0 + i * lineH)}">${xmlEsc(ln)}</tspan>`)
      .join('')
    return `<text text-anchor="middle" dominant-baseline="central" font-size="${r1n(size)}" fill="#000000"${rotateAttr(rotate, x, y)}>${spans}</text>`
  }

  const body =
    config.wmRepeat === true
      ? tileMarkup(page, textWidth, textHeight, config.wmRepeatGap, (x, y) => blockAt(x, y))
      : blockAt(cx, cy)
  return `<g data-overlay="wm" clip-path="url(#ovl-clip-${page.index})"${opacityAttr(opacity)}>${body}</g>`
}

/**
 * 估算文本宽度（pt）——**只用于"重复水印"的平铺步进**，不参与任何排版。
 *
 * 引擎零 DOM ⇒ 量不到真实字形宽度；这里按"全角 ≈ 1em、半角 ≈ 0.55em"累加：
 * CJK/全角标点算 1.0，其余（ASCII/数字/半角符）算 0.55。误差只影响铺得疏密，不影响正确性
 * （同族做法见描述头文本宽度的估算）。
 */
function estimateTextWidth(lines: string[], size: number): number {
  let maxUnits = 0
  for (const ln of lines) {
    let units = 0
    for (const ch of ln) {
      // 常见全角区：CJK 统一表意文字、全角标点、假名等
      units += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1 : 0.55
    }
    maxUnits = Math.max(maxUnits, units)
  }
  return Math.max(size, maxUnits * size)
}

/**
 * 平铺（用户 2026-10-15 要求：**重复水印**，"以一定行列间隔重复铺满页面"）。
 *
 * 规则与理由：
 *  · **步进** = `元素尺寸 × (1 + 间隔/100)` ⇒ `wmRepeatGap=100`（默认）时步进 = 2 倍自身尺寸；
 *  · **奇数行右移半个步进**（错位排布）：水印是**斜的**（默认 -45°），正交网格会让斜向留下明显的空带，
 *    错位后视觉上才是"铺满"；
 *  · 网格**向外多铺一圈**（`from -step` 到 `page + step`）：斜置的角会伸出页面外，
 *    不多铺就会在四边看到"秃边"；超出的部分由本层的 `clipPath` 裁掉 ⇒ 正好符合"只在页面内显示"。
 */
function tileMarkup(
  page: ScorePage,
  w: number,
  h: number,
  gapPct: number,
  at: (x: number, y: number) => string,
): string {
  const gap = numOr(gapPct, 0, 1000, 100) / 100
  const stepX = Math.max(8, w * (1 + gap))
  const stepY = Math.max(8, h * (1 + gap))
  const cols = Math.ceil(page.width / stepX) + 2
  const rows = Math.ceil(page.height / stepY) + 2
  const out: string[] = []
  for (let r = 0; r < rows; r += 1) {
    const y = r * stepY + stepY / 2 - stepY
    const dx = r % 2 === 1 ? stepX / 2 : 0
    for (let c = 0; c < cols; c += 1) {
      const x = c * stepX + stepX / 2 - stepX + dx
      out.push(at(x, y))
    }
  }
  return out.join('')
}

/**
 * 产出本页的两层（以及它们共用的 `<defs>`）。
 *
 * ⚠ **三个都为空串**时，`renderPage` 不会插入任何字节 ⇒ 不用这功能的谱，SVG 与改动前**逐字节相同**
 * （这条是回归断言，见方案 EP-04/EP-05）。
 */
export function overlayLayers(
  config: PageConfig,
  page: ScorePage,
  assets?: RenderAssets,
): { defs: string; bg: string; wm: string } {
  // adj965c（用户 2026-10-15）：两个总开关 —— 关掉就整层不画（**配置保留**，回头勾上即恢复）
  const bg =
    config.bgEnabled !== false && config.bgImage !== '' && assets?.bg !== undefined && assets.bg.href !== ''
      ? imageLayer('bg', config, page, assets.bg)
      : ''
  let wm = ''
  if (config.wmEnabled !== false) {
    if (config.wmType === 'image') {
      // 图形水印：路径没解析出资源（文件不在/读不到）⇒ 不画；**提示由应用层负责**（方案优化 7：不静默降级）
      wm = config.wmImage !== '' && assets?.wm !== undefined && assets.wm.href !== '' ? imageLayer('wm', config, page, assets.wm) : ''
    } else {
      wm = textLayer(config, page)
    }
  }
  const defs = bg !== '' || wm !== '' ? clipDef(page) : ''
  return { defs, bg, wm }
}
