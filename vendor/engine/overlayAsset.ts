/**
 * overlayAsset.ts — 水印 / 背景图**取图策略**的共用口径（adj965，方案 `docs/OVERLAY-PLAN.md`「OVL」）
 *
 * ## 为什么在引擎里
 *
 * 同一套策略**三端都要用**，而且必须**逐字一致**：
 *  · 应用：`ijipu/src/store/assetSource.ts`（解析 + 白名单 + 上限）
 *  · 应用桌面端：Rust 的 `read_asset_file` / `ws_read_binary`（那边的上限**另有一份**，
 *    见 `src-tauri/src/lib.rs` 的注释——Rust 引不到 TS，那条重复是刻意的）
 *  · **Obsidian 插件**：宿主桥的 `readAsset` op 与代码块预览的取图
 *    （`obsidian-ijipu/src/embed/bridge.ts`、`src/render.ts`）
 *
 * 按本项目「**两端共用的规则一律先落 engine**」（`ijipu/src/AGENTS.md` 一）与
 * 「数值口径必须同源」（`AGENTS.md` 六之二·4），扩展名白名单、大小上限、路径归一、
 * mime 映射**只写这一份**；插件经 `vendor/engine` 逐字节同步（闸门 `adj770`）。
 *
 * ## 安全（方案 §八.10：`.jps` 是纯文本、可能来自别人）
 *
 *  · **只接受图片扩展名**（`png/jpg/jpeg/webp/gif/bmp`）；
 *  · **拒绝 `svg`**——SVG 可以内嵌 `<script>` 与外链，当"图片"塞进产物等于把 `.jps`
 *    变成脚本投递通道；
 *  · 单文件大小上限，超过就**明确报错**（不静默少画一层）。
 *
 * ⚠ 只按扩展名判**不是**安全边界（真正的边界是"只走指定的读通道 + 不解释内容"），
 * 但它能挡住"随手写个路径把系统文件读进来当图"这一大类，并给用户一句能懂的话。
 */

import type { PageConfig } from './types'

/**
 * 这份配置**要画哪两张图**（空串 = 不画）——判据与 `render/overlay.ts` 的 `overlayLayers()` 同口径。
 *
 * 三处（合并前是各判一份）：应用的资源解析（`store/overlayAssets.ts`）、
 * 插件代码块预览的取图、以及渲染端自己的 `overlayLayers()`。
 * ⚠ 水印要看 `wmType`：只有 `'image'` 才取图形（文本水印根本不读 `wmImage`）。
 */
export function overlayAssetRefs(cfg: PageConfig): { wm: string; bg: string } {
  const wm = cfg.wmEnabled !== false && cfg.wmType === 'image' ? String(cfg.wmImage ?? '').trim() : ''
  const bg = cfg.bgEnabled !== false ? String(cfg.bgImage ?? '').trim() : ''
  return { wm, bg }
}

/** 单文件上限：16MB（超过它当背景基本也糊，且会让每页 SVG 巨大） */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024

/**
 * **降采样策略**（方案优化 1：多页谱每页 SVG 各嵌一份 base64 ⇒ 不缩会炸内存/PDF）。
 *
 * 定义在引擎里是为了**两端同口径**：应用侧 `src/store/assetDecode.ts`（浏览器 `Image`/canvas）
 * 与插件的取图实现各有一份"碰 DOM"的解码代码，但**阈值与质量只认这三个数**。
 *
 *  · 长边超过 `MAX_EDGE` 就按比例缩（A4 在 150dpi 下约 1754px ⇒ 2000px 足够清晰）；
 *  · 缩过、或原图本身就大（> `RE_ENCODE_BYTES`）时统一重编码（WebP 支持透明，
 *    比 JPEG 更适合带透明的 logo / 水印；引擎不支持该类型时 `toDataURL` 会按规范退回 PNG）；
 *  · 小图（图标类）**原样直通**，不做无意义的重编码（免得把清晰的矢量感符号弄糊）。
 */
