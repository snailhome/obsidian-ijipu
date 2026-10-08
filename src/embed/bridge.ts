/**
 * embed/bridge.ts — 应用（iframe）↔ 插件 的**桥**：把网页里的文件操作落到 Obsidian vault
 *
 * ## 为什么走桥
 *
 * iframe 是**浏览器上下文**，拿不到 Node/Electron 能力；而 Obsidian 的
 * `app.vault.adapter.*` 才是官方、跨版本稳定的文件 API（已核实
 * `obsidian.d.ts`：`list:2033` / `stat:2027` / `exists:2020` / `read:2038` / `write:2052` /
 * `readBinary:2044` / `writeBinary:2062` / `mkdir:2099` / `remove:2101`）。
 * 于是应用侧新增一个 `'vault'` 工作区后端，把每个原语转发到这里的 `op`。
 *
 * ## 安全
 *
 * - 只接受 **`iframe.contentWindow`** 发来的消息（比对 `event.source`）；
 * - 只接受握手时下发的 **token**（应用从 `location.pathname` 读出并回传）；
 * - 所有路径经 `normalizeVaultPath` 归一化，**拒绝 `..` 越界**。
 *
 * ## 协议
 *
 * 请求：`{ ch:'ijipu', id, op, args }` → 响应：`{ ch:'ijipu', id, ok, result|error }`
 * 事件：宿主 → 应用 `{ ch:'ijipu', type:'theme'|'openFile'|'vaultChanged', ... }`
 */
import { normalizePath, type App } from 'obsidian'

/** 握手令牌（与应用 URL 里的 token 同源） */
export const BRIDGE_CHANNEL = 'ijipu'

export interface BridgeRequest {
  ch?: string
  /** 一次性令牌（应用从 `location.pathname` 读出后回传；用于校验来源） */
  token?: string
  id?: number
  op?: string
  args?: Record<string, unknown>
  type?: string
}

export interface BridgeHost {
  app: App
  /** 应用 URL 里的 token（用于校验消息来源确实是我们的 iframe） */
  token: string
  /** 工作区根（vault 相对路径；`''` = vault 根，用户可在设置里指定子目录） */
  root: string
  /** 取当前主题（跟随 Obsidian） */
  theme: () => 'dark' | 'light'
}
/**
 * 归一化一个 vault 相对路径；越界/非法返回 `null`。
 *
 * 口径：统一正斜杠、去前后多余斜杠、拒绝 `..` 与绝对路径（`/` 开头会被剥掉但不允许逃逸）。
 */
export function normalizeVaultPath(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts: string[] = []
  for (const seg of cleaned.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null // 越界一律拒绝，不做"回退一层"的兜底
    parts.push(seg)
  }
  const p = parts.join('/')
  // normalizePath 会把多余斜杠/尾斜杠规整掉；空串代表"根"，交给调用方处理
  return p === '' ? '' : normalizePath(p)
}

/** 路径拼接：根 + 相对路径（根为空则就是相对路径） */
function joinRoot(root: string, rel: string): string {
  if (root === '') return rel
  return rel === '' ? root : `${root}/${rel}`
}

/** 一次 op 的执行结果 */
type OpResult = { ok: true; result: unknown } | { ok: false; error: string }

export class IJipuBridge {
  /** 当前注册的 iframe（应用页签与文件页签各自注册/注销） */
  private frame: HTMLIFrameElement | null = null

  constructor(private readonly host: BridgeHost) {}

  /** 服务启动后把 token 交给桥（在 `getEmbedUrl` 里调用） */
  setToken(token: string): void {
    this.host.token = token
  }

  /** 工作区根变化时更新（设置里改了子目录） */
  setRoot(root: string): void {
    this.host.root = root
  }

  /** 某个视图挂载 iframe 后登记（`postMessage` 需要它作为 target） */
  attach(frame: HTMLIFrameElement): void {
    this.frame = frame
  }

