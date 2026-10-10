/**
 * engine/diagnostics/problems.ts — 解析问题的**分级、排序、计数与展示行**（纯逻辑，零 DOM）
 *
 * 用户 2026-10 要求：「预览渲染、播放、源码格式化、源码高亮、**错误信息显示提示**等共性的功能
 * 都可以独立到引擎层面」，并明确「应用端也应同样处理」。
 *
 * 此前这套逻辑两端各写一遍、且**措辞不同**：
 *  · 应用 `src/ui/problems.ts`：`错误[第3行 第5列] 消息` + 分级标签 + 排序 + 计数 + `worst`；
 *  · 插件 `src/parseIssues.ts`：`第3行 第5列 消息`（没有分级标签）—— 于是同一份谱两端提示长得不一样。
 * 现在收到引擎：**语义（分级/排序/计数/位置换算）与默认文案都在这里**；
 * 宿主品牌文案（如应用 `brand/copy.ts` 的措辞）可以经 `labels` 传入覆盖。
 *
 * 约定：`ParseError.line` 1-based、`col` **0-based**（引擎内部口径）；
 * 展示用的 `ProblemRow.col` 一律 **1-based**（给人看的那份）。
 */
import type { ParseError } from '../types'

export type ProblemSeverity = 'error' | 'warning'

/** 分级标签（宿主可覆盖；默认与两端既有文案一致） */
export interface ProblemLabels {
  error: string
  warning: string
  /** 「正确写法」前缀（应用 `problemCopy.correctPrefix`） */
  correctPrefix: string
}

export const DEFAULT_PROBLEM_LABELS: ProblemLabels = {
  error: '错误',
  warning: '警告',
  correctPrefix: '正确写法：',
}

/** 单条问题的展示行 */
export interface ProblemRow {
  severity: ProblemSeverity
  /** 分级中文标签（如「错误」/「警告」） */
  label: string
  line: number
  /** 1-based 列（给人看的那份；引擎内部 `col` 是 0-based） */
  col: number
  message: string
  /** 正确语法规则（引擎给出，含最小示例）——端侧以「正确写法」呈现 */
  hint?: string
  /** 展示用全文，如「错误[第3行 第5列] 引号注释未闭合」 */
  text: string
}

/** 问题汇总（供提示条、状态栏、诊断行共用） */
export interface ProblemSummary {
  errorCount: number
  warnCount: number
  total: number
  /** 排序后的展示行（错误在前，同类按行列） */
  rows: ProblemRow[]
  /** 最严重级别：有 error 则 error，否则（有 warning）warning，否则 null */
  worst: ProblemSeverity | null
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warning: 1 }

/** 把一条引擎问题变成展示行 */
export function problemRowOf(e: ParseError, labels: ProblemLabels = DEFAULT_PROBLEM_LABELS): ProblemRow {
  const severity: ProblemSeverity = e.severity === 'warning' ? 'warning' : 'error'
  const label = severity === 'error' ? labels.error : labels.warning
  const col = e.col + 1
  return {
    severity,
    label,
    line: e.line,
    col,
    message: e.message,
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
    text: `${label}[第${e.line}行 第${col}列] ${e.message}`,
  }
}

/**
 * 汇总解析问题：**错误在前、同类按行列出**，并给出各级数量与最严重级别。
 * `max` 可限制返回行数（提示条默认只列前几条，其余用「还有 N 条」概括）；
 * ⚠ `total`/`errorCount`/`warnCount` 永远是**全部**问题的统计，不受 `max` 影响。
 */
export function summarizeProblems(
  errors: readonly ParseError[],
  opts?: { max?: number; labels?: ProblemLabels },
): ProblemSummary {
  const labels = opts?.labels ?? DEFAULT_PROBLEM_LABELS
  const sorted = [...errors].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity === 'warning' ? 'warning' : 'error'] -
        SEVERITY_ORDER[b.severity === 'warning' ? 'warning' : 'error'] ||
      a.line - b.line ||
      a.col - b.col,
  )
  const errorCount = sorted.filter((e) => e.severity !== 'warning').length
  const warnCount = sorted.length - errorCount
  const rows = sorted.map((e) => problemRowOf(e, labels))
  const max = opts?.max
  return {
    errorCount,
    warnCount,
    total: rows.length,
    rows: typeof max === 'number' && max >= 0 ? rows.slice(0, max) : rows,
    worst: errorCount > 0 ? 'error' : warnCount > 0 ? 'warning' : null,
  }
}

/** 按严重级别拆开（插件此前 `splitParseIssues` 的语义；`errors` 阻断渲染、`warnings` 仅提示） */
export function splitParseIssues(
  parsed: { errors: readonly ParseError[] },
  labels: ProblemLabels = DEFAULT_PROBLEM_LABELS,
): { errors: ProblemRow[]; warnings: ProblemRow[] } {
  const errors: ProblemRow[] = []
  const warnings: ProblemRow[] = []
  for (const e of parsed.errors) {
    const row = problemRowOf(e, labels)
    if (row.severity === 'error') errors.push(row)
    else warnings.push(row)
  }
  return { errors, warnings }
}

/**
 * 问题的提示行（供 tooltip / 提示条渲染）：第一行是消息，其后是「正确写法：<hint>」。
 * 没有 `hint` 时只返回消息一行。
 */
export function problemHintLines(row: Pick<ProblemRow, 'message' | 'hint'>, labels: ProblemLabels = DEFAULT_PROBLEM_LABELS): string[] {
  return row.hint ? [row.message, `${labels.correctPrefix}${row.hint}`] : [row.message]
}

/**
 * 「行/列」→ 源码字符偏移（供"跳到该问题处"定位；行/列越界自动钳制）。
 * 行、列均按 **1-based** 传入（列的 1 表示行首）。
 */
export function offsetOf(code: string, line: number, col: number): number {
  const lines = code.split('\n')
  const li = Math.min(Math.max(1, line), lines.length) - 1
  let offset = 0
  for (let i = 0; i < li; i++) offset += lines[i].length + 1
  const ci = Math.min(Math.max(0, col - 1), lines[li].length)
  return offset + ci
}
