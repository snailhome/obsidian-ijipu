/**
 * overlayAssets.ts — 插件**代码块预览**的取图（adj965，方案 `docs/OVERLAY-PLAN.md`「OVL」EP-09 插件侧）
 *
 * ## 为什么需要它
 *
 * 引擎只收"已经解析好的 `{ href, w, h }`"（它零 DOM、读不到字节也量不到宽高）⇒
 * **每个宿主自己取图**。本插件有两条面：
 *   · 「打开完整应用」那一面（嵌入版）：应用在 iframe 里，走**宿主桥的 `readAsset` op**（已接）；
 *   · **代码块 / `.jps` 文件视图（本文件）**：面板自己就在 Obsidian 里，**直接读 vault** 即可
 *     —— 没有它，`图.png` / `[[图.png]]` 在代码块里**永远画不出来**（用户看到"设置了没用"）。
 *
 * ## 两条取值（与 `assetSource.assetPathOf` 的三类对应）
 *
 * | 写法 | 怎么解析 |
 * |---|---|
 * | `图.png` / `img/图.png` | **相对承载它的那份笔记**（`containerPath` / `filePath` 的目录） |
 * | `[[图片.png]]` | Obsidian 的**链接解析**（`metadataCache.getFirstLinkpathDest`，vault 全域、可跨目录） |
 * | `data:image/…` | 直通（仍要解码量宽高） |
 *
 * ## 安全与策略：**全部取自引擎**（与应用、与宿主桥同一份）
 *
 * 扩展名白名单（**拒 svg**）、单文件上限、路径归一、mime、降采样阈值（长边/重编码/质量）
 * 都在 `@ijipu/engine` 的 `overlayAsset.ts` 里 —— 三处（应用、桥、本文件）不允许各写一份。
 * 解析失败**不静默**：给一句能照做的 `Notice`（方案优化 7）。
 *
 * ## 缓存与重画
 *
 * 读盘 + 解码是异步的，而 `paint()` 是同步的 ⇒ 先按"没有图"画一版（谱面立刻可见），
 * 资源到位后回调重画一次。缓存键 = **两张图的原始取值 + 承载它的文件**（同一个谱面反复重画只读一次）。
 */
import { App, Notice } from 'obsidian'
import {
  ASSET_MAX_EDGE,
  ASSET_REENCODE_BYTES,
  ASSET_REENCODE_QUALITY,
  MAX_ASSET_BYTES,
  assetPathOf,
  isAllowedAssetPath,
  mimeOf,
  overlayAssetRefs,
  splitAssetPath,
  toBase64,
  writeJpsConfig,
  type PageConfig,
  type RenderAssets,
} from '@ijipu/engine'

/** 引擎要的一张图 */
export interface PluginAsset {
  href: string
  w: number
  h: number
}

/**
 * 纯逻辑（冒烟可断言，不碰 vault）：把配置里那个值翻译成"要读哪一份文件"。
 *
 * @param raw 配置原值（**未剥壳**——双链与相对路径在这里才分得开）
 * @param sourceVaultPath 承载它那份文件的库内路径（`containerPath` / `filePath` / 笔记路径）
 * @returns `{ kind:'link' }` = 交给 Obsidian 的链接解析；`{ kind:'rel' }` = 库内相对路径；`null` = 不合法
 */
export function pluginAssetTarget(
  raw: string,
  sourceVaultPath: string,
): { kind: 'link'; link: string; source: string } | { kind: 'rel'; path: string } | null {
  const { path, link } = assetPathOf(raw)
  if (path === '') return null
  if (link) return { kind: 'link', link: path, source: sourceVaultPath }
  // 只有目录没有文件名（`img/`）⇒ 早一步拒（否则会被当成"名叫 img 的文件"）
  if (path.endsWith('/')) return null
  // 任何位置的上跳段都拒（`../x.png`、`img/../x.png`、`img/..` —— 最后那种会把 `..` 落到"文件名"位上）
  if (path.split('/').includes('..')) return null
  const { dirs, name } = splitAssetPath(path)
  if (name === '') return null
  const dir = sourceVaultPath.split('/').slice(0, -1)
  return { kind: 'rel', path: [...dir, ...dirs, name].join('/') }
}

/**
 * 缓存键：**两张图的原始取值 + 承载它的文件**。
 * 配置或所在文件一变，键就变 ⇒ 不会把上一份谱的图用到这一份上。
 */
export function pluginAssetKey(cfg: PageConfig, sourceVaultPath: string): string {
  const r = overlayAssetRefs(cfg)
  return `${sourceVaultPath}\u0000${r.wm}\u0000${r.bg}`
}

