/**
 * cropBox.ts — 谱面「墨迹盒」量取的**几何与坐标归位**（adj915）
 *
 * ## 为什么单独一个文件
 * 「谱面」视图要把整页 viewBox 裁到**墨迹**（用户口径：只显示有内容的部分）。
 * 墨迹只能由**拿到真实 DOM 的宿主**量（引擎是纯 TS、零 DOM，见 `vendor/engine/render/range.ts`
 * 的说明），量法就是"逐个顶层子元素 `getBBox()` 求并集"。
 *
 * 但这条量法此前有两个坑，**都在这份谱上真实发生过**（用户 2026-10：「多个 .jps 文件会有这种情况」）：
 *
 * ① **坐标系没归位** ✗：`getBBox()` 返回的是**元素自身坐标系**里的盒，
 *    **不含元素自己的 `transform`**。引擎把记号画成矢量字形时正是这种结构：
 *     · `glyphMarkup()`（波音/滑音/延长记号）⇒ `<g transform="translate(tx ty) scale(0.006831)"><path …/></g>`
 *       —— 盒是**字形源坐标**（~1024 单位制）里的 `951.6×349.91`，与它画在页面哪儿**毫无关系**；
 *     · 上/下装饰记号 ⇒ `<text transform="translate(cx symY) scale(0.75 1)">` —— 盒是 `-4.63,-7.92` 起。
 *    直接并集 ⇒ 墨迹盒被撑到 951.6 宽（页宽只有 595.28）或 x 变负 ⇒ **谱面某一侧一大块空白** ✗。
 *    ⇒ 修法：把每个盒用 **`svg.getCTM()⁻¹ · el.getCTM()`** 换算到**根 svg 的 viewBox 坐标系**。
 *    ⚠ 不能直接乘 `el.getCTM()`：它含「viewBox → CSS 像素」那层视口缩放
 *      （实测同一份谱：容器宽 595px 时 `a=0.9995`、宽 800px 时 `a=1.3439` ⇒ 盒会随容器宽变 ✗）。
 *
 * ② **页面外的元素照样算进并集** ✗：肉眼看不见的元素 `getBBox()` 照样有效值
 *    （零宽/零高的线条、被画到纸外的记号）⇒ 并集超出页面 ⇒ 同样是"某一侧空白"。
 *    ⇒ 修法：与**进裁剪前的整页矩形**求交（完全在页外就丢掉，跨界只算页内那一截）。
 *
 * ## 设计约束
 * · **纯函数优先**：`clipBoxToPage` / `unionBox` 不碰 DOM，浏览器与 Node 冒烟都能跑（断言见
 *   `scripts/smoke-frontmatter.mts` 的 adj915 区块）；
 * · **不引入任何依赖**；
 * · 只服务**显示端量取**：`rangeBox()` 的"±2px + 两道闸"、导出/复制/CLI 的口径**一律没动** ✗。
 */

/** 页面坐标里的一个矩形（与引擎 `RangeBox` 同形，避免两套形状） */
export interface CropBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 把盒**夹进页面**（求交）。
 *
 * · 完全落在页面外 ⇒ `null`（不可能是内容 ⇒ 调用方丢掉它）；
 * · 与页面相交 ⇒ 返回**页内那一截**（跨界元素只算页内部分 ✓）；
 * · 只在边界上"擦到"（`x1 === x0`）⇒ 保留成一个零面积的盒 ——
 *   引擎里**零宽/零高的笔画是合法内容**（小节线的竖、减时线的横），丢掉会把边界裁掉 ✗。
 */
