/**
 * engine/playback/sync.ts — 「伴奏对拍」的纯数学（锚点 → 拍速/偏移；拍 ↔ 音频毫秒）
 *
 * 用户口径（2026-10-24）：
 *  · 锚点 = 「伴奏文件里的一个**绝对时刻**」+「谱面的哪一拍」（如 `2:1`）；
 *  · 相邻两锚点为一段：`段拍速 = 段时长 / 段拍数`（实数，喂给播放序列/球/相机），
 *    `段节拍数 = 段拍数 / 段时长秒 × 60`（取整，给人看）；
 *  · 曲首/曲尾的"单锚点段"参考相邻段（全局拟合同一条线，天然就是这件事）；
 *  · 多锚点：**全局一条 `beatMs`**（最小二乘），`segments` 只做诊断；
 *  · 告警判据（用户定）：**某条锚点相对整体拟合偏 > 1 拍** ⇒ 提醒调整
 *    （不是"两段 BPM 差 1"，那是谱面拍数写错的信号，见 `residualBeatsOf`）。
 *
 * 为什么单独一个模块：对拍台（界面）、出片（宿主）、命令行（`--sync`）都要算同一件事
 * ——AGENTS「数值口径同源」，只能有一份实现，且必须能在 Node 里断言（无 DOM、无 AudioContext）。
 *
 * 时间轴约定：
 *  - `beat` = **从曲首算的拍序号**（0 起，可带小数）；小节起始拍由排版结构给（与速度无关）；
 *  - `audioMs` = 伴奏**文件绝对毫秒**（掐头去尾不改它）；
 *  - 整段线性：`audioMs = offsetMs + beat × beatMs`（即谱面时刻 `t` 与 `beat×beatMs` 同源）。
 */

/** 一个锚点：谱面拍位 ↔ 伴奏文件绝对毫秒 */
export interface SyncAnchor {
  /** 从曲首算的拍序号（0 起；`2:1` 由调用方换算成拍） */
  beat: number
  /** 伴奏文件里的绝对毫秒 */
  audioMs: number
  /** 用户锁定后不允许再拖/微调（只影响界面，不影响数学） */
  locked?: boolean
}

/**
 * 一段的**诊断**（相邻两锚点；只用于显示与告警，不参与时间轴）。
 *
 * 用户口径：多锚点时相邻两锚点为一段，分别算"拍速"与"实际节拍数"，
 * 互相差太多就说明锚点点歪了（或谱面拍数写错）。
 */
export interface SyncSegmentStat {
  fromBeat: number
  toBeat: number
  /** 段内拍数（= toBeat − fromBeat） */
  beats: number
  /** 段内时长（ms） */
  ms: number
  /** 段拍速（实数，ms/拍） */
  beatMs: number
  /** 段"实际节拍数"（取整，BPM） */
  bpm: number
  /** 与全局拟合的偏差（BPM；正 = 这段更快） */
  delta: number
}

/** 对拍解算结果（纯数据；直接存进 sidecar 的 `tempo`/`segments`） */
export interface SyncFit {
  /** 全局拍速（ms/拍，实数） */
  beatMs: number
  /** 拍 0 对应的伴奏毫秒（可能为负：伴奏从曲子中间开始） */
  offsetMs: number
  /**
   * 每条锚点相对拟合直线的残差（ms）。**与"按拍位排序后"的锚点同序**——
   * `fitSync` 内部先按 `beat` 升序排（同一份谱的锚点本来就是顺序打的）。
   */
  residualsMs: number[]
  /** 每段诊断（n 条锚点 → n−1 段；不足 2 条时为空） */
  segments: SyncSegmentStat[]
}

/** 掐头去尾的保留段（文件绝对毫秒） */
export interface SyncTrim {
  startMs: number
  endMs: number
}

/** 时间轴最小形状（只读这两个字段，`SyncFit` 与 sidecar 的 `tempo` 都能传） */
type Tempo = { beatMs: number; offsetMs: number }

/**
 * 锚点 → (beatMs, offsetMs)。**不足 2 条返回 `null`**（一条只能定偏移，不能定速度）。
 *
 * - 2 条：精确解；
 * - ≥3 条：最小二乘（`a = offset + beat × beatMs` 的一元线性回归）——
 *   比"首末两点"稳，能吃掉单点误差；
 * - 任何非法输入（非有限数、拍位重复导致 `beatMs ≤ 0`）→ `null`。
 */
