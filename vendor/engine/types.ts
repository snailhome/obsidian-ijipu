/**
 * engine/types.ts — iJipu 简谱引擎核心类型
 *
 * 语法依据：原「番茄简谱」脚本说明手册（doc.lezhi99.com/zhipu）完整逆向，
 * 兼容 .jps 标记语言 V1.0。
 *
 * 本文件只包含纯类型定义，无任何运行时逻辑，是 parser / layout / render /
 * playback 各模块的共同契约。引擎保持零 React 依赖，可独立单测。
 */

// ============================================================
// 源码位置
// ============================================================

/** 源码位置：line 为 1-based 行号，col 为 0-based 行内字符偏移 */
export interface SourcePos {
  line: number
  col: number
}

// ============================================================
// 描述头（Header）
// ============================================================

/**
 * 描述头字段。语法（大写字母，可多次出现）：
 *  V: 版本号（必须）    B: 标题（首个为主标题，后续为副标题）
 *  Z: 作者（可多次）    D: 调式（字母 + #/$ 升降）
 *  P: 拍号（4/4，可多个，辅助拍号加括号）   J: 节拍（数字=每分钟拍数，或文字）
 */
export interface Header {
  version?: string
  /** 标题列表：第一项为主标题，其余为副标题 */
  titles: string[]
  /** 作者列表（居右显示，从上到下） */
  authors: string[]
  /** 调式：如 "C"、"#D"、"$E"（$ 表示降） */
  key?: string
  /** 拍号字符串：如 "4/4"、"6/8"、"4/4 (2/4)" */
  meter?: string
  /** 节拍：数字或文字（或两者并存，如 "90"、"欢快地"）；多条 J 时最后一条 */
  tempo?: string
  /** 节拍数字（J 的数字部分，如 "80"；多条 J 取最后一条数字） */
  tempoNum?: string
  /** 节拍文字（J 的文字部分，如 "欢快地"；多条 J 的文字用空格连接） */
  tempoText?: string
  /** 乐器列表（Y 行，可多行，一行一种乐器；为多声部试听演奏预留，adj83） */
  instruments: string[]
  /** 说明文字列表（S 行，可多行；渲染在简谱主体最末尾，adj83） */
  notes: string[]
}

// ============================================================
// 行（Line）—— 解析后的源码行 AST
// ============================================================

/** 所有行的公共基 */
export interface LineBase {
  /** 行在源文件中的位置 */
  pos: SourcePos
  /** 原始行文本（不含换行符） */
  raw: string
}

/** 描述头行：如 "B: 排排坐" */
export interface HeaderLine extends LineBase {
  kind: 'header'
  /** 字段字母：V | B | Z | D | P | J */
  key: string
  /** 字段值（去除 "key:" 前缀与首尾空白） */
  value: string
}

/** 曲行（Q 开头）：一行音符 */
export interface MusicLine extends LineBase {
  kind: 'music'
  /** 声部编号（Q 后数字，缺省为 1；0 表示无编号） */
  voice: number
  /** 声部名称（如 Q1"女声"），可选 */
  voiceName?: string
  /** 音符 token 序列 */
  tokens: MusicToken[]
}

/** 词行（C 开头）：一行歌词，依附于上一个 Q 行 */
export interface LyricLine extends LineBase {
  kind: 'lyric'
  /** 声部编号（C 后数字） */
  voice: number
  /** 歌词字符序列（每个元素对应一个音符） */
  chars: LyricChar[]
}

/** 分页行：单独一行 "[fenye]" */
export interface PageBreakLine extends LineBase {
  kind: 'pagebreak'
}

/** 注释行（# 开头，仅在行首为 # 时是注释） */
export interface CommentLine extends LineBase {
  kind: 'comment'
}

/** 空行 */
export interface EmptyLine extends LineBase {
  kind: 'empty'
}

