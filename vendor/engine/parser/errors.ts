/**
 * engine/parser/errors.ts — 解析错误构造辅助
 *
 * adj394：错误/告警除 `message`（哪儿错了）外可带 `hint`（**正确语法规则 + 最小示例**），
 * 端侧（应用编辑区问题条 / Obsidian 插件告警区）据此在提示下方直接给出「正确写法」。
 */
import type { ParseError, SourcePos } from '../types'

export function err(
  message: string,
  pos: SourcePos | null,
  severity: ParseError['severity'] = 'error',
  hint?: string,
): ParseError {
  return {
    line: pos?.line ?? 0,
    col: pos?.col ?? 0,
    message,
    severity,
    hint,
  }
}

export function errAt(
  message: string,
  line: number,
  col: number,
  severity: ParseError['severity'] = 'error',
  hint?: string,
): ParseError {
  return { line, col, message, severity, hint }
}