/** 已解析好的资源（`{}` = 这份谱没有图 / 都解析失败；有键 = 已经处理过，不要再读盘） */
const cache = new Map<string, RenderAssets>()
/** 正在解析中的键（防抖：一次重画风暴里只读一轮） */
const inflight = new Set<string>()
/** 已经提示过的失败（同一句不重复弹 Notice，免得重画时刷屏） */
const notified = new Set<string>()

/**
 * 取这份配置的图片资源。
 *
 * · 命中缓存 ⇒ 直接返回（第一次调用会在后台发起解析，返回 `undefined` ⇒ 先按没图画一版）；
 * · 没命中 ⇒ 发起异步解析，**完成后回调 `onReady`**（调用方据此重画一次）。
 */
export function overlayAssetsFor(
  app: App,
  cfg: PageConfig,
  sourceVaultPath: string,
  onReady: () => void,
): RenderAssets | undefined {
  const refs = overlayAssetRefs(cfg)
  if (refs.wm === '' && refs.bg === '') return undefined
  const key = pluginAssetKey(cfg, sourceVaultPath)
  const hit = cache.get(key)
  if (hit !== undefined) return Object.keys(hit).length > 0 ? hit : undefined
  if (!inflight.has(key)) {
    inflight.add(key)
    void loadAssets(app, refs, sourceVaultPath)
      .then((assets) => {
        cache.set(key, assets)
      })
      .catch((err: unknown) => {
        // 解析整体失败（非单张图的问题）：也要说出来，不静默
        const msg = `水印/背景图读取失败：${err instanceof Error ? err.message : String(err)}`
        if (!notified.has(msg)) {
          notified.add(msg)
          new Notice(msg, 6000)
        }
        cache.set(key, {})
      })
      .finally(() => {
        inflight.delete(key)
        onReady()
      })
  }
  return undefined
}

/** 清缓存（换文件 / 外部改动时由面板调用；与应用的 `clearAssetCache` 同义） */
export function clearOverlayAssetCache(): void {
  cache.clear()
  notified.clear()
}

/**
 * adj965j（**用户 2026-10-15 实报**：「jps 代码块里背景用 `[[]]` 双链时，预览显示正常，
 * 但导出成 PNG 时没有背景」）：
 *
 * **可等待**的取图（导出用）——与 `overlayAssetsFor` 同一套缓存与解析，只是不"先画一版再补"，
 * 而是等到结果再返回。为什么导出必须另走这条路：导出的栅格化在**嵌入版应用**里做（插件没有 canvas），
 * 应用拿到的是**一段源码字符串**、它自己读不到 vault ⇒ 背景图在那边解析不出来 ⇒ 导出图里没有背景 ✗
 * （预览走的是本插件的渲染，所以预览一直是对的 ✓ ——"预览有、导出没有"就是这个错位）。
 */
export async function resolveOverlayAssetsFor(
  app: App,
  cfg: PageConfig,
  sourceVaultPath: string,
): Promise<RenderAssets> {
  const refs = overlayAssetRefs(cfg)
  if (refs.wm === '' && refs.bg === '') return {}
  const key = pluginAssetKey(cfg, sourceVaultPath)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  try {
    const assets = await loadAssets(app, refs, sourceVaultPath)
    cache.set(key, assets)
    return assets
  } catch {
    // 与面板那条不同：导出路径**不弹** Notice（失败就是"导出图里没背景"），但要给个空结果而不是抛错
    cache.set(key, {})
    return {}
  }
}

/**
 * adj965j：**把水印 / 背景图内联成 `data:` URI 写进那份（只用于导出的）源码**。
 *
 * 为什么这么做（而不是给桥加个 `assets` 参数）：导出的栅格化在应用里、应用读不到 vault，
 * 而引擎本来就支持 `data:` 取值（`assetSource` 的三类之一）⇒ 把宿主解析好的 data URI 写进
 * **临时源码**的 `# jps-config` 里，应用那边按老路子就能画出背景 ✓ ——
 * 一处改动（仅插件侧）同时覆盖"相对路径"与"`[[]]` 双链"两种写法 ✓。
 *
 * ⚠ 这份源码**只递给应用做导出**，绝不写回笔记（纯函数、不落盘）✓。
 */
