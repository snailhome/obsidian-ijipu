/**
 * embed/frame.ts — iframe 的**共用构造与生命周期**（应用页签与文件页签都用它）
 *
 * 两个页签的差别只在"打开后要不要指定一个文件"，其余（URL、sandbox、桥登记、
 * 消息监听、销毁）完全一致 ⇒ 收敛到这里，避免两处各写一遍再漂移。
 */
import type { App } from 'obsidian'

/**
 * 创建受信任的 iframe 元素。
 *
 * `sandbox` 同时给 `allow-same-origin` 与 `allow-scripts`：内容是我们**自托管**在
 * `http://127.0.0.1:<port>` 的本地页面（不是第三方站点），
 * 而 `same-origin` 是 IndexedDB（草稿/音源缓存）与 `postMessage` 目标校验的前提。
 */
export function createEmbedFrame(app: App, parent: HTMLElement, url: string): HTMLIFrameElement {
  void app
  return parent.createEl('iframe', {
    cls: 'ijipu-web-frame',
    attr: {
      src: url,
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
    },
  })
}

/** iframe 尺寸自适应（Obsidian 页签会随侧栏宽度变化） */
export function fitEmbedFrame(frame: HTMLIFrameElement): void {
  frame.style.width = '100%'
  frame.style.height = '100%'
  frame.style.border = '0'
  frame.style.display = 'block'
}

/**
 * 从服务 URL 里取出 token（形如 `http://127.0.0.1:<port>/<token>/`）。
 * 仅用于调试与断言；正常运行由 `EmbedServer.token` 直接提供。
 */
export function tokenFromEmbedUrl(url: string): string | null {
  const m = /^https?:\/\/127\.0\.0\.1:\d+\/([0-9a-f]+)\/?$/.exec(url)
  return m ? m[1] : null
}
