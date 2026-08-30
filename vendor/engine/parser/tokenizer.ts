/**
 * engine/parser/tokenizer.ts — Q 行（曲行）token 化
 *
 * 将一行音符文本（如 "1 2 3. 4/ |: [ 5 6 ] :|"）解析为 MusicToken[]。
 * 语法依据 .jps V1.0 手册：音符/休止符/节奏符、高低音点、变音（后置 # $ =）、
 * 时值线、附点、装饰符号（& 编码）、渐强渐弱（< > !）、连音线（( ... ) 带空格）、
 * 小节线与反复记号（| || |: :| :|: |/ |*）、跳房子（[] [/ [+）、
 * 虚音符（(1) 括号紧贴数字，adj23）、倚音（1[65] 前 / 1[h65] 后，adj23）。
 * 块间空格规则（adj23）：音符块与音符块、音符块与小节线块之间恰好一个空格。
 */
import type { BarlineMark, BarlineType, GracenoteNote, MusicToken, SourcePos } from '../types'
import { err } from './errors'
import type { ParseError } from '../types'

/**
 * 解析一行曲谱内容（不含 "Q..:" 行头）。
 * @param content 行内容
 * @param pos 行位置（用于错误定位）
 */
export function tokenizeMusicLine(
  content: string,
  pos: SourcePos,
): { tokens: MusicToken[]; errors: ParseError[] } {
  const tokens: MusicToken[] = []
  const errors: ParseError[] = []
  let i = 0
  const n = content.length
  const rawAt = (start: number, end: number) => content.slice(start, end)

  // ---- 块间空格提示（adj23）：空格仅用于格式化，缺空格合法；多空格提示规范为单空格 ----
  let lastBlockEnd = -1 // 上一个音符块/小节线块的结束字符偏移
  let lastBlockCounts = false // 上一个块是否参与校验
  const checkBlockGap = (blockStart: number) => {
    if (!lastBlockCounts) return
    const between = content.slice(lastBlockEnd, blockStart)
    if (/^ +$/.test(between) && between.length > 1) {
      errors.push(
        err('音符块与小节线块之间应只有一个空格', {
          line: pos.line,
          col: pos.col + blockStart,
        }, 'warning'),
      )
    }
  }
  const registerBlock = (start: number, end: number) => {
    checkBlockGap(start)
    lastBlockEnd = end
    lastBlockCounts = true
  }

  /** 解析 [ 后的跳房子修饰（adj26）：+ 抬高（可多个）、/ 不封闭、引号注释（番号） */
  const parseVoltaMods = (start: number): { k: number; slash: boolean; plus: number; comment?: string } => {
    let k = start
    let slash = false
    let plus = 0
    let comment: string | undefined
    while (k < n) {
      const ch = content[k]
      if (ch === '/') {
        slash = true
        k++
      } else if (ch === '+') {
        plus++
        k++
      } else if (ch === '"') {
        const close = content.indexOf('"', k + 1)
        if (close === -1) {
          comment = content.slice(k + 1)
          errors.push(err('引号注释未闭合', { line: pos.line, col: pos.col + k }))
          k = n
        } else {
          comment = content.slice(k + 1, close)
          k = close + 1
        }
      } else {
        break
      }
    }
    return { k, slash, plus, comment }
  }

  // 收集一个 token 的公共后缀：变音/减时线/增时线/附点/高低音点/装饰/注释
  const collectSuffix = (
    start: number,
    base: { accidental: '#' | '$' | '=' | null; augmentCount: number; diminishCount: number; dots: number; octaveShift: number; symbols: string[]; comment?: string },
  ): number => {
    let j = start
    while (j < n) {
      const c = content[j]
      if (c === '#') {
        base.accidental = '#'; j++
      } else if (c === '$') {
        base.accidental = '$'; j++
      } else if (c === '=') {
        base.accidental = '='; j++
      } else if (c === '-') {
        base.augmentCount++; j++
      } else if (c === '/') {
        base.diminishCount++; j++
      } else if (c === '.') {
        base.dots++; j++
      } else if (c === "'") {
        base.octaveShift++; j++
      } else if (c === ',') {
        base.octaveShift--; j++
      } else if (c === '&') {
        // & 装饰编码：连续字母（adj109：允许尾部 +，如 &sby+ / &cy+）
        // adj220：不再收数字——&dy5/ 中 5 是下一音符起点（此前被吞进 dy5，
        // 3&dy5/&dy5/… 粘连成一个音符）；编码均为字母（tr/cy/dy/fine 等）
        // adj294：&zkh/&ykh 为独立括号标记——不收集为音符符号，停止收集留给主循环处理
        let k = j + 1
        while (k < n && /[a-zA-Z]/.test(content[k])) k++
        if (content[k] === '+') k++
        if (k > j + 1) {
          const code = content.slice(j + 1, k)
          if (code === 'zkh' || code === 'ykh') break
          base.symbols.push(code)
          j = k
        } else {
          break // 孤立 &，停止收集
        }
      } else if (c === '"') {
        // 注释：直到下一个引号；_ 代替空格（adj59：曲部空格仅为分隔，注释内空格用 _ 表示）
        const close = content.indexOf('"', j + 1)
        if (close === -1) {
          base.comment = content.slice(j + 1).replace(/_/g, ' ')
          errors.push(err('引号注释未闭合', { line: pos.line, col: pos.col + j }))
          j = n
        } else {
          base.comment = content.slice(j + 1, close).replace(/_/g, ' ')
          j = close + 1
        }
        // 注释不固定为块末：注释后的 & 等修饰符仍继续收集（对「修饰符在注释后」的写法健壮）；
        // 遇非法字符（数字等）由下方 else break 停止
      } else {
        break
      }
    }
    return j
  }

  while (i < n) {
    const c = content[i]

    // 空白跳过（空格仅用于格式化美观，不影响解析——`(` 修饰其后音符，可紧贴）
    if (c === ' ' || c === '\t') {
      i++
      continue
    }

    // 连音线/连音组：`(` 修饰其后音符（起点），`)` 结束；"(y"/"(Y" 前缀 = 平均连音组（均分时值，adj86 大小写不敏感）；
    // adj135："(+"/"(y+" 的 + 数量抬升连音线；adj136："(-"/"(y-" 的 - 数量下降连音线
    if (c === '(') {
      let j = i + 1
      let plus = 0
      let minus = 0
      let tuplet = false
      while (j < n) {
        if (content[j] === '+') {
          plus++
          j++
        } else if (content[j] === '-') {
          minus++
          j++
        } else if (!tuplet && content[j].toLowerCase() === 'y') {
          tuplet = true
          j++
        } else {
          break
        }
      }
      tokens.push({
        kind: 'slur',
        dir: 'open',
        pos: i,
        raw: content.slice(i, j),
        tuplet,
        plus: plus > 0 ? plus : undefined,
        minus: minus > 0 ? minus : undefined,
      })
      i = j
      continue
    }
    if (c === ')') {
      tokens.push({ kind: 'slur', dir: 'close', pos: i, raw: ')' })
      i++
      continue
    }

    // 渐强渐弱
    if (c === '<' || c === '>') {
      let j = i + 1
      let plus = 0
      while (content[j] === '+') {
        plus++
        j++
      }
      const code = content.slice(i, j)
      tokens.push({
        kind: 'decoration',
        code,
        dynamics: c === '<' ? 'crescendo' : 'decrescendo',
        pos: i,
        raw: code,
      })
      i = j
      continue
    }
    if (c === '!') {
      tokens.push({ kind: 'decoration', code: '!', dynamics: 'end', pos: i, raw: '!' })
      i++
      continue
    }

    // & 装饰编码（行内独立出现）
    if (c === '&') {
      let k = i + 1
      // adj220：只收字母（+ 可选尾部 +）——&dy5/ 中 5 是下一音符起点，不进编码
      while (k < n && /[a-zA-Z]/.test(content[k])) k++
      if (content[k] === '+') k++ // adj109：允许尾部 +（&sby+ 等）
      if (k > i + 1) {
        const code = content.slice(i + 1, k)
        // adj294：&zkh/&ykh 是独立括号标记（无时值元素）——插在源码位置，占宽，不影响音符
        if (code === 'zkh') {
          tokens.push({ kind: 'bracket', dir: 'open', pos: i, raw: content.slice(i, k) })
          i = k
        } else if (code === 'ykh') {
          tokens.push({ kind: 'bracket', dir: 'close', pos: i, raw: content.slice(i, k) })
          i = k
        } else {
          tokens.push({ kind: 'decoration', code, pos: i, raw: content.slice(i, k) })
          i = k
        }
      } else {
        // adj178：孤立 &（输入中未完成）降为 warning——避免预览在 error 时整页阻断、
        // 输入过程中在正确预览与错误提示间闪动（error 仅用于真正破坏结构的错误）
        errors.push(err(`孤立的 "&" 符号（输入中未完成？）`, { line: pos.line, col: pos.col + i }, 'warning'))
        i++
      }
      continue
    }

    // adj301：@乐器名 / @@ 乐器切换指令（Q 行内；不占时值、不渲染，仅播放切换乐器）
    if (c === '@') {
      if (content[i + 1] === '@') {
        // @@ → 切回默认乐器
        tokens.push({ kind: 'instrument', name: null, pos: i, raw: '@@' })
        i += 2
        continue
      }
      let k = i + 1
      // 收集乐器名：到空白/小节线/行尾为止（中文名如 钢琴、英文如 piano）
      while (k < n && content[k] !== ' ' && content[k] !== '\t' && content[k] !== '|' && content[k] !== ':' && content[k] !== '\n') k++
      if (k > i + 1) {
        tokens.push({ kind: 'instrument', name: content.slice(i + 1, k), pos: i, raw: content.slice(i, k) })
        i = k
        continue
      }
      // 孤立 @：略过（作为指令边界）
      i++
      continue
    }

    // 小节线（含反复记号与隐藏线）
    if (c === '|' || (c === ':' && content[i + 1] === '|')) {
      let j = i
      let type: string = ''
      if (content[j] === ':' && content[j + 1] === '|') {
        type = ':|'
        j += 2
        if (content[j] === ':') {
          type = ':|:'
          j++
        }
      } else {
        // 从 '|' 开始
        let bars = 0
        while (content[j] === '|') {
          bars++
          j++
        }
        if (content[j] === ':') {
          type = bars === 2 ? '||:' : '|:'
          j++
        } else if (content[j] === '/') {
          type = bars === 2 ? '||/' : '|/'
          j++
        } else if (content[j] === '*') {
          type = '|*'
          j++
        } else {
          type = bars === 2 ? '||' : '|'
        }
      }
      const t: Extract<MusicToken, { kind: 'barline' }> = {
        kind: 'barline',
        type: type as BarlineType,
        pos: i,
        raw: rawAt(i, j),
      }
      // 跳过小节线后的空格，再处理备注（引号）与跳房子标记；
      // 若无附加内容则回退到空格前（空格留给下一个块做单空格校验，adj23）
      const barEnd = j
      while (content[j] === ' ' || content[j] === '\t') j++
      // adj295：跳房子标记（[ ]）、小节线修饰符（&fine/&dc/&ds/&ty/&hs）、
      // 小节线引号备注（"p:2/4" 临时节拍 / 备注）可**任意顺序共存**——循环处理而非固定顺序；
      // 此前引号只在开头处理一次，& 在引号前时（|&hs"p:2/4"）引号被吞、临时节拍丢失
      {
        let guard = 0
        while (guard++ < 6) {
          if (content[j] === '[') {
            // 跳房子开始（adj26：修饰 = + 抬高 / 不封闭 / 引号注释）
            const mod = parseVoltaMods(j + 1)
            t.voltaStart = { open: true, slash: mod.slash, plus: mod.plus, comment: mod.comment }
            t.raw = rawAt(i, mod.k)
            j = mod.k
          } else if (content[j] === ']') {
            // |] 跳房子结束；|]/ 开口结束（adj26）
            t.voltaEnd = true
            let k = j + 1
            if (content[k] === '/') {
              t.voltaEndSlash = true
              k++
            }
            t.raw = rawAt(i, k)
            j = k
          } else if (content[j] === '&') {
            // adj126：小节线修饰符（&fine 曲终 / &dc 从头反复 / &ds 大反复 / &ty 大跳跃 / &hs 花S）
            // adj206：同一小节线可叠加多个修饰符（如 |&ty&ds）——循环收集
            const marks: Extract<MusicToken, { kind: 'barline' }>['marks'] = []
            let k = j
            while (k < n && content[k] === '&') {
              let m = k + 1
              while (m < n && /[a-z]/i.test(content[m])) m++
              const code = content.slice(k + 1, m)
              if (code === 'fine' || code === 'dc' || code === 'ds' || code === 'ty' || code === 'hs') {
                marks.push(code as BarlineMark)
                k = m
              } else {
                break // 非小节线修饰符：停止收集（& 留给独立装饰处理）
              }
            }
            if (marks.length > 0) {
              t.marks = marks
              t.raw = rawAt(i, k)
              j = k
            } else {
              break // 非小节线修饰符：& 留给独立装饰处理
            }
          } else if (content[j] === '"') {
            // 小节线备注（引号，如 "p:2/4" 临时节拍 / 备注）——任意顺序下都能解析
            const close = content.indexOf('"', j + 1)
            if (close === -1) {
              t.comment = content.slice(j + 1)
              errors.push(err('引号注释未闭合', { line: pos.line, col: pos.col + j }))
              j = n
            } else {
              t.comment = content.slice(j + 1, close)
              t.raw = rawAt(i, close + 1)
              j = close + 1
            }
          } else {
            break
          }
        }
        // 无任何附加（备注/跳房子/修饰符）：回退到空格前（空格留给下一个块，adj23）
        if (t.comment === undefined && t.voltaStart === undefined && t.voltaEnd === undefined && t.marks === undefined) {
          j = barEnd
        }
      }
      tokens.push(t)
      registerBlock(i, j)
      i = j
      continue
    }

    // 倚音（adj23）：音符后面的 [65] 前倚音 / [h65] 后倚音，是音符块的一部分；
    // 括号内音符可含高低音点 ' ,、变音 # $ =、减时线 /。
    // 与跳房子区分（adj23）：小节线后的 [ 是跳房子；音符后的 [ 是倚音
    if (c === '[') {
      const last = tokens[tokens.length - 1]
      if (last && last.kind === 'note') {
        let k = i + 1
        let after = false
        // adj86：[h 与 [H 等效（后倚音，大小写不敏感）
        if (content[k] !== undefined && content[k].toLowerCase() === 'h') {
          after = true
          k++
        }
        const notes: GracenoteNote[] = []
        let closed = false
        while (k < n) {
          const ch = content[k]
          if (ch === ']') {
            closed = true
            k++
            break
          }
          if (ch === ' ' || ch === '\t') {
            k++
            continue
          }
          if (ch >= '1' && ch <= '7') {
            const gn: GracenoteNote = {
              pitch: ch.charCodeAt(0) - 48 as 1 | 2 | 3 | 4 | 5 | 6 | 7,
              octaveShift: 0,
              accidental: null,
              diminishCount: 0,
            }
            k++
            while (k < n) {
              const sc = content[k]
              if (sc === "'") {
                gn.octaveShift++
                k++
              } else if (sc === ',') {
                gn.octaveShift--
                k++
              } else if (sc === '#') {
                gn.accidental = '#'
                k++
              } else if (sc === '$') {
                gn.accidental = '$'
                k++
              } else if (sc === '=') {
                gn.accidental = '='
                k++
              } else if (sc === '/') {
                gn.diminishCount++
                k++
              } else {
                break
              }
            }
            notes.push(gn)
          } else {
            errors.push(
              err('倚音内不支持的符号', { line: pos.line, col: pos.col + k }, 'warning'),
            )
            k++
          }
        }
        if (!closed) {
          errors.push(
            err('倚音括号 "]" 未闭合', { line: pos.line, col: pos.col + i }, 'warning'),
          )
        }
        last.gracenotes = { after, notes }
        last.raw += rawAt(i, k)
        lastBlockEnd = k // 音符块结束延展到倚音括号后
        i = k
        continue
      }
    }

    // 跳房子标记（独立出现，例如行首用 |/ 之后；或小节线引号备注后带空格；或 ] 后连续 [）
    if (c === '[') {
      const mod = parseVoltaMods(i + 1)
      const last = tokens[tokens.length - 1]
      if (last && last.kind === 'barline' && !last.voltaStart && !last.voltaEnd) {
        // 继承前一小节线（含番号备注），合并跳房子起点
        last.voltaStart = { open: true, slash: mod.slash, plus: mod.plus, comment: mod.comment }
        last.raw += rawAt(i, mod.k)
        lastBlockEnd = mod.k // 小节线块结束延展
      } else if (last && last.kind === 'barline' && last.voltaEnd && !last.voltaStart) {
        // ] 后连续 [（如 |]["2"）：第二段起点与第一段结束**共用同一小节线**
        // （adj139：voltaEnd + voltaStart 共存于一根小节线，不另画竖线）
        last.voltaStart = { open: true, slash: mod.slash, plus: mod.plus, comment: mod.comment }
        last.raw += rawAt(i, mod.k)
        lastBlockEnd = mod.k
      } else {
        if (!last || last.kind !== 'barline') {
          errors.push(
            err('跳房子 "[" 应写在小节线后（行首请用 |/ 或小节线，adj26）', {
              line: pos.line,
              col: pos.col + i,
            }, 'warning'),
          )
        }
        // 其余（行首 [ 等无小节线可依）：纯跳房子起点（voltaOnly，不画小节线竖线）
        tokens.push({
          kind: 'barline',
          type: '|',
          voltaStart: { open: true, slash: mod.slash, plus: mod.plus, comment: mod.comment },
          voltaOnly: true,
          pos: i,
          raw: rawAt(i, mod.k),
        })
        lastBlockEnd = mod.k
        lastBlockCounts = true
      }
      i = mod.k
      continue
    }
    if (c === ']') {
      // 跳房子结束；]/ 开口结束（adj26）
      let k = i + 1
      let slash = false
      if (content[k] === '/') {
        slash = true
        k++
      }
      tokens.push({
        kind: 'barline',
        type: '|',
        voltaEnd: true,
        voltaEndSlash: slash,
        pos: i,
        raw: rawAt(i, k),
      })
      registerBlock(i, k)
      i = k
      continue
    }

    // 音符 / 休止符 / 节奏音符
    if (c >= '1' && c <= '7') {
      const start = i
      const base = {
        accidental: null as '#' | '$' | '=' | null,
        augmentCount: 0,
        diminishCount: 0,
        dots: 0,
        octaveShift: 0,
        symbols: [] as string[],
      }
      const end = collectSuffix(i + 1, base)
      const token: NoteToken_ = {
        kind: 'note',
        pitch: c.charCodeAt(0) - 48 as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        ...base,
        pos: i,
        raw: rawAt(start, end),
      }
      tokens.push(token)
      registerBlock(start, end)
      i = end
      continue
    }
    if (c === '0' || c === '8') {
      const start = i
      const base: { accidental: null; augmentCount: number; diminishCount: number; dots: number; octaveShift: number; symbols: string[]; comment?: string } = { accidental: null, augmentCount: 0, diminishCount: 0, dots: 0, octaveShift: 0, symbols: [] as string[] }
      const end = collectSuffix(i + 1, base)
      tokens.push({
        kind: 'rest',
        hidden: c === '8',
        augmentCount: base.augmentCount,
        diminishCount: base.diminishCount,
        dots: base.dots,
        symbols: base.symbols,
        // adj209：休止符注释（0"转调"）此前漏传——collectSuffix 已解析但未挂到 token
        comment: base.comment,
        pos: i,
        raw: rawAt(start, end),
      })
      registerBlock(start, end)
      i = end
      continue
    }
    if (c === '9') {
      const start = i
      const base: { accidental: null; augmentCount: number; diminishCount: number; dots: number; octaveShift: number; symbols: string[]; comment?: string } = { accidental: null, augmentCount: 0, diminishCount: 0, dots: 0, octaveShift: 0, symbols: [] as string[] }
      const end = collectSuffix(i + 1, base)
      tokens.push({
        kind: 'rhythm',
        augmentCount: base.augmentCount,
        diminishCount: base.diminishCount,
        dots: base.dots,
        symbols: base.symbols,
        // adj209：节奏符注释（9"…"）同休止符，此前漏传
        comment: base.comment,
        pos: i,
        raw: rawAt(start, end),
      })
      registerBlock(start, end)
      i = end
      continue
    }

    // 独立的增时线 "-"：原站自动格式化会把 "5-" 拆成 "5 -"，
    // 因此独立出现的 "-" 归入前面最近的音符/休止符/节奏符（adj37：
    // 可跳过连音线括号等中间符号，如 "1) -" 的 "-" 仍是对 1 的增时；不跨小节线）
    if (c === '-') {
      let found = false
      for (let k = tokens.length - 1; k >= 0; k--) {
        const last = tokens[k]
        if (last.kind === 'note' || last.kind === 'rest' || last.kind === 'rhythm') {
          last.augmentCount++
          last.raw += '-'
          // adj80：独立 "-" 后紧跟 "&编码"（如 "-&ykh"）应随音符收集，
          // 否则 "&ykh" 会落成独立 decoration（原 "6 - - -&ykh" 右括号丢失）
          // adj294：&zkh/&ykh 已是独立 bracket token——不随音符收集，留给主循环处理。
          // 仍归入增时线（augmentCount++ 已做），但 i 推进到 "&" 处，让主循环生成独立 bracket。
          if (content[i + 1] === '&') {
            let j = i + 2
            while (j < n && /[a-zA-Z0-9]/.test(content[j])) j++
            if (j > i + 2) {
              const bkCode = content.slice(i + 2, j)
              if (bkCode === 'zkh' || bkCode === 'ykh') {
                lastBlockEnd = i + 1
                found = true
                break // 留在 & 处，主循环处理 &ykh → 独立 bracket token
              }
              if (last.kind === 'note') last.symbols.push(bkCode)
              last.raw += content.slice(i + 1, j)
              i = j - 1 // 循环尾部 i++ 落到编码末
            }
          }
          lastBlockEnd = i + 1 // 音符块结束延展
          found = true
          break
        }
        if (last.kind === 'barline') break // 不跨小节线归入
      }
      if (found) {
        i++
        continue
      }
    }

    // 未知字符：保留原文作为装饰 token，并给出警告
    errors.push(err(`无法识别的符号 "${c}"`, { line: pos.line, col: pos.col + i }, 'warning'))
    tokens.push({ kind: 'decoration', code: c, pos: i, raw: c })
    i++
  }

  return { tokens, errors }
}

// 局部类型别名（避免在分支中手写冗长 Extract）
type NoteToken_ = Extract<MusicToken, { kind: 'note' }>