export const ASSET_MAX_EDGE = 2000
/** 超过这个字节数就重编码（小图标不值得重编码） */
export const ASSET_REENCODE_BYTES = 256 * 1024
/** 重编码质量（WebP） */
export const ASSET_REENCODE_QUALITY = 0.85

/**
 * 允许的图片扩展名。**故意不含 `svg`**：SVG 能带 `<script>`/外链，当"图片"塞进产物里
 * 等于把 `.jps` 变成脚本投递通道（见方案 §八.10）。
 */
export const ALLOWED_ASSET_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const

/** 路径归一：`[[双链]]` 去掉包裹、去首尾空白、`\` 归一成 `/`、去掉开头的 `./` */
export function assetPathOf(raw: string): { path: string; link: boolean; isData: boolean } {
  let s = String(raw ?? '').trim()
  let link = false
  // Obsidian 双链：`[[图片.png]]`（也接受 `[[图片.png|别名]]` —— 取 `|` 前那半）
  const m = /^\[\[([^\]]+)\]\]$/.exec(s)
  if (m !== null) {
    link = true
    s = (m[1] ?? '').split('|')[0]?.trim() ?? ''
  }
  if (/^data:/i.test(s)) return { path: s, link, isData: true }
  return { path: s.replace(/\\/g, '/').replace(/^\.\//, ''), link, isData: false }
}

/** 取扩展名（小写、不含点） */
export function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

/** 扩展名白名单（判据见文件头「安全」那一段） */
export function isAllowedAssetPath(path: string): boolean {
  return (ALLOWED_ASSET_EXT as readonly string[]).includes(extOf(path))
}

/** mime ← 扩展名（data URI 用；`data:` 直通时用原 mime） */
export function mimeOf(path: string): string {
  switch (extOf(path)) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

/**
 * 图片路径 → 目录段 + 文件名（`img/图.png` ⇒ `['img']` + `图.png`）。
 *
 * 三端的读图实现都要"逐级下钻到本谱所在目录，再进图片自己的子目录"
 * （网页版的工作区目录句柄、插件的 vault、桌面端的工作区相对段）⇒ 切分口径共用这一份。
 */
export function splitAssetPath(path: string): { dirs: string[]; name: string } {
  const parts = path.split('/').filter((s) => s !== '' && s !== '.')
  const name = parts.pop() ?? ''
  return { dirs: parts, name }
}

/** base64 字母表（自己实现，**不用 `btoa`/`Buffer`**：引擎零 DOM、也要能在 Node 里跑） */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 字节 → base64（纯函数）。
 *
 * 为什么不用 `btoa`：① 引擎零 DOM（`btoa` 是浏览器全局）；② `btoa` 对超大二进制串
 * 还要自己分块、且对非 Latin1 字符会抛错。这里按 3 字节一组直接算，两端（浏览器与 Node）行为一致。
 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64[b0 >> 2]
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : B64[b2 & 0x3f]
  }
  return out
}

/** base64 → 字节（非法字符按 0 处理；只用于"我们自己发出去的 base64"，不做严格校验） */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = B64.indexOf(clean[i] ?? 'A')
    const n1 = B64.indexOf(clean[i + 1] ?? 'A')
    const n2 = B64.indexOf(clean[i + 2] ?? 'A')
    const n3 = B64.indexOf(clean[i + 3] ?? 'A')
    const v = (n0 << 18) | (n1 << 12) | ((n2 < 0 ? 0 : n2) << 6) | (n3 < 0 ? 0 : n3)
    if (o < out.length) out[o++] = (v >> 16) & 0xff
    if (i + 2 < clean.length && o < out.length) out[o++] = (v >> 8) & 0xff
    if (i + 3 < clean.length && o < out.length) out[o++] = v & 0xff
  }
  return out
}

/** 字节 + mime ⇒ data URI（引擎的 `RenderAssets.href` 必须是 data URI，见 `render/overlay.ts`） */
export function dataUriOf(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${toBase64(bytes)}`
}
