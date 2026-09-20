/**
 * icons.ts — 工具条图标（**与应用顶栏同一批 PNG**，adj458）
 *
 * ## 为什么从"手绘内联 SVG"改成"应用的那批 PNG"
 * 此前本文件手绘了一套 SVG 来"对齐应用顶栏的形状"，但两端各画一份必然漂移——
 * 本文件历史上就为了对齐应用把「页面设置」从滑杆改成齿轮、把线宽从 1.4 提到 1.8。
 * adj458 起改为直接使用应用的同一批 PNG（`vendor/icons/`，从 `ijipu/public/icons/` 逐字节同步），
 * **形状天然一致**，不再需要"照着应用画一遍"。
 *
 * ## 上色：CSS mask + `background-color: currentColor`（与应用 `ToolIcon` 同一手法）
 * 只取 PNG 的 **alpha 通道**当形状、颜色完全交给 CSS，一次解决两件事：
 *  ① **统一颜色**：这批 PNG 的原始色并不完全一致（有的近纯黑、有的偏灰），直接用 `<img>`
 *     会把这种杂乱照搬进界面；走 mask 后所有图标只剩**一个颜色**（即当前文字色）。
 *  ② **自动适应明暗主题**：颜色 = 所在按钮的 `color`，于是亮/暗主题、悬停、
 *     以及 `.is-active` 选中态（`color` 换成 `--text-on-accent`）**全部自动同色**——
 *     不需要为深色主题另备一套图，也不会出现"黑线稿铺在深色底上隐形"。
 *
 * 图标是构建期内联的 data URI（原因见 `src/assets.d.ts`），此处不解析任何资源路径。
 * 形状由样式类 `.ijipu-tool-icon` 负责（见 `styles.css`）。
 */
import layoutPng from '../vendor/icons/排版.png'
import playPng from '../vendor/icons/播放.png'
import scorePng from '../vendor/icons/谱面.png'
import settingsPng from '../vendor/icons/设置.png'
import stopPng from '../vendor/icons/停止.png'
import fullWidthPng from '../vendor/icons/页宽.png'
import pagePng from '../vendor/icons/整页.png'

/** 显示模式（与 scorePane 的 ViewMode 同域；此处单独声明避免与调用方循环依赖） */
type Mode = 'page' | 'full' | 'score'

/**
 * 建一个「PNG + CSS mask」图标元素：形状取 PNG 的 alpha，颜色 = 当前 `color`。
 * @param dataUri 构建期内联的 PNG data URI
 * @param size 像素边长（默认 15——与改动前的 SVG 图标同尺寸，工具条高度不变）
 */
function pngIcon(dataUri: string, size = 15): HTMLElement {
  const el = document.createElement('span')
  el.className = 'ijipu-tool-icon'
  el.setAttribute('aria-hidden', 'true')
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  el.style.setProperty('--ijipu-icon', `url("${dataUri}")`)
  return el
}

/**
 * 「试听」图标：播放三角。
 *
 * 图标态下按钮文字可以被隐藏（见 styles.css 的 @container 规则），所以图标必须自解释——
 * 播放/停止用最通用的两个形状。
 */
export function playIcon(size = 15): HTMLElement {
  return pngIcon(playPng, size)
}

/** 「停止」图标：方块（试听中再点即停止）——与「试听」同一套图案，切换时不跳风格 */
export function stopIcon(size = 15): HTMLElement {
  return pngIcon(stopPng, size)
}

/** 「排版」图标：行距（与应用顶栏「排版」按钮同一形状） */
export function layoutIcon(size = 15): HTMLElement {
  return pngIcon(layoutPng, size)
}

/** 「页面设置」图标：齿轮（与应用顶栏「设置」按钮同一形状） */
export function settingsIcon(size = 15): HTMLElement {
  return pngIcon(settingsPng, size)
}

/**
 * 显示模式图标（三种，图案与应用/插件菜单项一一对应）：
 *  - 整页：完整一页（含页边距）
 *  - 满宽：横向撑满笔记宽度
 *  - 谱面：裁掉页边距、只保留内容区
 */
const MODE_PNG: Record<Mode, string> = { page: pagePng, full: fullWidthPng, score: scorePng }

/** 取某种显示模式的图标（按模式查表，避免调用方再写分支） */
export function modeIcon(mode: Mode, size = 15): HTMLElement {
  return pngIcon(MODE_PNG[mode], size)
}

/**
 * 「打开谱面文件」图标：链条（链接的通用意象）——**唯一保留的手绘 SVG**：
 * 应用那批图标里没有"链接"这一枚，且它只出现在嵌入模式的右端，不必强行凑图。
 *
 * 两节 45° 斜置的圆角环，各自开口朝向中心，中间一段连接杆把它们串起来。
 * 线宽沿用基准值，颜色随 `color`（与 PNG 图标同为 `currentColor`，视觉一致）。
 */
const NS = 'http://www.w3.org/2000/svg'
/** 图标基础线宽（深色主题下过细的笔画会糊成一团，故基准取 1.8） */
const SW = '1.8'

export function linkIcon(size = 15): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 14 14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', SW)
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const add = (d: string): void => {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  // 右上那一节：开口朝左下
  add('M 6.1 4.5 L 8.1 2.5 A 2.5 2.5 0 0 1 11.5 5.9 L 9.5 7.9')
  // 左下那一节：开口朝右上（与上一节关于图标中心点对称）
  add('M 7.9 9.5 L 5.9 11.5 A 2.5 2.5 0 0 1 2.5 8.1 L 4.5 6.1')
  // 中间的连接杆
  add('M 5.9 8.1 L 8.1 5.9')
  return svg
}

/**
 * 「应用打开」图标：**一个盒子 + 右上角外跳箭头**（"交给外部应用"）。
 *
 * 为什么不走 `vendor/icons/` 那批 PNG（adj458 的口径）：那批是**应用顶栏**的图标集，
 * 里面**没有**"外部打开"这个语义的图（应用自己不需要它）；这里按 `linkIcon` 的同一手法手绘，
 * 走 `currentColor` ⇒ 亮/暗主题、悬停、选中态自动同色（避免 E-2026-234 那类"图标与文字不同色"）。
 */
export function appOpenIcon(size = 15): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 14 14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', SW)
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const add = (d: string): void => {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  // 盒子：左侧 + 上下边（右边留缺口给外跳箭头）
  add('M 8 3.2 H 3.6 A 1.4 1.4 0 0 0 2.2 4.6 V 10.4 A 1.4 1.4 0 0 0 3.6 11.8 H 9.4 A 1.4 1.4 0 0 0 10.8 10.4 V 6')
  // 外跳箭头：斜杆 + 箭头头部
  add('M 8.2 2.2 H 11.8 V 5.8')
  add('M 11.8 2.2 L 7.4 6.6')
  return svg
}