/** 未识别的行 */
export interface UnknownLine extends LineBase {
  kind: 'unknown'
}

/** 所有行类型的联合 */
export type SourceLine =
  | HeaderLine
  | MusicLine
  | LyricLine
  | PageBreakLine
  | CommentLine
  | EmptyLine
  | UnknownLine

// ============================================================
// 音乐 token（MusicToken）
// ============================================================

/**
 * 音符（音符块）。语法：[(] 数字 [高低音点] [变音] [减时线] [增时线] [附点] [装饰符号] [倚音] [")"] ["注释"]
 *  - 变音写在数字后方：# 升、$ 降、= 还原（adj23）；
 *  - 虚音符：数字用括号包住 (1)，括号紧贴数字，是音符块的一部分（adj23）；
 *  - 倚音：1[65] 前倚音 / 1[h65] 后倚音，紧跟音符数字，是音符块的一部分（adj23）；
 *  - 例：1' 高音、1, 低音、1# 升、1$ 降、1= 还原、1/ 八分音符、1-- 全音符、1. 附点、1&tr 颤音、(1) 虚音符、1[65] 前倚音、1[h56] 后倚音
 */
export interface NoteToken {
  kind: 'note'
  /** 音级 1-7 */
  pitch: 1 | 2 | 3 | 4 | 5 | 6 | 7
  /** 八度偏移：正数=高音点个数（'），负数=低音点个数（,），0=中音 */
  octaveShift: number
  /** 变音记号：# 升、$ 降、= 还原、null 无 */
  accidental: '#' | '$' | '=' | null
  /** 增时线数量（- 的个数，每条 +1 拍） */
  augmentCount: number
  /** 减时线数量（/ 的个数，n 条 = 1/2^n 拍） */
  diminishCount: number
  /** 附点数量（. 的个数，1 个 ×1.5，2 个 ×1.75） */
  dots: number
  /** 平均连音组（(y...)）覆盖时值：组内音符均分括号总时值 */
  tupletDur?: number
  /** 装饰符号编码列表（& 开头，如 tr、mp；< > 渐强渐弱另见 DecorationToken） */
  symbols: string[]
  /** 虚音符：(1) 括号修饰，弱奏装饰，不占额外拍（adj23） */
  ghost?: boolean
  /** 倚音：1[65] 前倚音 / 1[h65] 后倚音，不占拍，紧跟音符数字（adj23） */
  gracenotes?: { after: boolean; notes: GracenoteNote[] }
  /** 音符注释（音符后引号内容），如 1"渐强" */
  comment?: string
  /** 该 token 在行内的起始字符偏移 */
  pos: number
  /** 原始文本 */
  raw: string
}

/** 倚音音符（[] 或 [h] 内，adj23）：可含高低音点 ' ,、变音 # $ =、减时线 / */
export interface GracenoteNote {
  /** 音级 1-7 */
  pitch: 1 | 2 | 3 | 4 | 5 | 6 | 7
  /** 八度偏移：正数=高音点（'），负数=低音点（,） */
  octaveShift: number
  /** 变音记号：# 升、$ 降、= 还原 */
  accidental: '#' | '$' | '=' | null
  /** 减时线数量（/） */
  diminishCount: number
}

/** 休止符：0 可见，8 隐藏（占空间不显示） */
export interface RestToken {
  kind: 'rest'
  /** false=可见休止符 0；true=隐藏休止符 8 */
  hidden: boolean
  /** 时值标记（同 NoteToken 的 - / .） */
  augmentCount: number
  diminishCount: number
  dots: number
  /** 平均连音组覆盖时值 */
  tupletDur?: number
  /** 装饰符号编码列表（& 开头，如 zkh/ykh 括号等，adj84） */
  symbols: string[]
  comment?: string
  pos: number
  raw: string
}

