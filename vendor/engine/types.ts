/**
 * engine/types.ts — iJipu（爱记谱）简谱引擎核心类型
 *
 * 语法依据：原「番茄简谱」脚本说明手册（doc.lezhi99.com/zhipu）完整逆向，
 * 兼容 .jps 标记语言 V1.0。
 *
 * 本文件只包含纯类型定义，无任何运行时逻辑，是 parser / layout / render /
 * playback 各模块的共同契约。引擎保持零 React 依赖，可独立单测。
 */
// 字体策略（跨机尽量有 / 适合简谱 / 保证有可用字体）集中在 fonts.ts，此处只用其默认栈常量
import { SYS_FONT } from './fonts'

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
  /**
   * adj629（用户要求）：本行歌词里的「替谱段」`{tp … }`——**第 k 段歌词 = 第 k 遍**，
   * 段内就是"这一遍与主旋律不同"的那几个音（写在被替换区间第一个字的前面）。
   * 解析后由 `parser.ts` 注入到所属曲行的 token 流（见 `injectLyricVariants`），
   * 于是排版/播放全部走现成的临时段机制（`{bz}` 那一套包络）。
   */
  variants?: LyricVariant[]
}

/**
 * adj629：歌词行内联的**替谱段**（`C2: … {tp 4/ 3// 6,/ 6,// 1/ .1 -} 借 一 丝 …`）。
 *
 * 为什么挂在歌词行上：谱面上"第二遍不同"这件事本身就是**跟着歌词段走**的——
 * 第 2 段歌词就是第 2 遍，加一段歌词就多一套替谱，不必在曲行里数遍次。
 */
export interface LyricVariant {
  /** 锚点：替谱从**第 `slot` 个歌词槽位**（0 起）对应的音符起生效（= 段前已提交的歌词字数） */
  slot: number
  /** 段内音乐 token（与曲行同一套，经 `tokenizeMusicLine` 递归解析） */
  tokens: MusicToken[]
  /** 段头 `{` 在本行内容里的列偏移（供报错/光标定位） */
  pos: number
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
  /** 平均连音组（(y...)）组号（adj395）：同组音符的减时线始终相连成一条，不随拍边界断开 */
  tupletGroup?: number
  /** 装饰符号编码列表（& 开头，如 tr、mp；< > 渐强渐弱另见 DecorationToken） */
  symbols: string[]
  /** 虚音符：(1) 括号修饰，弱奏装饰，不占额外拍（adj23） */
  ghost?: boolean
  /** 倚音：1[65] 前倚音 / 1[h65] 后倚音，不占拍，紧跟音符数字（adj23） */
  gracenotes?: { after: boolean; notes: GracenoteNote[] }
  /** 音符注释（音符后引号内容），如 1"渐强" */
  comment?: string
  /** 注释抬升级数（adj392：紧接注释引号后的 `+` 个数，每级 NOTE_COMMENT_RAISE px） */
  commentPlus?: number
  /** 注释降低级数（adj392：紧接注释引号后的 `-` 个数，每级 NOTE_COMMENT_RAISE px） */
  commentMinus?: number
  /** 该 token 在行内的起始字符偏移 */
  pos: number
  /** 原始文本 */
  raw: string
}

/**
 * adj632（用户要求）：**倚音音符专属**的修饰符编码——写在倚音括号内、该倚音之后，如 `6/[5/&tu]`。
 *
 * 为什么放这些：它们的画法在倚音尺度下仍然成立——
 *  · `tu` / `die` / `da`：画在该倚音**正上方**（粗体 T / 又 / 扌，与主音符同款字形）；
 *  · `sby` / `xby` / `sby+` / `xby+`（adj633，用户要求）：上/下/长上/长下波音，
 *    画在该倚音**正上方**（与主音符同款矢量图形），墨迹宽按「波音 : 所属音符」同一比率随倚音等比缩小；
 *  · `shy` / `xhy`：画在该倚音**右侧**（矢量滑音图形，与主音符同款图形）。
 * 其余编码（力度、颤音、独立括号 `&zkh/&ykh/&hx`……）**倚音不支持**：
 * 倚音本身只有主音符一半大小、且成组横向紧排，再堆这些记号必然与主音符自己的记号挤在一起。
 * 解析端对不支持的编码发告警（不静默丢弃），见 `parser/tokenizer.ts`。
 */
export const GRACE_MARK_CODES = ['tu', 'die', 'da', 'shy', 'xhy', 'sby', 'xby', 'sby+', 'xby+'] as const

/** 倚音支持的修饰符编码（见 `GRACE_MARK_CODES`） */
export type GraceMarkCode = (typeof GRACE_MARK_CODES)[number]

/** 画在倚音**正上方**的编码（其余已支持的编码一律画在**右侧**） */
export const GRACE_MARK_ABOVE: readonly GraceMarkCode[] = ['tu', 'die', 'da', 'sby', 'xby', 'sby+', 'xby+']

