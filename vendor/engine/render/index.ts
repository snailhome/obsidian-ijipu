/**
 * engine/render/index.ts — SVG 渲染
 *
 * M1a 阶段：单页 SVG 生成。
 *  - 页面骨架：A4/A5 白纸 + 边距；
 *  - 元数据：标题居中、副标题、作者居右、调号/拍号/节拍（左上）；
 *  - 音符：数字（衬线粗体）+ 高低音点/变音/附点/增时线/减时线/休止符/节奏符；
 *  - 小节线：| || |: :| :|:（含隐藏线 |/ |* 不绘制）；
 *  - 光标联动契约：音符 <text data-notepos="page_voice_group_index">。
 *    adj374：一个音符的**多个视觉元素**（数字主体 + 各条增时线）共用同一 data-notepos——
 *    消费方需要「整音高亮/命中」时用 querySelectorAll，需要「取代表元素（滚动/定位）」时用 querySelector（首个=数字）。
 *
 * TODO(M1b)：多页分页输出
 * TODO(M1c)：歌词 <text data-cipos>
 * TODO(M7)：跳房子/连音线/装饰符号/多声部
 */
import type { PageConfig, PlacedBarline, PlacedBarNumber, PlacedDynamic, PlacedLyric, PlacedSegmentBracket, PlacedSlur, PlacedToken, ScoreLayout, ScorePage, VoiceBlock } from '../types'
import { tokenDuration } from '../duration'
import { metaAnchorOf, metaAnchorPt, metaAuthorRowY, metaCornerOffsets } from '../layout/metaAnchors'
import {
  DOT_R,
  DOT_R_DOT,
  DIGIT_HEIGHT_RATIO,
  LAYER_GAP,
  INNER_GAP,
  BEAM_H,
  BARLINE_DOT_R,
  BARLINE_DOT_OFF,
  barlineGeometry,
  COMMENT_FONT_RATIO,
  NOTE_COMMENT_FONT_RATIO,
  NOTE_COMMENT_RAISE,
  DESC_RATIO,
  VOLTA_BAR_GAP,
  VOLTA_RAISE,
  DYN_HALF_H,
  SLUR_W,
  VOLTA_COMMENT_FONT_RATIO,
  TUPLET_NUM_RATIO,
  TUPLET_NUM_W_RATIO,
  TUPLET_LABEL_PAD,
  GRACE_SIZE_RATIO,
  GRACE_SLOT_RATIO,
  GRACE_SLOT_RATIO_MULTI,
  GRACE_BEAM_GAP,
  GRACE_LINE_W,
  // adj625：方框小节序号的几何（与布局端同源）
  BAR_NUMBER_BOTTOM_GAP,
  BAR_NUMBER_STROKE,
  barNumberFontSize,
  barNumberBoxH,
  barNumberBoxW,
  noteScaleOf,
  DIGIT_BOTTOM,
  digitBottomY,
  lowDotY,
  octaveDotY,
  octaveTopY,
} from '../layout/spacing'
import { tempoLabel } from '../parser/parser'
import { parseInstrumentRef } from '../playback/instruments'
import { graceAtTail, slideGlyphInk } from '../layout/spaceLayout'
// adj458：波音/滑音改用**用户提供的矢量修饰符**（生成文件，见 scripts/gen-modifier-glyphs.mjs）
import { MODIFIER_GLYPHS, glyphMarkup, type ModifierGlyphKey } from './modifierGlyphs'

// ============================================================
// 工具
// ============================================================

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 由 LayoutId 生成稳定 notepos 标识 */
function noteposId(p: { page: number; voice: number; group: number; index: number }): string {
  return `${p.page}_${p.voice}_${p.group}_${p.index}`
}

// ============================================================
// 字体常量
// ============================================================

const FONT_CN = "'Microsoft YaHei', 'SimHei', sans-serif"

/** 花体/手写体字体（adj：力度标记、反复记号 Fine/D.C./D.S. 用它渲染；
 *  只用系统/通用手写体（Windows 内置 Segoe Script，其他平台回退 cursive），保证跨平台可见；
 *  不用 Bravura 等需安装的音乐符号字体，避免缺字方块） */
const FONT_SCRIPT = "'Segoe Script', 'Brush Script MT', 'Script MT', 'Lucida Handwriting', 'Segoe Print', cursive"

/** 力度/速度修饰符编码（& 开头，写在音符后）：音符上方以斜体显示编码
 *  （adj：pp/p/mp/mf/f/ff/fff/sf/fp/sfp/rit，与 &.jps 语法一致） */
