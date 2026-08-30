/**
 * engine/parser/errors.ts — 解析错误构造辅助
 */
import type { ParseError, SourcePos } from '../types'

export function err(
  message: string,
  pos: SourcePos | null,
  severity: ParseError['severity'] = 'error',
): ParseError {
  return {
    line: pos?.line ?? 0,
    col: pos?.col ?? 0,
    message,
    severity,
  }
}

export function errAt(
  message: string,
  line: number,
  col: number,
  severity: ParseError['severity'] = 'error',
): ParseError {
  return { line, col, message, severity }
}
