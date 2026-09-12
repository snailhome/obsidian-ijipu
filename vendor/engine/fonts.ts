/**
 * engine/fonts.ts — 字体策略：**跨机尽量有 + 适合简谱 + 保证有字体可用**
 *
 * 三条原则（新增/调整字体项时按此界定）：
 *  1. **跨机尽量有**：只选 Windows / macOS / iOS / Android / Linux 里至少一到两个平台内置的字体，
 *     并覆盖 CJK 常见系统字体（微软雅黑、苹方 PingFang、Noto Sans/Serif CJK、思源黑体…）。
 *  2. **适合简谱**：音符数字用无衬线（黑体类）更醒目；歌词/说明用无衬线保持可读；宋楷作为可选风格。
 *  3. **保证有字体可用**：每个候选都是**完整 font-family 栈**，末尾必须落到通用族
 *     （`sans-serif` / `serif` / `monospace`）——绝不出现"裸字体名"（换机器就掉到浏览器默认字体，
 *     笔画粗细/字宽全变、简谱数字对位崩坏）。
 *
 * 历史问题（本次修复）：谱面字体下拉里存的是裸名（`Microsoft YaHei` / `SimHei` / `KaiTi` …），
 * macOS/Linux/手机缺字体时静默回退。现在：新值一律用下面的栈；**旧文件里的裸名在读取时经
 * `normalizeFontStack()` 自动补全 fallback**，无需用户手动改谱。
 */
import type { PageConfig } from './types'

/** 默认系统无衬线栈（标题/副标题/描述头/说明/歌词/音符数字共用；不附带字体文件） */
export const SYS_FONT =
  "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', sans-serif"

/** 通用族（用于判断一个 font-family 值是否已经有兜底） */
const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'cursive', 'fantasy']

/** 衬线类关键词（决定补 serif 还是 sans-serif） */
const SERIF_HINT = /(simsun|songti|song|stsong|kaiti|stkaiti|kai|fangsong|serif|georgia|times|garamond|book)/i
/** 等宽类关键词（决定补 monospace） */
const MONO_HINT = /(mono|consolas|courier|menlo|code|terminal)/i

/** 字体项（label 给界面，value 为完整栈） */
export interface FontOption {
  label: string
  value: string
}

/**
 * 谱面字体候选（6 项；每项都是含通用族的完整栈）。
 * 覆盖场景：默认无衬线（数字醒目、通用）、黑体、宋体、楷体、西文衬线、等宽（数字等距对齐）。
 */
export const SCORE_FONT_OPTIONS: FontOption[] = [
  { label: '默认（系统无衬线，推荐）', value: SYS_FONT },
  {
    label: '黑体（数字醒目）',
    value: "'SimHei', 'Heiti SC', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif",
  },
  {
    label: '宋体（衬线，正文感）',
    value: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', 'Source Han Serif SC', 'AR PL UMing CN', serif",
  },
  {
    label: '楷体（手写感）',
    value: "'Kaiti SC', 'KaiTi', 'STKaiti', 'Noto Serif CJK SC', 'AR PL UKai CN', serif",
  },
  {
    label: '西文衬线（Georgia）',
    value: "Georgia, 'Times New Roman', 'Noto Serif', 'Liberation Serif', serif",
  },
  {
    label: '等宽（数字等距）',
    value: "Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
  },
]

/**
 * 编辑器字体候选（4 项，**必须等宽**；且刻意排除带编程连字的字体
 * ——Fira Code / JetBrains Mono / Cascadia Code 等，连字会让 `|:`、`||` 字形变宽，
 * 导致高亮层与 textarea 逐字符错位，见 adj163/adj173）。
 */
export const EDITOR_FONT_OPTIONS: FontOption[] = [
  { label: 'Consolas（默认）', value: "Consolas, 'Cascadia Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace" },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
  { label: 'Menlo / DejaVu', value: "Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', monospace" },
  { label: '等宽（系统默认）', value: 'monospace' },
]

/** 编辑器字号范围（px） */
export const EDITOR_FONT_SIZE_RANGE: [number, number] = [10, 26]

/**
 * 规范化 font-family 值（**旧文件兼容的关键**）：
 *  - 空值 → 默认系统栈；
 *  - 已有通用族 → 原样返回（只在必要时给裸多词名加引号）；
 *  - 无通用族 → 按关键词判断补 `serif` / `monospace` / `sans-serif`，并给裸的多词名加单引号。
 */
export function normalizeFontStack(value: string | null | undefined): string {
  const raw = String(value ?? '').trim()
  if (raw === '') return SYS_FONT
  const families = raw.split(',').map((f) => f.trim()).filter((f) => f !== '')
  if (families.length === 0) return SYS_FONT
  const hasGeneric = families.some((f) => GENERIC_FAMILIES.includes(f.toLowerCase().replace(/['"]/g, '')))
  const quoted = families.map((f) => (/^['"].*['"]$/.test(f) ? f : /[\s]/.test(f) ? `'${f}'` : f))
  if (hasGeneric) return quoted.join(', ')
  const head = quoted[0].toLowerCase()
  const generic = MONO_HINT.test(head) ? 'monospace' : SERIF_HINT.test(head) ? 'serif' : 'sans-serif'
  return [...quoted, generic].join(', ')
}

/** 谱面字体字段（供统一替换/覆盖用） */
export const SCORE_FONT_FIELDS = ['biaoti_font', 'fubiaoti_font', 'miaoshu_font', 'notes_font', 'geci_font', 'shuzi_font'] as const

/* ------------------------------------------------------------------ *
 * L1 用户个性：编辑器偏好（**不随谱保存**）
 * 分层模型见 docs/SETTINGS-AUDIT.md：
 *   L0 代码默认 < L1 用户个性 < L1.5 笔记级 < L2 谱面级(# jps-config) < L3 会话级
 * ------------------------------------------------------------------ */

/** 编辑器偏好（用户个性，存本机/插件缓存；历史上曾被误写进谱面 # jps-config，本次修复移除） */
export interface EditorPrefs {
  /** 编辑器字体（等宽，含 fallback 链） */
  font: string
  /** 编辑器字号（px，见 EDITOR_FONT_SIZE_RANGE） */
  fontSize: number
}

export const defaultEditorPrefs: EditorPrefs = { font: EDITOR_FONT_OPTIONS[0].value, fontSize: 14 }

/** 把编辑器字号夹到合法范围 */
export function clampEditorFontSize(v: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : defaultEditorPrefs.fontSize
  return Math.min(EDITOR_FONT_SIZE_RANGE[1], Math.max(EDITOR_FONT_SIZE_RANGE[0], n))
}

/**
 * L1 用户个性：**用我的字体覆盖谱面字体**（默认关）。
 * 跨机缺字体时的兜底手段：开启后，标题/副标题/描述头/说明/歌词/数字六项字体统一用 `font`
 * （只换字体族，不动字号与其它排版参数）；谱面文件本身不改写。
 */
export interface FontOverride {
  enabled: boolean
  font: string
}

export const defaultFontOverride: FontOverride = { enabled: false, font: SYS_FONT }

/** 应用字体覆盖（enabled=false 时原样返回，不产生新对象） */
export function applyFontOverride(cfg: PageConfig, override: FontOverride | null | undefined): PageConfig {
  if (!override?.enabled) return cfg
  const font = normalizeFontStack(override.font)
  const next = { ...cfg } as PageConfig
  for (const f of SCORE_FONT_FIELDS) (next as unknown as Record<string, unknown>)[f] = font
  return next
}
