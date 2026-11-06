/**
 * engine/scoreMeta.ts — 乐谱发布信息（`meta.json` / `.jps.meta.json`）的唯一模型
 *
 * 为什么放在引擎：应用「乐谱信息」、导出乐谱包、曲库站点构建、本地乐谱库工具
 * 读写的都是同一份字段。以前四处各写一套类型/校验，结果应用新加了
 * `rights` / `CC` / `overlay`，工具和站点还在用旧字段，用户导入后看不到。
 *
 * 这里只做**纯数据**：解析、归一化、校验、默认值；不碰文件系统、不碰 React/DOM。
 * 各端只负责自己的 IO（应用写边车、工具写 meta.json、站点读构建产物）。
 */
export type ScoreMetaLicense = 'PD' | 'ORIGINAL' | 'AUTHORIZED' | 'CC'
export type ScoreArrangementLicense = 'NONE' | 'PD' | 'ORIGINAL' | 'AUTHORIZED' | 'CC'
export type PdReason = 'author-death' | 'public-domain-dedication' | 'government' | 'cc0' | 'other'

export const SCORE_META_LICENSES: readonly ScoreMetaLicense[] = ['PD', 'ORIGINAL', 'AUTHORIZED', 'CC']
export const SCORE_META_FORMAT = 'ijipu-score-meta'
export const SCORE_PACKAGE_FORMAT = 'ijipu-score-package'

/** 权利分层：旋律（license）→ 编配 → 记谱/排版 */
export interface ScoreRights {
  work?: ScoreMetaLicense
  arrangement?: ScoreArrangementLicense
  /** 记谱/排版许可（站点默认 CC BY-NC-SA 4.0，也允许作者另注） */
  notation?: string
  pdReason?: PdReason
  rightsHolder?: string
  evidence?: string
  territory?: string
  commercial?: boolean
  ccLicense?: string
  attribution?: string
  sourceUrl?: string
  expires?: string
}

export interface ScoreMetaAsset {
  path: string
  role: 'background' | 'watermark' | 'cover'
}

/** 应用里水印/背景的**渲染设置**（不只是图片文件）；导入乐谱库后要按这些值画 */
export interface OverlayMeta {
  bg?: {
    enabled: boolean
    scale: number
    rotate: number
    opacity: number
    offsetX: number
    offsetY: number
  }
  wm?: {
    enabled: boolean
    type: 'text' | 'image'
    text?: string
    size: number
    scale: number
    rotate: number
    opacity: number
    repeat: boolean
    repeatGap: number
    offsetX: number
    offsetY: number
  }
}

export type VideoPlatform = 'douyin' | 'xiaohongshu' | 'wechat' | 'other'

export interface VideoLink {
  platform: VideoPlatform
  url: string
}

/** 从 URL 的域名识别平台；识别不了归 other */
export function videoPlatformOf(url: string): VideoPlatform {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'douyin.com' || host.endsWith('.douyin.com') || host.endsWith('.iesdouyin.com')) return 'douyin'
    if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host === 'xhslink.com' || host.endsWith('.xhslink.com')) {
      return 'xiaohongshu'
    }
    if (host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com') || host.endsWith('.weixin110.com')) {
      return 'wechat'
    }
  } catch {
    /* 不是合法 URL */
  }
  return 'other'
}

/** 一份乐谱的发布信息；应用边车、乐谱包、站点卡片、工具编辑共用 */
export interface ScoreMetaDoc {
  format?: typeof SCORE_META_FORMAT | typeof SCORE_PACKAGE_FORMAT
  version?: number
  slug: string
  short: string
  title: string
  /** 副标题：其余 B 行去空格后用「，」连接 */
  subtitle?: string
  composer: string
  license: ScoreMetaLicense
  source: string
  /** 单条视频链接（旧字段；新数据优先用 videos） */
  videoUrl?: string
  /** 多条视频链接；工具自动识别抖音/小红书/微信 */
  videos?: VideoLink[]
  tags: string[]
  difficulty?: number
  order?: number
  excerpt?: string
  note?: string
  card?: 'paper' | 'ink' | 'brand' | 'minimal'
  watermark?: 'corner' | 'tile' | 'none'
  cover?: string
  file?: string
  assets?: ScoreMetaAsset[]
  overlay?: OverlayMeta
  rights?: ScoreRights
  status?: 'draft' | 'published' | 'retired'
  retiredReason?: string
  retiredAt?: string
  publishedAt?: string
  updatedAt?: string
  /** 乐谱包运输信息（应用导出时写；发布信息不含） */
  exportedAt?: string
  exportedBy?: string
  contentHash?: string
  importedAt?: string
  sourceZip?: string
}

