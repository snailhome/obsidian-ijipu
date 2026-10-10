/**
 * engine/highlight/palette.ts — **源码高亮与错误提示的配色常量**（唯一来源）
 *
 * 用户 2026-10 要求（清单 B5）：「源码高亮、错误信息显示提示等共性的功能都可以独立到引擎层面」，
 * 且「应用端也应同样处理」。
 *
 * 为什么放引擎而不是各自写死：应用侧这套色值定义在 `src/styles/theme.css` 的 `--jp-hl-*`
 * （深/浅两套），Obsidian 插件必须**写静态 CSS**（`styles.css` 的 `.ijipu-jps-*`）——两处都是字面量，
 * 一旦应用改配色，插件**不会跟着变**（本轮 adj752 就是人手抄过去的）。
 * 于是把"值的真源"放引擎，两端各写自己的 CSS，但**用冒烟断言把 CSS 与这份常量钉在一起**
 * （哪边漂了，测试立刻红）——这正是本项目"元规则②：能自动化的一律做成机器闸门"的落法。
 */

/** 高亮类别（与 `JpsTokenClass` 的可着色子集一一对应） */
export type JpsPaletteClass = 'line-header' | 'note' | 'barline' | 'lyric' | 'comment' | 'pagebreak' | 'decoration'

/** 一套主题下的高亮配色 */
export type JpsHighlightPalette = Record<JpsPaletteClass, string>

/**
 * 高亮配色（深/浅两套）——真源。
 * 与应用 `src/styles/theme.css` 的 `--jp-hl-*`、插件 `styles.css` 的 `.ijipu-jps-*` 必须一致（有断言守）。
 */
export const JPS_HIGHLIGHT_COLORS: { dark: JpsHighlightPalette; light: JpsHighlightPalette } = {
  dark: {
    'line-header': '#00f0ff',
    note: '#ffb86c',
    barline: '#6272a4',
    lyric: '#7dd6a8',
    comment: '#6a7bb8',
    pagebreak: '#ff79c6',
    // 装饰（渐强/渐弱/连音线记号等）跟分页同色，与应用既有观感一致
    decoration: '#ff79c6',
  },
  light: {
    'line-header': '#0891a6',
    note: '#b35900',
    barline: '#5a6a9e',
    lyric: '#2f8f5f',
    comment: '#6a7bb8',
    pagebreak: '#c73d8f',
    decoration: '#c73d8f',
  },
}

/** 无着色（普通文本）的底色/前景（应用 `--jp-hl-plain`） */
export const JPS_PLAIN_COLORS: { dark: string; light: string } = { dark: '#e8ecf8', light: '#1c2540' }

/**
 * 问题（错误/告警）提示色 —— 真源。
 * `lineBg`/`blockBg` 是半透明底（整行 / 块级外框内），`outline` 是块级外框线色。
 */
export const JPS_PROBLEM_COLORS = {
  error: { lineBg: 'rgba(255, 93, 108, 0.13)', blockBg: 'rgba(255, 93, 108, 0.14)', outlineVar: 'var(--text-error, #e5534b)' },
  warning: { lineBg: 'rgba(255, 176, 32, 0.14)', blockBg: 'rgba(255, 176, 32, 0.14)', outlineVar: 'var(--text-warning, #d29922)' },
} as const

/** 类别 → 应用 CSS 变量名（供应用侧断言/生成用） */
export const JPS_HL_CSS_VAR: Record<JpsPaletteClass, string> = {
  'line-header': '--jp-hl-line-header',
  note: '--jp-hl-note',
  barline: '--jp-hl-barline',
  lyric: '--jp-hl-lyric',
  comment: '--jp-hl-comment',
  pagebreak: '--jp-hl-pagebreak',
  decoration: '--jp-hl-pagebreak',
}
