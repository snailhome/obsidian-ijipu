/**
 * icons.ts — 界面图标（内联 SVG，零依赖；与 iJipu 应用顶栏用同一形状）
 *
 * 用 SVG 而非 emoji：emoji 在不同系统/字体下形状与基线都不同（齿轮 ⚙ 尤其容易跑偏），
 * 而 iJipu 应用的「排版」按钮本身就是**田字格**图标（方框 + 一竖一横），插件沿用同一形状
 * 才能一眼对应上。
 */
const NS = 'http://www.w3.org/2000/svg'

/**
 * 图标基础线宽。
 *
 * 深色主题下 1.4px 的细笔画（尤其中空形状：田字格、满宽箭头）会糊成一团看不清，
 * 故基准线宽提到 1.8；内部辅助线用 1.5 保持层次。颜色由父元素 `color` 决定
 * （样式里用 `--text-normal`，不用 `--text-muted`——后者在深色主题偏暗）。
 */
const SW = '1.8'
const SW_THIN = '1.5'

/** 建一个描边图标（与 iJipu 应用顶栏图标同规格：currentColor + 圆角线帽，配色由主题决定） */
function strokeIcon(
  build: (add: (tag: 'rect' | 'path' | 'circle', attrs: Record<string, string>) => void) => void,
  size = 14,
): SVGSVGElement {
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
  build((tag, attrs) => {
    const el = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.appendChild(el)
  })
  return svg
}

/**
 * 田字格图标（与 iJipu 应用顶栏「排版」按钮同一形状：方框 + 竖线 + 横线）。
 * @param size 像素尺寸（默认 15：深色主题下 14 略小，笔画挤在一起不易辨认）
 */
export function layoutIcon(size = 15): SVGSVGElement {
  return strokeIcon((add) => {
    add('rect', { x: '2', y: '2', width: '10', height: '10' })
    add('path', { d: 'M 7 2 V 12' })
    add('path', { d: 'M 2 7 H 12' })
  }, size)
}

/**
 * 「页面设置」图标：三条滑杆（设置/调整的通用意象，与「排版（田字格）」明确区分）。
 */
export function settingsIcon(size = 15): SVGSVGElement {
  return strokeIcon((add) => {
    add('path', { d: 'M 2 3.6 H 12', 'stroke-width': SW_THIN })
    add('path', { d: 'M 2 7 H 12', 'stroke-width': SW_THIN })
    add('path', { d: 'M 2 10.4 H 12', 'stroke-width': SW_THIN })
    add('circle', { cx: '5', cy: '3.6', r: '1.5' })
    add('circle', { cx: '9', cy: '7', r: '1.5' })
    add('circle', { cx: '6', cy: '10.4', r: '1.5' })
  }, size)
}

/**
 * 显示模式图标（三种，形状直接表意；笔画都尽量少、尽量粗，保证 14~15px 下清晰）：
 *  - 整页：整张纸 + 内部虚线框 = 含页边距的完整一页
 *  - 满宽：左右边界 + 贯穿双向箭头 = 横向撑满容器宽
 *  - 谱面：四角裁切标记 = 裁掉页边距、只保留内容区
 */
export function modeIcon(mode: 'page' | 'full' | 'score', size = 15): SVGSVGElement {
  if (mode === 'page') {
    return strokeIcon((add) => {
      add('rect', { x: '2.3', y: '1.3', width: '9.4', height: '11.4' })
      add('rect', { x: '4.2', y: '3.1', width: '5.6', height: '7.8', 'stroke-dasharray': '1.6 1.5', 'stroke-width': SW_THIN })
    }, size)
  }
  if (mode === 'full') {
    // 「横向撑满」：两条边界竖线 + 贯穿双向箭头（比"页面框 + 框外小箭头"笔画更少更清楚）
    return strokeIcon((add) => {
      add('path', { d: 'M 1.5 3.3 V 10.7' })
      add('path', { d: 'M 12.5 3.3 V 10.7' })
      add('path', { d: 'M 4.4 7 H 9.6' })
      add('path', { d: 'M 6 5.5 L 4.1 7 L 6 8.5' })
      add('path', { d: 'M 8 5.5 L 9.9 7 L 8 8.5' })
    }, size)
  }
  // score：裁切标记（左上/右上/左下/右下四个角）+ 中间内容线
  return strokeIcon((add) => {
    add('path', { d: 'M 2 5.4 V 2 H 5.4' })
    add('path', { d: 'M 8.6 2 H 12 V 5.4' })
    add('path', { d: 'M 12 8.6 V 12 H 8.6' })
    add('path', { d: 'M 5.4 12 H 2 V 8.6' })
    add('path', { d: 'M 4.4 7 H 9.6', 'stroke-width': SW_THIN })
  }, size)
}
