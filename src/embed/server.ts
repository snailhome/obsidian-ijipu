/**
 * embed/server.ts — 插件内的**本地 HTTP 服务**：把嵌入版 iJipu 提供给 iframe
 *
 * ## 为什么需要它（而不是 `app://` 或 `srcdoc`）
 *
 * | 方案 | 问题 |
 * |---|---|
 * | `<iframe src="app://…">` | 社区多次报"本地 HTML 在 iframe 里不再加载"（Obsidian 1.5.8 起），**不可靠** |
 * | `srcdoc` / `data:` / `blob:` | 都是 **opaque origin** ⇒ IndexedDB、localStorage、`postMessage` 目标校验全残废 |
 * | **本地 HTTP 服务** | origin 固定（`http://127.0.0.1:<port>`）⇒ 存储可用、postMessage 可靠、相对路径自然 |
 *
 * ## 安全
 *
 * - 只绑 `127.0.0.1`（不对外）；
 * - URL 带**一次性随机 token**，每次插件加载重新生成 ⇒ 同机其它页面猜不到；
 * - **只服务两样东西**：根路径的单文件 HTML、`WEBAPP_ASSETS` 里列出的路径
 *   （白名单查表，**不接受任意路径**，因此不存在目录穿越）；
 * - 其余一律 **204**（不暴露"文件是否存在"）。
 *
 * ## 与 `gen/webappAssets.ts` 的关系
 *
 * 网页产物由 `ijipu` 仓库构建并生成该文件（见 `scripts/embed-emit.mjs`），
 * 本服务只负责"按路径取出来回给浏览器"。
 */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WEBAPP_HTML, WEBAPP_ASSETS } from '../gen/webappAssets'

export interface EmbedServer {
  /** iframe 应加载的完整 URL（含 token） */
  readonly url: string
  /** 一次性令牌（桥用它校验消息来源；应用从 `location.pathname` 读出来回传） */
  readonly token: string
  /** 端口（调试用） */
  readonly port: number
  /** 关掉服务（插件卸载时调用） */
  dispose(): Promise<void>
}

/** 资产路径 → 二进制内容（启动时解一次，之后常驻内存） */
function decodeAssets(): Map<string, { mime: string; body: Buffer }> {
  const map = new Map<string, { mime: string; body: Buffer }>()
  for (const [rel, a] of Object.entries(WEBAPP_ASSETS)) {
    map.set(rel, { mime: a.mime, body: Buffer.from(a.b64, 'base64') })
  }
  return map
}

/**
 * 优先使用的端口。
 *
 * ## 为什么不再让系统随便分配（adj724b 修复）
 *
 * 用户实测：「嵌入版本的全局设置没有保存，ob 重启后恢复为默认」。
 * 根因：**`localStorage` 是按 origin 隔离的**，而 origin 含**端口**
 * （`http://127.0.0.1:<port>`）。此前用 `listen(0)` 每次随机分配端口 ⇒
 * 插件每次重载都是一个"新站点" ⇒ 上一轮的 `ijipu.*` 全局设置**读不回来**。
 *
 * 两处一起修（双保险）：
 *  ① 这里**优先固定端口**（被占才回退随机），让 origin 跨会话稳定；
 *  ② 应用的偏好/设置改走**宿主桥持久化**（`hostBridge` 的 `kvGet/kvSet`），
 *     这样即便端口被占、回退到别的端口，设置也不会丢。
 */
const PREFERRED_PORT = 47821

/**
 * 嵌入版应用运行时要按路径取的**非白名单资产**（adj727b）。
 *
 * `spessasynth/spessasynth_processor.min.js`：应用侧 `WORKLET_URL =
 * ${import.meta.env.BASE_URL}spessasynth/spessasynth_processor.min.js`
 * （`vite.config.embed.mjs` 的 `base: './'` ⇒ 实际请求 `/<token>/spessasynth/…`），
 * 试听与导出都靠 `audioWorklet.addModule(WORKLET_URL)` 起 SpessaSynth。
 * 而它**不在**嵌入版资产白名单里（`ijipu/scripts/embed-assets.mjs` 只带图标与示例谱，
 * 图上注释写着"网页版有、嵌入版不需要"的那一类只列了 PWA 图标与遗留 SVG）⇒
 * 服务对未知路径回 **204** ⇒ `addModule` 拿到空模块必然失败 ⇒
 * 用户看到的就是「音源加载失败，本次试听无声」/ 试听对话框里音源状态「加载失败」
 * （导入本身只写 IndexedDB，所以**导入看着是成功的**——这就是"能看到导入、但试听加载不了"）。
 */