/** 节奏音符 X（数字 9 表示），谱面显示为 X */
export interface RhythmToken {
  kind: 'rhythm'
  augmentCount: number
  diminishCount: number
  dots: number
  /** 平均连音组覆盖时值 */
  tupletDur?: number
  /** 装饰符号编码列表（& 开头，如 zkh/ykh 括号等，adj84） */
  symbols: string[]
  comment?: string
  pos: number
  raw: string
}

/**
 * 小节线。语法：
 *  |   单小节线      ||   双小节线（终止）
 *  |:  反复开始      :|   反复结束      :|: 反复包围
 *  |/  隐藏小节线1（不显示不占空间，用于行首跳房子等）
 *  |*  隐藏小节线2（不显示但占空间，用于单声部变多声部）
 *  ||/ 双线+隐藏
 *  [] 跳房子起点（可加 / 不封闭、+ 调高度）  ] 跳房子终点
 *  小节线后引号内容为小节线备注
 */
export type BarlineType =
  | '|'
  | '||'
  | '|:'
  | ':|'
  | ':|:'
  | '|/'
  | '|*'
  | '||/'
  | '||:'

/** 小节线修饰符（adj126：&fine 曲终 / &dc 从头反复 / &ds 大反复 / &ty 大跳跃 / &hs 花S） */
export type BarlineMark = 'fine' | 'dc' | 'ds' | 'ty' | 'hs'

export interface BarlineToken {
  kind: 'barline'
  type: BarlineType
  /** 小节线修饰符列表（adj206：同一条小节线可叠加多个，如 |&ty&ds） */
  marks?: BarlineMark[]
  /** 跳房子起点标记（adj26：[ 后修饰支持 + 抬高 / 不封闭、"注释"） */
  voltaStart?: {
    /** 是否有 "[" 起点 */
    open: boolean
    /** [/ 表示右侧不封闭 */
    slash?: boolean
    /** + 号数量，调整跳房子线高度 */
    plus?: number
    /** [ 后引号注释（跳房子番号，adj26） */
    comment?: string
  }
  /** 是否为跳房子终点 "]" */
  voltaEnd?: boolean
  /** |]/ 跳房子开口结束（终点不封闭，adj26） */
  voltaEndSlash?: boolean
  /** 纯跳房子起点（无小节线的 [，如 ] 后连续 [ 或行首），渲染不画小节线竖线（adj26） */
  voltaOnly?: boolean
  /** 小节线备注（引号内容） */
  comment?: string
  pos: number
  raw: string
}

/** 装饰记号：& 开头编码（如 &tr 颤音、&mp 力度）及渐强渐弱 < > ! */
export interface DecorationToken {
  kind: 'decoration'
  /** 编码：如 "tr"、"mp"；或 "<"、">"、">+"、"!" */
  code: string
  /** 渐强渐弱起止：crescendo | decrescendo | end（!） */
  dynamics?: 'crescendo' | 'decrescendo' | 'end'
  pos: number
  raw: string
}

/** 连音线/连音组开始/结束：( 与 )；"(y" 前缀 = 平均连音组（均分时值）；
 *  "(+"/"(y+" 前缀：+ 数量调整连音线抬升；"(-"/"(y-" 前缀：- 数量调整下降（adj136） */
export interface SlurToken {
  kind: 'slur'
  /** open=( 开始；close=) 结束 */
  dir: 'open' | 'close'
  /** "(y" 平均连音组：组内音符时值均分括号总时值 */
  tuplet?: boolean
  /** (+ 抬升数量（每级 2px，adj135） */
  plus?: number
  /** (- 下降数量（每级 2px，adj136） */
  minus?: number
  pos: number
  raw: string
}

/** 乐器切换指令（adj301）：Q 行内 @乐器名 / @@（@@=切回默认乐器）
 *  不占时值、不渲染，仅播放时切换当前乐器状态 */
export interface InstrumentToken {
  kind: 'instrument'
  /** 乐器名（@乐器名 的内容）；null = @@（切回默认乐器） */
  name: string | null
  pos: number
  raw: string
}

