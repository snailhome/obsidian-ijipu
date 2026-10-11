/**
 * render/range.ts — 「范围」参数的**唯一实现**（adj863 / T-3 定稿，2026-10-11）
 *
 * ## 这个"范围"是什么（用户口径）
 * 导出/复制谱面时，画布有两种口径，用户给它们定过名（见 `docs/HANDOVER-CLI-AND-COMMAND-API.md` 二之二）：
 *  · **`page`（导出页面）**：完整页面（A4 等）+ 四周留白 —— 就是**整页盒**；
 *  · **`score`（导出谱面）**：**墨迹包围盒 + 每边 N px**（默认 `N = 2`），不保留页宽 —— 真正的最小边界。
 *
 * ⚠ "2px" 一律理解为**每边 2px**（不是总量 2px）：画布 = `(墨迹宽 + 2N) × (墨迹高 + 2N)`。
 *
 * ## 为什么必须放在引擎里（本项目的老坑）
 * 同一套"范围几何"此前在**多处各写一遍**（插件预览的 viewBox / 插件的显示模式裁剪 / 导出 / CLI），
 * 于是"预览里看着是墨迹 ±2px、导出的却是整页"这类漂移反复出现（AGENTS §六之二·4「数值口径必须同源」）。
 * 现在只在这里算：调用方（插件预览 / 插件导出 / 应用导出对话框 / CLI `render --crop`）**只传参、不重算**。
 *
 * ## 墨迹盒与门槛值从哪来（为什么是入参）
 * 墨迹 = **实际画出来的字形/线条**的包围盒 —— 只有拿到真实 DOM 的宿主（插件面板 / 应用预览）
 * 用 `getBBox()`+`getCTM()` 才量得准，引擎是纯 TS、零 DOM，**不在这里瞎估**。
 * 所以本模块**接收**调用方量到的 `ink`，并负责：
 *  ① 加上每边 `pad`；
 *  ② 过**两道可信度闸**，不可信就判 `ok:false` 并给原因（让调用方**明确报错**，而不是产出报废图）：
 *     · **退化闸** `minInk`：墨迹盒比"一个音符的墨迹"还小 ⇒ 一定是没量到（判据公式见 `minInkFor`）；
 *     · **近整页闸** `NEAR_PAGE_RATIO`：墨迹盒几乎等于整页（≥98%）⇒ 多半把整页白底算进来了（等于没裁）。
 *  ③ 顺手把外框写进 SVG 字符串（`applyRangeToSvg`）——SVG 外框的改写也**只此一处**。
 */

/** 范围口径：整页 / 墨迹 */
export type ExportRange = 'page' | 'score'

/** 页面坐标里的一个矩形（引擎里所有几何量都用这个形状） */
export interface RangeBox {
  x: number
  y: number
  w: number
  h: number
}

/** 每边默认留白（px）：与"谱面视图四周 2px 留白"同一口径 */
export const RANGE_PAD_DEFAULT = 2

/**
 * 墨迹盒退化闸的**兜底**下限（px）：拿不到"一个音符的墨迹高"时用它。
 * 取极小值是刻意的 —— 宁可放过一个可疑盒，也不要把"合法但很短的谱（单行）"误杀（`adj843` 的实测结论）。
 */
export const MIN_INK_FALLBACK = 6

/**
 * 近整页闸的比例：墨迹盒 ≥ 整页的 98% ⇒ 视为**量取不可靠**（引擎第一层是整页白底 `data-page-bg`，
 * `getBBox()` 一不留神就把它算进来 ⇒ 裁剪等于没裁，"谱面还有 A4 那么大空白"就是这个现象）。
 * 真实谱面上下必有边距，不可能占满整页。
 */
export const NEAR_PAGE_RATIO = 0.98

/**
 * **数据驱动的退化闸阈值**（`adj843`，用户口径）：「**通常音符墨迹高度为最小墨迹盒高度**」
 * —— 即整块谱面的墨迹盒**不可能比一个音符的墨迹还矮**。
 *
 * 于是不再用魔数（40 误伤短谱、6 又拦不住假值，都被实证过）：宿主量一个音符的墨迹高 `noteInkH` 传进来，
 * 这里取它的 ~90%（留抗锯齿/取整余量）并不低于兜底值。取不到音符 ⇒ 传 0/不传 ⇒ 用兜底值。
 */
export function minInkFor(noteInkH: number): number {
  if (!Number.isFinite(noteInkH) || noteInkH <= 0) return MIN_INK_FALLBACK
  return Math.max(MIN_INK_FALLBACK, Math.round(noteInkH * 0.9))
}

/** `rangeBox()` 的入参 */
export interface RangeRequest {
  /** 口径 */
  range: ExportRange
  /** 整页宽（页面坐标单位） */
  pageW: number
  /** 整页高 */
  pageH: number
  /** 调用方量到的**墨迹**包围盒；`score` 口径必填，`null`/缺省 ⇒ 判失败（并给原因） */
  ink?: RangeBox | null
  /** 每边留白（px），缺省 `RANGE_PAD_DEFAULT`；钳制到 [0, 64] */
  pad?: number
  /** 退化闸阈值（px），缺省 `MIN_INK_FALLBACK`；宿主按 `minInkFor(音符墨迹高)` 传 */
  minInk?: number
}

/** `rangeBox()` 的结果：`box` **恒有值**（失败时退回整页盒，便于调用方"明确报错"或"照样导整页"） */
export interface RangeOutcome {
  ok: boolean
  range: ExportRange
  box: RangeBox
  /** 是否发生了回退（`false` = 完全按请求的口径给盒） */
  fellBack: boolean
  /** 失败/回退原因（面向用户的一句话，可直接进 Notice / CLI stderr） */
  reason?: string
}

