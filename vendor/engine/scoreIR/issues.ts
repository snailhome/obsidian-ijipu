/**
 * engine/scoreIR/issues.ts — IR 转换问题的构造/去重
 *
 * 为什么单独一个文件：`.jps` ↔ MusicXML 互转与识图都会产出 issue，
 * 三处各写一套 `{id,severity,...}` 必然漂开；而且 issue 必须**可去重**
 * （同一处低置信被两层各报一次，用户会在清单里看到两条一样的）。
 */
import type { IRIssue, IRIssueKind, IRSourcePos } from './types'

/** 构造一条 issue（id 用「类型 + 位置 + 消息摘要」定死，便于去重与断言） */
export function makeIssue(
  kind: IRIssueKind,
  severity: IRIssue['severity'],
  message: string,
  source?: IRSourcePos,
  refs?: string[],
): IRIssue {
  const where = source ? `@${source.line}:${source.col}` : ''
  const id = `ir-${kind}${where}-${message.slice(0, 16)}`
  return { id, severity, kind, message, ...(source ? { source } : {}), ...(refs ? { refs } : {}) }
}

/** 按 id 去重（保留先出现的那条：先到的通常是更具体的来源） */
export function dedupeIssues(list: IRIssue[]): IRIssue[] {
  const seen = new Set<string>()
  const out: IRIssue[] = []
  for (const it of list) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  return out
}

/** 是否含必须处理的问题（UI 用它决定「能否直接导出」） */
export function hasMustIssue(list: IRIssue[]): boolean {
  return list.some((it) => it.severity === 'must')
}
