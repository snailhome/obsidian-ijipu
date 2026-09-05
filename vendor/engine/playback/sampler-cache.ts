/**
 * engine/playback/sampler-cache.ts — 采样音色库离线缓存接口（adj323，纯接口零 DOM）
 *
 * 浏览器（IndexedDB）与桌面 Tauri（文件系统）各提供一种实现，由 src 层注入。
 * SamplerBackend 通过该接口「优先读缓存 → 未命中再联网下载」，使已缓存库可离线试听。
 */
export interface SamplerCache {
  /** 读缓存文本（soundfont JS 文本），不存在返回 null */
  loadText(libId: string): Promise<string | null>
  /** 写缓存文本 */
  saveText(libId: string, text: string): Promise<void>
  /** 是否已缓存 */
  has(libId: string): Promise<boolean>
  /** 删除缓存 */
  remove(libId: string): Promise<void>
}
