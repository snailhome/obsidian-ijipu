/**
 * overlayGesture.ts — 水印层 / 背景层的**手势口径**（adj965d，方案 EP-13）
 *
 * ## 为什么放在引擎里
 *
 * 同一套手势**两端都要有**：应用的预览区（`ijipu/src/preview/PreviewPane.tsx`）与
 * Obsidian 插件的代码块预览（`obsidian-ijipu/src/scorePane.ts`）。
 * 按本项目「**两端共用的规则一律先落 engine**」（`ijipu/src/AGENTS.md` 一）与
 * 「数值口径必须同源」（`AGENTS.md` 六之二·4），判定与换算**只写这一份**，
 * 插件经 `vendor/engine` 逐字节同步（闸门 `adj770`），两端各自只负责"接线"。
 *
 * 本模块**零 React / 零 DOM**（只有纯数值与对象运算）⇒ 能进引擎、也能在 `smoke` 里直接断言。
 *
 * ## 键位（用户 2026-10-15 终裁 = 方案 A「Alt 一族全包」，见 `docs/OVERLAY-PLAN.md` 裁定记录 9）
 *
 * | 操作 | 改什么 |
 * |---|---|
 * | `Alt+滚轮` | 缩放该层（滚轮**累计约 100px 走一档**） |
 * | `Alt+Shift+滚轮` | 旋转该层（**绕元素自身中心**——`render/overlay.ts` 的 `rotateAttr` 的 `cx/cy` 就是元素中心，裁定 9.1） |
 * | `Alt+左键拖动` | 平移该层（改"元素中心相对页面中心的偏移"） |
 *
 * 为什么不是 `Ctrl`：**`Ctrl+滚轮` 是浏览器与桌面壳的页面缩放热键**（用户指出）；
 * 而 `Ctrl+单击` 在应用里已经是"从这里试听"。拖动改用 `Alt` 之后两者**完全不冲突**
 * ⇒ 不需要早期方案里"4px 位移阈值 + 抑制 click"那套判据，修饰键也只剩一个，好记。
 *
 * ## 三条前提（缺一不动，见方案 §七 EP-13 那一行）
 *
 * ①「排版辅助」打开（应用 `uiStore.showGuides` / 插件 `plugin.showGuides`，由调用方判）；
 * ② 该层已启用；③ 该层有内容。
 * ②③ 的判据**与 `render/overlay.ts` 的 `overlayLayers()` 同口径**：总开关用 `!== false`
 * （默认值本身就是 `false` ⇒ 实际等于"要显式勾上"），这样两边不会各判一套。
 */
import { defaultPageConfig, type PageConfig } from './types'

/** 手势作用在哪一层（`wm` = 水印层、`bg` = 背景层） */
export type OverlayLayer = 'wm' | 'bg'

/** 缩放的钳制：与设置面板的 `range=[10,1000]`、`render/overlay.ts` 的 `numOr(…,10,1000,100)` 三处同口径 */
export const OVERLAY_SCALE_RANGE: readonly [number, number] = [10, 1000]
/** 旋转的钳制（同上三处同口径） */
export const OVERLAY_ROTATE_RANGE: readonly [number, number] = [-180, 180]
/** 文本水印字号（pt）的钳制：面板 `range=[6,400]`、引擎 `numOr(…,6,400,36)` */
export const OVERLAY_TEXT_SIZE_RANGE: readonly [number, number] = [6, 400]
/** 中心偏移的兜底界限：引擎按 ±1e6 兜底，这里跟它一致（等于"实际不钳"） */
const OVERLAY_OFFSET_LIMIT = 1e6

/** 滚轮步进：比例类 ±5（**个百分点**，100 → 105）；字号类 ±5%（相对当前字号，至少 1pt） */
const SCALE_STEP = 5
const SIZE_STEP_RATIO = 0.05
/**
 * 滚轮的**累计阈值**（CSS px）：累计滚动够这个量才走一档。
 *
 * 由来（用户 2026-10-15 确认改成累计）：鼠标滚一格在 Chrome/Windows 上恰好是 `deltaY≈100`
 * ⇒ 一格一档；而**触控板**一次两指滑动会派发很多个小 delta，若"一个事件一档"就会滑一下连跳好几档。
 * 代价：个别"一格不满 100px"的鼠标要滚两下才动一档（用户已确认接受）。
 */
