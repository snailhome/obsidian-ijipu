/**
 * rpc.ts — Obsidian ⇄ 嵌入版 iJipu 的 **postMessage RPC**（方案 B / B2）
 *
 * 口径见 `docs/CLI-AND-COMMAND-PLAN.md` §B 与 `docs/OBSIDIAN-API.md`：
 *  · **纯 TS 能力**（解析/格式化/校验/导出 SVG）留在插件内直调引擎（B1 的 `api.ts`）✓，
 *    **不必**跨 iframe ✓；
 *  · 本文件只负责"**要用应用才有的能力**"（位图/PDF、音色库试听）的**通道与安全边界** ✓；
 *  · **默认关闭**（用户裁决 ③）：总开关关着时一律回 `-32001 未启用` ✓；
 *  · **只允许 vault 内相对路径**（用户裁决 ③）：路径参数一律做校验，禁绝对路径与 `..` ✓。
 *
 * 安全边界（逐条写死，不靠"约定"）：
 *  1. `event.source` 必须是**我们的 iframe 窗口**（否则直接忽略 ✓）；
 *  2. 消息结构必须是 `{ id, method, params? }`，`method` 必须在**白名单**里 ✓；
 *  3. `params` 逐项校验（类型/长度/枚举 ✓）—— 不做"尽力解析" ✗；
 *  4. 回包只发给**同一个 iframe 窗口**（不用 `'*'` 之外的通道 ✓）；
 *  5. 未知方法 ⇒ `-32601`；内部异常 ⇒ `-32603`；未启用 ⇒ `-32001`（JSON-RPC 风格 ✓）。
 */
import { Platform, type App } from 'obsidian'
import { WEBAPP_META } from '../gen/webappAssets'

/** B2 的**最小面**：先只放这三个；其余（png/pdf/midi/playback）留 B3 ✓ */
export const RPC_METHODS = ['engine.version', 'capabilities', 'render.svg'] as const
export type RpcMethod = (typeof RPC_METHODS)[number]

/** JSON-RPC 风格错误码（对外承诺，调用方按它分支 ✓） */
export const RPC_ERROR = {
  disabled: -32001,
  notFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export type RpcRequest = { id: number | string; method: string; params?: unknown }
export type RpcResponse =
  | { id: number | string; ok: true; result: unknown }
  | { id: number | string; ok: false; error: { code: number; message: string } }

/** 路径校验：**只允许 vault 内相对路径**（用户裁决 ③） */
export function isSafeVaultPath(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 512) return false
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  if (p.includes('..')) return false
  if (p.includes('\0')) return false
  return true
}

type Deps = {
  app: App
  /** 总开关（设置里控制；**默认 false**） */
  isEnabled: () => boolean
  /** 当前嵌入版 iframe 的窗口（用于校验来源 + 回包） */
  getIframeWindow: () => Window | null
  /** 渲染 SVG（复用插件内 B1 的纯 TS 能力，**不重复实现** ✓） */
  renderSvg: (source: string, pageConfig?: Record<string, unknown>) => { ok: boolean; svgs: string[]; error?: string }
  pluginVersion: string
}

export type EmbedRpc = { handle: (ev: MessageEvent) => void; methods: readonly string[] }

/** 造一个 RPC 处理器。**纯逻辑**（依赖注入）⇒ 冒烟里可直接构造假事件断言 ✓ */
export function createEmbedRpc(deps: Deps): EmbedRpc {
  const reply = (win: Window, res: RpcResponse): void => {
    win.postMessage({ __ijipuRpc: 1, ...res }, '*')
  }

  const handle = (ev: MessageEvent): void => {
    const data = ev.data as { __ijipuRpcRequest?: number; id?: number | string; method?: string; params?: unknown } | null
    if (data === null || typeof data !== 'object' || data.__ijipuRpcRequest !== 1) return
    const win = deps.getIframeWindow()
    // ① 来源校验：不是我们的 iframe 就**彻底忽略**（不回包，避免探测 ✓）
    if (win === null || ev.source !== win) return
    const id = data.id ?? 0
    const method = String(data.method ?? '')
    const fail = (code: number, message: string): void => reply(win, { id, ok: false, error: { code, message } })
    // ② 总开关（默认关）
    if (!deps.isEnabled()) return fail(RPC_ERROR.disabled, '嵌入版 RPC 未启用（设置 → iJipu → 开发者）')
    // ③ 白名单
    if (!(RPC_METHODS as readonly string[]).includes(method)) return fail(RPC_ERROR.notFound, `未知方法：${method}`)
    try {
      if (method === 'engine.version') {
        reply(win, { id, ok: true, result: { plugin: deps.pluginVersion, embedded: WEBAPP_META.appVersion, engine: WEBAPP_META.appVersion } })
        return
      }
      if (method === 'capabilities') {
        reply(win, {
          id,
          ok: true,
          result: {
            platform: Platform.isDesktopApp ? 'desktop' : Platform.isMobileApp ? 'mobile' : 'unknown',
            svg: true,
            // 诚实报告：位图/PDF/试听要应用侧实现（B3），先报 false，不骗调用方 ✓
            raster: false,
            pdf: false,
            midi: false,
            audio: false,
            methods: [...RPC_METHODS],
          },
        })
        return
      }
      // render.svg
      const params = (data.params ?? {}) as { source?: unknown; pageConfig?: unknown }
      if (typeof params.source !== 'string' || params.source.length > 500_000) {
        return fail(RPC_ERROR.invalidParams, 'params.source 必须是字符串（≤500000 字符）')
      }
      const cfg =
        params.pageConfig === undefined || params.pageConfig === null
          ? undefined
          : typeof params.pageConfig === 'object'
            ? (params.pageConfig as Record<string, unknown>)
            : undefined
      if (params.pageConfig !== undefined && cfg === undefined) {
        return fail(RPC_ERROR.invalidParams, 'params.pageConfig 必须是对象')
      }
      const r = deps.renderSvg(params.source, cfg)
      if (!r.ok) return fail(RPC_ERROR.internal, r.error ?? '渲染失败')
      reply(win, { id, ok: true, result: { svgs: r.svgs } })
    } catch (e) {
      fail(RPC_ERROR.internal, String(e))
    }
  }

  return { handle, methods: RPC_METHODS }
}