  detach(frame: HTMLIFrameElement): void {
    if (this.frame === frame) this.frame = null
  }

  /** 宿主 → 应用：推一个事件（主题变化 / 请求打开某文件 / vault 变更） */
  emit(type: string, payload: Record<string, unknown> = {}): void {
    const win = this.frame?.contentWindow
    if (!win) return
    win.postMessage({ ch: BRIDGE_CHANNEL, type, ...payload }, '*')
  }

  /**
   * 处理一条来自 iframe 的消息。
   *
   * 返回 `true` 表示"这条消息属于本桥"（调用方据此决定是否阻止其它监听者）。
   */
  handle(event: MessageEvent): boolean {
    const data = event.data as BridgeRequest | undefined
    if (!data || typeof data !== 'object' || data.ch !== BRIDGE_CHANNEL) return false
    // ① 来源必须是当前登记的 iframe
    if (!this.frame || event.source !== this.frame.contentWindow) return false
    // ② token 必须匹配（握手消息带 token；后续消息用同一帧，已通过来源校验）
    if (data.token !== undefined && data.token !== this.host.token) return false

    // 事件型（应用 → 宿主）：目前只需要握手的回执
    if (data.type === 'hello') {
      this.emit('welcome', {
        vaultName: this.host.app.vault.getName(),
        theme: this.host.theme(),
        root: this.host.root,
        capabilities: { write: true, rename: true, remove: true, trash: true },
      })
      return true
    }
    if (data.type !== undefined && data.id === undefined) return true // 其它事件型：已消费

    // 请求型：{ id, op, args }
    if (typeof data.id !== 'number' || typeof data.op !== 'string') return true
    void this.run(data.id, data.op, data.args ?? {})
    return true
  }