export function clipBoxToPage(box: CropBox, page: CropBox): CropBox | null {
  const x0 = Math.max(box.x, page.x)
  const y0 = Math.max(box.y, page.y)
  const x1 = Math.min(box.x + box.w, page.x + page.w)
  const y1 = Math.min(box.y + box.h, page.y + page.h)
  if (x1 < x0 || y1 < y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** 两个盒的**外接矩形**（并集）；`null` 是单位元（空并集 + 盒 = 盒） */
export function unionBox(acc: CropBox | null, box: CropBox | null): CropBox | null {
  if (box === null) return acc
  if (acc === null) return { x: box.x, y: box.y, w: box.w, h: box.h }
  const x0 = Math.min(acc.x, box.x)
  const y0 = Math.min(acc.y, box.y)
  const x1 = Math.max(acc.x + acc.w, box.x + box.w)
  const y1 = Math.max(acc.y + acc.h, box.y + box.h)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * 取**进裁剪前的整页矩形**：`data-orig-vb` 优先（进"谱面"模式前把整页 viewBox 记在那儿），
 * 兜底读当前的 `viewBox`（引擎刚渲染出来时就是整页）。
 *
 * 读不到 / 解析不出来 ⇒ `null` ⇒ 调用方**不做求交**（用户口径：宁可不裁，也不误伤 ✓）。
 */
export function pageBoxOf(svgEl: SVGSVGElement): CropBox | null {
  const raw = svgEl.dataset.origVb ?? svgEl.getAttribute('viewBox') ?? ''
  const p = raw.trim().split(/[\s,]+/).map(Number)
  if (p.length !== 4 || !p.every((v) => Number.isFinite(v))) return null
  if (!(p[2] > 0) || !(p[3] > 0)) return null
  return { x: p[0], y: p[1], w: p[2], h: p[3] }
}

/**
 * 「元素自身坐标系 → 根 svg 的 viewBox 坐标系」的矩阵
 * = `svg.getCTM()⁻¹`（**只算一次**，逐个元素再乘 `el.getCTM()`）。
 *
 * 取不到（`getCTM` 抛错 / 返回 null）⇒ `null` ⇒ 调用方退回原盒（不做归位，也不误伤 ✓）。
 */
export function rootMatrixOf(svgEl: SVGSVGElement): DOMMatrix | null {
  let m: DOMMatrix | null = null
  try {
    m = typeof svgEl.getCTM === 'function' ? svgEl.getCTM() : null
  } catch {
    m = null
  }
  if (!m) return null
  try {
    return m.inverse()
  } catch {
    return null // 不可逆（奇异矩阵）：极少见，退回原盒
  }
}

/**
 * 把一个**元素自身坐标系**里的盒换算到根 svg 空间。
 *
 * 为什么用「四角变换后取外接矩形」而不是只搬 x/y：引擎里有 `scale(-1)` 的镜像记号
 * （替谱括号，见 `render/index.ts` 的 `translate(x) scale(-st) translate(…)`）
 * ⇒ 只搬原点会得到负宽度；四角外接对镜像/旋转都成立 ✓。
 *
 * `invRoot === null`（拿不到矩阵）⇒ 原样返回 —— 与"没做归位"的旧行为一致，不会更差。
 */
export function boxInRoot(el: SVGGraphicsElement, local: CropBox, invRoot: DOMMatrix | null): CropBox {
  if (invRoot === null) return local
  let own: DOMMatrix | null = null
  try {
    own = typeof el.getCTM === 'function' ? el.getCTM() : null
  } catch {
    own = null
  }
  if (!own) return local
  const m = invRoot.multiply(own)
  const xs = [
    m.a * local.x + m.c * local.y + m.e,
    m.a * (local.x + local.w) + m.c * local.y + m.e,
    m.a * local.x + m.c * (local.y + local.h) + m.e,
    m.a * (local.x + local.w) + m.c * (local.y + local.h) + m.e,
  ]
  const ys = [
    m.b * local.x + m.d * local.y + m.f,
    m.b * (local.x + local.w) + m.d * local.y + m.f,
    m.b * local.x + m.d * (local.y + local.h) + m.f,
    m.b * (local.x + local.w) + m.d * (local.y + local.h) + m.f,
  ]
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
}

/**
 * 元素在诊断里的**短名字**：`标签[.class][@data-meta][+tf]`。
 * `+tf` 是"这个元素自带 `transform`"的标记 —— 本轮的两个元凶正是这一类
 * （不加它，半年后回看诊断只会看到一堆 `g`/`text`，认不出是谁 ✓）。
 */
export function elementLabelOf(el: Element): string {
  const cls = (el.getAttribute('class') ?? '').trim()
  const meta = el.getAttribute('data-meta') ?? ''
  const tf = el.getAttribute('transform') ? '+tf' : ''
  return el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).join('.') : '') + (meta ? '@' + meta : '') + tf
}

/** 盒在诊断里的短写法：`x36.2~987.8`（**横向范围**，空白问题只看这一轴 ✓） */
export function boxRangeText(box: CropBox): string {
  const r = (v: number): string => String(Math.round(v * 10) / 10)
  return `x${r(box.x)}~${r(box.x + box.w)}`
}