/**
 * adj633：倚音上的**波音**编码（`GRACE_MARK_ABOVE` 里走矢量图形的那几个）。
 * 渲染（画在正上方、随倚音等比缩小）与演奏（按倚音自己的时值展开波音短音）都要认这一组，
 * 收在这里避免两处各写一份（同 `MORDENT_SYMBOLS` 之于主音符波音）。
 */
export const GRACE_MORDENT_CODES = ['sby', 'xby', 'sby+', 'xby+'] as const

/** 倚音音符（[] 或 [h] 内，adj23）：可含高低音点 ' ,、变音 # $ =、减时线 /、修饰符 & 编码（adj632） */
export interface GracenoteNote {
  /** 音级 1-7 */
  pitch: 1 | 2 | 3 | 4 | 5 | 6 | 7
  /** 八度偏移：正数=高音点（'），负数=低音点（,） */
  octaveShift: number
  /** 变音记号：# 升、$ 降、= 还原 */
  accidental: '#' | '$' | '=' | null
  /** 减时线数量（/） */
  diminishCount: number
  /**
   * adj632：依附在**本倚音**上的修饰符编码（`&tu`/`&die`/`&da`/`&shy`/`&xhy`）。
   * 只有写了才存在——旧谱面的 `gracenotes` 形状保持不变。
   */
  symbols?: GraceMarkCode[]
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
  /** 平均连音组组号（adj395，同 NoteToken） */
  tupletGroup?: number
  /** 装饰符号编码列表（& 开头，如 zkh/ykh 括号等，adj84） */
  symbols: string[]
  comment?: string
  /** 注释抬升级数（adj392，同音符） */
  commentPlus?: number
  /** 注释降低级数（adj392，同音符） */
  commentMinus?: number
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
  /** 平均连音组组号（adj395，同 NoteToken） */
  tupletGroup?: number
  /** 装饰符号编码列表（& 开头，如 zkh/ykh 括号等，adj84） */
  symbols: string[]
  comment?: string
  /** 注释抬升级数（adj392，同音符） */
  commentPlus?: number
  /** 注释降低级数（adj392，同音符） */
  commentMinus?: number
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
    /** + 号数量，调整跳房子线高度（抬升，向上） */
    plus?: number
    /** - 号数量，调整跳房子线高度（降低，向下，adj356 与 + 相反） */
    minus?: number
    /** [ 后引号注释（跳房子番号，adj26） */
    comment?: string
  }
  /** 是否为跳房子终点 "]" */
  voltaEnd?: boolean
  /** |]/ 跳房子开口结束（终点不封闭，adj26） */
  voltaEndSlash?: boolean
  /** 纯跳房子起点（无小节线的 [，如 ] 后连续 [ 或行首），渲染不画小节线竖线（adj26） */
  voltaOnly?: boolean
  /** 小节线备注（引号内容；`d:` 转调指令已从其中剥掉，见 `keyChange`） */
  comment?: string
  /**
   * adj627 临时转调（用户要求，与 `"p:2/4"` 临时节拍同槽位）：小节线引号备注里写 `d:<key>`。
   *  - `targetKey`：新调号根音半音偏移（与 `parseKey` 同口径，如 `d:1=D` / `d:D` / `d:Eb` / `d:F#`）；
   *  - `keyText`：**用户写的调名原文**（如 `Ab` / `F#` / `$B`）——预览按用户的写法显示（`转1=Ab`），
   *    不折算成等音（`Ab` 不会显示成 `#G`）；
   *  - `clear: true`：`d:` 单用 ⇒ 恢复描述头 `D:` 的全局调号；
   *  - `plus` / `minus`：紧跟调名的 `+` / `-` 个数——**抬升 / 降低转调记号的显示高度**
   *    （与音符注释 `1"注"+` 的 adj392 同一套记法，每级 `NOTE_COMMENT_RAISE` px）；
   *  - 字段缺省 = 这条小节线没有转调指令（显示 `comment` 与普通备注无异）。
   */
  keyChange?: { targetKey?: number; clear?: boolean; keyText?: string; plus?: number; minus?: number }
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
  /**
   * adj394：`!` 的**终点停靠处**——`!` 可以写在任意「有时值的元素」之后：
   *  - `note`：默认，紧跟在音符（/休止符/节奏符）数字后 → 结束于该音符数字槽中心；
   *  - `aug`：紧跟在增时线 `-` 之后 → 结束于该音符**末增时线的右缘**；
   *  - `dot`：紧跟在附点 `.` 之后 → 结束于该音符**附点的右缘**。
   */
  dynamicsEndOn?: 'note' | 'aug' | 'dot'
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
  /** adj337：true = 旧写法单 @乐器名（无尾 @），需告警提示用 @...@ 新语法；false = @...@ 包裹 */
  legacy?: boolean
}

/**
 * 独立标记符（&zkh / &ykh 括号，adj294；&hx 呼吸记号，adj375）：**独立无时值元素**——不依附音符。
 * 放在源码哪个位置，就在那插入一个标记并占宽；对音符的时值/位置不施加影响，仅是标记符。
 *  - zkh=( 左括号；ykh=) 右括号
 *  - hx=呼吸换气记号（V 形，"换气/静音"语义由播放端实现：见 playback/sequence.ts）
 * 显示上三者都按**基本占宽**（与括号相同，adj376），因此书写时可以写在音符前或音符后：`&hx 6 5` / `6 &hx 5`。
 */