export const EMBED_WORKLET_PATH = 'spessasynth/spessasynth_processor.min.js'

/**
 * 启动服务。**幂等**：同一个插件实例只起一个（调用方负责缓存返回的 Promise）。
 *
 * 端口策略：先试 `PREFERRED_PORT`（让 origin 稳定 ⇒ 浏览器侧的 `localStorage` 得以延续），
 * 被占用再退回系统分配（此时靠桥存储兜底）。
 *
 * @param opts.workletCode SpessaSynth worklet 的源码文本（插件已 `import … from
 *   '../spessasynth_processor.min.js'` 内联进 main.js）——由它顶上应用要的那条路径，
 *   **不额外增加体积**（那份代码本来就在 main.js 里）。
 */
export async function startEmbedServer(opts: { workletCode?: string } = {}): Promise<EmbedServer> {
  const token = randomBytes(16).toString('hex')
  const html = Buffer.from(WEBAPP_HTML, 'utf8')
  const assets = decodeAssets()
  const workletCode = opts.workletCode ?? ''

  const server: Server = createServer((req, res) => {
    const raw = String(req.url ?? '/')
    // 剥掉 token 前缀：URL 形如 /<token>/ 或 /<token>/icons/xx.png
    const parts = raw.split('?')[0].split('/').filter((s) => s !== '')
    if (parts[0] !== token) {
      // token 不对：一律 404，且不区分"存在与否"
      res.writeHead(404).end()
      return
    }
    /**
     * ⚠ **必须 `decodeURIComponent`**：资产里有**中文文件名**（`icons/菜单.png` 等），
     * 浏览器请求时会把非 ASCII 百分号编码（`/icons/%E8%8F%9C%E5%8D%95.png`）。
     * 用原始字符串查表 ⇒ **永远查不到**、图标全部 204（用户实测"嵌入版图标都未显示"）。
     */
    const rest = parts
      .slice(1)
      .map((s) => {
        try {
          return decodeURIComponent(s)
        } catch {
          return s // 非法百分号编码：保留原样（反正查不到）
        }
      })
      .join('/')

    if (rest === '' || rest === 'index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // 嵌入版内容随插件版本变化；不缓存可避免"更新插件后 iframe 仍是旧版"
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    // adj727b：应用要的 SpessaSynth worklet —— 用插件**已经内联**的那份顶上（见 EMBED_WORKLET_PATH 的说明）
    if (rest === EMBED_WORKLET_PATH) {
      if (!workletCode) {
        // 理论上不会发生（main.ts 一定会传）；真发生也要能一眼看出原因，而不是静默 204
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('worklet code missing（插件未把 SpessaSynth worklet 交给嵌入服务）')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(workletCode)
      return
    }

    // 只认白名单里的资产（`..`/绝对路径都不可能命中，因为表里只有构建期列出的相对路径）
    const hit = assets.get(rest)
    if (hit) {
      res.writeHead(200, { 'Content-Type': hit.mime, 'Cache-Control': 'no-store' })
      res.end(hit.body)
      return
    }
    res.writeHead(204).end()
  })

  /** 先试固定端口；`EADDRINUSE` 等失败再交给系统分配 */
  const listen = (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onErr = (e: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onOk)
        reject(e)
      }
      const onOk = (): void => {
        server.removeListener('error', onErr)
        resolve()
      }
      server.once('error', onErr)
      server.once('listening', onOk)
      server.listen(port, '127.0.0.1')
    })

  let usedPreferred = true
  try {
    await listen(PREFERRED_PORT)
  } catch {
    // 端口被占（例如开了两个 Obsidian 实例）⇒ 回退随机；此时靠桥存储保证设置不丢
    usedPreferred = false
    await listen(0)
  }

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  if (!usedPreferred) {
    console.warn(`[iJipu] 固定端口 ${PREFERRED_PORT} 被占用，本次改用 ${port}（设置仍走宿主桥持久化，不受影响）`)
  }

  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    token,
    port,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
