/**
 * png.ts — PNG 字节级小工具：**pHYs（物理像素密度 = DPI）** 的写入与读取（adj864）
 *
 * ## 为什么需要它
 * 「复制为图片」把 PNG 放进剪贴板后，Word / 微信 / 飞书这类程序**按 pHYs 声明的 DPI** 决定
 * "这张图该显示多大"：没有 pHYs 时它们多按 96 DPI 兜底 ⇒ 一张 2× 渲染的 A4 谱（1190×1684）
 * 会被当成 12.4 英寸宽的巨图插进文档 ✗。所以复制/导出图片时要**明确写出 DPI**：
 *  · 我们按 `scale` 倍渲染（`scale=2` ⇒ 2 倍像素）；
 *  · 页面基准是 72 DPI（PDF/SVG 的 1 单位 = 1/72 英寸）⇒ **DPI = 72 × scale**（2× ⇒ 144 DPI，4× ⇒ 288 DPI）。
 *
 * ## 为什么在引擎里（而不是各端各写）
 * 插件（剪贴板）、应用（导出对话框）、将来的 CLI（`render -t png --dpi`）都要同一份写法；
 * 且这是**纯字节运算**（零 DOM、零 canvas）⇒ 天然属于引擎，能被 smoke 直接单测
 * （PNG 结构 + CRC32 都能用已知向量钉死）。
 *
 * ## 只做最小必要的事
 * 不重新编码像素、不动其它块：只**跳过已有的 pHYs**（若存在）并在 `IHDR` 之后插入我们的一个。
 * 非法输入（不是 PNG）⇒ **原样返回**，绝不猜、绝不破坏（调用方照旧能拿到图）。
 */

/** PNG 8 字节签名 */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** 1 米 = 39.3700787… 英寸 ⇒ 像素/米 = DPI ÷ 0.0254 */
const METERS_PER_INCH = 0.0254

/** 每米像素数（pHYs 的单位是"米"，这是 PNG 规范里唯一的公制单位） */
export function pixelsPerMeterFor(dpi: number): number {
  return Math.max(1, Math.round(dpi / METERS_PER_INCH))
}

/**
 * DPI ← 渲染倍率：页面基准 72 DPI（与 PDF/SVG 的 1 单位 = 1/72 英寸同口径），
 * 与应用导出对话框的说明一致（`2x ≈ 144 DPI`、`4x ≈ 288 DPI`）。
 */
export function dpiForScale(scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  return Math.round(72 * s)
}

/** 标准 CRC-32（PNG 用的 IEEE 802.3：初值/末值取反、反射） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** 计算 CRC-32（`crc32(new TextEncoder().encode('123456789')) === 0xcbf43926`，有断言守着） */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 是否是 PNG（签名逐字节比对） */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false
  return true
}

/** 读第 i 个块的 `长度/类型/数据起点`；越界或损坏返回 `null` */
function chunkAt(
  bytes: Uint8Array,
  offset: number,
): { type: string; len: number; dataStart: number; end: number } | null {
  if (offset + 8 > bytes.length) return null
  const len = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
  if (len < 0) return null
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
  const dataStart = offset + 8
  const end = dataStart + len + 4 // 数据 + CRC
  if (end > bytes.length) return null
  return { type, len, dataStart, end }
}

/** 组装一个块（长度 + 类型 + 数据 + CRC） */
function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const len = data.length
  out[0] = (len >>> 24) & 0xff
  out[1] = (len >>> 16) & 0xff
  out[2] = (len >>> 8) & 0xff
  out[3] = len & 0xff
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crc = crc32(out.subarray(4, 8 + data.length))
  out[8 + data.length] = (crc >>> 24) & 0xff
  out[9 + data.length] = (crc >>> 16) & 0xff
  out[10 + data.length] = (crc >>> 8) & 0xff
  out[11 + data.length] = crc & 0xff
  return out
}

/** 造一个 pHYs 块（4 字节 X 像素/米 + 4 字节 Y 像素/米 + 1 字节单位 1 = 米） */
function makePhys(dpi: number): Uint8Array {
  const ppm = pixelsPerMeterFor(dpi)
  const data = new Uint8Array(9)
  const put = (v: number, at: number): void => {
    data[at] = (v >>> 24) & 0xff
    data[at + 1] = (v >>> 16) & 0xff
    data[at + 2] = (v >>> 8) & 0xff
    data[at + 3] = v & 0xff
  }
  put(ppm, 0)
  put(ppm, 4)
  data[8] = 1 // 单位：米
  return makeChunk('pHYs', data)
}

/**
 * 写入/替换 pHYs（放在 `IHDR` 之后 —— PNG 规范允许 pHYs 出现在 IHDR 与 IDAT 之间）。
 *
 * 非 PNG / 结构损坏 ⇒ **原样返回**（调用方照旧有图）。已有 pHYs ⇒ 跳过旧的、写入新的
 * （等价于"替换"，但只搬一次字节）。
 */
export function insertPngPhys(png: Uint8Array, dpi: number): Uint8Array {
  if (!isPng(png)) return png
  const ihdr = chunkAt(png, 8)
  if (ihdr === null || ihdr.type !== 'IHDR') return png
  const parts: Uint8Array[] = [png.subarray(0, ihdr.end), makePhys(dpi)]
  let offset = ihdr.end
  for (;;) {
    const c = chunkAt(png, offset)
    if (c === null) break
    // 旧的 pHYs 直接丢掉（我们要写自己的那个）
    if (c.type !== 'pHYs') parts.push(png.subarray(offset, c.end))
    offset = c.end
    if (c.type === 'IEND') break
  }
  // 结构没读全（例如尾部被截断）⇒ 不冒险：原样返回，附加的字节由下面这段兜底拼回
  if (offset < png.length) parts.push(png.subarray(offset))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 读出 pHYs 声明的 DPI（没有/损坏 ⇒ `null`）——断言与诊断用 */
export function readPngPhys(png: Uint8Array): number | null {
  if (!isPng(png)) return null
  let offset = 8
  for (;;) {
    const c = chunkAt(png, offset)
    if (c === null) return null
    if (c.type === 'pHYs' && c.len >= 9) {
      const d = c.dataStart
      const ppm = (png[d] << 24) | (png[d + 1] << 16) | (png[d + 2] << 8) | png[d + 3]
      const unit = png[d + 8]
      if (unit !== 1 || ppm <= 0) return null
      return Math.round(ppm * METERS_PER_INCH)
    }
    if (c.type === 'IEND') return null
    offset = c.end
  }
}
