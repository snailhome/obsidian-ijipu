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
 * 启动服务。**幂等**：同一个插件实例只起一个（调用方负责缓存返回的 Promise）。
 *
 * 端口用 `0` 交给系统分配（避免固定端口被占），随后读出真实端口。
 */
export async function startEmbedServer(): Promise<EmbedServer> {
  const token = randomBytes(16).toString('hex')
  const html = Buffer.from(WEBAPP_HTML, 'utf8')
  const assets = decodeAssets()

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

    // 只认白名单里的资产（`..`/绝对路径都不可能命中，因为表里只有构建期列出的相对路径）
    const hit = assets.get(rest)
    if (hit) {
      res.writeHead(200, { 'Content-Type': hit.mime, 'Cache-Control': 'no-store' })
      res.end(hit.body)
      return
    }
    res.writeHead(204).end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

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