export function inlineAssetsInSource(source: string, cfg: PageConfig, assets: RenderAssets): string {
  const wmHref = assets.wm?.href
  const bgHref = assets.bg?.href
  if (wmHref === undefined && bgHref === undefined) return source
  const next: PageConfig = { ...cfg }
  if (wmHref !== undefined) next.wmImage = wmHref
  if (bgHref !== undefined) next.bgImage = bgHref
  // `mode:'full'`：把整份生效配置写成一行（临时串，不落盘；差量模式会因"等于默认"丢掉一些键，
  // 虽然不影响渲染，但"导出用的源码"最好逐项写全，便于出问题时肉眼比对）
  return writeJpsConfig(source, next, { mode: 'full' })
}

/** 读 + 解码两张图（任一张失败只影响那一张：另一张照画，失败的那张弹一句说明） */
async function loadAssets(
  app: App,
  refs: { wm: string; bg: string },
  sourceVaultPath: string,
): Promise<RenderAssets> {
  const out: RenderAssets = {}
  const [wm, bg] = await Promise.all([
    refs.wm === '' ? Promise.resolve(null) : resolveOne(app, refs.wm, sourceVaultPath, '水印图'),
    refs.bg === '' ? Promise.resolve(null) : resolveOne(app, refs.bg, sourceVaultPath, '背景图'),
  ])
  if (wm !== null) out.wm = wm
  if (bg !== null) out.bg = bg
  return out
}

/** 解析一张图：定位 → 读字节 → 白名单/上限 → 解码量宽高（必要时降采样） */
async function resolveOne(
  app: App,
  raw: string,
  sourceVaultPath: string,
  who: string,
): Promise<PluginAsset | null> {
  const fail = (why: string): null => {
    const msg = `${who}：${why}`
    if (!notified.has(msg)) {
      notified.add(msg)
      new Notice(msg, 6000)
    }
    return null
  }
  const target = pluginAssetTarget(raw, sourceVaultPath)
  if (target === null) return fail('路径为空或不合法')
  if (!isAllowedAssetPath(target.kind === 'link' ? target.link : target.path)) {
    return fail(`只支持 png / jpg / jpeg / webp / gif / bmp 图片：${target.kind === 'link' ? target.link : target.path}`)
  }
  let bytes: ArrayBuffer
  try {
    if (target.kind === 'link') {
      const dest = app.metadataCache.getFirstLinkpathDest(target.link, target.source)
      if (dest === null) return fail(`未找到图片：[[${target.link}]]`)
      bytes = await app.vault.readBinary(dest)
    } else {
      if (!(await app.vault.adapter.exists(target.path))) return fail(`未找到图片：${target.path}`)
      bytes = await app.vault.adapter.readBinary(target.path)
    }
  } catch (e) {
    return fail(`读取失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return fail(`图片超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB 上限`)
  }
  try {
    return await decodeToAsset(new Uint8Array(bytes), mimeOf(target.kind === 'link' ? target.link : target.path))
  } catch (e) {
    return fail(`图片解码失败（可能不是有效图片）：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 解码 + 量宽高 +（必要时）降采样 —— 与应用 `store/assetDecode.ts` **同一套策略**，
 * 阈值与质量都取自引擎（两边不允许各写一份）。
 */
async function decodeToAsset(bytes: Uint8Array, mime: string): Promise<PluginAsset> {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
  try {
    // adj724b（社区审核）：用 Obsidian 全局 `createEl`，不碰 `document.createElement`
    const img = createEl('img')
    img.src = url
    await img.decode()
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    if (!(nw > 0 && nh > 0)) throw new Error('量不到图片尺寸')
    const long = Math.max(nw, nh)
    const scale = long > ASSET_MAX_EDGE ? ASSET_MAX_EDGE / long : 1
    const needResize = scale < 1
    if (!needResize && bytes.byteLength <= ASSET_REENCODE_BYTES) {
      // 小图（图标类）原样直通：不做无意义的重编码，免得把清晰的矢量感符号弄糊
      return { href: blobToDataUri(bytes, mime), w: nw, h: nh }
    }
    const w = Math.max(1, Math.round(nw * scale))
    const h = Math.max(1, Math.round(nh * scale))
    const canvas = createEl('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('拿不到 2D 画布上下文')
    ctx.drawImage(img, 0, 0, w, h)
    // WebP 支持透明；引擎/浏览器不支持该类型时 `toDataURL` 会按规范退回 PNG ✓
    const href = canvas.toDataURL('image/webp', ASSET_REENCODE_QUALITY)
    if (!href.startsWith('data:image/')) throw new Error('重编码失败')
    return { href, w, h }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 字节 → data URI（小图直通用；base64 用引擎那一份，三处同一套算法） */
function blobToDataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${toBase64(bytes)}`
}
