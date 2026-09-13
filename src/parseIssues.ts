/**
 * parseIssues.ts — 解析问题的分级拆分（纯逻辑，零 Obsidian 依赖，可单测）
 *
 * adj394：引擎 `parseJps` 的产出里含 `error`（阻断渲染）与 `warning`（提示，不阻断——
 * 如多空格、孤立 &、渐强/渐弱写得不完整等）。插件此前一律用 `errors.length > 0` 判失败，
 * 于是**只要有一条告警就整页不渲染**（应用侧一直按 severity 区分，插件漏了）。
 *
 * 每条问题还带 `hint`（引擎给出的**正确语法规则 + 最小示例**），端侧据此显示「正确写法」。
 */
import type { ParseResult } from '@ijipu/engine'

/** 单条解析问题（已按严重级别归类、带行列与正确写法） */
export interface ParseIssue {
  severity: 'error' | 'warning'
  /** 1-based 行/列（列 = 源码 0-based + 1） */
  line: number
  col: number
  message: string
  /** 正确语法规则（含最小示例），可能缺省 */
  hint?: string
  /** 展示用一行文本：第N行 第M列 消息 */
  text: string
}

/** 拆分后的解析问题：errors 阻断渲染；warnings 仅提示 */
export interface ParseIssues {
  errors: ParseIssue[]
  warnings: ParseIssue[]
}

export function splitParseIssues(parsed: Pick<ParseResult, 'errors'>): ParseIssues {
  const errors: ParseIssue[] = []
  const warnings: ParseIssue[] = []
  for (const e of parsed.errors) {
    const message = e.message ?? String(e)
    const col = e.col + 1
    const issue: ParseIssue = { severity: e.severity, line: e.line, col, message, hint: e.hint, text: `第${e.line}行 第${col}列 ${message}` }
    if (e.severity === 'error') errors.push(issue)
    else warnings.push(issue)
  }
  return { errors, warnings }
}
