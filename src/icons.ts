/**
 * icons.ts — 界面图标（内联 SVG，零依赖；与 iJipu 应用顶栏用同一形状）
 *
 * 用 SVG 而非 emoji：emoji 在不同系统/字体下形状与基线都不同（齿轮 ⚙ 尤其容易跑偏），
 * 而 iJipu 应用的「排版」按钮本身就是**田字格**图标（方框 + 一竖一横），插件沿用同一形状
 * 才能一眼对应上。
 */
const NS = 'http://www.w3.org/2000/svg'

/** 建一个 14×14 描边图标（与 iJipu 应用顶栏图标同规格：strokeWidth 1.4、currentColor） */
function strokeIcon(build: (add: (tag: 'rect' | 'path', attrs: Record<string, string>) => void) => void): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 14 14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('aria-hidden', 'true')
  build((tag, attrs) => {
    const el = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.appendChild(el)
  })
  return svg
}

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

/**
 * 显示模式图标（三种，形状直接表意）：
 *  - 整页：整张纸 + 内部虚线框 = 含页边距的完整一页
 *  - 满宽：左右带箭头的整宽条 = 撑满容器宽（不留页面留白）
 *  - 谱面：四角裁切标记 = 裁掉页边距、只保留内容区
 */
export function modeIcon(mode: 'page' | 'full' | 'score'): SVGSVGElement {
  if (mode === 'page') {
    return strokeIcon((add) => {
      add('rect', { x: '2.4', y: '1.4', width: '9.2', height: '11.2' })
      add('rect', { x: '4.2', y: '3.2', width: '5.6', height: '7.6', 'stroke-dasharray': '1.4 1.4', 'stroke-width': '1' })
    })
  }
  if (mode === 'full') {
    return strokeIcon((add) => {
      add('rect', { x: '1.2', y: '3', width: '11.6', height: '8', 'stroke-width': '1.2', 'stroke-dasharray': '1.4 1.4' })
      add('path', { d: 'M 3.2 7 H 10.8' })
      add('path', { d: 'M 4.6 5.6 L 3.1 7 L 4.6 8.4' })
      add('path', { d: 'M 9.4 5.6 L 10.9 7 L 9.4 8.4' })
    })
  }
  // score：裁切标记（左上/右上/左下/右下四个角）
  return strokeIcon((add) => {
    add('path', { d: 'M 2.2 5.2 V 2.2 H 5.2' })
    add('path', { d: 'M 8.8 2.2 H 11.8 V 5.2' })
    add('path', { d: 'M 11.8 8.8 V 11.8 H 8.8' })
    add('path', { d: 'M 5.2 11.8 H 2.2 V 8.8' })
    add('path', { d: 'M 4.6 7 H 9.4', 'stroke-width': '1.1' })
  })
}
