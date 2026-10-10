/**
 * engine/highlight/model.ts — **整篇/逐行高亮模型**（纯逻辑，零 DOM）
 *
 * 用户 2026-10 要求（清单 B4）：「预览渲染、播放、源码格式化、源码高亮、错误信息显示提示等共性的功能
 * 都可以独立到引擎层面」，且「应用端也应同样处理」。
 *
 * 现状：规则（`tokenizeJpsLine`）与"错误→块"换算（`jpsBlockMarks`）都已经在引擎里了，
 * 但**两端仍各自"按行取 token + 查该行的错误块 + 判行级级别"** —— 这套组合逻辑一旦分叉，
 * 就会出现"应用给这行标红、插件给那行标红"。本模块把它一次算好，两端只做**渲染映射**
 * （应用→HTML span；插件→CM6 Decoration）。
 *
 * 设计要点：
 *  · `tokens` 覆盖整行（含前导空白），拼接 === 原行 ⇒ 渲染端可以直接按位置打标记，不会错位；
 *  · `blocks` 是**行内**区间（0-based 半开，相对整行原文），与 `jpsBlockMarks` 同源；
 *  · `level` 是该行最严重级别（有 error 则 error），供"整行底色"用；
 *  · 逐行入口 `highlightLineModel` 让宿主只为**可视区域**算（大文件不吃性能）。
 */
import type { ParseError } from '../types'
import { jpsBlockMarks, jpsSeverityOf, type JpsBlockMark } from './jpsProblems'
import { jpsHeaderOf, tokenizeJpsLine, type JpsToken } from './jpsHighlight'

export type ProblemLevel = 'error' | 'warning'

/** 一行的高亮模型 */
export interface JpsLineModel {
  /** 1-based 行号 */
  line: number
  /** 该行原文 */
  text: string
  /** 覆盖整行的 token（拼接 === text） */
  tokens: JpsToken[]
  /** 行头（`Q:` / `C:` 等）——无行头为 null */
  header: { cmd: string; headLen: number } | null
  /** 该行的错误/告警块（行内区间，0-based 半开） */
  blocks: JpsBlockMark[]
  /** 该行最严重级别（有 error 则 error；无问题为 null） */
  level: ProblemLevel | null
}

/** 整篇高亮模型 */
export interface JpsHighlightModel {
  lines: JpsLineModel[]
  /** 全部错误/告警块（按行、按位置排序） */
  blockMarks: JpsBlockMark[]
  /** 有问题的行号集合（供"整行底色"或行号栏着色） */
  errorLines: Set<number>
  warningLines: Set<number>
  /** 有任意问题（错误或告警）的行号集合 —— 宿主"该行需要提示"的判据 */
  problemLines: Set<number>
}

/** 把"整篇块标记"按行分组，便于逐行查（宿主可视区渲染用） */
export function groupBlocksByLine(marks: readonly JpsBlockMark[]): Map<number, JpsBlockMark[]> {
  const m = new Map<number, JpsBlockMark[]>()
  for (const b of marks) {
    const arr = m.get(b.line)
    if (arr) arr.push(b)
    else m.set(b.line, [b])
  }
  return m
}

/** 行级级别：有错误则 error，否则有告警则 warning，否则 null */
export function lineLevelOf(blocks: readonly JpsBlockMark[]): ProblemLevel | null {
  let level: ProblemLevel | null = null
  for (const b of blocks) {
    if (b.severity === 'error') return 'error'
    level = 'warning'
  }
  return level
}

/**
 * **逐行**模型（宿主的可视区渲染入口）：只为给定行算 token / 块 / 级别。
 * @param blocks 该行的错误/告警块（可由 `groupBlocksByLine(jpsBlockMarks(...))` 预先分好）
 */
export function highlightLineModel(lineText: string, lineNo: number, blocks: readonly JpsBlockMark[] = []): JpsLineModel {
  const trimmed = lineText.trim()
  const head = jpsHeaderOf(trimmed)
  const cmd = head ? /^([A-Z])/.exec(trimmed)?.[1] ?? '' : ''
  return {
    line: lineNo,
    text: lineText,
    tokens: tokenizeJpsLine(lineText),
    header: head && cmd ? { cmd, headLen: head.headLen } : null,
    blocks: [...blocks],
    level: lineLevelOf(blocks),
  }
}

/**
 * **整篇**模型（一次算完，供需要全文信息的宿主用；插件渲染请优先用 `highlightLineModel` 只算可视区）。
 */
export function highlightModel(source: string, issues: readonly ParseError[] = []): JpsHighlightModel {
  const text = source.replace(/\r\n/g, '\n')
  const blockMarks = jpsBlockMarks(text, issues)
  const byLine = groupBlocksByLine(blockMarks)
  const errorLines = new Set<number>()
  const warningLines = new Set<number>()
  for (const issue of issues) {
    if (jpsSeverityOf(issue) === 'error') errorLines.add(issue.line)
    else warningLines.add(issue.line)
  }
  const lines = text.split('\n').map((lineText, i) => highlightLineModel(lineText, i + 1, byLine.get(i + 1) ?? []))
  return { lines, blockMarks, errorLines, warningLines, problemLines: new Set([...errorLines, ...warningLines]) }
}
