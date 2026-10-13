/**
 * savePath.ts — 保存出口的**落点与文件名**（`adj912`，用户 2026-10-13 定稿）
 *
 * ## 口径（用户原话）
 * 「保存为 PNG / SVG」**存到同一目录，同名不覆盖就加序号**：与那份 `.jps` **同一目录**、
 * 文件名用该 `.jps` 的**主名** + `.png` / `.svg`；已存在则**依次加序号**（例：`花又期二重奏 2.png`）。
 *
 * ## 为什么抽成纯函数
 * ① 「重名怎么加序号」是本项目**踩过坑**的地方（`adj873` 那条"手机端保存到谱面同目录"因为
 *    "取图必须走嵌入版应用"整条删除，见 `adj874`）—— 这次只做**命名**这一件事，可被冒烟逐项断言；
 * ② 命名要**跨平台一致**：Windows / macOS 上 `a.PNG` 与 `a.png` 是**同一个文件** ⇒ 比较一律按小写；
 *    而 Obsidian 的 `getAbstractFileByPath` 未必这么认 ⇒ 由调用方传进来的 `exists` 负责这一点
 *    （`main.ts` 用"目录里已有哪些文件名"的**小写集合**实现它）。
 *
 * 本模块**不依赖 obsidian / DOM**（只输出纯数据）⇒ `npm run smoke` 可直接 import 逐项断言。
 */
import { dirOfPath } from './newFile'

/** 扩展名规范化：`png` / `PNG` / `.png` 一律 ⇒ `.png`（拼接前统一，免得出现两套规则） */
export function normExt(ext: string): string {
  const e = ext.startsWith('.') ? ext : `.${ext}`
  return e.toLowerCase()
}

/** 库内路径 → 文件名（最后一段；反斜杠也当分隔符，容错） */
export function fileNameOf(path: string): string {
  const p = path.replace(/\\/g, '/')
  return p.slice(p.lastIndexOf('/') + 1)
}

/**
 * 谱面**主名**：去目录、去**最后一个扩展名**，前面/中间的点号保留
 * （`曲谱集/v1.2.jps` ⇒ `v1.2`，不是 `v1`；`花又期二重奏.JPS` ⇒ `花又期二重奏`）。
 *
 * 为什么是"去最后一个扩展名"而不是"只去 `.jps`"：代码块（```jps）没有"自己的文件" ⇒ 调用方传
 * **承载它的笔记**的路径，那时要去掉的是 `.md`（`笔记/我的歌.md` ⇒ `我的歌`）—— 两种情形
 * 恰好是同一个规则（"去掉尾巴上的扩展名"），于是只有一处实现，也就不会有第二套口径。
 */
export function scoreBaseName(pathOrName: string): string {
  const name = fileNameOf(pathOrName.trim())
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 保存落点：**优先 `.jps` 自己**（`.jps` 文件视图 / `![[x.jps]]` 嵌入都会给出它的库内路径）；
 * 代码块没有自己的文件 ⇒ 退到**承载它的笔记**（`containerPath`：同一目录 + 笔记主名）。
 *
 * 两者都没有（理论上到不了：代码块的 `<ctx.sourcePath>` 一定在）⇒ 库根 + `未命名谱面`，
 * 至少**不往别处乱写**（这条路径由 Notice 如实报出文件名）。
 */
export function saveTargetOf(filePath?: string, containerPath?: string): { dir: string; base: string } {
  const path = (filePath ?? '').trim() !== '' ? (filePath as string) : (containerPath ?? '').trim()
  if (path === '') return { dir: '', base: '未命名谱面' }
  return { dir: dirOfPath(path), base: scoreBaseName(path) }
}

/**
 * **同名不覆盖，依次加序号**（纯函数）：`a.png` 已存在 ⇒ `a 2.png`；`a.png` + `a 2.png` 都在 ⇒ `a 3.png`。
 *
 * 为什么从 **2** 起：用户口径给的例子就是 `花又期二重奏 2.png` —— 第一个重名是"第 2 份"，
 * 不是"第 1 份"（`未命名 1.png` 会让人以为还有 `未命名 0`）。取**第一个空位**（而不是"已有数量 + 1"），
 * 删掉中间某个之后不会又撞上已占用的名字。
 *
 * @param dir  库内目录（`''` 或 `'/'` = 库根；不会再拼一个多余的分隔符）
 * @param base 主名（不含扩展名；`scoreBaseName()` 的产物）
 * @param ext  扩展名（带不带点、大小写都行，内部走 `normExt`）
 * @param exists 判据：这个**完整库内路径**是否已被占用（大小写不敏感的比较由调用方负责）
 * @returns 完整库内路径（调用方直接喂给 `vault.create` / `createBinary`）
 */
export function uniqueNameIn(dir: string, base: string, ext: string, exists: (path: string) => boolean): string {
  const e = normExt(ext)
  const join = (name: string): string => (dir === '' || dir === '/' ? name : `${dir}/${name}`)
  const first = join(`${base}${e}`)
  if (!exists(first)) return first
  for (let i = 2; i < 10000; i += 1) {
    const candidate = join(`${base} ${i}${e}`)
    if (!exists(candidate)) return candidate
  }
  // 一万个同名前缀都占满了（实际不可能）：退化成时间戳，**绝不覆盖**已有文件
  return join(`${base} ${Date.now()}${e}`)
}