const DYN_MARKS = new Set(['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'fp', 'sfp', 'rit'])

/** adj334：音符上方单字修饰符（吐音/打音/叠音）——在音符正上方居中显示一个粗体字形。
 *  吐音 &tu → 粗体 T；吐音 &ku → 粗体 K；打音 &da → 粗体 扌；叠音 &die → 粗体 又。
 *  除 die（横向缩 0.75，adj335）外，其余走无缩放居中粗体分支。 */
const ABOVE_GLYPH: Record<string, string> = {
  tu: 'T',
  ku: 'K',
  da: '扌',
  die: '又',
}

/** adj338：音符上方**修饰层**专属层间留白（px）——比共享 LAYER_GAP(2) 更小，
 *  让多修饰符堆叠更紧凑；仅用于音符上方符号循环（`symY = aboveTop - SYM_LAYER_GAP*s`），
 *  不影响减时线/连音线等（仍用 LAYER_GAP）。 */
const SYM_LAYER_GAP = 1

/**
 * 13px 元数据字形宽（px）——用于调式/节拍 = 号对齐（adj42）。
 * 其余 ASCII 按 7.62、CJK 按 13 兜底估算。
 *
 * adj629v：表格里除 `♩` 外都是 YaHei 的 GDI 实测值，与浏览器实测一致
 * （Blink `measureText`：`1` 7.62 / ` ` 3.85 / `=` 9.64）；**`♩` 是例外**——
 * YaHei 没有 U+2669，浏览器回退到 CJK 字体、占宽 **一个全角 = 13px**
 * （GDI 当年量到的 7.0 在浏览器渲染路径上不成立）。不改这个数，节拍行的
 * `=` 会**比调式行右偏 6px**（估算宽 7.0 vs 实际 13.0 的差）。
 */
const META_GLYPH_W: Record<string, number> = {
  ' ': 3.85,
  '=': 9.64,
  '♩': 13.0,
  '0': 7.62, '1': 7.62, '2': 7.62, '3': 7.62, '4': 7.62,
  '5': 7.62, '6': 7.62, '7': 7.62, '8': 7.62, '9': 7.62,
  'A': 9.15, 'B': 8.16, 'C': 8.7, 'D': 9.9, 'E': 7.15,
  'F': 6.91, 'G': 9.67, '#': 8.3, '$': 7.62,
  // 升降号占宽：等宽字体下 ♯/♭ 与半角字符同宽，取半角基准 7.62（adj192 用于 1.2×占宽）
  '♯': 7.62, '♭': 7.62,
}

/** 估算 13px 元数据文本宽（px） */
function metaTextW(s: string): number {
  let w = 0
  for (const ch of s) {
    w += META_GLYPH_W[ch] ?? (ch.charCodeAt(0) > 127 ? 13 : 7.62)
  }
  return w
}

/** 按可用宽将一行说明拆成多子行（字符级估算宽、随字号缩放；adj153 内容不超边距） */
function wrapNotesLine(line: string, availW: number, size: number): string[] {
  const scale = size / 13
  const subs: string[] = []
  let cur = ''
  let curW = 0
  for (const ch of line) {
    const w = (META_GLYPH_W[ch] ?? (ch.charCodeAt(0) > 127 ? 13 : 7.62)) * scale
    if (cur && curW + w > availW) {
      subs.push(cur)
      cur = ''
      curW = 0
    }
    cur += ch
    curW += w
  }
  if (cur) subs.push(cur)
  return subs.length ? subs : ['']
}

/** 音符字体：直接使用页面设置中的字体名（adj105：原 a/b/c 字形改为字体名） */
function noteFont(style: string): string {
  return style || "'Microsoft YaHei', 'SimHei', 'Segoe UI', sans-serif"
}

// ============================================================
// 页面骨架与元数据（描述头）
// ============================================================

/**
 * 描述头默认布局（adj16 锚点语义；adj629u 调整为**贴角**）：
 *  - 主标题：上边中点（top-center），字顶贴区域上沿；副标题/乐器紧接其下
 *  - 作者：右下角（bottom-right，从底部往上：末行贴区域下沿）
 *  - 调式+拍号：左下角（bottom-left），节拍在其下（末行贴区域下沿）
 *  - metaPos 可覆盖任意元素位置（key: title/subtitle_i/author_i/keyline/tempo）
 *    值为相对各自锚点的偏移（adj16）：区域宽/高变化时元素跟随锚点。
 */
type RenderFontMeta = {
  /** `1 = ` 实测宽（决定调号字母/角标左缘，adj199） */
  w1eq?: number
  /** `♯` 实测宽（角标，adj199） */
  wAcc?: number
  /** `1 ` 实测宽（adj629v：调式行 = 号左缘基准） */
  w1sp?: number
  /** `♩` 实测宽（adj629v：节拍行 = 号左缘基准） */
  wTempo?: number
}
/**
 * adj627c（用户要求）：把**调名**画成与描述头 `1 = Ab` 完全同一套效果——
 * 字母 + **左上角 ♯/♭ 角标**（角标字号 = 字母 3/4、上移 0.35×字号、字母右移 0.9×角标宽腾位）。
 *
 * 描述头调式行（`data-meta="keyline"`）与临时转调记号（`转1=Ab`）**共用本函数**，两处预览因此长得一模一样；
 * 此前转调记号是整串文字，`Ab` 的降号会显示成普通字母 `b`，与描述头的 `A♭` 不是一回事。
 *
 * @param prefix   调名前的固定文字（`1 = ` / `转1=`）
 * @param prefixW  前缀实际占宽（px）：角标左缘 = `x + prefixW`
 * @param accW     角标字形实测宽（浏览器 measureText 传入）；缺省按角标字号估算
 */
function drawKeyName(o: {
  x: number
  y: number
  size: number
  font: string
  /** 调名原文（如 `Ab` / `$B` / `F#`；非法时原样当字母画） */
  keyRaw: string
  prefix: string
  prefixW: number
  accW?: number
  /** 写在 `<text>` 开头的额外属性（如 `data-meta="keyline" `） */
  headAttrs?: string
  /** 写在 `font-family` 与 `fill` 之间的额外属性（如 ` text-anchor="start"`） */
  midAttrs?: string
  /** 写在 `<text>` 末尾的额外属性（如 ` data-keychange="转1=Ab"`） */
  tailAttrs?: string
}): { parts: string[]; letter: string; accShift: number } {
  const m = /^([#$b]?)([A-G])([#$b]?)$/.exec((o.keyRaw ?? '').trim())
  const letter = m ? m[2] : (o.keyRaw ?? '').trim() // 调号字母（无效时原样）
  const acc = m ? m[1] || m[3] : '' // 升降号（# 或 $/b）
  const symb = acc ? (acc === '#' ? '♯' : '♭') : '' // 升降号字形（$ 与 b 等价 → ♭）
  const symSize = symb ? o.size * (3 / 4) : 0 // 角标字号 = 字母 3/4
  const symW = symb ? (o.accW ?? symSize) : 0
  const accShift = symb ? 0.9 * symW : 0 // 字母右移 = 0.9×角标实际宽（角标略叠入字母约 0.1×占宽，更贴）
  const parts: string[] = []
  if (letter) {
    const body = symb ? `<tspan dx="${r1n(accShift)}">${xmlEsc(letter)}</tspan>` : xmlEsc(letter)
    parts.push(
      `<text ${o.headAttrs ?? ''}x="${o.x}" y="${o.y}" font-size="${o.size}" font-family="${o.font}"${o.midAttrs ?? ''} fill="#1b1b1b"${o.tailAttrs ?? ''}>${o.prefix}${body}</text>`,
    )
    if (symb) {
      // 字母右移后其左上角即原字母左缘：x=原字母左缘，y 抬升至字母中线；下沿与中线对齐
      parts.push(
        `<text x="${r1n(o.x + o.prefixW)}" y="${r1n(o.y - 0.35 * o.size)}" font-size="${r1n(symSize)}" font-family="${o.font}" fill="#1b1b1b">${symb}</text>`,
      )
    }
  }
  return { parts, letter, accShift }
}

function renderMeta(page: ScorePage, config: PageConfig, opts?: RenderFontMeta): string {
  const parts: string[] = []
  const { width } = page
  const posOf = (key: string, defOff: { x: number; y: number }) => {
    // 绝对 = 锚点 + 偏移；无 metaPos 用默认偏移（等价旧默认公式）
    const anchor = metaAnchorPt(metaAnchorOf(key), width, config)
    const p = config.metaPos?.[key]
    return p ? { x: anchor.x + p.x, y: anchor.y + p.y } : { x: anchor.x + defOff.x, y: anchor.y + defOff.y }
  }

  // ---- 调式 + 拍号（左下锚，同排）：调号文本 + 拍号分数（数字上下正对，中间横线） ----
  // adj42：调式行 = 号两侧加空格（如 "1 = C"），与下方节拍行的 = 号垂直对齐
  // adj174/175：调号支持升降号在前（#F/$B/bE）或在后（F#/B$/Eb），降号 $ 与 b 等价；
  // 预览时 ♯/♭ 作角标画在调号字母左侧、中线以上，字号为调号的一半
  const mFont = config.miaoshu_font
  const mSize = config.miaoshu_size
  // adj194：b/# 为字母左上角角标——字号=字母 2/3、下沿对齐字母中线；有 b/# 时字母右移
  // 1.2×角标占宽给角标让位，确保不重叠（前一轮 1/3 角标起点正好压在字母左缘而重叠）。
  const KEY_SHIFT = 6
  const keyRaw = (page.meta.key ?? '').trim()
  const scale0 = mSize / 13
  // 按字体实际宽度摆放角标/字母：w1eq(1= 宽)/wAcc(♯ 宽) 由 PreviewPane 用 canvas.measureText 实测传入，
  // 消除中/英文字体下 ♯ 宽度差异导致的间距忽大忽小或重叠；无实测（导出等场景）回退按字号估算（全角）
  const W1eq = opts?.w1eq ?? metaTextW('1 = ') * scale0 // "1 = " 实际宽（决定字母/角标左缘）
  // ---- adj629u：描述头默认布局 = **贴角**（左栏贴左下角、右栏贴右下角、居中栏贴区域上沿） ----
  // 用户报「空设置下没有按『左靠左下角 / 右靠右下角 / 居中靠中上』排列」：
  // 默认值原是与字号脱钩的硬编码（标题 30.6 = 旧字号 36×0.85，调式 -44 / 节拍 -12 / 作者 -16-18n），
  // 空设置下三块恰好都落在区域中部。公式集中在 layout/metaAnchors.ts（与 smoke 共用一份）。
  const hasKeyRow = Boolean(keyRaw || page.meta.meter)
  const hasTempoRow = Boolean(page.meta.tempoNum || page.meta.tempoText || page.meta.tempo)
  const corner = metaCornerOffsets({
    mSize,
    biaotiSize: config.biaoti_size,
    hasKeyRow,
    hasTempoRow,
  })
  const keyDefY = corner.keyline
  const tempoDefY = corner.tempo
  const keyPos = posOf('keyline', { x: KEY_SHIFT, y: keyDefY })
  const keyName = drawKeyName({
    x: keyPos.x,
    y: keyPos.y,
    size: mSize,
    font: mFont,
    keyRaw,
    prefix: '1 = ',
    prefixW: W1eq,
    accW: opts?.wAcc,
    headAttrs: 'data-meta="keyline" ',
  })
  const keyLetter = keyName.letter // 调号字母（拍号定位要用）
  const accShift = keyName.accShift // 字母右移量（拍号定位要用）
  if (keyLetter) {
    parts.push(...keyName.parts)
  }
  if (page.meta.meter) {
    const pos = posOf('keyline', { x: KEY_SHIFT, y: keyDefY })
    // 拍号左缘 = "1 = " 宽（优先实测 W1eq）+ 字母区（字母右移 accShift + 字母宽）+ 一个空格 + 10 间距
    const meterX = pos.x + W1eq + accShift + metaTextW(keyLetter) * scale0 + metaTextW(' ') * scale0 + 10
    parts.push(renderMeterMeta(page.meta.meter, meterX, pos.y, mFont, mSize))
  }
  // ---- 节拍（左下锚，keyline 下方；数字 ♩=N + 文字，多条 J 时并排） ----
  // adj42：= 号后加空格（"♩= 80"），并与调式行 = 号垂直对齐：
  // 调式行 "=" 位于 x + w("1 ")，节拍行 "=" 位于 x' + w("♩")，令 x' = x + w("1 ") - w("♩")
  // 仅当节拍行含 "♩=" 前缀时对齐；纯文字节拍（无 = 号）保持与调式行左缘对齐
  // adj629v（用户要求「描述头 D 的 = 号和 J 的 = 号保持对齐」）：调号带升降号时字母是在
  // **字符串内部**用 `<tspan dx>` 右移的（adj190），调式行的 "=" 不再跟着右移；而节拍行还留着
  // adj181 时代的 `+ accShift`（那是"整行右移给角标让位"的写法）⇒ 带升降号时 J 行的 "=" 恰好
  // 右偏一个角标宽（`D: Bb` 实测 8.8px）。去掉 accShift，并优先用 PreviewPane 实测的
  // "1 " / "♩" 宽（与 adj199 的角标实测同一口径），消除估算宽与实际字体的差。
  const tempoNum = page.meta.tempoNum
  const tempoText = page.meta.tempoText
  const legacyTempo = page.meta.tempo
  const hasTempoEq = Boolean(tempoNum) || (legacyTempo !== null && Number.isFinite(Number(legacyTempo)) && legacyTempo.trim() !== '')
  const w1sp = opts?.w1sp ?? metaTextW('1 ') * scale0
  const wTempo = opts?.wTempo ?? metaTextW('♩') * scale0
  const tempoEqShift = keyLetter && hasTempoEq ? w1sp - wTempo : 0
  if (tempoNum || tempoText) {
    // adj：与调式行间距加大（偏移 -20 → -12），防止拍号分母与节拍行重叠；
    // adj176：与调号同步右移 KEY_SHIFT（adj629v：不再叠加 accShift，= 号与调式行严格对齐）
    const pos = posOf('tempo', { x: tempoEqShift + KEY_SHIFT, y: tempoDefY })
    parts.push(
      `<text data-meta="tempo" x="${pos.x}" y="${pos.y}" font-size="${mSize}" font-family="${mFont}" fill="#1b1b1b">${xmlEsc(tempoLabel(tempoNum ?? undefined, tempoText ?? undefined))}</text>`,
    )
  } else if (page.meta.tempo) {
    // 兼容旧数据（无 tempoNum/tempoText 字段）：数字或原文
    const n = Number(page.meta.tempo)
    const tempoText =
      Number.isFinite(n) && page.meta.tempo.trim() !== ''
        ? `♩= ${n}`
        : xmlEsc(page.meta.tempo.replace(/\s*\n\s*/g, '　'))
    const pos = posOf('tempo', { x: tempoEqShift + KEY_SHIFT, y: tempoDefY })
    parts.push(
      `<text data-meta="tempo" x="${pos.x}" y="${pos.y}" font-size="${mSize}" font-family="${mFont}" fill="#1b1b1b">${tempoText}</text>`,
    )
  }

  // ---- 主标题（上居中锚；默认偏移 = 字顶贴区域上沿 + 视觉余量，adj32/adj629u） ----
  const titleDefY = corner.title
  if (page.meta.titles[0]) {
    const pos = posOf('title', { x: 0, y: titleDefY })
    parts.push(
      `<text data-meta="title" x="${pos.x}" y="${pos.y}" text-anchor="middle" font-size="${config.biaoti_size}" font-family="${config.biaoti_font}" font-weight="bold" fill="#1b1b1b">${xmlEsc(page.meta.titles[0])}</text>`,
    )
  }
  // ---- 副标题（上居中锚，主标题下） ----
  let subIdx = 0
  let subOffY = titleDefY + config.biaoti_size * 1.1
  for (const t of page.meta.titles.slice(1)) {
    const pos = posOf(`subtitle_${subIdx}`, { x: 0, y: subOffY })
    parts.push(
      `<text data-meta="subtitle_${subIdx}" x="${pos.x}" y="${pos.y}" text-anchor="middle" font-size="${config.fubiaoti_size}" font-family="${config.fubiaoti_font}" fill="#1b1b1b">${xmlEsc(t)}</text>`,
    )
    subOffY += config.fubiaoti_size * 1.3
    subIdx++
  }

  // ---- 乐器（adj83：Y 行，多行，一行一种乐器；显示在副标题下面，上居中锚） ----
  // adj151：颜色与 P:/J: 等描述头一致（#555 → #1b1b1b）
  let instOffY = subOffY
  for (let i = 0; i < page.meta.instruments.length; i++) {
    const pos = posOf(`instrument_${i}`, { x: 0, y: instOffY })
    parts.push(
      `<text data-meta="instrument_${i}" x="${pos.x}" y="${pos.y}" text-anchor="middle" font-size="${mSize}" font-family="${mFont}" fill="#1b1b1b">${xmlEsc(parseInstrumentRef(page.meta.instruments[i]).display)}</text>`,
    )
    instOffY += mSize * 1.4
  }

  // ---- 作者（右下锚，从底部往上：**末行贴区域下沿**，adj629u） ----
  for (let i = 0; i < page.meta.authors.length; i++) {
    const pos = posOf(`author_${i}`, { x: 0, y: metaAuthorRowY(i, page.meta.authors.length, mSize) })
    parts.push(
      `<text data-meta="author_${i}" x="${pos.x}" y="${pos.y}" text-anchor="end" font-size="${Math.max(9, mSize - 1)}" font-family="${mFont}" fill="#1b1b1b">${xmlEsc(page.meta.authors[i])}</text>`,
    )
  }

  return parts.join('\n')
}

/**
 * 拍号 → SVG 分数：数字上下正对，中间一条横线（传统拍号记法）。
 * 几何（adj 调整）：横线 = 调式文字垂直中心（基线 - 0.35×字号）；
 * 分子底部与分母顶部距横线各 2px（分子底≈基线+0.05em，分母顶≈基线-0.85em）。
 * 支持多个拍号（空格分隔，如 "4/4 (2/4)"）：首个为主拍号（mSize），
 * 括号内为辅助拍号（mSize-3，两侧带括号）；无法解析的片段按文本原样渲染。
 * 字体/字号跟随描述头设置（adj45：miaoshu_font/miaoshu_size）。
 */
function renderMeterMeta(meter: string, x: number, baseline: number, mFont: string, mSize: number): string {
  const parts = meter.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let gx = 0
  const auxSize = Math.max(8, mSize - 3)
  for (const part of parts) {
    const m = /^\(?(\d+)\s*\/\s*(\d+)\)?$/.exec(part)
    if (!m) {
      out.push(
        `<text x="${x + gx}" y="${baseline}" font-size="${mSize}" font-family="${mFont}" fill="#1b1b1b">${xmlEsc(part)}</text>`,
      )
      gx += part.length * 7 + 8
      continue
    }
    const aux = part.startsWith('(')
    const size = aux ? auxSize : mSize
    const num = m[1]
    const den = m[2]
    const cx = x + gx
    // 分数半宽：按数字位数估算，两侧略留白
    const halfW = Math.max(num.length, den.length) * size * 0.32 + 1.5
    // 横线 = 调式文字垂直中心；分子/分母距线各 2px
    const lineY = baseline - size * 0.35
    const numY = lineY - 2 - size * 0.05
    const denY = lineY + 2 + size * 0.85
    const frac =
      `<text x="${cx}" y="${numY.toFixed(1)}" text-anchor="middle" font-size="${size}" font-family="${mFont}" fill="#1b1b1b">${num}</text>` +
      `<line x1="${(cx - halfW).toFixed(1)}" y1="${lineY.toFixed(1)}" x2="${(cx + halfW).toFixed(1)}" y2="${lineY.toFixed(1)}" stroke="#1b1b1b" stroke-width="1.1"/>` +
      `<text x="${cx}" y="${denY.toFixed(1)}" text-anchor="middle" font-size="${size}" font-family="${mFont}" fill="#1b1b1b">${den}</text>`
    if (aux) {
      out.push(
        `<text x="${(cx - halfW - 5).toFixed(1)}" y="${(baseline + 2).toFixed(1)}" font-size="${auxSize}" font-family="${mFont}" fill="#1b1b1b">(</text>` +
          frac +
          `<text x="${(cx + halfW + 5).toFixed(1)}" y="${(baseline + 2).toFixed(1)}" font-size="${auxSize}" font-family="${mFont}" fill="#1b1b1b">)</text>`,
      )
      gx += halfW * 2 + 16
    } else {
      out.push(frac)
      gx += halfW * 2 + 10
    }
  }
  return `<g data-meta="meter" data-meter="${xmlEsc(meter)}">${out.join('')}</g>`
}

// ============================================================
// 音符绘制
// ============================================================

// ============================================================
// 附点几何（adj411：附点绘制与减时线延伸共用同一份，避免两处各算一次）
// ============================================================

/**
 * 首个附点的圆心 x；无附点返回 null。
 * adj284：空间优先给附点生成独立段（`el === 'dot'`，其 x 即圆心）；
 * adj291：否则回退「主段起点 + 主时值×每拍宽」（时值优先路径，附点落在主时值结束处）。
 */
function dotCenterXOf(note: PlacedToken, noteSize: number): number | null {
  const t = note.token
  if (t.dots <= 0) return null
  const rDot = DOT_R_DOT * noteScaleOf(noteSize)
  const dotSeg = note.segments?.find((sg) => sg.el === 'dot')
  if (dotSeg) return dotSeg.x
  const seg0 = note.segments?.[0]
  const mainDur = tokenDuration({ diminishCount: t.diminishCount, augmentCount: t.augmentCount, dots: 0 })
  return seg0 ? seg0.x + mainDur * seg0.perBeat : note.x + noteSize * 0.62 + rDot
}

/** 末个附点的**右缘** x（供减时线延伸用）；无附点返回 null */
function dotRightEdgeOf(note: PlacedToken, noteSize: number): number | null {
  const cx = dotCenterXOf(note, noteSize)
  if (cx === null) return null
  const rDot = DOT_R_DOT * noteScaleOf(noteSize)
  // 第 i 个附点圆心 = cx + i·2r（两附点相切），故末个右缘 = cx + (dots−1)·2r + r
  return cx + (note.token.dots - 1) * rDot * 2 + rDot
}

/**
 * adj629b：段层（`layerScale` = 整层纵向压缩比 k < 1）里**基线以下那一块**（减时线 + 低八度点）
 * 的**存储坐标补偿**。
 *
 * 为什么需要：整层用一个 `<g transform="… scale(1,k)">` 压扁后，`BEAM_H` 只有 0.8px × k ≈ 0.53px
 * ——渲染出来几乎看不见，两级十六分减时线也会挤在一起（用户报「低八度点出现了，但减时线没了」）。
 * 所以这一段在**存储坐标**里预先 ÷k：渲染结果仍是**原尺寸**（线宽、层间距、点半径都不变），
 * 只有「基线 → 块顶」那一段随整层一起被压扁（视觉上整层更贴数字、更扁）。
 */
const layerBlockDiv = (v: number, k: number): number => (k === 1 ? v : v / k)

/** adj629b：段层低八度点 cy（块内保持原尺寸；`k === 1` 时与 `lowDotY` 完全一致） */
function layerLowDotY(y: number, i: number, dc: number, noteSize: number, k: number): number {
  if (k === 1) return lowDotY(y, i, dc, noteSize)
  const s = noteScaleOf(noteSize)
  const top = y + (DIGIT_BOTTOM + LAYER_GAP) * s // 这一段会被 <g> ×k
  const block = dc > 0 ? ((dc - 1) * (BEAM_H + INNER_GAP) + BEAM_H) * s : 0
  const first = dc > 0 ? LAYER_GAP * s : digitBottomY(y, noteSize) - y + LAYER_GAP * s
  return top + (block + first + DOT_R * s + i * (DOT_R * 2 + INNER_GAP) * s) / k
}

/**
 * adj629b（用户要求）：**临时叠加层整层纵向压扁**（不逐个元素压）。
 *
 * `renderScoreToSvg` 把同一段层的元素（数字、减时线、括号、小节线、连音线）收进**一个**
 * `<g transform="translate(0, baseY·(1−k)) scale(1, k)">`（见 `layerGroupKey` / 页组装），
 * 以层基线为不动点做非等比缩放：`y' = baseY + k·(y − baseY)`。
 * **字号不变**（数字仍按原字号绘制，只是被压扁），减时线/低八度点那一块在存储坐标里
 * 已按 `layerBlockDiv` 补偿，压扁后仍是原尺寸 ⇒ 看得见、不互相压。
 */
function segmentYScaleWrap(html: string, layerScale: number | undefined, baseY: number | undefined): string {
  if (html === '' || layerScale === undefined || layerScale === 1 || baseY === undefined) return html
  // 取到 3 位小数：2/3 的浮点尾（0.6666666666666666）会把 SVG 属性写得很长
  const k = Math.round(layerScale * 1000) / 1000
  return `<g transform="translate(0 ${r1n(baseY * (1 - k))}) scale(1 ${k})">${html}</g>`
}

function renderNote(note: PlacedToken, config: PageConfig): string {
  const t = note.token
  // adj629b：段层**字号不变**（用户口径：只压高度）；纵向压扁在 `segmentYScaleWrap` 里统一做
  const size = config.note_size
  const digitW = size * 0.62 // 数字槽宽（随字号）
  const x = note.x
  const y = note.y
  const parts: string[] = []
  const nid = noteposId(note.id)
  const font = noteFont(config.shuzi_font)
  // adj69：修饰符缩放因子（18 号字 = 1；字号调大后八度点/附点/增时线/倚音等同比率放大）
  const s = noteScaleOf(size)

  // 隐藏休止符 8：不绘制（占位）
  if (t.kind === 'rest' && t.hidden) return ''

  // 变音符号（数字左侧上方，随字号）
  if (t.kind === 'note' && t.accidental) {
    const sym = t.accidental === '#' ? '#' : t.accidental === '$' ? 'b' : '♮'
    parts.push(
      `<text x="${x - 7 * s}" y="${y - 10 * s}" font-size="${r1n(12 * s)}" font-family="${font}" fill="#1b1b1b">${sym}</text>`,
    )
  }

  // 高低音点（adj60 层级化：高音点层贴数字顶、低音点层贴数字底/减时线层底，层内间距 INNER_GAP×s）
  const oct = t.kind === 'note' ? t.octaveShift : 0
  if (oct !== 0) {
    const n = Math.abs(oct)
    // 数字槽宽中心：高/低八度点一律取「数字槽中心」（adj391 用户规则：高八度点与音符水平居中，
    // 取消 adj19 的左移 1px——项目中其它居中元素（增时线/上方修饰符/注释）也都用这一中心）
    const dotCx = x + digitW / 2
    const dc = t.diminishCount
    // adj629b：段层（纵向压缩 k）——低八度点属于"减时线块"，块内在存储坐标里 ÷k 保持原尺寸；
    // 高八度点在数字上方，随整层一起压扁即可（点半径随之略扁，观感自然）
    const kL = note.layerScale ?? 1
    for (let i = 0; i < n; i++) {
      const cy = oct > 0 ? octaveDotY(y, i, size) : layerLowDotY(y, i, dc, size, kL)
      const rr = oct > 0 || kL === 1 ? DOT_R * s : DOT_R * s / kL
      parts.push(`<circle cx="${dotCx}" cy="${r1n(cy)}" r="${r1n(rr)}" fill="#1b1b1b"/>`)
    }
  }

  // 数字主体（含 notepos 契约；虚音符 (1) 两侧加小括号，adj23；字号随字号）
  const glyph = t.kind === 'rest' ? '0' : t.kind === 'rhythm' ? 'X' : String(t.pitch)
  if (t.kind === 'note' && t.ghost) {
    parts.push(
      `<text x="${x - 5 * s}" y="${y}" font-size="${r1n(13 * s)}" font-family="${font}" fill="#1b1b1b">(</text>`,
      `<text x="${x}" y="${y}" data-notepos="${nid}" font-size="${size}" font-family="${font}" font-weight="bold" fill="#1b1b1b">${glyph}</text>`,
      `<text x="${x + digitW + s}" y="${y}" font-size="${r1n(13 * s)}" font-family="${font}" fill="#1b1b1b">)</text>`,
    )
  } else {
    parts.push(
      `<text x="${x}" y="${y}" data-notepos="${nid}" font-size="${size}" font-family="${font}" font-weight="bold" fill="#1b1b1b">${glyph}</text>`,
    )
  }

  // 附点（adj71）：附点是音符的修饰符——增加前面音符一半时值（1. 总宽 1.5 拍、1/. 0.75 拍，
  // tokenDuration 已按 ×1.5/×1.75 计算，占位宽度随之增半）；
  // adj288：主音符与附点在 1.5 倍时值宽内平均分布（三等分）——附点圆心 = 主段（第 1 拍段）右端
  // = 总宽 2/3 处，数字中心在主段中点 = 1/3 处；原附点紧贴数字右缘（视觉挤在左侧）
  // adj396/adj411：附点圆心与右缘的几何收敛到 dotCenterXOf/dotRightEdgeOf（与减时线延伸共用）
  const rDot = DOT_R_DOT * s
  const dotX0 = dotCenterXOf(note, size) ?? x + digitW + rDot

  // 倚音（adj23/65/97/98/99/100/101/102/103）：前倚音 [65] 排于主音符左上角、后倚音 [h65] 排于右上角
  // 规范（用户 2026-08-22 + adj100~103 调整）：
  //  ① 倚音字号 = 主音符 × 0.5（adj105 由 0.4 调大），**加粗**（adj105，与主音符粗体一致）；
  //  ② 倚音减时线 = 实际时值 +1 条（2[3] → 1 条、2[3/] → 2 条），线**更细**（0.6）、
  //     间距固定 1.2px（adj100 由 1.8px 减小）；
  //  ③ 第一条减时线与主音符文本上端对齐（= mainTop，adj100）；数字底距首条线 2px，
  //     adj101 数字整体下移 1.5px（数字底距线 0.5px）；
  //  ④ 低八度点紧贴该音符最后一条减时线下方，间距规则同主音符
  //     （线底 + LAYER_GAP×s + DOT_R×s = 圆心，层内点距 INNER_GAP×s，adj101）；
  //  ⑤ 无论几个倚音，只有**一条弧线**：起点 = 组中心正下方，控制点 = 起点正下方
  //     → 前倚音**先向下再弯向右**、后倚音**先向下再弯向左**（二次贝塞尔，adj101）；
  //     adj102：无低八度点 → 弧线起点 = 最后一条减时线底（直接连接）；
  //             有低八度点 → 弧线起点 = 最低低八度点底 + LAYER_GAP×s（间距 = 点到减时线的距离）；
  //  adj103：所有固定 px 间距改为 ×s（主音符缩放因子）随字号等比缩放；多音符（≥2）数字间
  //          间距由 0.62×字号 缩为 0.5×字号（GRACE_SLOT_RATIO_MULTI），占位宽度同步
  //  adj396：后倚音**位置规则**（用户规范）——主音符带**增时线或附点**时，
  //          后倚音移到这些时值元素**之后**（`3 -[h5/]` 的倚音画在 `-` 右侧、
  //          `3.[h5/]` 画在附点右侧），弧线终点同样落在该尾部元素右缘；
  //          无增时线也无附点的后倚音仍紧贴数字右上角（既有行为不变）。
  if (t.kind === 'note' && t.gracenotes && t.gracenotes.notes.length > 0) {
    const gn = t.gracenotes
    // ①倚音字号 = 主音符 × 0.4（下限 6×s 随字号等比，adj103）
    const gSize = Math.max(6 * s, size * GRACE_SIZE_RATIO)
    const gW = gSize * GRACE_SLOT_RATIO // 数字槽宽（同数字槽宽比例）
    // adj103：多音符（≥2）数字间占宽缩小为 0.5×字号；单音无间距问题
    const gapW = gn.notes.length >= 2 ? gSize * GRACE_SLOT_RATIO_MULTI : gW
    const gs = gSize / 18 // 倚音缩放因子（高低音点/间距随倚音字号缩放）
    const mainTop = y - size * DIGIT_HEIGHT_RATIO // 主音符文本上端（adj100 = 第一条减时线位置）
    // ③ 数字底 = 首条减时线上方 0.5×s（adj101 下移 1.5px 后；间距随字号等比）
    //    基线 = mainTop - 0.5×s - 字号/9（字号/9 = 2×gs，即数字底到基线的 descender）
    const gBaseY = mainTop - 0.5 * s - gSize / 9
    // adj396：后倚音的锚点（组左缘基准 / 弧线终点）——尾部倚音取「末个时值元素右缘」
    const tailGrace = graceAtTail(t)
    let graceAnchorX = x + digitW
    if (tailGrace) {
      graceAnchorX = x + digitW
      if (t.dots > 0) graceAnchorX = Math.max(graceAnchorX, dotX0 + (t.dots - 1) * rDot * 2 + rDot)
      if (t.augmentCount > 0) {
        // 空间优先路径的增时线段带 el 标记（点在附点段之后）；时值优先路径按段序取第 augmentCount 段
        const augSegs = (note.segments ?? []).filter((sg) => sg.el === 'aug')
        const lastAug = augSegs.length > 0 ? augSegs[augSegs.length - 1] : note.segments?.[t.augmentCount]
        const augRight = lastAug ? lastAug.x + lastAug.beats * lastAug.perBeat : (note.rightX ?? x + note.width)
        graceAnchorX = Math.max(graceAnchorX, augRight)
      }
    }
    // 数字水平排列：前倚音从主音符左上角向左依次排；后倚音从锚点向右依次排
    // adj106：组右端（前倚音）固定与主音符留 1px×s——多音符时组内间距 gapW < 槽宽 gW，
    // 原公式按 gapW 排组尾会右移侵入主音符区造成重叠；后倚音原公式组左端已固定
    const gxs: number[] = []
    for (let gi = 0; gi < gn.notes.length; gi++) {
      gxs.push(
        gn.after
          ? graceAnchorX + 1 * s + gi * gapW
          : x - 1 * s - gW - (gn.notes.length - 1 - gi) * gapW,
      )
    }
    const gy = gBaseY // 同基线（水平排列）
    // 组范围（数字区）：组首 x、组尾 x
    const gx1 = Math.min(...gxs)
    const gx2 = Math.max(...gxs) + gW
    // ② 减时线参数：首条 = mainTop（与主音符文本上端对齐），间距 GRACE_BEAM_GAP×s（adj103 等比）
    const maxDim = Math.max(0, ...gn.notes.map((g) => g.diminishCount + 1))
    const beamGap = GRACE_BEAM_GAP * s
    const beamTop = mainTop
    const lineHalf = (GRACE_LINE_W * s) / 2 // 减时线/弧线半线宽（线底 = 线中心 + 半线宽）
    for (let gi = 0; gi < gn.notes.length; gi++) {
      const g = gn.notes[gi]
      const gx = gxs[gi]
      // 小高低音点（规则同主音符，以倚音字号为参照）
      if (g.octaveShift !== 0) {
        const cx = gx + gW / 2
        const n = Math.abs(g.octaveShift)
        for (let d = 0; d < n; d++) {
          const cy =
            g.octaveShift > 0
              ? octaveDotY(gy, d, gSize)
              : // ④ 低八度点：该音符最后一条减时线底（线中心 + 半线宽）+ LAYER_GAP×s + DOT_R×s
                beamTop + g.diminishCount * beamGap + lineHalf + (LAYER_GAP + DOT_R) * gs + d * (DOT_R * 2 + INNER_GAP) * gs
          parts.push(`<circle cx="${r1n(cx)}" cy="${r1n(cy)}" r="${r1n(DOT_R * gs)}" fill="#1b1b1b"/>`)
        }
      }
      // 变音
      if (g.accidental) {
        const sym = g.accidental === '#' ? '#' : g.accidental === '$' ? 'b' : '♮'
        parts.push(
          `<text x="${gx - 3.5 * s}" y="${gy - 6 * s}" font-size="${r1n(8 * s)}" font-family="${font}" fill="#1b1b1b">${sym}</text>`,
        )
      }
      // ①数字：adj105 加粗（与主音符粗体一致）
      parts.push(
        `<text x="${gx}" y="${gy}" font-size="${gSize}" font-family="${font}" font-weight="bold" fill="#1b1b1b">${g.pitch}</text>`,
      )
    }
    // ②减时线（跨组平行横线）：实际时值 +1 条；线宽 GRACE_LINE_W×s、间距 GRACE_BEAM_GAP×s
    for (let d = 0; d < maxDim; d++) {
      const ly = beamTop + d * beamGap
      parts.push(
        `<line x1="${r1n(gx1)}" y1="${r1n(ly)}" x2="${r1n(gx2)}" y2="${r1n(ly)}" stroke="#1b1b1b" stroke-width="${GRACE_LINE_W * s}"/>`,
      )
    }
    // ⑤ 一条弧线（二次贝塞尔 = 抛物线）：起点 = 组中心正下方；控制点 = 起点正下方（先向下再弯向主音符）
    //    adj102：无低八度点 → 起点 = 最后一条减时线底（弧线与线**直接连接**）；
    //            有低八度点 → 起点 = 最低低八度点底 + LAYER_GAP×s（与点留间距 = 点到减时线的距离）
    const gcx = (gx1 + gx2) / 2 // 倚音组中心 x
    let lowDotBottom = -Infinity // 组内最低低八度点底 y
    for (const g of gn.notes) {
      if (g.octaveShift < 0) {
        const nLow = Math.abs(g.octaveShift)
        const lastBeamBottom = beamTop + g.diminishCount * beamGap + lineHalf // 该音符最后一条线底（线中心+半线宽）
        const cy = lastBeamBottom + (LAYER_GAP + DOT_R) * gs + (nLow - 1) * (DOT_R * 2 + INNER_GAP) * gs
        lowDotBottom = Math.max(lowDotBottom, cy + DOT_R * gs)
      }
    }
    const arcStartY =
      lowDotBottom > -Infinity ? lowDotBottom + LAYER_GAP * gs : beamTop + (maxDim - 1) * beamGap + lineHalf
    const arcDrop = 3 * s // 终点比起点低（垂度，随字号等比）
    const arcW = GRACE_LINE_W * s // 弧线宽 = 减时线宽
    if (gn.after) {
      // 后倚音（组在右）：终点 = 锚点下方 → 先向下再弯向左
      // adj396：尾部倚音的锚点 = 增时线/附点右缘（弧线随之落在这些元素之后）
      parts.push(
        `<path d="M ${r1n(gcx)} ${r1n(arcStartY)} Q ${r1n(gcx)} ${r1n(arcStartY + arcDrop)} ${r1n(graceAnchorX)} ${r1n(arcStartY + arcDrop)}" fill="none" stroke="#1b1b1b" stroke-width="${arcW}"/>`,
      )
    } else {
      // 前倚音（组在左）：终点 = 主音符数字左缘（= x）下方 → 先向下再弯向右
      parts.push(
        `<path d="M ${r1n(gcx)} ${r1n(arcStartY)} Q ${r1n(gcx)} ${r1n(arcStartY + arcDrop)} ${r1n(x)} ${r1n(arcStartY + arcDrop)}" fill="none" stroke="#1b1b1b" stroke-width="${arcW}"/>`,
      )
    }
  }

  // 附点（adj71）：圆心与半径在倚音之前已算好（adj396），此处只绘制
  // adj291：附点圆心 = 主时值部分结束处 = 段起点 + 主时值×每拍宽
  //（1.5 倍时值宽的三等分点，数字中心在主时值段中心 = 1/3 处）。
  // 此前误用 segments[0] 整段右端：总时值 < 1 拍的音符（如 2/. 0.75 拍）主/附点
  // 合并为一段，段右端 = 音符结束位置 → 附点圆点压到下一音符（如 2/. 3//）
  if (t.dots > 0) {
    for (let i = 0; i < t.dots; i++) {
      // 第 i 个附点：圆心在主时值结束处（第 2 个起紧贴前一个，间距 2×r）
      const cx = dotX0 + i * rDot * 2
      // 垂直居中于数字（数字视觉中心 ≈ 基线-0.4×字号）
      parts.push(`<circle cx="${r1n(cx)}" cy="${r1n(y - size * 0.4)}" r="${r1n(rDot)}" fill="#1b1b1b"/>`)
    }
  }

  // 增时线（"-" 各占一拍的位置，每根在所在拍段占位宽度内居中；
  // adj35：第 i 条增时线在第 i+1 拍段；adj73：垂直居中于音符数字（数字中心 = 基线-0.4×字号））
  const augY = y - size * 0.4
  if (t.augmentCount > 0) {
    const seg0 = note.segments?.[0]
    const pb0 = seg0 ? seg0.perBeat : note.duration > 0 ? note.width / note.duration : digitW
    const segStart0 = seg0 ? seg0.x : x + 6 - Math.min(note.duration, 1) * (pb0 / 2)
    for (let i = 0; i < t.augmentCount; i++) {
      const seg = note.segments?.[i + 1]
      const beatStart = seg ? seg.x : segStart0 + (1 + i) * pb0
      const pb = seg ? seg.perBeat : pb0
      const lx = r1n(beatStart + (pb - digitW) / 2)
      // adj73："-" 字符随音符字号；dominant-baseline=central 使字符垂直居中于数字中心；
      // text-anchor=middle 使字符在占位宽（digitW）内居中；adj76：加粗与数字一致
      // adj374：增时线同样带 data-notepos（与数字同一 id）——播放高亮/光标联动能覆盖到增时线，
      // 此前只有数字带 id，试听时高亮"只显示到数字、后面的 -- 没有高亮"。
      // 属性放在末尾：不影响既有断言/外部消费方对前面属性顺序的假设。
      parts.push(
        `<text x="${r1n(lx + digitW / 2)}" y="${augY}" text-anchor="middle" dominant-baseline="central" font-weight="bold" font-size="${size}" font-family="${font}" fill="#1b1b1b" data-notepos="${nid}">-</text>`,
      )
    }
  }

  // 装饰符号（& 编码，M7d）：tr 颤音带波浪线，其余画上方小文本；
  // adj60：上方装饰层从「高八度点层顶（无高八度则数字顶）」往上，按书写顺序逐层排（层间距 LAYER_GAP×s）
  // adj294：&zkh/&ykh 为独立 bracket token，不再作为音符 symbols——由 renderBracket 单独渲染
  if (t.symbols.length > 0) {
    // 当前已占用的上方层顶（高八度点层顶优先；无高八度点则为数字顶）
    let aboveTop = oct > 0 ? octaveTopY(y, Math.abs(oct), size) : y - size * DIGIT_HEIGHT_RATIO
    const SYM_FS = Math.round(10 * s) // 装饰符号字号（随字号）
    for (const sym of t.symbols) {
      // 上方符号（adj109 扩展 & 编码修饰符）：文字底 = aboveTop - LAYER_GAP×s；基线 = 底 - descender
      const symY = aboveTop - SYM_LAYER_GAP * s - SYM_FS * DESC_RATIO
      const cx = x + digitW / 2 // 数字槽中心
        if (sym === 'tr' || sym === 'cy+') {
          // 颤音：tr（粗体，adj112）+ 正弦波（adj115：周期数随音符点位/时值——每拍约 2 周期）
          parts.push(
            `<text x="${x}" y="${r1n(symY)}" font-size="${SYM_FS}" font-weight="bold" font-style="italic" font-family="${FONT_CN}" fill="#1b1b1b">tr</text>`,
          )
          // adj116：正弦波更细密（每拍约 4 周期）；adj117：正弦波与 tr 文本垂直居中对齐
          // （tr 文本视觉中心 ≈ 基线 - 4×s，正弦波中心线取同高）
          const cycles = Math.max(4, Math.round((note.duration || 1) * 4))
          parts.push(wavePath(x + 16 * s, symY - 4 * s, x + 34 * s, 1, cycles))
        } else if (sym === 'cy') {
          // 颤音：仅 tr 文本（粗体，adj112；&cy 不带波浪线，&cy+ 才带）
          parts.push(
            `<text x="${x}" y="${r1n(symY)}" font-size="${SYM_FS}" font-weight="bold" font-style="italic" font-family="${FONT_CN}" fill="#1b1b1b">tr</text>`,
          )
        } else if (sym === 'bc') {
          // 保持音：上方短横线（adj124：尺寸 ×0.8）
          parts.push(
            `<line x1="${r1n(cx - 3.6 * s)}" y1="${r1n(symY - 2 * s)}" x2="${r1n(cx + 3.6 * s)}" y2="${r1n(symY - 2 * s)}" stroke="#1b1b1b" stroke-width="${r1n(2 * s)}"/>`,
          )
        } else if (sym === 'zy') {
          // 重音：上方线形 > 符号（adj112 非实心；adj113 调小 + 上移；adj124 尺寸 ×0.8）
          parts.push(
            `<path d="M ${r1n(cx - 3.2 * s)} ${r1n(symY - 5 * s)} L ${r1n(cx + 2 * s)} ${r1n(symY - 2 * s)} L ${r1n(cx - 3.2 * s)} ${r1n(symY + 1 * s)}" fill="none" stroke="#1b1b1b" stroke-width="1.5"/>`,
          )
        } else if (sym === 'dy') {
          // 顿音：上方实心倒三角（尖朝下；adj113 上移；adj124 尺寸 ×0.8）
          parts.push(
            `<path d="M ${r1n(cx - 3.2 * s)} ${r1n(symY - 4.4 * s)} L ${r1n(cx + 3.2 * s)} ${r1n(symY - 4.4 * s)} L ${r1n(cx)} ${r1n(symY + 1.6 * s)} Z" fill="#1b1b1b"/>`,
          )
        } else if (sym === 'yc') {
          // adj458（用户要求）：延长记号改用**用户提供的矢量图形**（同上），不再手绘"点 + 半圆弧"。
          // 摆放沿用旧几何：旧图形墨迹 = 宽 9.6s（cx ± 4.8s）、纵向 cy0-2.8s ~ cy0+1.6s
          // （cy0 = symY - 1.5s，adj113 下移、adj124 尺寸 ×0.8）⇒ 墨迹中心 = symY - 2.1s。
          // 高度交给图形自身比例（`fit='width'`）：新图宽高比 1.89，比旧手绘的 2.18 略高一点。
          // 层顶更新仍走下方 `symY - 8.7s` 的既有分支（留有富余，不受新图高度影响）。
          parts.push(
            glyphMarkup(MODIFIER_GLYPHS.yc, { x: cx - 4.8 * s, y: symY - 2.1 * s, w: 9.6 * s, h: 0 }, 'width', '#1b1b1b'),
          )
        } else if (sym === 'sby' || sym === 'xby' || sym === 'sby+' || sym === 'xby+') {
          // adj458（用户要求）：波音改用**用户提供的矢量修饰符**（`./modifierGlyphs`，由
          // `scripts/gen-modifier-glyphs.mjs` 从 `public/icons/*.svg` 生成），不再手绘锯齿线。
          //   · 横向占位沿用此前逐轮调好的值（2.5 齿 = 9s、3.5 齿 = 13.5s），以数字槽中心 cx 居中；
          //   · 高度交给图形自身比例（`fit='width'`）——「复下波音」中带竖线，天生比「复上波音」高；
          //   · 垂直中心沿用 adj125 定下的 wy（= symY - 2s）。
          // 旧矢量实现（斜上细线 0.7 / 斜下粗线 1.8、adj113~adj125）随之移除；
          // 需要退回旧画法时，从 git 历史取回该分支即可。
          const half = (sym.endsWith('+') ? 9 * s : 5 * s) * (sym.endsWith('+') ? 0.75 : 0.9)
          const wy = symY - 2 * s
          parts.push(
            glyphMarkup(
              MODIFIER_GLYPHS[sym as ModifierGlyphKey],
              { x: cx - half, y: wy, w: 2 * half, h: 0 },
              'width',
              '#1b1b1b',
            ),
          )
        } else if (sym === 'shy' || sym === 'xhy') {
          // adj458（用户要求）：滑音改用**用户提供的矢量修饰符**（同上），不再手绘弧线 + 箭头。
          // adj479：摆放几何抽到 `layout/spaceLayout.ts` 的 `slideGlyphInk`（与布局占宽**同源**）——
          // 渲染端按它的 `dx/dy/w/h` 放置（左缘贴数字右缘、按高度贴合 `fit='height'`），
          // 布局端按同一份宽度给音符占位，多声部里不再压到相邻数字（用户报「与音符重叠」）。
          const ink = slideGlyphInk(sym, size)
          parts.push(
            glyphMarkup(
              MODIFIER_GLYPHS[sym as ModifierGlyphKey],
              { x: x + ink.dx, y: y + ink.dy, w: 0, h: ink.h },
              'height',
              '#1b1b1b',
            ),
          )
        } else if (ABOVE_GLYPH[sym]) {
          // adj334：吐音/打音/叠音——音符正上方居中显示一个粗体单字（T / 扌 / 又）。
          // 用中文黑体栈（FONT_CN）保证 /扌/又 可见；粗体 + 居中于数字槽。
          // adj335：叠音「又」显示宽度缩为 3/4（横向 scale 0.75）——以数字槽中心为锚缩放，
          // 用 translate(cx,symY) + scale(0.75,1) + text-anchor="middle" 保持视觉居中。
          if (sym === 'die') {
            parts.push(
              `<text x="0" y="0" text-anchor="middle" transform="translate(${r1n(cx)},${r1n(symY)}) scale(0.75,1)" font-size="${SYM_FS}" font-weight="bold" font-family="${FONT_CN}" fill="#1b1b1b">${xmlEsc(ABOVE_GLYPH[sym])}</text>`,
            )
          } else {
            parts.push(
              `<text x="${r1n(cx)}" y="${r1n(symY)}" text-anchor="middle" font-size="${SYM_FS}" font-weight="bold" font-family="${FONT_CN}" fill="#1b1b1b">${xmlEsc(ABOVE_GLYPH[sym])}</text>`,
            )
          }
        } else if (DYN_MARKS.has(sym)) {
          // 力度/速度标记（adj）：音符上方花体（斜体加粗），居中于数字槽。
          // 不用 Bravura 等非系统音乐字体，避免缺字；花体字栈带通用 fallback 保证可见
          parts.push(
            `<text x="${r1n(cx)}" y="${r1n(symY)}" text-anchor="middle" font-size="${SYM_FS}" font-style="italic" font-weight="bold" font-family="${FONT_SCRIPT}" fill="#1b1b1b">${xmlEsc(sym)}</text>`,
          )
        } else {
          // 其余编码：上方小文本（既有行为）
          parts.push(
            `<text x="${x}" y="${r1n(symY)}" font-size="${SYM_FS}" font-family="${FONT_CN}" fill="#1b1b1b">${xmlEsc(sym)}</text>`,
          )
        }
        // 更新层顶：文字顶 = 基线 - ascent（0.8×字号）；延长记号弧顶更高单独处理（adj124 缩 80%）
        aboveTop = sym === 'yc' ? symY - 8.7 * s : symY - SYM_FS * DIGIT_HEIGHT_RATIO
      }
    }

  // 减时线由 computeBeams 按拍分组绘制（M3：同一拍内相连）
  // 音符备注（引号注释，adj62）—— 字号 = 音符字体高度的一半（0.5×note_size）；
  // 置于上方最高层之上（高八度点/装饰符号之后），数字中心居中
  // adj392：紧接注释引号后的 + / - 逐级抬升/降低注释文本（每级 NOTE_COMMENT_RAISE px，
  // 与跳房子 [+/[-、连音线 (+/(- 同一套记法）；其余元素不动，供用户手动避让
  const commentRaise = (t.commentPlus ?? 0) - (t.commentMinus ?? 0)
  if (t.comment) {
    const cfs = Math.max(7, Math.round(size * NOTE_COMMENT_FONT_RATIO))
    // 注释层顶：装饰符号处理后的层顶（无符号则高八度点层顶/数字顶）
    let aboveTop = y - size * DIGIT_HEIGHT_RATIO
    if (oct > 0) aboveTop = octaveTopY(y, Math.abs(oct), size)
    if (t.symbols.length > 0) {
      const SYM_FS = Math.round(10 * s)
      const nTop = t.symbols.length
      aboveTop -= nTop * (SYM_FS * (DIGIT_HEIGHT_RATIO + DESC_RATIO) + LAYER_GAP * s)
    }
    const base = aboveTop - LAYER_GAP * s - cfs * DESC_RATIO - commentRaise * NOTE_COMMENT_RAISE // 注释文字底距上层元素顶 LAYER_GAP×s
    parts.push(
      `<text x="${r1n(x + digitW / 2)}" y="${r1n(base)}" text-anchor="middle" font-size="${cfs}" font-family="${FONT_CN}" fill="#555">${xmlEsc(t.comment)}</text>`,
    )
  }

  // adj303：乐器名注释（@乐器名 / @@ 后第一个音符正上方标注；仅 config.showInstrument 开启时）
  if (config.showInstrument === true && note.instrumentLabel) {
    const ifs = Math.max(7, Math.round(size * NOTE_COMMENT_FONT_RATIO))
    // 位于注释层顶之上（有注释再往上，否则数字/高音点/装饰之上）
    let iTop = y - size * DIGIT_HEIGHT_RATIO
    if (oct > 0) iTop = octaveTopY(y, Math.abs(oct), size)
    if (t.symbols.length > 0) {
      const SYM_FS = Math.round(10 * s)
      const nTop = t.symbols.length
      iTop -= nTop * (SYM_FS * (DIGIT_HEIGHT_RATIO + DESC_RATIO) + LAYER_GAP * s)
    }
    if (t.comment) {
      const cfs = Math.max(7, Math.round(size * NOTE_COMMENT_FONT_RATIO))
      iTop -= LAYER_GAP * s + cfs * DESC_RATIO + cfs // 注释占位高
      iTop -= commentRaise * NOTE_COMMENT_RAISE // adj392：注释被 +/- 抬降后，其上的乐器名随之同向平移
    }
    const ibase = iTop - LAYER_GAP * s - ifs * DESC_RATIO
    parts.push(
      `<text x="${r1n(x + digitW / 2)}" y="${r1n(ibase)}" text-anchor="middle" font-size="${ifs}" font-family="${FONT_CN}" fill="#888">${xmlEsc(note.instrumentLabel)}</text>`,
    )
  }

  return parts.join('\n')
}

// ============================================================
// 小节线绘制
// ============================================================

function renderBarline(bar: PlacedBarline, noteSize = 18, noteFontFamily = FONT_CN): string {
  // 纯跳房子起点（] 后连续 [ 或行首）：只承载跳房子线，不画小节线竖线（adj26）
  if (bar.voltaOnly) return ''
  const { x, yTop, yBottom } = bar
  const parts: string[] = []
  const h = (yBottom - yTop).toFixed(1)
  const draw = (off: number, w: number) =>
    `<rect x="${x + off}" y="${yTop}" width="${w}" height="${h}" fill="#1b1b1b"/>`
  // adj69：小节线高度/反复点随曲部字号缩放（线宽与占位保持，避免布局占位连锁变化）
  const s = noteScaleOf(noteSize)
  // 反复点（r=BARLINE_DOT_R×s，adj58/104 调小），off 为几何给出的圆心偏移；
  // 垂直对称于小节线中心 ±BARLINE_DOT_OFF×s
  const dotR = BARLINE_DOT_R * s
  const dots = (off: number) => {
    const midY = (yTop + yBottom) / 2
    return (
      `<circle cx="${x + off}" cy="${(midY - BARLINE_DOT_OFF * s).toFixed(1)}" r="${r1n(dotR)}" fill="#1b1b1b"/>` +
      `<circle cx="${x + off}" cy="${(midY + BARLINE_DOT_OFF * s).toFixed(1)}" r="${r1n(dotR)}" fill="#1b1b1b"/>`
    )
  }
  // adj391：线组几何统一由 spacing.ts 的 barlineGeometry 产出——**以小节线中心 x 对称**，
  // 线宽 细 1 / 粗 2（用户规则）、线与线 1px、线与点 1.2px；渲染与布局占位共用同一份定义。
  // `|/` 不绘制也不占位；`|*` 不绘制但占位（几何同 `|`）。
  if (bar.type !== '|/' && bar.type !== '|*') {
    const geom = barlineGeometry(bar.type)
    for (const ln of geom.lines) parts.push(draw(ln.off, ln.w))
    for (const cx of geom.dots) parts.push(dots(cx))
  }

  // 线组右缘（相对中心 x）：临时节拍分数、小节线修饰符都以此起排（adj391 改用几何，不再写死偏移表）
  const barRightEdge = barlineGeometry(bar.type).total / 2

  // 小节线备注；adj67：|"P:2/4" 临时节拍 → 小节线右侧画分数（上下数字+横线，整体高度与小节线等高，随字号 adj69）
  // adj86：|"p:2/4" 与 |"P:2/4" 等效（大小写不敏感）
  // adj357：字体=音符字体（shuzi_font）、字号=音符字号、加粗；分数高度缩减为正常字号的 2/3（紧凑，不压小节线）
  if (bar.comment) {
    const pm = /^p:\s*(\d+)\s*\/\s*(\d+)$/i.exec(bar.comment)
    if (pm) {
      const size = noteSize // 分数字号 = 音符字号（与音符一致）
      const hScale = 2 / 3 // 高度缩减为正常字号高度的 2/3（围绕小节线中点纵向压缩）
      const halfW = Math.max(pm[1].length, pm[2].length) * size * 0.32 + 1.5 * s
      const midY = (yTop + yBottom) / 2
      const lineY = midY - s // 横线略上移，使分数整体居中于小节线
      const numY = lineY - 2 * s - size * 0.05
      const denY = lineY + 2 * s + size * 0.85
      // 分数中心：左缘 = 小节线右缘 + 2px×s（adj68：左右留空），即 fx = 右缘 + 2s + halfW
      const fx = x + barRightEdge + 2 * s + halfW
      parts.push(
        `<g transform="translate(0,${midY.toFixed(1)}) scale(1,${hScale}) translate(0,${(-midY).toFixed(1)})">` +
          `<text x="${fx.toFixed(1)}" y="${numY.toFixed(1)}" text-anchor="middle" font-weight="bold" font-size="${size}" font-family="${noteFontFamily}" fill="#1b1b1b">${pm[1]}</text>` +
          `<line x1="${(fx - halfW).toFixed(1)}" y1="${lineY.toFixed(1)}" x2="${(fx + halfW).toFixed(1)}" y2="${lineY.toFixed(1)}" stroke="#1b1b1b" stroke-width="1"/>` +
          `<text x="${fx.toFixed(1)}" y="${denY.toFixed(1)}" text-anchor="middle" font-weight="bold" font-size="${size}" font-family="${noteFontFamily}" fill="#1b1b1b">${pm[2]}</text>` +
        `</g>`,
      )
    } else {
      parts.push(
        `<text x="${x}" y="${yBottom + 13}" text-anchor="middle" font-size="10" font-family="${FONT_CN}" fill="#333">${xmlEsc(bar.comment)}</text>`,
      )
    }
  }

  // adj126：小节线修饰符（&fine 曲终 / &dc 从头反复 / &ds 大反复 → 正下方文本；
  // &ty 大跳跃 → 正上方 ⊕；&hs 花S → 正上方花 S 记号）
  // adj206：同一条小节线可叠加多个修饰符（如 |&ty&ds）——全部渲染；
  // 正上方记号（ty/hs）横向依次排开，正下方文本（fine/dc/ds）也横向排开
  if (bar.marks?.length) {
    // adj391：横排基准沿用原式（线组右缘的一半 = 总宽/4），右缘由几何给出，不再写死偏移表
    const mx = x + barRightEdge / 2
    // 上方记号组（ty/hs）
    const upMarks = bar.marks.filter((m) => m === 'ty' || m === 'hs')
    upMarks.forEach((m, idx) => {
      const ux = mx + (idx - (upMarks.length - 1) / 2) * 9 * s
      if (m === 'ty') {
        // 大跳跃记号（adj130）：官方 Unicode U+1D10C（𝄌）；adj131：调大 + 下移靠近小节线；
        // adj182：高度 120%（16s→19.2s）、记号下端与小节线上端（yTop）齐平
        // （text y 为基线，记号下端 ≈ y + 0.15×fs）；
        // adj183：再向下移动 60% 自身高度（y → yTop + 0.45×fs）；
        // adj184：再上移 10% 自身高度（y → yTop + 0.35×fs）
        const fs = Math.max(14, Math.round(16 * s * 1.2))
        parts.push(
          `<text x="${ux.toFixed(1)}" y="${(yTop + 0.35 * fs).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-family="'Bravura','Finale Maestro','Noto Music','Segoe UI Symbol',sans-serif" fill="#1b1b1b">𝄌</text>`,
        )
      } else {
        // 花 S 记号（adj129）：官方 Unicode U+1D10B（𝄋）；adj131：调小与大跳跃匹配 + 下移靠近小节线；
        // adj182：记号下端与小节线上端（yTop）齐平
        const fs = Math.max(10, Math.round(12 * s))
        parts.push(
          `<text x="${ux.toFixed(1)}" y="${(yTop - 0.15 * fs).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-family="'Bravura','Finale Maestro','Noto Music','Segoe UI Symbol',sans-serif" fill="#1b1b1b">𝄋</text>`,
        )
      }
    })
    // 下方文本组（fine/dc/ds）
    const downMarks = bar.marks.filter((m) => m === 'fine' || m === 'dc' || m === 'ds')
    downMarks.forEach((m, idx) => {
      const label = m === 'fine' ? 'Fine' : m === 'dc' ? 'D.C.' : 'D.S.'
      // 小节线正下方文本（adj：&fine/&dc/&ds 一律粗体 + 斜体；
      // adj210：字号为主音符的 0.5（9×s = noteSize×0.5））
      const fs = Math.max(8, Math.round(9 * s))
      const bold = ' font-weight="bold"'
      const italic = ' font-style="italic"'
      const dx = mx + (idx - (downMarks.length - 1) / 2) * 10 * s
      parts.push(
        // adj：位置下移 0.1 音符高度（0.1×18×s = 1.8×s），与字号缩放一致；花体渲染
        `<text x="${dx.toFixed(1)}" y="${(yBottom + 8 * s + 1.8 * s).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-family="${FONT_SCRIPT}"${bold}${italic} fill="#1b1b1b">${label}</text>`,
      )
    })
  }

  // adj627（用户要求）：**临时转调记号**——小节线引号备注写了 `"d:..."` 时，在线的**右上方**
  // 画一小段 `转1=D`（文本由布局端算好，含 `d:` 单用时的"恢复调名"）。
  // 位置取"线右缘 + 2×s"（与 `"p:2/4"` 临时节拍分数的起始口径一致），纵向在**小节线上端之上**，
  // 与上方记号（&ty/&hs 画在线中心 mx）横向错开、互不压。
  // adj627b（用户要求）：调名后面紧跟的 `+` / `-` 逐级抬升/降低记号（口径同 adj392 的音符注释）。
  // adj627c（用户要求）：调名部分**与描述头 `D: Ab` 同款**——字母 + 左上角 ♯/♭ 角标
  // （共用 `drawKeyName`；此前整串文字里 `Ab` 的降号只是普通字母 b，与描述头的 `A♭` 不一致）。
  // 角标左缘 = `转1=` 起始 + 该前缀占宽（按字号估算，与导出路径上的描述头同口径）。
  // adj627d（用户要求）：记号**只用粗体、不要斜体**（斜体让角标与字母的贴合看着发飘）。
  if (bar.keyChangeLabel) {
    const fs = Math.max(8, Math.round(9 * s))
    const kcRaise = ((bar.keyChange?.plus ?? 0) - (bar.keyChange?.minus ?? 0)) * NOTE_COMMENT_RAISE
    const kcX = x + barRightEdge + 2 * s
    const kcY = yTop - 3 * s - kcRaise
    parts.push(
      ...drawKeyName({
        x: r1n(kcX),
        y: r1n(kcY),
        size: fs,
        font: noteFontFamily,
        keyRaw: bar.keyChangeName ?? bar.keyChangeLabel.replace(/^转1=/, ''),
        prefix: '转1=',
        prefixW: metaTextW('转1=') * (fs / 13),
        midAttrs: ' text-anchor="start" font-weight="bold"',
        tailAttrs: ` data-keychange="${xmlEsc(bar.keyChangeLabel)}"`,
      }).parts,
    )
  }

  return parts.join('\n')
}

// ============================================================
// 方框小节序号（adj625，用户要求）
// ============================================================

/**
 * 画一个**带外框的小节序号**（`showBarCount`）。几何全部来自 `spacing.ts`（布局端同源）：
 *  - 字号 = **倚音音符**字号 **× 3/4**（`barNumberFontSize`；框内空隙与线宽同步 ×0.75，见 `spacing.ts`）；
 *  - 外框顶 = 该谱行小节线底缘 + `BAR_NUMBER_BOTTOM_GAP`，数字在框内**上下居中**；
 *  - 框宽按数字位数自适应（等宽估算 0.62em，与数字槽同比例）。
 */
function renderBarNumber(bn: PlacedBarNumber, config: PageConfig): string {
  const noteSize = config.note_size
  const fs = barNumberFontSize(noteSize)
  const boxH = barNumberBoxH(noteSize)
  const text = String(bn.n)
  const boxW = barNumberBoxW(bn.n, noteSize)
  const top = bn.yBarBottom + BAR_NUMBER_BOTTOM_GAP
  const cy = top + boxH / 2
  // adj625（用户反馈"序号在方框里偏靠上"）：必须用 `central` 而**不是** `middle`——
  // `middle` 对齐的是 **x-height 的中线**，而数字占的是 cap 高 ⇒ 数字整体偏上；
  // `central` 才是"字符中心对齐"（本库增时线 `-`、段层括号等居中文本一直用 `central`）。
  return (
    `<g data-barnumber="${bn.n}">` +
    `<rect x="${r1n(bn.x - boxW / 2)}" y="${r1n(top)}" width="${r1n(boxW)}" height="${r1n(boxH)}" ` +
    `fill="none" stroke="#1b1b1b" stroke-width="${r1n(BAR_NUMBER_STROKE * noteScaleOf(noteSize))}"/>` +
    `<text x="${r1n(bn.x)}" y="${r1n(cy)}" text-anchor="middle" dominant-baseline="central" ` +
    `font-size="${r1n(fs)}" font-family="${noteFont(config.shuzi_font)}" fill="#1b1b1b">${text}</text>` +
    `</g>`
  )
}

// ============================================================
// 歌词绘制
// ============================================================

function renderLyric(lyric: PlacedLyric, config: PageConfig): string {
  const size = config.geci_size
  const cid = noteposId(lyric.id)
  // adj71：歌词字宽 > 对应音符占位宽 **且** 相邻歌词间距 < 字宽（任一侧密集会重叠）时，
  // 横向缩窄歌词字：缩窄到 min(槽宽, 相邻间距−1)（预留 ≥1px 间距避免文字粘黏；下限 0.5）；
  // 缩放以歌词中心为基准——左缘平移 size×(1-sx)/2，使中心仍对中音符槽中心
  // adj292：仅当页面设置开启「宽度不足时压缩文字宽度」（lyricShrink）才压缩，否则允许重叠
  const gap = lyric.gapL ?? Infinity
  const need = config.lyricShrink === true && !!lyric.slotW && lyric.slotW < size && gap < size
  const sx = need ? Math.max(Math.min(lyric.slotW!, gap - 1) / size, 0.5) : 1
  const parts = [
    // 字以 x 为左边缘，中心 = x + 字号/2（对中音符槽中心，adj40）；横向缩放时中心保持对齐
    sx < 1
      ? `<text x="0" y="${lyric.y}" transform="translate(${r1n(lyric.x + (size * (1 - sx)) / 2)},0) scale(${sx.toFixed(3)},1)" data-cipos="${cid}" font-size="${size}" font-family="${config.geci_font}" fill="#101010">${xmlEsc(lyric.char.text)}</text>`
      : `<text x="${lyric.x}" y="${lyric.y}" data-cipos="${cid}" font-size="${size}" font-family="${config.geci_font}" fill="#101010">${xmlEsc(lyric.char.text)}</text>`,
  ]
  // 引号注释（adj58）：双引号文本显示在「注释后面的歌词」前面，不占歌词对齐位（灰色小字）
  if (lyric.char.note) {
    const noteSize = Math.max(9, Math.round(size * COMMENT_FONT_RATIO))
    // 宽度估算：汉字按 1 字宽、拉丁/数字按 0.55 字宽
    const w = [...lyric.char.note].reduce(
      (acc, ch) => acc + (/\p{Script=Han}/u.test(ch) ? noteSize : noteSize * 0.55),
      0,
    )
    parts.unshift(
      `<text x="${r1n(lyric.x - w - 3)}" y="${lyric.y}" font-size="${noteSize}" font-family="${config.geci_font}" fill="#999">${xmlEsc(lyric.char.note)}</text>`,
    )
  }
  // 中文标点不占音符位，紧跟本字之后独立渲染（adj35/40）——
  // 分开渲染避免标点并入后整个文本视觉中心偏移、与音符失中
  if (lyric.char.trailing) {
    parts.push(
      `<text x="${r1n(lyric.x + size + 1)}" y="${lyric.y}" font-size="${size}" font-family="${config.geci_font}" fill="#101010">${xmlEsc(lyric.char.trailing)}</text>`,
    )
  }
  return parts.join('\n')
}

// ============================================================
// 多声部括弧与名称（M7a）
// ============================================================

/** adj276：多声部括号——左粗(2.1)右细(1.125)双竖线（间距 3px）；上下弧各自以弧两端点为轴翻转（sweep 交换）、
 *  上弧顺转 30°、下弧逆转 30°，弧 = 1/6 圆。 */
function bracePath(x: number, yTop: number, yBottom: number, noteSize: number): { arc: string; lineL: string; lineR: string } {
  const R = Math.min(noteSize / 2, (yBottom - yTop) * 0.15)
  const dx = 3 // 粗/细线间距 ×1.5（2 → 3）
  // 弧 = 1/6 圆（60°）；上下弧各以两端点为轴翻转一次（sweep 1↔0），凸向翻到另一侧
  const endX = x + R * 0.866
  const endTopY = yTop + R * 0.5
  const endBotY = yBottom - R * 0.5
  const aTop = `M ${x} ${yTop + R} A ${R} ${R} 0 0 0 ${endX.toFixed(2)} ${endTopY.toFixed(2)}`
  const aBot = `M ${x} ${yBottom - R} A ${R} ${R} 0 0 1 ${endX.toFixed(2)} ${endBotY.toFixed(2)}`
  const lineL = `M ${x} ${yTop + R} L ${x} ${yBottom - R}`
  const lineR = `M ${x + dx} ${yTop + R} L ${x + dx} ${yBottom - R}`
  return { arc: `${aTop} ${aBot}`, lineL, lineR }
}

function renderVoiceBlocks(page: ScorePage, vb: VoiceBlock, noteSize: number): string {
  const parts: string[] = []
  // 大括号：弧线/右细线 1.125（0.9×1.25）、左粗线 2.1；括号整体上移 0.1×音符高（在上移 0.2 基础上再下移 0.1，注释不动）
  const { arc, lineL, lineR } = bracePath(vb.x, vb.yTop - noteSize * 0.1, vb.yBottom - noteSize * 0.1, noteSize)
  parts.push(`<path d="${arc}" fill="none" stroke="#1b1b1b" stroke-width="1.125"/>`)
  parts.push(`<path d="${lineL}" fill="none" stroke="#1b1b1b" stroke-width="2.1"/>`)
  parts.push(`<path d="${lineR}" fill="none" stroke="#1b1b1b" stroke-width="1.125"/>`)
  // 声部名称（括弧左侧，与该声部曲部垂直居中；仅当有声部名注释时显示，无注释不显示）
  const n = vb.voices.length
  for (let i = 0; i < n; i++) {
    const v = vb.voices[i]
    if (!v.name) continue
    const cy = vb.voiceCenters?.[i] ?? vb.yTop + ((vb.yBottom - vb.yTop) * (i + 0.5)) / n
    parts.push(
      `<text x="${vb.x - 10}" y="${cy}" text-anchor="end" dominant-baseline="middle" font-size="${noteSize}" font-family="${FONT_CN}" fill="#1b1b1b">${xmlEsc(v.name)}</text>`,
    )
  }
  void page
  return parts.join('\n')
}

// ============================================================
// 跳房子渲染（M7b）
// ============================================================

/** 画一条跳房子线（起点 [ 至终点 ]；未封闭或 |]/ 开口时终点不封闭；
 *  adj107：跨行（起点与终点在不同行）时拆两半——左半到页面右边距、右半从行首小节线/边距到终点 */
function renderVoltaLine(
  start: PlacedBarline,
  end: PlacedBarline | null,
  noteSize = 18,
  marginLeft = 40,
  pageWidth = 595.28,
  marginRight = 80,
  firstOfRow?: Map<number, PlacedBarline>,
): string {
  const plus = start.voltaStart?.plus ?? 0
  const minus = start.voltaStart?.minus ?? 0
  // adj60：跳房子线基于小节线定位（距小节线上端 VOLTA_BAR_GAP，+ 修饰每级 VOLTA_RAISE 抬升、- 修饰每级降低，adj356）
  const y = start.yTop - VOLTA_BAR_GAP - plus * VOLTA_RAISE + minus * VOLTA_RAISE
  // 起止偏移（adj50）：起点 = 小节线正中右移 2px、终点 = 小节线正中左移 2px
  const x1 = start.x + 2
  const openEnd = !end || !!end.voltaEndSlash // 开口结束：无终点折线（adj26）
  const parts: string[] = []
  // 起点竖线（[ 处：从线高向下到小节线上端上方 2px，adj29；adj150 线宽 0.8；adj76：下沿下延 2px）
  parts.push(
    `<line x1="${x1}" y1="${y}" x2="${x1}" y2="${start.yTop - 2}" stroke="#1b1b1b" stroke-width="0.8"/>`,
  )
  // 番号（[ 后引号注释优先；小节线引号备注兼容）显示在跳房子线下方（adj27/28）；
  // adj71：字号 = 音符高度的 0.5（VOLTA_COMMENT_FONT_RATIO），随音符字号
  // adj77：注释相对起点竖线 左上移 2px（x=x1+2、y=线+8）
  const label = start.voltaStart?.comment ?? start.comment
  const labelSvg = label
    ? `<text x="${x1 + 2}" y="${y + 8}" font-size="${Math.max(8, Math.round(noteSize * VOLTA_COMMENT_FONT_RATIO))}" font-family="${FONT_CN}" fill="#1b1b1b">${xmlEsc(label)}</text>`
    : ''
  if (end && end.yTop !== start.yTop) {
    // 跨行：左半（起点行）延伸到页面右边距（adj162：与跨行连音线一致——
    // 上一行横线贯穿到右侧边距）；右半从下一行行首小节线（有则从其开始，
    // 与连音线 rowStartBarX 一致）否则从行首边距开始，连到终点小节线
    const xEndA = pageWidth - marginRight
    parts.push(
      `<line x1="${x1}" y1="${y}" x2="${xEndA}" y2="${y}" stroke="#1b1b1b" stroke-width="0.8"/>`,
    )
    parts.push(labelSvg)
    const yB = end.yTop - VOLTA_BAR_GAP - plus * VOLTA_RAISE + minus * VOLTA_RAISE
    const rowFirst = firstOfRow?.get(end.yTop)
    const xStartB =
      rowFirst && rowFirst.x < end.x - 2 ? rowFirst.x : marginLeft + 2
    const x2B = end.x - 2
    parts.push(
      `<line x1="${xStartB}" y1="${yB}" x2="${x2B}" y2="${yB}" stroke="#1b1b1b" stroke-width="0.8"/>`,
    )
    if (!openEnd) {
      parts.push(
        `<line x1="${x2B}" y1="${yB}" x2="${x2B}" y2="${end.yTop - 2}" stroke="#1b1b1b" stroke-width="0.8"/>`,
      )
    }
    return parts.join('\n')
  }
  const x2 = end ? end.x - 2 : start.x + 60
  // 水平线（adj150 线宽 0.8）
  parts.push(
    `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#1b1b1b" stroke-width="0.8"/>`,
  )
  // 终点折线（] 处：向下到小节线上端上方 2px，adj29；开口结束不画；adj150 线宽 0.8；adj76：下沿下延 2px）
  if (end && !openEnd) {
    parts.push(
      `<line x1="${x2}" y1="${y}" x2="${x2}" y2="${end.yTop - 2}" stroke="#1b1b1b" stroke-width="0.8"/>`,
    )
  }
  parts.push(labelSvg)
  return parts.join('\n')
}

/** 渲染页内全部跳房子线（配对 [ ]；未闭合 [ 向右延伸） */
function renderVoltas(
  barlines: PlacedBarline[],
  noteSize = 18,
  marginLeft = 40,
  pageWidth = 595.28,
  marginRight = 80,
  notes?: PlacedToken[],
): string {
  const parts: string[] = []
  // adj164：按行（yTop 容差匹配，避免浮点误差）求「真正的行首小节线」
  // （位于该行首音符左侧，与连音线 rowStartBarX 语义一致），供跨行跳房子
  // 右半从下一行行首小节线开始；行首无小节线则从边距+2 开始
  const rows = new Map<number, PlacedBarline[]>()
  for (const bar of barlines) {
    const arr = rows.get(bar.yTop) ?? []
    arr.push(bar)
    rows.set(bar.yTop, arr)
  }
  const firstOfRow = new Map<number, PlacedBarline>()
  for (const [y, arr] of rows) {
    arr.sort((a, b) => a.x - b.x)
    // 该行首音符 x（音符基线 y - 18.4 = 小节线 yTop，容差 1px）
    let firstNoteX: number | undefined
    if (notes) {
      for (const n of notes) {
        if (Math.abs(n.y - 18.4 - y) < 1 && (firstNoteX === undefined || n.x < firstNoteX)) {
          firstNoteX = n.x
        }
      }
    }
    const lead =
      firstNoteX !== undefined ? arr.find((b) => b.x < firstNoteX) : arr[0]
    if (lead) firstOfRow.set(y, lead)
  }
  let open: PlacedBarline | null = null
  for (const bar of barlines) {
    // adj139：一根小节线可同时 voltaEnd（闭合上一段）与 voltaStart（开启下一段）
    // —— 连续跳房子共用同一小节线（|["1" …|]["2" …|]）
    if (bar.voltaEnd && open) {
      parts.push(renderVoltaLine(open, bar, noteSize, marginLeft, pageWidth, marginRight, firstOfRow))
      open = null
    }
    if (bar.voltaStart) {
      if (open) parts.push(renderVoltaLine(open, null, noteSize, marginLeft, pageWidth, marginRight, firstOfRow)) // 未闭合上一段
      open = bar
    }
  }
  if (open) parts.push(renderVoltaLine(open, null, noteSize, marginLeft, pageWidth, marginRight, firstOfRow))
  return parts.join('\n')
}

// ============================================================
// 连音线绘制（M7c）
// ============================================================

/** adj459：测试用导出——直接调用 renderSlur，便于在不依赖布局的情况下核对路径与弧线半径 */
export function renderSlurForTest(s: PlacedSlur, noteSize = 18): string {
  return renderSlur(s, noteSize)
}

function renderSlur(s: PlacedSlur, noteSize = 18): string {
  const { x1, x2, y } = s
  // 平均连音组标注（adj43）：仅 (y...) 组在弧线/横线正中画数字（不透明背景）；
  // 普通连音线 (…) 不标注。数字向下偏移 2px 使其居于线正中。
  // adj89：数字字号 = 音符字号 × TUPLET_NUM_RATIO（默认 0.2，可调常量）
  const label = (cx: number, cy: number): string => {
    if (!s.tupletCount || s.tupletCount < 2) return ''
    const size = Math.max(7, Math.round(noteSize * TUPLET_NUM_RATIO))
    const text = String(s.tupletCount)
    // adj222：不透明背景只包裹文字字形——数字宽 ≈ 0.62em/字 + 两侧各 1px 空隙；
    // 原 max(14, n×7+3) 白底远大于字形（单数字 14px vs 字形约 4px），大片白块遮线
    const w = text.length * size * TUPLET_NUM_W_RATIO + TUPLET_LABEL_PAD * 2
    const dy = 2 // 数字下移 2px → 位于线正中
    return (
      `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - size + 1 + dy).toFixed(1)}" width="${w.toFixed(1)}" height="${size}" rx="2" fill="#ffffff"/>` +
      `<text x="${cx.toFixed(1)}" y="${(cy + dy).toFixed(1)}" text-anchor="middle" font-size="${size}" font-family="${FONT_CN}" fill="#1b1b1b">${text}</text>`
    )
  }
  if (s.style === 'flat') {
    // adj96：嵌套内层（depth>0）连音线高度少 1px（横线更贴音符，层次更分明）
    // adj148：平顶线高度 leg 由 7 减小到 5（更贴音符）
    const leg = 5 - (s.depth > 0 ? 1 : 0)
    const barY = y - leg
    // adj147：弧线 = 标准 1/4 圆弧（SVG A 命令），半径 = 平顶线高度 leg，
    // 从音符竖直上弯、平滑转水平接横线（真正的圆弧，非贝塞尔近似）。
    // adj459：弧线半径**统一**为 leg，与连音线总长无关——
    //   完整连音线（无 half）：两端各占一段，R 受半段约束（span<12 时收缩，避免两弧重叠）
    //   半条连音线（half=l/r，仅一端有弧）：R 占满整段 span-1，不再随总长收缩
    //   → 无论跨行连音线跨多远，端点弧线都是同一个标准半径，观感统一
    const R = s.half
      ? Math.min(leg, Math.abs(x2 - x1) - 1)
      : Math.min(leg, Math.abs(x2 - x1) / 2 - 1)
    if (s.half === 'l') {
      // 左半部：1/4 圆弧（音符竖直上弯转水平）+ 横线平直延伸到行末（右侧开口）
      return (
        `<path d="M ${x1} ${y} ` +
        `A ${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${(x1 + R).toFixed(1)} ${barY} ` +
        `L ${x2} ${barY}" ` +
        `fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>`
      )
    }
    if (s.half === 'r') {
      // 右半部：横线从行首平直伸来（左侧开口）+ 1/4 圆弧弯到音符（凸右上，sweep=1 与左半镜像）
      return (
        `<path d="M ${x1} ${barY} ` +
        `L ${(x2 - R).toFixed(1)} ${barY} ` +
        `A ${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${x2} ${y}" ` +
        `fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>`
      )
    }
    // 完整：两端 1/4 圆弧弯到平顶线 + 中间横线；正中标连音组数字
    const midX = (x1 + x2) / 2
    return (
      `<path d="M ${x1} ${y} ` +
      `A ${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${(x1 + R).toFixed(1)} ${barY} ` +
      `L ${(x2 - R).toFixed(1)} ${barY} ` +
      `A ${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${x2} ${y}" ` +
      `fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>` +
      label(midX, barY)
    )
  }
  // 圆弧（adj96：嵌套内层 depth>0 高度少 1px，弧线更贴音符）
  const topY = y - (s.depth > 0 ? 3.5 : 4.5) // 弧线最高点（与完整弧线顶点同高）
  if (s.half === 'l') {
    // 左半部：从最低处（x1,y）竖直向上出发，行末为最高点（x2, topY），右侧开口
    return (
      `<path d="M ${x1} ${y} C ${x1} ${(y - 9).toFixed(1)} ${x2} ${topY.toFixed(1)} ${x2} ${topY.toFixed(1)}" ` +
      `fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>`
    )
  }
  if (s.half === 'r') {
    // 右半部：行首为最高点（x1, topY）水平出发，到最低处（x2,y）竖直向下，左侧开口
    return (
      `<path d="M ${x1} ${topY.toFixed(1)} C ${x1} ${topY.toFixed(1)} ${x2} ${(y - 9).toFixed(1)} ${x2} ${y}" ` +
      `fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>`
    )
  }
  // 完整：二次贝塞尔（两端低、中间高）；正中（顶点）标连音组数字
  const midX = (x1 + x2) / 2
  const midY = y - 9
  return (
    `<path d="M ${x1} ${y} Q ${midX} ${midY} ${x2} ${y}" fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>` +
    label(midX, topY)
  )
}

// ============================================================
// 渐强渐弱与波浪线（M7d）
// ============================================================

/** 颤音尾部正弦波（adj113 正弦；adj115：幅度 = 原 1/3、周期数由调用方按音符点位传入） */
function wavePath(x1: number, y: number, x2: number, w = 1, cycles = 3): string {
  const amp = 2.5 / 3 // 幅度（adj115：原 2.5 的 1/3）
  const wl = (x2 - x1) / Math.max(1, cycles) // 波长 = 总长/周期数
  let d = `M ${x1} ${y}`
  const n = Math.max(8, Math.round(x2 - x1))
  for (let i = 1; i <= n; i++) {
    const x = x1 + ((x2 - x1) * i) / n
    const yy = y - amp * Math.sin(((x - x1) / wl) * 2 * Math.PI)
    d += ` L ${x.toFixed(1)} ${yy.toFixed(1)}`
  }
  return `<path d="${d}" fill="none" stroke="#1b1b1b" stroke-width="${w}"/>`
}

function renderDynamic(d: PlacedDynamic, noteSize = 18): string {
  // adj：渐强渐弱 "<" / ">" 每 +1 提升数级（类似跳房子），整体上移 VOLTA_RAISE×plus；
  // 记号为开口尖括号（两条线从尖点向内/外张开，非梯形闭合）；张开半高随音符字号缩放
  const midY = d.y - (d.plus ?? 0) * VOLTA_RAISE
  const h = DYN_HALF_H * noteScaleOf(noteSize)
  if (d.type === 'crescendo') {
    // 渐强：尖在左（起点音符正中），向右上/右下张开成开口尖括号 "<"
    return `<path d="M ${d.x1} ${midY} L ${d.x2} ${midY - h} M ${d.x1} ${midY} L ${d.x2} ${midY + h}" fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>`
  }
  // 渐弱：尖在右（起点音符正中），向左上/左下张开成开口尖括号 ">"
  return `<path d="M ${d.x2} ${midY} L ${d.x1} ${midY - h} M ${d.x2} ${midY} L ${d.x1} ${midY + h}" fill="none" stroke="#1b1b1b" stroke-width="${SLUR_W}"/>`
}

// ============================================================
// 减时线分组（adj3：同一拍内相连）
// ============================================================

interface Beam {
  x1: number
  x2: number
  y: number
  /** adj629b：线高（段层里已 ÷k 补偿，压扁后仍是 BEAM_H；缺省 = BEAM_H） */
  h?: number
  /**
   * adj629b：该减时线所属**段层**的纵向压缩比与不动点（基线）——
   * 段层整层用一个 `<g>` 压扁，减时线高度在存储坐标里已补偿（`h`），
   * 这里只用于把该 beam 归到"哪一层"的组里。主旋律缺省（= 1）。
   */
  layerScale?: number
  layerBase?: number
}

/**
 * 计算减时线横线组：
 * 第 n 条横线连接「相邻且减时线数 ≥ n」的音符（相邻判定见 linked）。
 * 例：1/2/ → 1 条（整拍连）；1/2/3/4/ → 拍 1 连、拍 2 连（中间断开）；
 *     1//2//3//4// → 2 条（各整拍连）；1//2//3/ → 第 1 条全连、第 2 条连 1//2//
 */
function computeBeams(notes: PlacedToken[], noteSize = 18): Beam[] {
  const beams: Beam[] = []
  const digitW = noteSize * 0.62
  // adj219：近整数归整——浮点拍位（0.9999…）误判拍边界（同布局 adj217/218）
  const beatOf = (v: number) => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : Math.floor(v))
  /**
   * adj397：相邻两音符是否共用同一条减时线（**逐对判定**，不再按"分组桶"比较）：
   *  ① 同属一个等时值连音组 `(y...)` → 相连（跨拍也不断开，adj395 保留）；
   *  ② 否则只要落在**同一拍**内 → 相连。
   * 旧实现「组号优先」把连音组音符与同拍组外音符分到两个桶里，于是
   * `2/. 3// 5/ (y5// 6// 5//) …` 中 5/（拍 2 起点）与组首音（拍 2 内）各自成线、
   * 减时线在谱面上断开——而二者本在同一拍内，按拍相连才是简谱的书写习惯。
   */
  const linked = (a: PlacedToken, b: PlacedToken): boolean => {
    const ga = a.token.tupletGroup
    if (ga !== undefined && ga === b.token.tupletGroup) return true
    return beatOf(a.beatPos) === beatOf(b.beatPos)
  }
  const groups = new Map<string, PlacedToken[]>()
  for (const n of notes) {
    const key = `${n.y}|${n.barIndex}`
    const arr = groups.get(key) ?? []
    arr.push(n)
    groups.set(key, arr)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.beatPos - b.beatPos)
    const maxLevel = Math.max(0, ...list.map((n) => n.token.diminishCount))
    for (let level = 1; level <= maxLevel; level++) {
      let i = 0
      while (i < list.length) {
        if (list[i].token.diminishCount < level) {
          i++
          continue
        }
        let j = i
        while (j + 1 < list.length && linked(list[j], list[j + 1]) && list[j + 1].token.diminishCount >= level) {
          j++
        }
        // adj411：组尾音符带附点时，减时线**延伸到附点下面**——`1//2/.` 里 2 的减时线
        // 原本止于数字右缘，而附点画在数字右侧（一拍的后半），线在谱面上"提前断了"；
        // 附点右缘与该音符时值宽度一致（附点属于该音符），故取两者的较大值。
        const dotRight = dotRightEdgeOf(list[j], noteSize)
        const digitRight = list[j].x + digitW - 1
        beams.push({
          x1: r1n(list[i].x + 1),
          x2: r1n(dotRight !== null ? Math.max(digitRight, dotRight) : digitRight),
          // adj60/69：减时线层贴数字底（LAYER_GAP×s），层内线距 INNER_GAP×s，随字号
          // adj629b：段层——"基线→块顶"照常随整层压扁，块内（层距/线高）÷k 补偿成原尺寸
          y: r1n(
            list[i].y +
              (DIGIT_BOTTOM + LAYER_GAP) * noteScaleOf(noteSize) +
              layerBlockDiv((level - 1) * (BEAM_H + INNER_GAP) * noteScaleOf(noteSize), list[i].layerScale ?? 1),
          ),
          h: r1n(layerBlockDiv(BEAM_H, list[i].layerScale ?? 1)),
          layerScale: list[i].layerScale,
          layerBase: list[i].layerScale !== undefined ? list[i].y : undefined,
        })
        i = j + 1
      }
    }
  }
  return beams
}

const r1n = (v: number) => Math.round(v * 10) / 10

/** 供冒烟测试：计算减时线横线组 */
export function computeBeamsForTest(notes: PlacedToken[], noteSize = 18): Beam[] {
  return computeBeams(notes, noteSize)
}

/**
 * adj629b：把同一段层的元素收进**一个** `<g transform>`（用户要求"整体压扁，而不是逐个元素压"）。
 * 键 = `压缩比|层基线`；同层元素（数字/减时线/括号/小节线/连音线）在页组装时归到同一组，
 * 最后一次性包一层 `<g>`。
 */
function layerGroupKey(layerScale: number | undefined, layerBase: number | undefined): string | null {
  if (layerScale === undefined || layerScale === 1 || layerBase === undefined) return null
  return `${Math.round(layerScale * 1000) / 1000}|${layerBase}`
}

function renderBeams(beams: Beam[], collect?: (html: string, layerScale?: number, layerBase?: number) => void): string {
  return beams
    .map((b) => {
      const html = `<rect x="${b.x1}" y="${b.y}" width="${Math.max(1, b.x2 - b.x1)}" height="${b.h ?? BEAM_H}" fill="#1b1b1b"/>`
      // 有收集器（页组装）：交给调用方按层归组，最后统一包一层 `<g>`——此处**不再**单独包（否则双重包裹）
      if (collect) {
        collect(html, b.layerScale, b.layerBase)
        return html
      }
      return segmentYScaleWrap(html, b.layerScale, b.layerBase)
    })
    .join('\n')
}

// ============================================================
// 页面组装
// ============================================================

/**
 * 页号（adj42）：多页时渲染在页面内、下边距线与页面边沿之间垂直居中
 *  - x = 页面水平中心（text-anchor middle）
 *  - y = 下边距线（height - margin_bottom）与页面底边沿（height）的中点
 *  - 仅多页（pageCount > 1）时输出，与预览页脚行为一致；单页不画
 */
function renderPageNum(page: ScorePage, config: PageConfig, pageCount: number): string {
  if (pageCount <= 1) return ''
  const size = 11
  const bandTop = page.height - config.margin_bottom
  const centerY = (bandTop + page.height) / 2
  const baseline = centerY + size * 0.35
  const label = `第 ${page.index + 1} / ${pageCount} 页`
  return (
    `<text data-pagenum="1" x="${(page.width / 2).toFixed(1)}" y="${baseline.toFixed(1)}" text-anchor="middle" font-size="${size}" font-family="${FONT_CN}" fill="#8a8a8a">${xmlEsc(label)}</text>`
  )
}

/**
 * 渲染独立标记（&zkh/&ykh 括号、&hx 呼吸记号）——放在插位、垂直居中于数字
 * （dominant-baseline=central 使字符中心对齐数字中心）。
 * adj375：&hx 已独立化——画呼吸记号（单线 V、尖朝下，adj112 的既有画法），
 * 位置取「占位中心 x」以及**略高于数字**的 y（呼吸记号画在音符右上方，不用数字基线中心）。
 */
function renderBracket(
  b: {
    code: 'zkh' | 'ykh' | 'hx'
    dir: 'open' | 'close'
    x: number
    yTop: number
    width: number
    layerScale?: number
    layerBase?: number
  },
  config: PageConfig,
): string {
  const size = config.note_size
  if (b.code === 'hx') {
    // adj180：线宽 0.8（不加粗）、横向尺寸 80%（3.5s → 2.8s）。
    // 纵向与旧「依附音符」画法一致：旧式为 `音符基线 - 0.8×字号 - 4s`，而括号/标记的
    // yTop = 行顶 + 0.7×字号 = 数字中心 = 基线 - 0.4×字号 → 基线 = yTop + 0.4×字号。
    const s = noteScaleOf(size)
    const hw = 3.5 * s * 0.8
    const cy = b.yTop - size * 0.4 - 4 * s
    return `<path d="M ${r1n(b.x - hw)} ${r1n(cy - 3 * s)} L ${r1n(b.x)} ${r1n(cy + 3 * s)} L ${r1n(b.x + hw)} ${r1n(cy - 3 * s)}" fill="none" stroke="#1b1b1b" stroke-width="0.8"/>`
  }
  const glyph = b.dir === 'open' ? '(' : ')'
  // adj629b：段层括号**字号不变**，随整层一起压扁——压扁由页组装的整层 `<g>` 统一做，这里不再单独包
  return `<text x="${r1n(b.x)}" y="${r1n(b.yTop)}" text-anchor="middle" dominant-baseline="central" font-weight="bold" font-size="${size}" font-family="${noteFont(config.shuzi_font)}" fill="#1b1b1b">${glyph}</text>`
}

/**
 * adj427：临时段（`{bz … }` / `{dsb … }`）的**跨两层大花括号** `{ … }`（dsb 专用）。
 *
 * - 位置由**布局层**给出：`x1` / `x2` 是大括号所占槽位的**左缘**（已排在小节线**内侧**且留了
 *   与小节线的净距）；`yTop` / `yBottomLower` 由布局层按**上下两层音符的外沿**给出
 *   （上过上一行音符上沿、下过下一行音符下沿），故能真正"包住"。
 * - 形状：**自绘描边路径**（`M/Q/L` + `stroke`）——粗细变化版本（自绘填充轮廓 / 字体字形）
 *   经试用观感都不合适，按用户要求**先回退到这种最简绘制方式**；笔画为**细描边**。
 *   路径只在**自己的占宽槽位内**（左 `{` 占 `[x1, x1+w]`、右 `}` 占 `[x2, x2+w]`），不外扩。
 * - 圆括号 `( … )` 不在这里画——由布局层发成 `page.brackets`（`zkh`/`ykh` 文本字形），
 *   与全项目其它括号同一套渲染与纵向基准（字形中心 = 数字中心）。
 */
function renderSegmentBracket(b: PlacedSegmentBracket, config: PageConfig): string {
  const lo = b.yBottomLower
  if (b.type !== 'dsb' || lo === undefined || lo <= b.yTop) return ''
  const ns = config.note_size
  /** 大括号横向占宽——与布局层 `braceW` 同源（`max(3, 0.32×字号)`） */
  const w = Math.max(3, ns * 0.32)
  /** 细描边（先不做粗细变化） */
  const sw = Math.max(1, ns * 0.1)
  const cw = w / 2
  const yTop = b.yTop
  const yBot = lo
  const my = (yTop + yBot) / 2
  /**
   * 单个花括号：两端尖端在中轴一侧、中间尖角在另一侧。
   * dir=-1 → `{`（cusp 朝左、两端朝右）→ 传 `x = 槽位右缘`，形状正好占满 `[x−w, x]`；
   * dir=+1 → `}`（镜像）→ 传 `x = 槽位左缘`，形状占满 `[x, x+w]`。
   */
  const brace = (x: number, dir: 1 | -1): string =>
    `<path d="M ${r1n(x)} ${r1n(yTop)} ` +
    `Q ${r1n(x + dir * cw * 2)} ${r1n(yTop)} ${r1n(x + dir * cw)} ${r1n(yTop + cw)} ` +
    `L ${r1n(x + dir * cw)} ${r1n(my - cw)} ` +
    `Q ${r1n(x + dir * cw)} ${r1n(my)} ${r1n(x + dir * cw * 2)} ${r1n(my)} ` +
    `Q ${r1n(x + dir * cw)} ${r1n(my)} ${r1n(x + dir * cw)} ${r1n(my + cw)} ` +
    `L ${r1n(x + dir * cw)} ${r1n(yBot - cw)} ` +
    `Q ${r1n(x + dir * cw)} ${r1n(yBot)} ${r1n(x)} ${r1n(yBot)}" ` +
    `fill="none" stroke="#1b1b1b" stroke-width="${r1n(sw)}" stroke-linecap="round" data-segment-brace="${b.type}"/>`
  return brace(b.x1 + w, -1) + brace(b.x2, 1)
}

function renderPage(page: ScorePage, config: PageConfig, pageCount: number, opts?: RenderFontMeta): string {
  const { width, height } = page
  const body: string[] = []

  // 描述头（标题/作者/调号/拍号/节拍）仅第一页显示，后续页面不重复
  if (page.index === 0) body.push(renderMeta(page, config, opts))
  body.push(renderVoltas(page.barlines, config.note_size, config.margin_left, width, config.margin_right, page.notes)) // 跳房子线画在最底层
  /**
   * adj629b（用户要求）：**临时叠加层整层压扁**——把同一段层的元素（连音线/减时线/数字/括号/小节线）
   * 先按 `压缩比|层基线` 归组，页末一次性各包一层 `<g transform>`，而不是逐个元素各包一层。
   * 主旋律元素（键为 null）照原顺序直接进 `body`。
   */
  const layerGroups = new Map<string, string[]>()
  const pushEl = (html: string, layerScale?: number, layerBase?: number): void => {
    if (html === '') return
    const key = layerGroupKey(layerScale, layerBase)
    if (key === null) {
      body.push(html)
      return
    }
    const arr = layerGroups.get(key)
    if (arr) arr.push(html)
    else layerGroups.set(key, [html])
  }
  const flushLayerGroups = (): void => {
    for (const [key, els] of layerGroups) {
      const [ks, bs] = key.split('|')
      body.push(segmentYScaleWrap(els.join('\n'), Number(ks), Number(bs)))
    }
    layerGroups.clear()
  }
  for (const s of page.slurs) pushEl(renderSlur(s, config.note_size), s.layerScale, s.layerBase)
  for (const d of page.dynamics) pushEl(renderDynamic(d, config.note_size))
  renderBeams(computeBeams(page.notes, config.note_size), (html, ls, lb) => pushEl(html, ls, lb))
  for (const n of page.notes) pushEl(renderNote(n, config), n.layerScale, n.y)
  // adj294：&zkh/&ykh 独立括号标记——按插位画括号
  for (const b of page.brackets) pushEl(renderBracket(b, config), b.layerScale, b.layerBase)
  // adj427：临时段（{bz … } / {dsb … }）叠加层括弧——段内容音符已并入 page.notes 一并绘制
  for (const sb of page.segmentBrackets ?? []) body.push(renderSegmentBracket(sb, config))
  for (const b of page.barlines)
    pushEl(renderBarline(b, config.note_size, noteFont(config.shuzi_font)), b.layerScale, b.layerBase)
  flushLayerGroups() // 段层的所有元素在此一次性包一层 <g> 压扁
  // adj625：方框小节序号（「显示小节计数」）——画在小节线下方，数字与方框 = 倚音字号 × 3/4
  for (const bn of page.barNumbers) body.push(renderBarNumber(bn, config))
  for (const l of page.lyrics) body.push(renderLyric(l, config))
  for (const vb of page.voiceBlocks) body.push(renderVoiceBlocks(page, vb, config.note_size))
  body.push(renderPageNum(page, config, pageCount))

  // 说明文字（adj83：S 行，多行；渲染在简谱主体最末尾——最后一页正文下方、下边距线上方，
  // adj154：用独立的说明字体字号 notes_font/notes_size（默认沿用描述头）；
  // adj151：左对齐（text-anchor=start、x=左边距）、颜色与 P:/J: 一致，
  // 每段 data-meta="notes_i" 可独立拖拽调整位置，metaPos["notes_i"] 为相对默认的偏移；
  // adj153：内容不超边距——超宽自动换行成子行（data-notes-sub）、x 钳制在左右边距内）
  if (page.index === pageCount - 1 && page.meta.notes.length > 0) {
    const nFont = config.notes_font ?? config.miaoshu_font
    const nSize = config.notes_size ?? config.miaoshu_size
    const baseX = config.margin_left
    const baseY = height - config.margin_bottom - 24
    // 可用宽 = 左右边距之间（adj153：文本不超此范围）
    const availW = Math.max(width - config.margin_left - config.margin_right, 10)
    for (let i = 0; i < page.meta.notes.length; i++) {
      const line = page.meta.notes[i]
      // adj151：新 metaPos["notes_i"] 相对左边距基准；兼容旧 metaPos["notes"]
      // （adj83 语义：相对页面居中）——旧偏移按居中基准解释，避免位置出页面
      const p = config.metaPos?.[`notes_${i}`]
      const pOld = config.metaPos?.['notes']
      const pos = p
        ? { x: baseX + p.x, y: baseY + i * nSize * 1.4 + p.y }
        : pOld
          ? { x: width / 2 + pOld.x, y: baseY + i * nSize * 1.4 + pOld.y }
          : { x: baseX, y: baseY + i * nSize * 1.4 }
      // adj153：超宽自动换行（字符级估算宽、随字号缩放），每子行一个 text
      const subs = wrapNotesLine(line, availW, nSize)
      for (let k = 0; k < subs.length; k++) {
        const sub = subs[k]
        const subW = metaTextW(sub) * (nSize / 13)
        // 钳制：文字整体在 [左边距, 右边距 - 文本宽] 内，右缘不超右边距
        const maxX = width - config.margin_right - subW
        const x = Math.min(Math.max(pos.x, baseX), maxX)
        body.push(
          `<text data-meta="notes_${i}" data-notes-line="${i}" data-notes-sub="${k}" x="${r1n(x)}" y="${r1n(pos.y + k * nSize * 1.4)}" text-anchor="start" font-size="${nSize}" font-family="${nFont}" fill="#1b1b1b">${xmlEsc(sub)}</text>`,
        )
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    /**
     * adj629n：页面白底 rect 带 `data-page-bg` 标记——宿主（预览层）需要把它透明化时
     * **必须按这个标记选**，不能用 `rect:first-child`：
     * 段层（`{bz}`/`{dsb}`/`{tp}`）整层被包在一个 `<g>` 里，而那个 `<g>` 的**第一个子元素
     * 正是该层的第一条减时线 rect** ⇒ `rect:first-child` 会把它一起选中、fill 变透明
     * （用户报「伴奏里的 `0/ 2/` 预览里下面没有减时线」——同层第二条线却正常）。
     */
    `<rect data-page-bg="1" x="0" y="0" width="100%" height="100%" fill="#ffffff"/>` +
    body.join('\n') +
    `</svg>`
  )
}

/** 将排版结果渲染为 SVG 页面数组；opts 提供浏览器实测的 "1 = " 宽与 ♯ 宽（按字体实际宽度摆放角标） */
export function renderScoreToSvg(layout: ScoreLayout, opts?: RenderFontMeta): string[] {
  return layout.pages.map((p) => renderPage(p, layout.config, layout.pages.length, opts))
}