/**
 * 括号标记（&zkh / &ykh，adj294）：**独立无时值元素**——不再依附音符。
 * 放在源码哪个位置，就在那插入一个括号符号并占宽；对音符的时值/位置不施加影响，
 * 仅是标记符。open=( 左括号；close=) 右括号。
 */
export interface BracketToken {
  kind: 'bracket'
  /** open=( 左括号；close=) 右括号 */
  dir: 'open' | 'close'
  pos: number
  raw: string
}

/** 音乐 token 联合 */
export type MusicToken =
  | NoteToken
  | RestToken
  | RhythmToken
  | BarlineToken
  | DecorationToken
  | SlurToken
  | InstrumentToken
  | BracketToken

// ============================================================
// 歌词（LyricChar）
// ============================================================

/**
 * 歌词字符。每个元素对应曲行中的一个音符：
 *  汉字一字一符；标点自动识别；@ 跳过当前音符；~ 将前后两字连为一个音节
 */
export interface LyricChar {
  /** 音节文本（可能为多个字，~ 连接） */
  text: string
  /** true=此位置跳过（@ 标记），不画字 */
  skip: boolean
  /** 是否为标点（自动识别，排版时适当缩小间距） */
  punctuation: boolean
  /** 紧跟本字的标点串（adj40：标点不占音符位，渲染在本字之后） */
  trailing?: string
  /** 本字前的引号注释文本（"..."，adj58：渲染在该字前面，不占歌词对齐位） */
  note?: string
  /** 行内字符偏移 */
  pos: number
  raw: string
}

// ============================================================
// 解析结果
// ============================================================

export interface ParseError {
  /** 错误行号（1-based），0 表示全局错误 */
  line: number
  col: number
  message: string
  severity: 'error' | 'warning'
}

/** 曲行 + 其附属歌词行（词依附于上一个曲行；一行曲可对多行词） */
export interface MusicGroup {
  music: MusicLine
  lyrics: LyricLine[]
  /** 该组在 lines 中的起始索引 */
  startIndex: number
}

export interface ParseResult {
  header: Header
  /** 全部源码行（含空行/注释，保持顺序与行号一致） */
  lines: SourceLine[]
  /** 曲词分组（按出现的顺序） */
  groups: MusicGroup[]
  errors: ParseError[]
}

// ============================================================
// 谱面模型（layout 输出，render 输入）
// ============================================================

/** 谱面元素的稳定 ID：page_声部_组_序号（与光标联动对应） */
export interface LayoutId {
  page: number
  voice: number
  group: number
  index: number
}

/** 一个已定位的音符元素（含可点击/光标信息） */
export interface PlacedToken {
  id: LayoutId
  token: NoteToken | RestToken | RhythmToken
  /** 相对页面左上角的坐标 */
  x: number
  y: number
  /** 占宽 */
  width: number
  /** adj290：音符实际占位右端（含分配+留空，不含相邻休止符）——播放色块/定位用，防止延伸到后面的休止符 */
  rightX?: number
  /** 时值（拍数，用于播放） */
  duration: number
  /** 小节内拍位置（累积拍，从 0 起，用于减时线分组） */
  beatPos: number
  /** 小节索引（行内唯一，用于减时线分组） */
  barIndex: number
  /**
   * 拍段序列（adj35 拍级宽度）：每段一拍（跨拍音符拆段），供增时线/附点按拍定位。
   * x = 段起点，perBeat = 该拍每拍宽，beats = 段内时值（拍）。
   * adj284：空间优先布局给每段加 el 标记（note=音符块 / aug=增时线 / dot=附点），
   * 供渲染端读取显式段位置；时值优先路径不设置该标记，不影响既有行为。
   */
  segments?: { x: number; perBeat: number; beats: number; el?: 'note' | 'aug' | 'dot' }[]
  /** 试听音高：音级+八度+变音计算出的简谱音名（如 C5） */
  audioPitch: string | null
  /** 是否可点击（休止符/隐藏符不可发声） */
  playable: boolean
  /** adj303：乐器名注释（@乐器名 / @@ 切换后的下一个音符上方显示；仅 config.showInstrument 时渲染） */
  instrumentLabel?: string
}

