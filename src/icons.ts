/**
 * icons.ts — 界面图标（内联 SVG，零依赖；与 iJipu 应用顶栏用同一形状）
 *
 * 用 SVG 而非 emoji：emoji 在不同系统/字体下形状与基线都不同（齿轮 ⚙ 尤其容易跑偏），
 * 而 iJipu 应用的「排版」按钮本身就是**田字格**图标（方框 + 一竖一横），插件沿用同一形状
 * 才能一眼对应上。
 */
const NS = 'http://www.w3.org/2000/svg'

/**
 * 田字格图标（与 iJipu 应用顶栏「排版」按钮完全一致：14×14、stroke 1.4、方框 + 竖线 + 横线）。
 * @param size 像素尺寸（默认 14，与顶栏一致）
 */
export function layoutIcon(size = 14): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 14 14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('aria-hidden', 'true')
  const rect = document.createElementNS(NS, 'rect')
  rect.setAttribute('x', '2.2')
  rect.setAttribute('y', '2.2')
  rect.setAttribute('width', '9.6')
  rect.setAttribute('height', '9.6')
  const vertical = document.createElementNS(NS, 'path')
  vertical.setAttribute('d', 'M 7 3.6 V 10.4')
  const horizontal = document.createElementNS(NS, 'path')
  horizontal.setAttribute('d', 'M 3.6 7 H 10.4')
  svg.append(rect, vertical, horizontal)
  return svg
}