export interface BracketToken {
  kind: 'bracket'
  /** 标记编码：zkh 左括号 / ykh 右括号 / hx 呼吸记号（adj375） */
  code: 'zkh' | 'ykh' | 'hx'
  /** open=( 左括号；close=) 右括号（hx 无方向，恒为 'open'：不画括号） */
  dir: 'open' | 'close'
  pos: number
  raw: string
}

/**
 * 临时段（adj427）：`{bz ... }` 临时伴奏、`{dsb ... }` 临时多声部。
 *
 * 语法：
 *  - `{bz 1 2 3 | 4 5}` —— bz 段：包裹范围对应的主旋律拍位确定总宽；段内内容按比例映射到该宽度；
 *    画在主旋律**上方**，用括号包裹；段内 `|` 按自身拍位映射到该宽度内。
 *  - `{dsb 1 2 3 | 4 5}` —— dsb 段：临时多声部；上层画段内内容（主声部），下层画主旋律该拍位的
 *    音（伴奏），两层同一拍位垂直对齐；段内/主旋律各自的小节线**三层对齐**。
 *
 * `}` 是**段结束** token（与 `{bz`/`{dsb` 配对）；段内 token 通过 `children` 挂在 open token 上。
 * 段内允许任意 MusicToken（含小节线、装饰、连音线、倚音等）；段内**不嵌套** `{bz/dsb`（嵌套时报错）。
 */
export interface SegmentToken {
  kind: 'segment'
  /**
   * 段类型：
   *  - `bz` 临时伴奏（画主旋律上方）
   *  - `dsb` 临时多声部（上下两层）
   *  - `tp` 替谱段（adj629，来自歌词行的 `{tp … }`；画在**它所属那条歌词行的上方**，
   *    且只在第 `pass` 遍替代主旋律）
   */
  type: 'bz' | 'dsb' | 'tp'
  /** open = `{bz` / `{dsb`（段开始）；close = `}`（段结束） */
  dir: 'open' | 'close'
  pos: number
  raw: string
  /** 段内 token（仅 open 时存在；close 时为 undefined） */
  children?: MusicToken[]
  /**
   * adj629：**替谱段专属**——本段替代的是**第几遍**（1 起，= 所属歌词行的序号）。
   * 只有 `type === 'tp'` 时有值；其它段型缺省。播放端据此按遍次替换主旋律。
   */
  pass?: number
  /**
   * adj629d：**替谱段的源码坐标**——所属歌词行的序号（0 起）与该行内第几个 `{tp … }`（0 起）。
   * 段头 token 是解析期注入的，`openIndex` 在源码侧复现不出来；光标联动/试听定位改用这两个
   * 源码可推导的值（见 `layout/segments.ts` 的 `tpNoteIndexBase`）。
   */
  tpLine?: number
  tpVariant?: number
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
  | SegmentToken

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
  /**
   * adj394：**正确语法规则**（含最小示例）——用于端侧在告警信息下方直接给出「正确写法」，
   * 而不是只告诉用户"哪里错了"。缺省表示该问题无需额外说明。
   */
  hint?: string
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
  /**
   * adj732：本音符**最左墨迹** x（含左伸量：变音角标 / 前倚音组 `[5/]` / 滑音记号 —— 都画在数字**左侧**）。
   *
   * 为什么要有它：播放色块右界的规则是"**不越下一个元素的最左墨迹**"（用户口径：
   * 「不超下一音符（包括倚音）、滑音等属于下个音符的元素，和 `&zkh`/`&ykh`/`&hx` 等独立修饰符」），
   * 而 `x` 是**数字左缘**、左伸墨迹还在它左边 ⇒ 只用 `x` 会让前一个音的色块压住这些记号。
   * 无左伸（大多数音符）时**不写该字段**，保持放置结果精简。
   */
  inkLeftX?: number
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
  /**
   * adj647：变音角标的**已解析几何**（相对数字左缘，px）——布局按生效的字形度量算好，
   * 渲染端直接消费（`penDx` = 角标文字锚点，`leadW` = 角标占宽/左伸量）。
   *
   * 为什么由布局存下来：字形度量可以由**宿主实测**（`layoutScore` 的 `fontMeta`）传入，
   * 渲染若自己再算一遍就可能与布局用的不是同一份 ⇒ "占宽"与"锚点"两套账。
   * 无变音的音符不带该字段；老调用点（未传度量）渲染端回退到内置常量表。
   */
  accidentalGeo?: { penDx: number; leadW: number }
  /** adj303：乐器名注释（@乐器名 / @@ 切换后的下一个音符上方显示；仅 config.showInstrument 时渲染） */
  instrumentLabel?: string
  /**
   * adj427：临时段叠加层标记——该音符来自 `{bz … }` / `{dsb … }` 段（不在主旋律时间轴上）。
   * `layer`：upper = 段内容层（画在主旋律**上方**）；lower = dsb 段包络内的主旋律（下层声部，
   * 与上层同一拍位垂直对齐）。主旋律音符不带该字段。
   */
  segment?: { type: 'bz' | 'dsb' | 'tp'; layer: 'upper' | 'lower'; pass?: number }
  /**
   * adj689：段层音符所属**视觉行**的行顶 y（= 该行主旋律基线）。
   *
   * 为什么要存：段层是"叠加后处理"，`{dsb}` 会把包络内的主旋律下移 `dy/2`，
   * 之后 `y` 就不再等于"所在行的行顶"了；而"这段内容属于哪一行"要靠它反查
   * （见 `layout/index.ts` 的 `alignLyricsToLowestVoice`）。主旋律音符不带该字段。
   */
  parentY?: number
  /**
   * adj427：临时段重叠区的**声部角色**——供播放端决定音色与力度（用户规格）：
   *  - `'accomp'`：bz 段的段内容层 = **伴奏声部** → 第 2 可用音色 + 0.75 力度
   *  - `'main'`  ：dsb 段的段内容层 = **主声部** → 用该曲行声部音色（与主旋律一致、色块同色）
   *  - `'second'`：dsb 段**包络内的主旋律音** = **第二声部** → 第 2 可用音色 + 0.75 力度
   * 未设置 = 普通主声部（音色与力度都不变）。
   */
  playVoice?: 'accomp' | 'main' | 'second'
  /**
   * adj629b（用户要求）：**临时叠加层（`{bz}`/`{dsb}`/`{tp}`）的曲部高度压缩比**——
   * 段层音符的字号与各层间距按 `SEGMENT_LAYER_SCALE`（2/3）缩小，看起来比主旋律"扁"，
   * 从而一眼区分"这是另一层/另一遍的内容"。主旋律音符缺省（= 1）。
   */
  layerScale?: number
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
  /**
   * adj629g：本字所属的**歌词行序号**（该曲行里第几条 `C…:`，0 起）。
   * 预览虚线据此决定拖的是"歌词区↔曲部"（第 1 行 = `height_quci`）还是"歌词行之间"
   * （第 2 行及以后 = `height_cici`）——此前按键在**那一行内的序号**判，
   * 替谱层插进来后第 2 行歌词会被归到替谱行、序号又变 0，拖它错改成 quci（用户报）。
   */
  line?: number
  /**
   * adj672（用户要求「歌词注释也要不与歌词重叠」）：**歌词注释的绘制锚点**。
   *
   * `noteX` = 注释文字**左缘** x、`noteY` = 注释基线 y；由布局在"歌词全部放置完"之后统一避让算出
   * （① 紧贴本字左侧；② 与邻居挤在一起就在"前一个字墨迹右缘 ~ 本字左缘"的空档里重排；
   * ③ 空档放不下则**上下错开**）。缺省（老数据/无注释）时渲染端回退到 `x − 宽 − 3`。
   */
  noteX?: number
  noteY?: number
  /**
   * adj677：歌词注释的**横向压缩比**（缺省 1 = 不压缩）。
   *
   * 用户口径：「歌词注释**调整到同一水平线上**，高高低低的不美观」⇒ 注释**永远与本字同基线**，
   * 放不下时改为横向压缩（与歌词字 `adj71/adj292` 同一手法），缩放以**右缘**为基准（贴住本字）。
   */
  noteSx?: number
}