/** 一个定位后的歌词字符 */
export interface PlacedLyric {
  id: LayoutId
  char: LyricChar
  x: number
  y: number
  /** 对应音符的占位宽度（px，adj71：歌词字宽 > 槽宽且相邻歌词密时横向缩窄） */
  slotW?: number
  /** 与相邻歌词的最小间距（px，adj71 后处理；判断两侧是否密集会重叠） */
  gapL?: number
}

/** 一个定位后的小节线（含反复记号/跳房子信息） */
export interface PlacedBarline {
  id: LayoutId
  type: BarlineType
  /** 小节线修饰符列表（adj206：可叠加多个，如 |&ty&ds 同时渲染 ⊕ 与 D.S.） */
  marks?: BarlineMark[]
  /** 跳房子起点/终点标记 */
  voltaStart?: { open: boolean; slash?: boolean; plus?: number; comment?: string }
  voltaEnd?: boolean
  /** |]/ 跳房子开口结束（adj26） */
  voltaEndSlash?: boolean
  /** 纯跳房子起点（无小节线），不画小节线竖线（adj26） */
  voltaOnly?: boolean
  /** 小节线备注 */
  comment?: string
  /** 小节线中心 x */
  x: number
  /** 行顶 y */
  yTop: number
  /** 行底 y */
  yBottom: number
  /** 小节线占宽 */
  width: number
}

/** 多声部块（Q1/Q2 纵向堆叠，小节对齐），供渲染声部括弧与名称 */
export interface VoiceBlock {
  /** 括弧 x（块左侧） */
  x: number
  /** 块顶 y（第一声部行顶） */
  yTop: number
  /** 块底 y（最末声部行底） */
  yBottom: number
  /** 各声部信息（按堆叠顺序） */
  voices: { voice: number; name?: string }[]
  /** adj280：每声部曲部中心 y（音符数字垂直中心），供声部注释与曲部垂直居中 */
  voiceCenters?: number[]
}

/** 连音线（() 匹配的音符对，同行内绘制） */
export interface PlacedSlur {
  /** 起点（第一个音符左边缘） */
  x1: number
  /** 终点（最后一个音符右边缘） */
  x2: number
  /** 线的 y（音符上方） */
  y: number
  /** 嵌套深度（错开高度） */
  depth: number
  /** 样式：arc 圆弧 / flat 平顶 */
  style: 'arc' | 'flat'
  /** 跨行半条：l = 上一行左半部（低→高、右侧开口）；r = 下一行右半部（高→低、左侧开口） */
  half?: 'l' | 'r'
  /** 平均连音组 (y...) 音符数（仅 (y 组标注数字；普通连音线 (…) 不标注，adj43） */
  tupletCount?: number
}

/** 渐强渐弱记号（< > 起点至 ! 结束） */
export interface PlacedDynamic {
  x1: number
  x2: number
  /** 记号的 y（行上方） */
  y: number
  type: 'crescendo' | 'decrescendo'
  /** 渐强渐弱 "+" 提升级数（<+ / >++，每级抬升，类似跳房子；无则 0 缺省） */
  plus?: number
}

/** 括号标记（&zkh/&ykh，adj294）：独立无时值元素，插位占宽 */
export interface PlacedBracket {
  /** open=( 左括号；close=) 右括号 */
  dir: 'open' | 'close'
  /** 括号字符绘制中心 x */
  x: number
  /** 所在行顶 y（括号垂直居中于数字） */
  yTop: number
  /** 占位宽 */
  width: number
  voice: number
  group: number
}