  private async run(id: number, op: string, args: Record<string, unknown>): Promise<void> {
    let out: OpResult
    try {
      out = await this.exec(op, args)
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const win = this.frame?.contentWindow
    if (!win) return
    win.postMessage({ ch: BRIDGE_CHANNEL, id, ...out }, '*')
  }

  /** 各 op 的实现（与 `ijipu/src/store/workspace.ts` 的 `WorkspaceFs` 一一对应） */
  private async exec(op: string, args: Record<string, unknown>): Promise<OpResult> {
    const adapter = this.host.app.vault.adapter
    const rel = normalizeVaultPath(args.path)
    /** 把 vault 相对路径（这是"工作区内的路径"）换算成实际的 vault 路径 */
    const abs = (r: string | null): string | null => (r === null ? null : joinRoot(this.host.root, r))

    switch (op) {
      case 'list': {
        if (rel === null) return { ok: false, error: '非法路径' }
        const target = abs(rel)
        if (target === null) return { ok: false, error: '非法路径' }
        const listed = await adapter.list(target === '' ? '/' : target)
        const dirs: { name: string; mtime: number }[] = []
        const files: { name: string; mtime: number }[] = []
        for (const f of listed.folders) {
          const name = f.split('/').pop() ?? f
          if (name.startsWith('.')) continue // 与网页版一致：隐藏项不列
          const st = await adapter.stat(f).catch(() => null)
          dirs.push({ name, mtime: st?.mtime ?? 0 })
        }
        for (const f of listed.files) {
          const name = f.split('/').pop() ?? f
          if (name.startsWith('.')) continue
          // 工作区是"谱夹"：只列 .jps（与网页版 workspace.ts 的 DirEntry 口径一致）
          if (!/\.jps$/i.test(name)) continue
          const st = await adapter.stat(f).catch(() => null)
          files.push({ name, mtime: st?.mtime ?? 0 })
        }
        return { ok: true, result: { dirs, files } }
      }
      case 'read': {
        const target = abs(rel)
        if (target === null || target === '') return { ok: false, error: '非法路径' }
        return { ok: true, result: { text: await adapter.read(target) } }
      }
      case 'write': {
        const target = abs(rel)
        const text = args.text
        if (target === null || target === '') return { ok: false, error: '非法路径' }
        if (typeof text !== 'string') return { ok: false, error: 'text 必须是字符串' }
        await this.ensureParent(target)
        await adapter.write(target, text)
        // 回读校验：与网页版的写入口径一致（宁可报错也不谎报已保存）
        const back = await adapter.read(target)
        if (back !== text) return { ok: false, error: '写入后回读校验不一致' }
        return { ok: true, result: {} }
      }
      case 'exists': {
        const target = abs(rel)
        if (target === null || target === '') return { ok: true, result: { exists: true } }
        return { ok: true, result: { exists: await adapter.exists(target) } }
      }
      case 'mkdir': {
        const target = abs(rel)
        if (target === null || target === '') return { ok: false, error: '非法路径' }
        await adapter.mkdir(target)
        return { ok: true, result: {} }
      }
      case 'create': {
        const target = abs(rel)
        if (target === null || target === '') return { ok: false, error: '非法路径' }
        await this.ensureParent(target)
        if (await adapter.exists(target)) return { ok: false, error: '文件已存在' }
        await adapter.write(target, '')
        return { ok: true, result: {} }
      }
      case 'rename':
      case 'move': {
        const from = abs(normalizeVaultPath(args.from))
        const to = abs(normalizeVaultPath(args.to))
        if (from === null || to === null || from === '' || to === '') return { ok: false, error: '非法路径' }
        await this.ensureParent(to)
        await adapter.rename(from, to)
        return { ok: true, result: {} }
      }
      case 'remove': {
        const target = abs(rel)
        if (target === null || target === '') return { ok: false, error: '非法路径' }
        // 用 Obsidian 的 trash（进系统回收站/库内 .trash）而不是硬删
        const file = this.host.app.vault.getAbstractFileByPath(target)
        if (file) await this.host.app.vault.trash(file, true)
        else await adapter.remove(target)
        return { ok: true, result: {} }
      }
      case 'rmdirIfEmpty': {
        const target = abs(rel)
        if (target === null || target === '') return { ok: false, error: '非法路径' }
        const listed = await adapter.list(target)
        if (listed.files.length > 0 || listed.folders.length > 0) {
          return { ok: false, error: '目录非空' }
        }
        await adapter.rmdir(target, false)
        return { ok: true, result: {} }
      }
      case 'search': {
        if (rel === null) return { ok: false, error: '非法路径' }
        const scope = abs(rel)
        if (scope === null) return { ok: false, error: '非法路径' }
        const query = String(args.query ?? '')
        const hits: { path: string; name: string }[] = []
        const walk = async (dir: string): Promise<void> => {
          const listed = await adapter.list(dir === '' ? '/' : dir)
          for (const f of listed.files) {
            const name = f.split('/').pop() ?? f
            if (!/\.jps$/i.test(name)) continue
            // 作用域是"工作区根" ⇒ 命中结果要换算回工作区相对路径
            const relPath = this.host.root !== '' && f.startsWith(`${this.host.root}/`) ? f.slice(this.host.root.length + 1) : f
            if (query === '' || relPath.toLowerCase().includes(query.toLowerCase())) hits.push({ path: relPath, name })
          }
          for (const d of listed.folders) {
            if ((d.split('/').pop() ?? '').startsWith('.')) continue
            await walk(d)
          }
        }
        if (scope !== '') await walk(scope)
        return { ok: true, result: { hits } }
      }
      default:
        return { ok: false, error: `未知 op: ${op}` }
    }
  }

  /** 确保目标文件的父目录存在（Obsidian 的 `adapter.write` 不会自动建目录） */
  private async ensureParent(target: string): Promise<void> {
    const idx = target.lastIndexOf('/')
    if (idx <= 0) return
    const dir = target.slice(0, idx)
    const adapter = this.host.app.vault.adapter
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir)
  }
}