const LICENSES = new Set<string>(SCORE_META_LICENSES)
const ARRANGEMENTS = new Set<string>(['NONE', ...SCORE_META_LICENSES])
const PD_REASONS = new Set<string>([
  'author-death',
  'public-domain-dedication',
  'government',
  'cc0',
  'other',
])

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function normalizeRights(raw: unknown): ScoreRights | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const r: ScoreRights = {}
  if (typeof o.work === 'string' && LICENSES.has(o.work)) r.work = o.work as ScoreMetaLicense
  if (typeof o.arrangement === 'string' && ARRANGEMENTS.has(o.arrangement)) {
    r.arrangement = o.arrangement as ScoreArrangementLicense
  }
  for (const key of ['notation', 'rightsHolder', 'evidence', 'territory', 'ccLicense', 'attribution', 'sourceUrl', 'expires'] as const) {
    if (typeof o[key] === 'string') r[key] = o[key]
  }
  if (typeof o.pdReason === 'string' && PD_REASONS.has(o.pdReason)) r.pdReason = o.pdReason as PdReason
  if (typeof o.commercial === 'boolean') r.commercial = o.commercial
  return Object.keys(r).length > 0 ? r : undefined
}

function normalizeOverlay(raw: unknown): OverlayMeta | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
  const out: OverlayMeta = {}
  if (typeof o.bg === 'object' && o.bg !== null && !Array.isArray(o.bg)) {
    const b = o.bg as Record<string, unknown>
    out.bg = {
      enabled: b.enabled !== false,
      scale: num(b.scale, 100),
      rotate: num(b.rotate, 0),
      opacity: num(b.opacity, 100),
      offsetX: num(b.offsetX, 0),
      offsetY: num(b.offsetY, 0),
    }
  }
  if (typeof o.wm === 'object' && o.wm !== null && !Array.isArray(o.wm)) {
    const w = o.wm as Record<string, unknown>
    out.wm = {
      enabled: w.enabled !== false,
      type: w.type === 'image' ? 'image' : 'text',
      ...(typeof w.text === 'string' ? { text: w.text } : {}),
      size: num(w.size, 22),
      scale: num(w.scale, 100),
      rotate: num(w.rotate, -45),
      opacity: num(w.opacity, 15),
      repeat: w.repeat !== false,
      repeatGap: num(w.repeatGap, 300),
      offsetX: num(w.offsetX, 0),
      offsetY: num(w.offsetY, 0),
    }
  }
  return out.bg !== undefined || out.wm !== undefined ? out : undefined
}

function normalizeAssets(raw: unknown): ScoreMetaAsset[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ScoreMetaAsset[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const a = item as Record<string, unknown>
    if (typeof a.path !== 'string' || a.path === '') continue
    if (a.role !== 'background' && a.role !== 'watermark' && a.role !== 'cover') continue
    out.push({ path: a.path, role: a.role })
  }
  return out.length > 0 ? out : undefined
}

function normalizeVideos(raw: unknown): VideoLink[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: VideoLink[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    let url = ''
    let platform: VideoPlatform | undefined
    if (typeof item === 'string') {
      url = item
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const v = item as Record<string, unknown>
      if (typeof v.url === 'string') url = v.url
      if (v.platform === 'douyin' || v.platform === 'xiaohongshu' || v.platform === 'wechat' || v.platform === 'other') {
        platform = v.platform
      }
    }
    url = url.trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    out.push({ platform: platform ?? videoPlatformOf(url), url })
  }
  return out.length > 0 ? out : undefined
}