/**
 * 保留 2 位小数：与渲染端写进 SVG 的数字精度**同档**（页面尺寸本身是 `595.28×841.89` 这种两位小数）
 * ⇒ **整页范围对渲染产物是逐字恒等变换**（`applyRangeToSvg(svg, pageBox) === svg`，有断言守着）。
 * 两位小数足够用：墨迹盒来自 `getBBox()`，两位小数远在亚像素以下。
 */
function r2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 取有效的每边留白：缺省 2，越界钳制到 [0, 64]（用户可写 `--pad 0`） */
export function normalizeRangePad(pad?: number): number {
  if (pad === undefined || !Number.isFinite(pad)) return RANGE_PAD_DEFAULT
  return Math.min(64, Math.max(0, pad))
}

/** 取有效的退化闸阈值：缺省兜底值，越界钳制到 [0, 1000] */
export function normalizeMinInk(minInk?: number): number {
  if (minInk === undefined || !Number.isFinite(minInk)) return MIN_INK_FALLBACK
  return Math.min(1000, Math.max(0, minInk))
}

/**
 * 按范围给出画布盒（**纯函数**：同输入必同输出；不读 DOM、不读配置）。
 *
 * 语义（口径表见文件头）：
 *  · `page` ⇒ 恒为 `{0,0,pageW,pageH}`，`ok:true`；
 *  · `score` ⇒ 墨迹 ± `pad`，`ok:true`；墨迹缺失 / 退化 / 近整页 ⇒ `ok:false` + `fellBack:true` + `reason`，
 *    `box` 退回整页。
 */
export function rangeBox(req: RangeRequest): RangeOutcome {
  const page: RangeBox = { x: 0, y: 0, w: Math.max(1, r2(req.pageW)), h: Math.max(1, r2(req.pageH)) }
  if (req.range === 'page') return { ok: true, range: 'page', box: page, fellBack: false }

  const ink = req.ink
  if (!ink || !(Number.isFinite(ink.x) && Number.isFinite(ink.y) && Number.isFinite(ink.w) && Number.isFinite(ink.h))) {
    return {
      ok: false,
      range: 'score',
      box: page,
      fellBack: true,
      reason: '没有量到墨迹盒（这份谱还没在预览里渲染过，或量取时机太早）——已退回整页',
    }
  }
  const minInk = normalizeMinInk(req.minInk)
  if (ink.w < minInk || ink.h < minInk) {
    return {
      ok: false,
      range: 'score',
      box: page,
      fellBack: true,
      reason: `墨迹盒退化（${r2(ink.w)}×${r2(ink.h)}，小于可信下限 ${minInk}px）——量取不可靠，已退回整页`,
    }
  }
  if (ink.w >= page.w * NEAR_PAGE_RATIO && ink.h >= page.h * NEAR_PAGE_RATIO) {
    return {
      ok: false,
      range: 'score',
      box: page,
      fellBack: true,
      reason: `墨迹盒几乎等于整页（${r2(ink.w)}×${r2(ink.h)} ≥ 整页的 ${Math.round(NEAR_PAGE_RATIO * 100)}%）——多半把整页白底量进来了，已退回整页`,
    }
  }
  const pad = normalizeRangePad(req.pad)
  return {
    ok: true,
    range: 'score',
    box: { x: r2(ink.x - pad), y: r2(ink.y - pad), w: r2(ink.w + pad * 2), h: r2(ink.h + pad * 2) },
    fellBack: false,
  }
}

/**
 * 把画布盒写进 SVG 的**外层属性**（`width`/`height`/`viewBox`）——**唯一**一处改写 SVG 外框的代码。
 *
 * 为什么必须集中：调用方（插件导出 / 应用导出 / CLI）此前各写一遍正则，于是出现过
 * "页面的 viewBox 改了、`width` 没改" ⇒ 导出的 PNG 尺寸与预览不一致。
 *
 * 安全：只认**本引擎产物**（以 `<svg` 开头、能在首个 `>` 前找到开头标签）；不是就**原样返回**，不猜、不破坏。
 */
export function applyRangeToSvg(svg: string, box: RangeBox): string {
  const end = svg.indexOf('>')
  if (!svg.startsWith('<svg') || end < 0) return svg
  const head = svg.slice(0, end)
  const x = r2(box.x)
  const y = r2(box.y)
  const w = Math.max(1, r2(box.w))
  const h = Math.max(1, r2(box.h))
  let next = head
  next = /\swidth="[^"]*"/.test(next) ? next.replace(/\swidth="[^"]*"/, ` width="${w}"`) : next.replace(/^<svg/, `<svg width="${w}"`)
  next = /\sheight="[^"]*"/.test(next) ? next.replace(/\sheight="[^"]*"/, ` height="${h}"`) : next.replace(/^<svg/, `<svg height="${h}"`)
  next = /\sviewBox="[^"]*"/.test(next) ? next.replace(/\sviewBox="[^"]*"/, ` viewBox="${x} ${y} ${w} ${h}"`) : next.replace(/^<svg/, `<svg viewBox="${x} ${y} ${w} ${h}"`)
  return next + svg.slice(end)
}

/** 取 SVG 外层的 `viewBox`（`[x,y,w,h]`；读不到返回 `null`）——断言与诊断用 */
export function readViewBoxOf(svg: string): [number, number, number, number] | null {
  const end = svg.indexOf('>')
  if (!svg.startsWith('<svg') || end < 0) return null
  const m = /\sviewBox="([^"]*)"/.exec(svg.slice(0, end))
  if (!m) return null
  const parts = m[1].trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null
  return [parts[0], parts[1], parts[2], parts[3]]
}