export const OVERLAY_WHEEL_STEP_PX = 100
/** 单次事件最多走几档：防"页"模式或异常 delta 把值一次拉飞（正常情况下远到不了这个数） */
const OVERLAY_WHEEL_MAX_STEPS = 20

/** 滚轮（按住了 Alt）要做的事 */
export type OverlayWheelMode = 'scale' | 'rotate'

/** 有限数校验（手改坏成 `NaN`/字符串时回退默认值，与 `render/overlay.ts` 的 `numOr` 同一手法） */
function numOr(v: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

/** 取整 + 钳到区间（写进 `# jps-config` 的值一律是整数 px/pt，与设置面板一致） */
function clampRound(v: number, range: readonly [number, number]): number {
  return Math.round(Math.min(range[1], Math.max(range[0], v)))
}

/**
 * 该层现在**看得见**吗 = 总开关打开 + 有内容。
 *
 * ⚠ 水印的"有内容"看的是**实际会画出来的那一个字段**（`wmType` 决定画文本还是图形）：
 * 若写成"两个字段有一个非空"，那么在 `wmType==='text'` 而只填了图片时，
 * `Alt+滚轮` 会去改 `wmScale`——而**文本层根本不读 `wmScale`** ⇒ "改了却什么都没变"，
 * 正是最容易让人以为功能坏了的情形。所以这里与 `overlayLayers()` 的取用分支严格对齐。
 */
export function overlayLayerVisible(cfg: PageConfig, layer: OverlayLayer): boolean {
  if (layer === 'bg') return cfg.bgEnabled !== false && String(cfg.bgImage ?? '').trim() !== ''
  const has = cfg.wmType === 'image' ? String(cfg.wmImage ?? '').trim() !== '' : String(cfg.wmText ?? '').trim() !== ''
  return cfg.wmEnabled !== false && has
}

/**
 * 手势实际作用的那一层。
 *
 *  · 两层都可用 ⇒ 用**用户在预览角落选的那一层**（`preferred`）；
 *  · 只有一层可用 ⇒ 就是它（此时角落也不显示切换器，见 `bothOverlayLayersVisible`）；
 *  · 都不满足 ⇒ `null`（手势完全不介入，普通滚动/点击一字不变）。
 */
export function activeOverlayLayer(cfg: PageConfig, preferred: OverlayLayer): OverlayLayer | null {
  const wmOk = overlayLayerVisible(cfg, 'wm')
  const bgOk = overlayLayerVisible(cfg, 'bg')
  if (wmOk && bgOk) return preferred
  if (wmOk) return 'wm'
  if (bgOk) return 'bg'
  return null
}

/** 两层是否都可用——**只有这时才需要「调整对象」切换器**（用户口径：单一层或都没有就不显示） */
export function bothOverlayLayersVisible(cfg: PageConfig): boolean {
  return overlayLayerVisible(cfg, 'wm') && overlayLayerVisible(cfg, 'bg')
}

/**
 * 该层是否**已经写进谱面**（按**源码层**配置算，不看设置面板的草稿）。
 *
 * 只用来决定预览角落那句「尚未写入谱面」的提醒（用户 2026-10-15 要求"加一层保险"）：
 * 只在面板里勾了开关时，这一层只活在草稿里 —— 此时**除手势以外**的任何动作都可能让它消失
 * （在编辑器里打字、刷新、宿主整页重载都会让生效配置重新从源码派生）。
 *
 * 判据与"这一层看不看得见"**同一个函数**：源码层配置下它仍然可见 ⇒ 就已经在谱面里了。
 */
export function overlayLayerPersisted(sourceCfg: PageConfig, layer: OverlayLayer): boolean {
  return overlayLayerVisible(sourceCfg, layer)
}

/**
 * 一次 `wheel` 事件的位移换算成 CSS px。
 * `deltaMode`：0 = 像素、1 = 行（按 16px 粗算）、2 = 页（按预览区高度）。
 */
export function wheelDeltaPx(ev: { deltaY: number; deltaMode?: number }, pagePx = 0): number {
  const d = typeof ev.deltaY === 'number' && Number.isFinite(ev.deltaY) ? ev.deltaY : 0
  if (ev.deltaMode === 1) return d * 16
  if (ev.deltaMode === 2) return d * (pagePx > 0 ? pagePx : 800)
  return d
}

/**
 * 累计位移 → **这一次要走几档**，以及剩下的累计值（留给下一次事件）。
 *
 * `steps` 为正 = 向下滚（值变小）。不足一档时返回 `{ steps: 0, rest }`
 * ——**余数要留着**，否则触控板上永远攒不满一档。
 */
export function overlayWheelSteps(acc: number, deltaPx: number): { steps: number; rest: number } {
  const total = acc + deltaPx
  const raw = Math.trunc(total / OVERLAY_WHEEL_STEP_PX)
  const steps = Math.max(-OVERLAY_WHEEL_MAX_STEPS, Math.min(OVERLAY_WHEEL_MAX_STEPS, raw))
  return { steps, rest: total - steps * OVERLAY_WHEEL_STEP_PX }
}

/**
 * `Alt+滚轮` 是缩放还是旋转；没按 Alt ⇒ `null`（**绝不拦截**，普通滚动与 `Ctrl+滚轮` 页面缩放照旧）。
 *
 * `Shift` 在滚轮里切换"缩放/旋转"两种模式；它在拖动里是另一个意思（吸附页面中心），
 * 两者互不干扰——同一修饰键在不同手势里各表一意，与方案裁定 9 的表述一致。
 */
export function overlayWheelMode(ev: { altKey?: boolean; shiftKey?: boolean }): OverlayWheelMode | null {
  if (ev.altKey !== true) return null
  return ev.shiftKey === true ? 'rotate' : 'scale'
}

/** 该层当前的中心偏移（拖动的起点值） */
export function overlayOffsetOf(cfg: PageConfig, layer: OverlayLayer): { x: number; y: number } {
  return layer === 'wm'
    ? { x: numOr(cfg.wmOffsetX, 0), y: numOr(cfg.wmOffsetY, 0) }
    : { x: numOr(cfg.bgOffsetX, 0), y: numOr(cfg.bgOffsetY, 0) }
}

/**
 * 手势落盘时用的**基线快照**：把"目标层自己那些键"置回**代码默认值**，其余字段照旧。
 *
 * ## 为什么不能直接用"按下时的生效配置"当基线（**真机上踩到过**）
 *
 * 落盘走 `mergeConfigEdits(code, base, cfg)`（`settings.ts`），规则是
 * 「**只把 `base` 与 `cfg` 不同的键**并进源码层」。
 * 于是：用户只在设置面板里**打开**了水印/背景（没点「保存设置」）时，
 * `wmEnabled` / `wmText` / `bgImage` 这些只活在草稿里、源码层没有 ⇒ 基线里它们与最新值相同 ⇒
 * **一个键都不会被写**，写进谱面的只有手势真正动过的那个字段（比如 `wmSize`）。
 * 结果就是**半截配置**：谱面里多了一个"没启用的水印层 + 一个孤零零的字号"；
 * 此后任何一次"从源码重新派生生效配置"的动作（在编辑器里打字、刷新、宿主整页重载）
 * 都会让这一层**连提示条带手势一起消失**，而配置行里那个孤儿键还留着。
 *
 * 把这个层的键在基线里置默认 ⇒ 它们在 `mergeConfigEdits` 眼里都算"本次改动"，
 * 于是**一次手势 = 把被调的那一层按现在看到的样子固化进谱面**（启用 + 内容 + 各项参数），
 * 而且**仍然不碰别的东西**——页边距、字体、另一层那些同批草稿改动都不会被顺手带进谱面
 * （`mergeConfigEdits` 的本意"不把本机/草稿设置泄漏成谱面级"原样保留）。
 */
export function overlayGestureBase(cfg: PageConfig, layer: OverlayLayer): PageConfig {
  const d = defaultPageConfig
  if (layer === 'bg') {
    return {
      ...cfg,
      bgEnabled: d.bgEnabled,
      bgImage: d.bgImage,
      bgScale: d.bgScale,
      bgRotate: d.bgRotate,
      bgOpacity: d.bgOpacity,
      bgOffsetX: d.bgOffsetX,
      bgOffsetY: d.bgOffsetY,
    }
  }
  return {
    ...cfg,
    wmEnabled: d.wmEnabled,
    wmType: d.wmType,
    wmText: d.wmText,
    wmImage: d.wmImage,
    wmSize: d.wmSize,
    wmScale: d.wmScale,
    wmRotate: d.wmRotate,
    wmRepeat: d.wmRepeat,
    wmRepeatGap: d.wmRepeatGap,
    wmOpacity: d.wmOpacity,
    wmOffsetX: d.wmOffsetX,
    wmOffsetY: d.wmOffsetY,
  }
}

/**
 * 滚轮一档 ⇒ 新配置（**只改目标字段**，返回浅拷贝；调用方按"预览态"套用）。
 *
 * 方向：`deltaY < 0`（向上滚）＝ 放大 / 角度变大。
 * 缩放的目标字段**按层与类型分**：
 *  · 背景图、图形水印 ⇒ `bgScale` / `wmScale`（宽度占页宽百分比）；
 *  · **文本水印 ⇒ `wmSize`**（字号 pt）——文本层只读它（见 `overlayLayerVisible` 的说明）。
 */
export function applyOverlayWheel(
  cfg: PageConfig,
  layer: OverlayLayer,
  mode: OverlayWheelMode,
  deltaY: number,
): PageConfig {
  if (deltaY === 0) return cfg
  const dir = deltaY < 0 ? 1 : -1
  if (mode === 'rotate') {
    const next = clampRound(numOr(layer === 'wm' ? cfg.wmRotate : cfg.bgRotate, 0) + dir * SCALE_STEP, OVERLAY_ROTATE_RANGE)
    return layer === 'wm' ? { ...cfg, wmRotate: next } : { ...cfg, bgRotate: next }
  }
  if (layer === 'wm' && cfg.wmType !== 'image') {
    const cur = numOr(cfg.wmSize, 36)
    const step = Math.max(1, Math.round(cur * SIZE_STEP_RATIO))
    return { ...cfg, wmSize: clampRound(cur + dir * step, OVERLAY_TEXT_SIZE_RANGE) }
  }
  const next = clampRound(numOr(layer === 'wm' ? cfg.wmScale : cfg.bgScale, 100) + dir * SCALE_STEP, OVERLAY_SCALE_RANGE)
  return layer === 'wm' ? { ...cfg, wmScale: next } : { ...cfg, bgScale: next }
}

/**
 * 拖动 ⇒ 新配置：把指针位移（CSS px）换算成谱面 pt 后加到按下时的偏移上。
 *
 * @param start 按下那一刻该层的偏移（**基线**，不是每帧的当前值——否则位移会自我累加）
 * @param scale 预览缩放系数（`显示宽 / 页宽`）——与描述头 / 辅助虚线拖拽同一个换算
 * @param snapCenter `Shift` 按住 ⇒ 吸附页面中心（`(0,0)` 就是居中），与方案优化 6 一致
 */
export function applyOverlayDrag(
  cfg: PageConfig,
  layer: OverlayLayer,
  start: { x: number; y: number },
  dxPx: number,
  dyPx: number,
  scale: number,
  snapCenter: boolean,
): PageConfig {
  const limit: readonly [number, number] = [-OVERLAY_OFFSET_LIMIT, OVERLAY_OFFSET_LIMIT]
  const x = snapCenter ? 0 : clampRound(start.x + dxPx / (scale > 0 ? scale : 1), limit)
  const y = snapCenter ? 0 : clampRound(start.y + dyPx / (scale > 0 ? scale : 1), limit)
  return layer === 'wm' ? { ...cfg, wmOffsetX: x, wmOffsetY: y } : { ...cfg, bgOffsetX: x, bgOffsetY: y }
}