/** 一个定位后的小节线（含反复记号/跳房子信息） */
export interface PlacedBarline {
  id: LayoutId
  type: BarlineType
  /** 小节线修饰符列表（adj206：可叠加多个，如 |&ty&ds 同时渲染 ⊕ 与 D.S.） */
  marks?: BarlineMark[]
  /** 跳房子起点/终点标记 */
  voltaStart?: { open: boolean; slash?: boolean; plus?: number; minus?: number; comment?: string }
  voltaEnd?: boolean
  /** |]/ 跳房子开口结束（adj26） */
  voltaEndSlash?: boolean
  /** 纯跳房子起点（无小节线），不画小节线竖线（adj26） */
  voltaOnly?: boolean
  /**
   * adj723aa：小节线的**源码原文**——跳房子配对要按里面 `[`/`]` 的**出现顺序**判定。
   *
   * 同一根线上可能既有 `]` 又有 `[`（`|]["2."`，画法上就是同一根竖线），用户的写法约定是
   * 「**结束符 `]` 写在开始符 `[` 前面**」，而这两个布尔量 `voltaEnd`/`voltaStart` 无法表达先后；
   * 故把原文带到走查侧，由它按顺序配对（**不改画法**）。
   */
  raw?: string
  /** 小节线备注 */
  comment?: string
  /**
   * adj627 临时转调：从该小节线起的整段谱改为 `<targetKey>`（半音偏移，与 `parseKey` 口径一致）。
   * - `targetKey` 给定 + `clear` 缺省/假：转调生效；
   * - `clear` 真：恢复描述头 `D:` 的全局调号（`d:` 单用）；
   * - `keyText`：用户写的调名原文——记号显示按用户写法（`转1=Ab` 不折算成 `#G`）；
   * - `plus` / `minus`：紧跟调名的 `+` / `-` 个数 ⇒ 抬升 / 降低记号显示高度。
   * 由小节线引号备注 `d:<key>` / `d:` 解析得到；不写 `d:` 时整字段缺省（`undefined`），表示没有转调指令。
   */
  keyChange?: { targetKey?: number; clear?: boolean; keyText?: string; plus?: number; minus?: number }
  /**
   * adj627：转调记号的**显示文本**（如 `转1=D`；`d:` 单用时显示恢复后的调名）——
   * 布局端算好（它同时知道描述头调号与目标调），渲染端直接画。
   */
  keyChangeLabel?: string
  /**
   * adj627c：转调记号里的**调名部分**（`转1=Ab` 的 `Ab`）。
   *
   * 为什么要单独给：渲染端要把它拆成「字母 + 左上角 ♯/♭ 角标」两笔来画，
   * **与描述头 `D: Ab` 的预览完全同一套笔法**（角标字号 = 字母 3/4、上移 0.35×字号、
   * 字母右移 0.9×角标宽让位）——只给一个拼好的字符串就没法复用同一段画法了。
   */
  keyChangeName?: string
  /** 小节线中心 x */
  x: number
  /** 行顶 y */
  yTop: number
  /**
   * adj667（用户报「跳房子线与多声部音符重叠」）：**跳房子线的抬升后 y**（缺省 = 按 `yTop` 常规算）。
   *
   * 为什么要单独给：跳房子线画在 `yTop − VOLTA_BAR_GAP` 处，而 `{dsb … }` 叠加后的上层声部
   * 会**伸到行顶之上**（段层基线 = 行基线 − 间距/2），两者正好撞在一起。
   * 但 `yTop` 同时被曲部虚线 / 行高 / 方框小节序号等消费，直接抬它会牵动一大片几何 ⇒
   * 布局只把"抬到哪"记在本字段，渲染端画跳房子线时优先采用。
   */
  voltaYTop?: number
  /** 行底 y */
  yBottom: number
  /** 小节线占宽 */
  width: number
  /**
   * adj427：临时段叠加层标记——该小节线来自 `{bz … }` / `{dsb … }` 段内
   * （按段内自身拍位映射到包络内的 x；主旋律小节线不带该字段）。
   * 渲染时用 `yTop`/`yBottom` 限制在该层高度内，避免与主旋律小节线重叠。
   */
  segment?: { type: 'bz' | 'dsb' | 'tp'; layer: 'upper' | 'lower'; pass?: number }
  /**
   * adj629b：段层小节线的**纵向压缩比**（同 `PlacedToken.layerScale`；主旋律缺省 = 1）。
   * 渲染端以 `layerBase` 为不动点做 `scale(1, 该值)`——**字号不变**，只把高度压扁。
   */
  layerScale?: number
  /** adj629b：纵向压缩的**不动点 y**（= 该段层的音符基线 `yUpper`） */
  layerBase?: number
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

/**
 * adj625（用户要求）：**方框小节序号**的锚点（布局给出，渲染画「数字 + 外框」）。
 *
 * 位置规则（用户口径）：
 *  - `x` = 该小节**左侧小节线**的中心 x；行首那根小节线通常不画（隐藏小节线）⇒ 取行首内容左缘
 *    （单声部 = 左边距；多声部 = 大括号与音符之间的空隙）；
 *  - `yBarBottom` = 该谱行**小节线底缘** y（方框画在它下方一个固定间隙处，字号与音符注释一致）。
 */
export interface PlacedBarNumber {
  /** 小节序号（1 起，**全曲连续**；多声部块内每小节只算一次） */
  n: number
  /** 方框中心 x */
  x: number
  /** 谱行小节线底缘 y（方框顶 = 该值 + `BAR_NUMBER_TOP_GAP`） */
  yBarBottom: number
  voice: number
  group: number
}

/** 连音线（() 匹配的音符对，同行内绘制） */
export interface PlacedSlur {
  /** 起点（第一个音符左边缘） */
  x1: number
  /** 终点（最后一个音符右边缘） */
  x2: number
  /** 线的 y（音符上方） */
  y: number
  /**
   * adj723l：**不含嵌套抬升（`raise`）的基础 y**——只给"同行齐平"用。
   *
   * 用户口径：「中间的 `1'` **既归于前一个连音线、也归于后一个连音线**」
   * ⇒ 同一行的线必须**同高**（`adj689` 记谱惯例）。
   * 齐平时只统一**基础高度**，再把各条自己的 `raise`（嵌套错开 `SLUR_NEST_RAISE` / `(+` `(-`）加回去——
   * 若连 `raise` 一起抹平，嵌套线会叠在一起（实测打红 `adj95` 等 4 条断言）。
   */
  baseYNoRaise?: number
  /**
   * adj723l：本行跳房子线给出的**下限**（`voltaFloorY`；无跳房子时缺省）。
   *
   * 连音线不得高于跳房子线（`adj134`），故最终 `y = max(齐平后的 y, voltaFloor)`。
   * 该钳制**放在"同行齐平"之后**做，否则钳制量会污染 `baseYNoRaise`/`raise` 的推导
   * （实测 `raise` 被算成 15.80 / 8.60 这种荒谬值，齐平随之算错）。
   */
  voltaFloor?: number
  /** 嵌套深度（错开高度） */
  depth: number
  /** 样式：arc 圆弧 / flat 平顶 */
  style: 'arc' | 'flat'
  /** 跨行半条：l = 上一行左半部（低→高、右侧开口）；r = 下一行右半部（高→低、左侧开口） */
  half?: 'l' | 'r'
  /**
   * adj667：连音线画在音符**下方**（缺省 = 上方）。
   *
   * ⚠️ **adj670 起布局端不再置位它**：用户口径是「`(1'// 7// 6//) (6// 6/)` 这部分的连音线
   * 是在下面的**反转的**」——下方声部的弧线仍应朝上；两层放不下的问题改由
   * `segmentMinGap()` **撑开层间距**解决（见 `layout/segments.ts`）。
   * 字段与渲染支持保留：宿主若确需"朝下画"可直接置位。
   */
  below?: boolean
  /** 平均连音组 (y...) 音符数（仅 (y 组标注数字；普通连音线 (…) 不标注，adj43） */
  tupletCount?: number
  /**
   * adj629b：**段层连音线**所在层的**纵向压缩比**（临时叠加层压扁到 `SEGMENT_LAYER_YSCALE` = 2/3）。
   * 主旋律连音线缺省（= 1）。
   */
  layerScale?: number
  /** adj629b：纵向压缩的**不动点 y**（= 该段层的音符基线） */
  layerBase?: number
  /**
   * adj667（用户报「整个乐谱多处连音线向下错位」）：连音线所属的**曲词分组 / 声部**。
   *
   * 为什么要带上：`{dsb … }` 会把包络内的主旋律整体下移，连带下移它们的连音线。
   * 旧的筛法是"**x 落在包络区间内**就下移"——而连音线不带 group/voice/行信息，
   * 于是**同一 x 区间内其它曲行（甚至其它声部）的连音线也被跟着下移**，
   * 整个乐谱到处出现 11px 的错位。带上归属后按 group+voice 精确筛选。
   */
  group?: number
  voice?: number
  /**
   * adj689（adj667 的同一现象**再次复发**）：连音线所属的**视觉行序号**（跨行线取"画它的那一行"）。
   *
   * 为什么 group+voice 还不够：同一组同一声部里**每一行都可能各有一个 `{dsb … }`**，
   * 它们共享同一个 `group`/`voice` ⇒ 只按这两者筛选时，"第 2 行的包络"会把
   * **第 1 行**里 x 恰好落在同一区间的连音线也一起下移——本轮用户原谱里第 1 行的
   * `(1'// 7// 6//)` 被下移 **32.5px**（两个段的位移叠加），而不是它自己那段的 16.7px。
   */
  row?: number
  /**
   * adj689b：该连音线所在**视觉行的行顶 y**（= 该行主旋律基线）。
   *
   * 为什么要单独存：`{dsb}` 是**叠加后处理**（在所有连音线都排完之后才跑），而同一行里
   * 可能有多段 `{dsb}`、**各段下移量不同**（本轮实测 15.77 / 16.74 / 15.77），于是同一行内
   * "在包络里的线"与"不在包络里的线"被下移了不同的量 ⇒ 仍旧错位（实测第 3 行里
   * `(1'// 7// 6//)` y=352.1 与 `(6// 6/)` y=353.0 差 0.9px）。
   *
   * 口径：**一行只认一个下移量**（= `整行最低声部 − 行顶`），行内所有连音线齐平；
   * 段层搬完之后由 `alignRowSlurBaselines` 按本字段统一落地。
   */
  rowTop?: number
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

/** 独立标记（&zkh/&ykh 括号、&hx 呼吸记号）：独立无时值元素，插位占宽 */
export interface PlacedBracket {
  /** 标记编码：zkh / ykh / hx（adj375） */
  code: 'zkh' | 'ykh' | 'hx'
  /** open=( 左括号；close=) 右括号（hx 恒 'open'） */
  dir: 'open' | 'close'
  /** 标记绘制中心 x */
  x: number
  /** 所在行顶 y（标记垂直居中于数字） */
  yTop: number
  /** 占位宽 */
  width: number
  voice: number
  group: number
  /**
   * adj629b：**段层括号**所在层的**纵向压缩比**（临时叠加层压扁到 `SEGMENT_LAYER_YSCALE` = 2/3，
   * **字号不变**）。主旋律的 `&zkh/&ykh` 缺省（= 1）。
   */
  layerScale?: number
  /** adj629b：纵向压缩的**不动点 y**（= 该段层的音符基线） */
  layerBase?: number
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
  /**
   * adj625：**方框小节序号**清单（`showBarCount` 打开时才有内容）。
   * 渲染层按 `n` 画「数字 + 外框」；位置由布局给出（见 `PlacedBarNumber`）。
   */
  barNumbers: PlacedBarNumber[]
  /**
   * adj427：临时段（`{bz … }` / `{dsb … }`）叠加层的**左右大括号**。
   * 段内容音符与小节线直接追加在 `notes` / `barlines`（带 `segment` 标记），
   * 本字段只描述包络范围的括弧几何（可选——无临时段时不存在）。
   */
  segmentBrackets?: PlacedSegmentBracket[]
  /**
   * adj689b：**段层下移量**（`行顶 y → 该行被 `{dsb}` 下移的像素`），仅布局内部使用。
   *
   * 为什么要记：`{dsb}` 是叠加后处理（连音线都排完之后才跑），而同一行可能有多段、
   * 各段下移量不同（由"该段内容多密"决定，本轮实测 15.77 / 16.74 / 15.77）。
   * 连音线基准 y 是**行级**的 ⇒ 必须"一行只认一个下移量"，
   * 段层搬完后由 `alignRowSlurBaselines` 按它把整行连音线统一落地。宿主不必消费。
   */
  rowSlides?: Map<number, number>
  /** 页面级元数据（标题/作者/调号拍号等文本元素） */
  meta: ScorePageMeta
}

/**
 * 临时段叠加层括弧（adj427）：包住 `{bz … }` / `{dsb … }` 段内容层。
 *
 * adj667：`dsb` 的左右大括号分别落在**段内容墨迹的两侧**（以两侧邻居的墨迹边界为限，
 * 绝不外溢压字），`x1`/`x2` 是墨迹左缘、`inkW` 是墨迹宽；`bz` 无大括号（`inkW` 缺省）。
 */
export interface PlacedSegmentBracket {
  /** 段类型：bz 临时伴奏 / dsb 临时多声部 / tp 替谱段（adj629，无大括号，只有包络范围供色块用） */
  type: 'bz' | 'dsb' | 'tp'
  /**
   * 左大括号**墨迹左缘** x（adj667 口径；渲染端直接按 `[x1, x1 + inkW]` 摆放，不再自行算宽度）。
   *
   * 历史（adj427~adj666）：x1 曾是"槽位左缘"，宽度由渲染端按段高算 ⇒ 实际墨迹会比槽位宽、
   * 向两侧溢出，压到相邻音符（用户报「右括号与后面的音符重叠」）。adj667 起**布局算准墨迹区间**
   * （以两侧邻居的墨迹边界为限），渲染只消费。
   */
  x1: number
  /** 右大括号**墨迹左缘** x（同上；渲染按 `[x2, x2 + inkW]` 摆放） */
  x2: number
  /**
   * adj667：大括号**墨迹宽**（左右同宽）。缺省时渲染端回退 `max(3, 0.32×字号)`（老数据兼容）。
   * 布局保证 `[x1, x1+inkW]` / `[x2, x2+inkW]` 落在"两侧元素墨迹之间的空档"内。
   */
  inkW?: number
  /** 层顶 y */
  yTop: number
  /** 层底 y */
  yBottom: number
  /**
   * dsb 专用：**下层声部**（包络内的主旋律）底缘 y——供渲染画一对跨两层的大花括号
   * （图 2 的 `{ … }`）；bz 无下层，不设该字段。
   */
  yBottomLower?: number
  /**
   * adj722 专用：**段内容层基线 y**（= 视觉上排音符的 `y`）。
   *
   * 为什么要记：色块的上下界要按"两排的**真实**中线"切，而 `rowSlides`/`parentY`
   * 那条链只能给出"行基点"，与"段内容实际落在哪"差 **3.3px**（实测：行基点 168.2，
   * 两排实际为 153.9 / 182.5 ⇒ 真实中点 168.2 但由基点反推会偏）。
   * 偏差会让上下两块各错 3~7px（`smoke` 的 `Z8d`/`V3b` 报出 `contentBot=157.8 vs outsideTop=164.95`）。
   *
   * 与之配对的下排基线由 `yBottomLower − 0.3×字号` 得到（`yBottomLower` 是既有字段，
   * 口径 = 下排数字墨迹底 + `0.35×字号`）⇒ 两排基线都能从括号本身取到，**不再靠反推**。
   */
  yUpper?: number
  /**
   * adj685（用户口径「大括号的对齐**以墨迹的居中**」）：大括号**自己的**上下墨迹端点。
   *
   * 为什么不复用 `yTop`/`yBottomLower`：那两个字段还被**声部色块**、曲部虚线、方框小节序号消费，
   * 按"墨迹 + 对称留白"改会连带把色块拉成上下不等高。这里单开一对字段，
   * 口径 = 上层数字墨迹顶 − `0.35×字号` / 下层数字墨迹底 + `0.35×字号`（上下对称）。
   */
  braceTop?: number
  braceBottom?: number
  /**
   * adj707：**让位区间的可用宽**（布局算出，供断言按墨迹口径判定）。
   *
   * 为什么随括号一起给：断言要判"括号与两侧邻居/内容的净距是否够 `w/2`"，
   * 但**可用宽本身不够 `w` 时**（`leftLimit > contentL` 的退化行）根本放不下，
   * 此时只能贴住一侧；断言若不知道这个前提，就会把"合规的退化布局"判成红灯。
   * 布局是唯一知道这个前提的一方 ⇒ 由布局给出，断言直接消费（AGENTS 六之二·4「数值口径同源」）。
   */
  availL?: number
  availR?: number
  /**
   * adj442：**色块占宽边界**（用户规则）——
   *  - `bz`（临时伴奏）：以**前后的小节线**为界（`blockLeft`/`blockRight` = 包络两端的主旋律小节线 x）；
   *  - `dsb`（临时多声部）：以大括号为界，取两括号的**内缘**（adj667：左 = `{` 墨迹右缘、
   *    右 = `}` 墨迹左缘）——色块严格落在括号之间，不压括号墨迹。
   * 播放色块在重叠区内按此收边（见 `playback/sequence.ts`）。
   */
  blockLeft?: number
  blockRight?: number
  /** 所属声部 */
  voice: number
  /** 所属曲词分组下标（= result.groups 下标） */
  group: number
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
  /**
   * adj651c（用户报「跳房子 2 / 结束句的连音线按两个半拍演奏」）：**延续类连音线**的音符索引对
   * （跳房子里那个孤立 `)`：起点在房子起始小节线之前、终点是该房子首音）。
   *
   * 为什么要交给播放端：这类连线在**演奏顺序**里两端相邻（第 2 遍跳过房子 1 之后，
   * 房子 2 的首音紧跟着起音），但在**源码顺序**里隔着一整段旋律 ⇒ 播放的合并判据
   * （源码索引相邻 + 同属一弧）认不出来，只能靠这份显式清单把"接续"关系带过去。
   */
  continuationTies?: { start: number; end: number }[]
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
  /**
   * adj625（用户要求）：**显示小节计数**——在小节线下方画带方框的小节序号。
   * 谱面级设置（L2，随 .jps 走：开关会改变谱面外观）。
   */
  showBarCount: boolean
  /**
   * adj625（用户要求）：**小节序号间隔**——每隔几个小节显示一个序号（默认 4 ⇒ 第 4、8、12… 小节）。
   * 只在 `showBarCount` 打开时生效；排版端钳制到 1~99（越界/非数回退 4）。
   */
  barCountInterval: number
  /** adj303：是否显示乐器名注释（@乐器名 / @@ 切换后的下一个音符上方；缺省 false 不显示） */
  showInstrument?: boolean
  /**
   * adj428：临时叠加段（`{bz … }` / `{dsb … }` / adj629 `{tp … }`）上下两行之间的纵向间距（px）。
   *  - `bz`：主旋律行不动，段层抬 `segmentRowGap.bz`。
   *  - `dsb`：上下两层各偏移 `segmentRowGap.dsb / 2`，整块关于主旋律基线居中。
   *  - `tp`（adj629 替谱段）：主旋律行不动，替谱层画在**所属歌词行上方** `segmentRowGap.tp` 处，
   *    该歌词行及其后各歌词行整体下移以腾出空间。
   * 单项缺省回退 `spacing.ts` 的 `SEGMENT_ROW_GAP_DEFAULT`（22 px，与 adj427 原值 ≈`note_size × 1.7` 一致）。
   * 谱面级设置——改它会让这份谱"长不一样"，需随 .jps 走（见 docs/SETTINGS-AUDIT.md）。
   */
  segmentRowGap?: { bz?: number; dsb?: number; tp?: number }
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

export const defaultPageConfig: PageConfig = {
  page: 'A4',
  // adj213：默认边距 80 → 40（页面留白收窄）
  margin_top: 40,
  margin_bottom: 40,
  // adj418：左右边距 40 → 50（用户要求：左右留白略宽一点，行不贴边）
  margin_left: 50,
  margin_right: 50,
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
  // adj213：曲部与词部间距 13 → 15；adj629y（用户要求）：默认 15 → 20
  height_quci: 20,
  height_cici: 10,
  height_ciqu: 20, // adj78：曲部与曲部间距默认 40→20；adj79 拆分后仅指无歌词行行尾间距
  // adj213：曲部与上一行词部间距 12 → 10；adj629w（用户要求）：默认 10 → -5（歌词行压得更紧）
  height_ciqu_lyric: -5,
  height_shengbu: 0,
  bar_gap: 0,
  align_min_bars: 4,
  // adj289：默认空间优先（指定为默认布局方式）
  noteSpaceLayout: 'space',
  // adj625：小节计数（方框小节序号）；间隔默认 4 小节
  // adj630c（用户要求）：默认由**关闭**改为**勾选**（新谱/未写过该项的谱都显示序号）
  showBarCount: true,
  barCountInterval: 4,
  lianyinxian_type: 0,
}

/** 纸张尺寸（mm → 渲染用 pt，1pt = 25.4/72 mm） */
export const PAPER_SIZE: Record<PageConfig['page'], { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  A4_horizontal: { width: 841.89, height: 595.28 },
  A5_horizontal: { width: 595.28, height: 419.53 },
}