/** 单个乐谱页 */
export interface ScorePage {
  index: number
  width: number
  height: number
  notes: PlacedToken[]
  lyrics: PlacedLyric[]
  barlines: PlacedBarline[]
  voiceBlocks: VoiceBlock[]
  slurs: PlacedSlur[]
  dynamics: PlacedDynamic[]
  /** adj294：独立括号标记（&zkh/&ykh）——按源码位置插位、占宽，不影响音符 */
  brackets: PlacedBracket[]
  /** 页面级元数据（标题/作者/调号拍号等文本元素） */
  meta: ScorePageMeta
}

export interface ScorePageMeta {
  titles: string[]
  authors: string[]
  key: string | null
  meter: string | null
  tempo: string | null
  /** 节拍数字（渲染 ♩=N 用） */
  tempoNum: string | null
  /** 节拍文字（渲染在 ♩=N 之后） */
  tempoText: string | null
  /** 乐器列表（Y 行，副标题下，adj83） */
  instruments: string[]
  /** 说明文字列表（S 行，谱尾，adj83） */
  notes: string[]
}

/** 排版结果：多页谱面 */
export interface ScoreLayout {
  pages: ScorePage[]
  /** 页面配置快照（用于缓存失效判断，render 需要） */
  config: PageConfig
  configKey: string
}

// ============================================================
// 页面配置（PageConfig，与 localStorage/服务端持久化一致）
// ============================================================

/**
 * 音符空间布局模式（adj281）：
 *  - 'duration' 时值优先：音符水平宽度与拍数成正比（当前默认/历史行为）；
 *  - 'space' 空间优先：预留，后续实现（按横向空间需求排布）。
 */
export type NoteSpaceLayout = 'duration' | 'space'

export interface PageConfig {
  /** 纸张：A4 | A5 | A4_horizontal | A5_horizontal */
  page: 'A4' | 'A5' | 'A4_horizontal' | 'A5_horizontal'
  margin_top: number
  margin_bottom: number
  margin_left: number
  margin_right: number
  /** 正文上间距（标题与正文之间） */
  body_margin_top: number
  /** 描述头内容区高度（标题/作者/调式等，adj30：描述头下端虚线调整） */
  descAreaH: number
  /** 标题字体与字号 */
  biaoti_font: string
  biaoti_size: number
  /** 副标题字体与字号 */
  fubiaoti_font: string
  fubiaoti_size: number
  /** 描述头字体与字号（除标题/副标题外的其它内容：调式/拍号/节拍/作者；adj45） */
  miaoshu_font: string
  miaoshu_size: number
  /** 说明文字（S 行）字体与字号（adj154：独立于描述头设置） */
  notes_font: string
  notes_size: number
  /** 歌词字体与字号 */
  geci_font: string
  geci_size: number
  /** adj292：歌词宽度不足时是否压缩字宽（true = 横向缩窄防重叠；false/缺省 = 允许重叠） */
  lyricShrink?: boolean
  /** 音符字号（px）与字体（adj105：由字形 a|b|c 改为字体名，默认微软雅黑） */
  note_size: number
  shuzi_font: string
  /** 行间距：曲下间距/词下间距/曲上间距/声部间距 */
  height_quci: number
  height_cici: number
  /** 曲部与曲部间距（行尾间距，本行无歌词时，adj79：原 ciqu 拆分） */
  height_ciqu: number
  /** 曲部与上一行词部间距（行尾间距，本行有歌词时，adj79） */
  height_ciqu_lyric: number
  height_shengbu: number
  /** 小节间距（列间距，px；小节线之间的空隙） */
  bar_gap: number
  /** adj297：两端对齐最小小节数——行小节数 < 该值做自然对齐（行尾留白），≥ 该值撑满两端对齐；默认 4 */
  align_min_bars: number
  /** adj281：音符空间布局模式——时值优先（音符宽度与拍数成正比）/ 空间优先（预留） */
  noteSpaceLayout: NoteSpaceLayout
  /** adj303：是否显示乐器名注释（@乐器名 / @@ 切换后的下一个音符上方；缺省 false 不显示） */
  showInstrument?: boolean
  /** 编辑器字体（谱面级，adj221：随 # jps-config 保存；缺省回退全局/默认） */
  editorFont?: string
  /** 编辑器字号（px，谱面级，adj221；缺省回退全局/默认） */
  editorFontSize?: number
  /**
   * 描述头自定义位置：相对各自锚点的偏移（adj16）。
   * title/subtitle_i → 描述区上边中点；author_i → 右下角；keyline/tempo → 左下角。
   * 区域宽/高变化时元素跟随锚点。
   */
  metaPos?: Record<string, { x: number; y: number }>
  /** 连音线样式：0 自动 | 1 圆弧 | 2 平顶 */
  lianyinxian_type: 0 | 1 | 2
  /** 按页覆盖的行距（key: 页码；[quci, cici, ciqu, shengbu, ciquLyric?]，adj79 末位可选兼容旧存储） */
  heights?: Record<string, [number, number, number, number, number?]>
}

