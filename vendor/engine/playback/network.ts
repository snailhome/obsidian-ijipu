/**
 * engine/playback/network.ts — 联网状态分类（纯函数，零 DOM 依赖，adj323）
 *
 * 试听采样音色库需要网络下载/缓存：联网分类决定「能否预缓存大库」。
 * UI 层从 navigator.connection / onLine 构造连接信息对象传入，本模块不直接读
 * 浏览器 API，便于单测。offline → 只能播放已缓存库。
 */

/** 联网分类 */
export type NetworkClass = 'offline' | 'ethernet' | 'wifi' | 'slow' | 'unknown'

/** 传入的连接信息（来自 navigator.connection / onLine），结构化便于测 */
export interface NetworkInfo {
  /** 是否在线（navigator.onLine） */
  online?: boolean
  /** 连接类型（navigator.connection.type：'wifi'|'ethernet'|'cellular'…） */
  type?: string
  /** 有效连接类型（navigator.connection.effectiveType：'4g'|'3g'…） */
  effectiveType?: string
  /** 估算连接速度（navigator.connection.downlink，Mbps） */
  downlink?: number
}

/** 连接信息 → 联网分类 */
export function classifyNetwork(info: NetworkInfo | null | undefined): NetworkClass {
  if (!info || info.online === false) return 'offline'
  // 具体无线类型优先
  const type = (info.type ?? '').toLowerCase()
  if (type === 'ethernet' || type === 'wired') return 'ethernet'
  if (type === 'wifi') return 'wifi'
  if (type === 'cellular') {
    return isSlow(info) ? 'slow' : 'wifi'
  }
  // 慢网探测（effectiveType 3g/2g 或 downlink 低）
  if (info.effectiveType && /^(2g|3g|slow)/.test(info.effectiveType)) return 'slow'
  if (isSlow(info)) return 'slow'
  // 未给出明确类型但在线 → 视为 wifi（可缓存）
  return info.type || info.effectiveType || info.downlink ? 'wifi' : 'unknown'
}

function isSlow(info: NetworkInfo): boolean {
  if (info.downlink !== undefined && Number.isFinite(info.downlink)) {
    return info.downlink < 4 // <4Mbps 视为慢
  }
  return false
}