export function fitSync(anchors: readonly SyncAnchor[]): SyncFit | null {
  const pts = anchors
    .filter((a) => Number.isFinite(a.beat) && Number.isFinite(a.audioMs))
    .slice()
    .sort((a, b) => a.beat - b.beat)
  if (pts.length < 2) return null
  // 拍位必须严格递增（同一拍两个锚点没有意义）
  for (let i = 1; i < pts.length; i++) if (pts[i].beat - pts[i - 1].beat <= 1e-9) return null

  let beatMs: number
  let offsetMs: number
  if (pts.length === 2) {
    const [p, q] = pts
    beatMs = (q.audioMs - p.audioMs) / (q.beat - p.beat)
    offsetMs = p.audioMs - p.beat * beatMs
  } else {
    const n = pts.length
    let sb = 0
    let sa = 0
    let sbb = 0
    let sba = 0
    for (const p of pts) {
      sb += p.beat
      sa += p.audioMs
      sbb += p.beat * p.beat
      sba += p.beat * p.audioMs
    }
    const den = n * sbb - sb * sb
    if (Math.abs(den) < 1e-9) return null
    beatMs = (n * sba - sb * sa) / den
    offsetMs = (sa - beatMs * sb) / n
  }
  if (!Number.isFinite(beatMs) || beatMs <= 0 || !Number.isFinite(offsetMs)) return null

  const residualsMs = pts.map((p) => p.audioMs - (offsetMs + p.beat * beatMs))
  const bpm = 60000 / beatMs
  const segments: SyncSegmentStat[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const beats = b.beat - a.beat
    const ms = b.audioMs - a.audioMs
    if (beats <= 0 || ms <= 0) continue
    const segBeatMs = ms / beats
    const segBpm = beats * 60000 / ms
    segments.push({
      fromBeat: a.beat,
      toBeat: b.beat,
      beats,
      ms,
      beatMs: segBeatMs,
      bpm: Math.round(segBpm * 10) / 10,
      delta: Math.round((segBpm - bpm) * 10) / 10,
    })
  }
  return { beatMs, offsetMs, residualsMs, segments }
}

/** 拍 → 伴奏毫秒（整段线性） */
export function audioMsOfBeat(fit: Tempo, beat: number): number {
  return fit.offsetMs + beat * fit.beatMs
}

/** 伴奏毫秒 → 拍（反解；波形上点位置/滚回重听用） */
export function beatOfAudioMs(fit: Tempo, ms: number): number {
  return (ms - fit.offsetMs) / fit.beatMs
}

/**
 * 每条锚点的残差**换算成拍**（绝对值）。
 *
 * 用户 2026-10-24 定的告警判据：`> 1` ⇒ 告警（"这个锚点跟整体速度对不上超过 1 拍"）。
 * 为什么用拍而不是毫秒：拍是音乐单位，用户能判断"差一拍"意味着什么；毫秒对人不直观。
 */
export function residualBeatsOf(fit: Pick<SyncFit, 'beatMs' | 'residualsMs'>): number[] {
  return fit.residualsMs.map((r) => Math.abs(r) / fit.beatMs)
}

/** BPM（取整前的实数） */
export function bpmOfFit(fit: Pick<Tempo, 'beatMs'>): number {
  return 60000 / fit.beatMs
}

/** 这个绝对时刻在保留段里吗（导出/播放都先问它；`trim` 缺省视为整段） */
export function inTrimRange(trim: SyncTrim | undefined, audioMs: number): boolean {
  if (!trim) return true
  return audioMs >= trim.startMs && audioMs < trim.endMs
}

/**
 * 对拍台**动态谱预览**：音频时刻 → 放映会话时刻（`adj1123`）。
 *
 * 预览会话按**谱面 `J:`** 建（一次建好、不随微调重建），而伴奏可能是另一个速度，
 * 所以这里按拍速比例缩放：`t = (audioMs − offsetMs) × beatMsSession / beatMsFit`。
 *
 * 为什么这样可以：谱面的"音乐时间"只由拍数决定 —— `audioMs = offset + 拍 × beatMsFit`，
 * 代入后 `t = 拍 × beatMsSession`，正是"第几拍"在会话里的位置。**拍数不变，只换秒数**，
 * 所以微调 ±5ms 不需要重建会话（重建一次几百毫秒，会把手感拖垮）。
 */
export function sessionMsOfAudioMs(audioMs: number, fit: Tempo, sessionBeatMs: number): number {
  return (audioMs - fit.offsetMs) * (sessionBeatMs / fit.beatMs)
}

/**
 * 段落"实际节拍数"（BPM）的**显示口径**：取整。
 * 单独一个函数是为了让界面与命令行说同一个数（AGENTS「数值口径同源」）。
 */
export function displayBpm(beatMs: number): number {
  return Math.round(60000 / beatMs)
}
