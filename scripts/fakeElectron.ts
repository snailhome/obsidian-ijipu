/**
 * scripts/fakeElectron.ts — 冒烟用的 `electron` 替身（**仅供 `npm run smoke` 打包**，adj926）
 *
 * 与 `scripts/obsidianStub.ts` 同一手法：冒烟在 Node 里跑，没有 Obsidian/Electron 运行时，
 * 于是 `npm run smoke` 用 `--alias:electron=./scripts/fakeElectron.ts` 把该依赖换成本文件
 * ⇒ 冒烟可以**真的调用** `openUrlExternally()`，并逐条核对"到底把什么交给了 shell"。
 *
 * 记录的是真实调用参数（而不是断言源码字符串）：这样"传的是相对路径还是绝对路径 / 有没有真的调到"
 * 这类判断才有实际证据。
 */
export type FakeShellCall = {
  fn: 'openExternal' | 'openPath'
  arg: string
}

/** 每次调用按顺序记在这里（断言前清空即可） */
export const shellCalls: FakeShellCall[] = []

export const shell = {
  async openExternal(url: string): Promise<void> {
    shellCalls.push({ fn: 'openExternal', arg: url })
  },
  async openPath(path: string): Promise<string> {
    shellCalls.push({ fn: 'openPath', arg: path })
    return ''
  },
}