/** adj194：谱面默认系统字体栈（不附带字体文件，减小体积；与 META_GLYPH_W 比例宽度估算匹配） */
const SYS_FONT = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"

export const defaultPageConfig: PageConfig = {
  page: 'A4',
  // adj213：默认边距 80 → 40（页面留白收窄）
  margin_top: 40,
  margin_bottom: 40,
  margin_left: 40,
  margin_right: 40,
  // adj213：首行至描述头间距 40 → 20
  body_margin_top: 20,
  // adj213：描述头内容区高 87.6 → 80（与默认标题字号 20 更协调）
  descAreaH: 80,
  // adj：默认字体统一用系统字体栈（微软雅黑/PingFang/系统 Noto CJK），不附带大字体文件；
  //   META_GLYPH_W 文本宽度估算按比例字体测量与系统字体匹配（等宽 Noto Mono 反而不匹配），
  //   跨端一致且显著减小站点体积（移除 ~33MB .otf，adj194）。
  biaoti_font: SYS_FONT,
  // adj213：标题字号 36 → 20
  biaoti_size: 20,
  fubiaoti_font: SYS_FONT,
  // adj213：副标题字号 20 → 15
  fubiaoti_size: 15,
  miaoshu_font: SYS_FONT,
  miaoshu_size: 13,
  // adj213：说明文字字体微软雅黑 → 宋体（与正文说明区分）
  notes_font: SYS_FONT,
  // adj215：说明文字字号 13 → 12
  notes_size: 12,
  geci_font: SYS_FONT,
  // adj215：歌词字号 18 → 11
  geci_size: 11,
  // adj215：音符字号 18 → 13
  note_size: 13,
  // adj213：音符字体微软雅黑 → 黑体（简谱数字用黑体更醒目）
  shuzi_font: SYS_FONT,
  // adj213：曲部与词部间距 13 → 15
  height_quci: 15,
  height_cici: 10,
  height_ciqu: 20, // adj78：曲部与曲部间距默认 40→20；adj79 拆分后仅指无歌词行行尾间距
  // adj213：曲部与上一行词部间距 12 → 10
  height_ciqu_lyric: 10,
  height_shengbu: 0,
  bar_gap: 0,
  align_min_bars: 4,
  // adj289：默认空间优先（指定为默认布局方式）
  noteSpaceLayout: 'space',
  lianyinxian_type: 0,
}

/** 纸张尺寸（mm → 渲染用 pt，1pt = 25.4/72 mm） */
export const PAPER_SIZE: Record<PageConfig['page'], { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  A4_horizontal: { width: 841.89, height: 595.28 },
  A5_horizontal: { width: 595.28, height: 419.53 },
}