/** 把任意 JSON 归一化成 ScoreMetaDoc；连 slug/title 都没有则返回 null（视为不是 meta） */
export function normalizeScoreMeta(raw: unknown): ScoreMetaDoc | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.slug !== 'string' || typeof o.title !== 'string') return null
  const license = typeof o.license === 'string' && LICENSES.has(o.license) ? (o.license as ScoreMetaLicense) : 'ORIGINAL'
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : []
  const doc: ScoreMetaDoc = {
    format: o.format === SCORE_PACKAGE_FORMAT ? SCORE_PACKAGE_FORMAT : SCORE_META_FORMAT,
    version: 1,
    slug: o.slug,
    short: str(o.short),
    title: o.title,
    composer: str(o.composer),
    license,
    source: str(o.source),
    tags,
  }
  if (typeof o.difficulty === 'number') doc.difficulty = o.difficulty
  if (typeof o.order === 'number') doc.order = o.order
  for (const key of ['subtitle', 'excerpt', 'note', 'cover', 'file', 'videoUrl', 'retiredReason', 'retiredAt', 'publishedAt', 'updatedAt', 'exportedAt', 'exportedBy', 'contentHash', 'importedAt', 'sourceZip'] as const) {
    if (typeof o[key] === 'string') doc[key] = o[key]
  }
  if (o.card === 'paper' || o.card === 'ink' || o.card === 'brand' || o.card === 'minimal') doc.card = o.card
  if (o.watermark === 'corner' || o.watermark === 'tile' || o.watermark === 'none') doc.watermark = o.watermark
  if (o.status === 'draft' || o.status === 'published' || o.status === 'retired') doc.status = o.status
  const assets = normalizeAssets(o.assets)
  if (assets) doc.assets = assets
  const videos = normalizeVideos(o.videos)
  if (videos) doc.videos = videos
  const overlay = normalizeOverlay(o.overlay)
  if (overlay) doc.overlay = overlay
  const rights = normalizeRights(o.rights)
  if (rights) doc.rights = rights
  return doc
}

export function parseScoreMeta(text: string): ScoreMetaDoc | null {
  try {
    return normalizeScoreMeta(JSON.parse(text))
  } catch {
    return null
  }
}

/** 表单校验；返回中文错误（空串 = 通过）。站点/工具可在此之后再查文件是否存在 */
export function validateScoreMeta(meta: ScoreMetaDoc): string {
  if (!/^[a-z0-9-]+$/.test(meta.slug)) return 'slug 只能用小写字母、数字、连字符'
  if (!/^[a-z0-9]{3,6}$/.test(meta.short)) return 'short 必须是 3-6 位小写字母或数字'
  if (meta.title.trim() === '') return '标题不能为空'
  if (meta.composer.trim() === '') return '作曲 / 作词不能为空'
  if (meta.source.trim() === '') return '来源不能为空（公版写「传统」/ 授权写授权方）'
  if (meta.videoUrl !== undefined && meta.videoUrl.trim() !== '' && !/^https?:\/\//i.test(meta.videoUrl)) {
    return '视频链接必须是 http(s) 地址'
  }
  for (const v of meta.videos ?? []) {
    if (!/^https?:\/\//i.test(v.url)) return '视频链接必须是 http(s) 地址'
  }
  if (!Array.isArray(meta.tags) || meta.tags.some((t) => t.trim() === '')) return 'tags 不能有空项'
  if (meta.difficulty !== undefined && (!Number.isInteger(meta.difficulty) || meta.difficulty < 1 || meta.difficulty > 5)) {
    return '难度只能是 1-5 的整数'
  }
  if (meta.license === 'CC') {
    if ((meta.rights?.ccLicense ?? '').trim() === '') return '许可为 CC 时必须填写 CC 协议（如 CC-BY-NC-SA-4.0）'
    if ((meta.rights?.attribution ?? '').trim() === '' && (meta.rights?.sourceUrl ?? '').trim() === '') {
      return '许可为 CC 时必须填写署名或来源链接'
    }
  }
  if (meta.rights?.work !== undefined && meta.rights.work !== meta.license) {
    return 'rights.work 必须与顶层 license 一致'
  }
  return ''
}

/** 标题/文件名 → 可用的 slug/short 默认值（中文会退到时间戳） */
export function slugifyMeta(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s !== '' ? s : `score-${Date.now().toString(36)}`
}

export function shortifyMeta(slug: string): string {
  const letters = slug.replace(/[^a-z]/g, '')
  if (letters.length >= 3) return letters.slice(0, 6)
  return `pkg${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 1) || 'x'}`
}

export function todayMeta(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function defaultScoreMeta(titles: string[], authors: string[], fileName: string): ScoreMetaDoc {
  const title = (titles[0] ?? '').trim() || fileName.replace(/\.(jps|md|txt)$/i, '') || '未命名'
  const composer = (authors[0] ?? '').trim() || '佚名'
  const slug = slugifyMeta(fileName.replace(/\.(jps|md|txt)$/i, '') || title)
  return {
    format: SCORE_META_FORMAT,
    version: 1,
    slug,
    short: shortifyMeta(slug),
    title,
    composer,
    license: 'ORIGINAL',
    source: '原创',
    tags: [],
    difficulty: undefined,
    excerpt: '',
    note: '',
    rights: {
      work: 'ORIGINAL',
      arrangement: 'ORIGINAL',
      notation: 'CC-BY-NC-SA-4.0',
      commercial: false,
    },
  }
}
